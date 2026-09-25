// Real, runnable regression tests for the alert-ranking engine (spec_v2.mvp_feature).
// Run with: node mvp/alert-scoring.test.js
// No dependencies beyond Node's built-in test/assert modules -- consistent with
// this portfolio's minimize-third-party-runtime-deps preference, and this is
// dev-only tooling, not shipped in the deployed Worker anyway.

const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreAlert, rankAlerts, parseCSV, escapeHtml, toCSV, TYPE_WEIGHTS, detectMissingColumns, EXPECTED_COLUMNS, toNumber } = require('./alert-scoring.js');

test('amount_component caps at 40 for amounts >= $40k', () => {
  const low = scoreAlert({ amount: 5000, alert_type: 'other', account_age_days: 400, prior_alerts_90d: 0 });
  const high = scoreAlert({ amount: 90000, alert_type: 'other', account_age_days: 400, prior_alerts_90d: 0 });
  assert.equal(low.score_breakdown.amount_component, 5);
  assert.equal(high.score_breakdown.amount_component, 40);
});

test('type_component uses the documented weight table, falls back to 5 for unknown types', () => {
  for (const [type, weight] of Object.entries(TYPE_WEIGHTS)) {
    const a = scoreAlert({ amount: 0, alert_type: type, account_age_days: 400, prior_alerts_90d: 0 });
    assert.equal(a.score_breakdown.type_component, weight, `${type} should score ${weight}`);
  }
  const unknown = scoreAlert({ amount: 0, alert_type: 'not_a_real_type', account_age_days: 400, prior_alerts_90d: 0 });
  assert.equal(unknown.score_breakdown.type_component, 5);
});

test('type matching is case-insensitive and trims whitespace', () => {
  const a = scoreAlert({ amount: 0, alert_type: '  Sanctions_Match  ', account_age_days: 400, prior_alerts_90d: 0 });
  assert.equal(a.score_breakdown.type_component, TYPE_WEIGHTS.sanctions_match);
});

test('tenure_component: <90d=15, <365d=7, else 0', () => {
  assert.equal(scoreAlert({ account_age_days: 10 }).score_breakdown.tenure_component, 15);
  assert.equal(scoreAlert({ account_age_days: 200 }).score_breakdown.tenure_component, 7);
  assert.equal(scoreAlert({ account_age_days: 900 }).score_breakdown.tenure_component, 0);
});

test('repeat_component caps at 20 (4+ prior alerts)', () => {
  assert.equal(scoreAlert({ prior_alerts_90d: 2 }).score_breakdown.repeat_component, 10);
  assert.equal(scoreAlert({ prior_alerts_90d: 10 }).score_breakdown.repeat_component, 20);
});

test('missing/malformed numeric fields degrade to 0 rather than NaN or throwing', () => {
  const a = scoreAlert({ amount: 'not-a-number', account_age_days: undefined, prior_alerts_90d: null });
  assert.equal(Number.isNaN(a.risk_score), false);
  assert.equal(a.score_breakdown.amount_component, 0);
  assert.equal(a.score_breakdown.tenure_component, 0);
  assert.equal(a.score_breakdown.repeat_component, 0);
});

test('rankAlerts sorts descending by risk_score', () => {
  const alerts = [
    { alert_id: 'low', amount: 100, alert_type: 'other', account_age_days: 900, prior_alerts_90d: 0 },
    { alert_id: 'high', amount: 45000, alert_type: 'sanctions_match', account_age_days: 10, prior_alerts_90d: 4 },
    { alert_id: 'mid', amount: 9800, alert_type: 'structuring', account_age_days: 60, prior_alerts_90d: 3 },
  ];
  const ranked = rankAlerts(alerts);
  assert.deepEqual(ranked.map((a) => a.alert_id), ['high', 'mid', 'low']);
});

test('parseCSV: header row order does not matter, whitespace is trimmed', () => {
  const csv = 'alert_type,alert_id,amount\nvelocity, A-1 ,  600 \n';
  const rows = parseCSV(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].alert_id, 'A-1');
  assert.equal(rows[0].amount, '600');
});

test('parseCSV: handles quoted fields with embedded commas and escaped quotes', () => {
  const csv = 'alert_id,alert_type\n"A,1","he said ""hi"""\n';
  const rows = parseCSV(csv);
  assert.equal(rows[0].alert_id, 'A,1');
  assert.equal(rows[0].alert_type, 'he said "hi"');
});

test('parseCSV: ignores trailing blank lines, handles \\r\\n endings', () => {
  const csv = 'alert_id,amount\r\nA-1,100\r\n\r\n';
  const rows = parseCSV(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, '100');
});

test('parseCSV: empty input returns an empty array, not a crash', () => {
  assert.deepEqual(parseCSV(''), []);
  assert.deepEqual(parseCSV('\n\n'), []);
});

test('the sample CSV embedded in the dashboard actually parses and scores without error', () => {
  const SAMPLE_CSV = `alert_id,amount,alert_type,account_age_days,prior_alerts_90d
A-1001,45000,sanctions_match,40,1
A-1002,2500,other,900,0
A-1003,9800,structuring,60,3
A-1004,15000,high_risk_country,200,0
A-1005,600,velocity,15,4
A-1006,32000,large_cash,1000,0`;
  const ranked = rankAlerts(parseCSV(SAMPLE_CSV));
  assert.equal(ranked.length, 6);
  assert.equal(ranked[0].alert_id, 'A-1001');
  ranked.forEach((a) => assert.equal(Number.isNaN(a.risk_score), false));
});

test('escapeHtml neutralizes markup so a malicious CSV field cannot inject script into the dashboard', () => {
  assert.equal(
    escapeHtml('<img src=x onerror=alert(1)>'),
    '&lt;img src=x onerror=alert(1)&gt;'
  );
  assert.equal(escapeHtml(`"quoted" & 'apostrophe'`), '&quot;quoted&quot; &amp; &#39;apostrophe&#39;');
  assert.equal(escapeHtml(''), '');
  assert.equal(escapeHtml(42), '42');
});

test('toCSV: includes rank, original fields, total score, and per-component breakdown', () => {
  const ranked = rankAlerts([
    { alert_id: 'A-1', amount: 45000, alert_type: 'sanctions_match', account_age_days: 40, prior_alerts_90d: 1 },
  ]);
  const csv = toCSV(ranked);
  const [header, row] = csv.trim().split('\n');
  assert.equal(header, 'rank,alert_id,amount,alert_type,account_age_days,prior_alerts_90d,risk_score,amount_component,type_component,tenure_component,repeat_component');
  const cells = row.split(',');
  assert.equal(cells[0], '1');
  assert.equal(cells[1], 'A-1');
  assert.equal(cells[6], String(ranked[0].risk_score));
});

test('toCSV: quotes fields containing commas or quotes, escapes embedded quotes', () => {
  const ranked = rankAlerts([
    { alert_id: 'A-1, dup', amount: 100, alert_type: 'other', account_age_days: 10, prior_alerts_90d: 0 },
  ]);
  const csv = toCSV(ranked);
  assert.match(csv, /"A-1, dup"/);
});

test('toCSV: empty input produces just the header row', () => {
  const csv = toCSV([]);
  assert.equal(csv.trim(), 'rank,alert_id,amount,alert_type,account_age_days,prior_alerts_90d,risk_score,amount_component,type_component,tenure_component,repeat_component');
});

test('detectMissingColumns: returns empty when the CSV has every expected column', () => {
  const csv = 'alert_id,amount,alert_type,account_age_days,prior_alerts_90d\nA-1,100,other,10,0\n';
  assert.deepEqual(detectMissingColumns(csv), []);
});

test('detectMissingColumns: flags a renamed/missing column instead of silently scoring it as 0', () => {
  // "account_age" instead of the expected "account_age_days" -- a plausible
  // real-world mismatch between a bank's export and this tool's format.
  const csv = 'alert_id,amount,alert_type,account_age,prior_alerts_90d\nA-1,100,other,10,0\n';
  assert.deepEqual(detectMissingColumns(csv), ['account_age_days']);
});

test('detectMissingColumns: header order and case do not affect detection', () => {
  const csv = 'PRIOR_ALERTS_90D,Alert_Id,amount,Alert_Type,account_age_days\n0,A-1,100,other,10\n';
  assert.deepEqual(detectMissingColumns(csv), []);
});

test('detectMissingColumns: empty input reports every expected column missing', () => {
  assert.deepEqual(detectMissingColumns(''), EXPECTED_COLUMNS);
});

test('toNumber: strips a leading "$" and thousands-separator commas', () => {
  assert.equal(toNumber('$45,000'), 45000);
  assert.equal(toNumber('45,000'), 45000);
  assert.equal(toNumber('45,000.00'), 45000);
  assert.equal(toNumber('$ 1,234.50'), 1234.5);
});

test('toNumber: plain numbers and numeric types still work unchanged', () => {
  assert.equal(toNumber(45000), 45000);
  assert.equal(toNumber('45000'), 45000);
  assert.equal(toNumber('  600 '), 600);
});

test('toNumber: genuinely non-numeric input still degrades to NaN, not a false 0', () => {
  assert.equal(Number.isNaN(toNumber('not-a-number')), true);
  assert.equal(Number.isNaN(toNumber(undefined)), true);
  assert.equal(Number.isNaN(toNumber(null)), true);
  assert.equal(Number.isNaN(toNumber('')), true);
});

test('a currency-formatted amount ($45,000) scores the same as its bare numeric equivalent, not 0', () => {
  const bare = scoreAlert({ amount: 45000, alert_type: 'other', account_age_days: 400, prior_alerts_90d: 0 });
  const currency = scoreAlert({ amount: '$45,000', alert_type: 'other', account_age_days: 400, prior_alerts_90d: 0 });
  assert.equal(currency.score_breakdown.amount_component, bare.score_breakdown.amount_component);
  assert.equal(currency.score_breakdown.amount_component, 40);
});

test('a comma-formatted account_age_days/prior_alerts_90d still parses correctly', () => {
  const a = scoreAlert({ amount: 0, alert_type: 'other', account_age_days: '1,200', prior_alerts_90d: '10' });
  assert.equal(a.score_breakdown.tenure_component, 0); // 1200 days >= 365
  assert.equal(a.score_breakdown.repeat_component, 20); // 10 * 5, capped at 20
});
