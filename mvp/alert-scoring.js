/**
 * anattar.com MVP: single-institution alert-ranking engine.
 *
 * Scope (per spec_v2.mvp_feature): ingest ONE bank's existing transaction-alert
 * CSV export and re-rank alerts by a FIXED, EXPLAINABLE risk score. This is not
 * a general data platform, not machine-learned, and not connected to any live
 * bank feed -- it is a deterministic scoring function over a CSV a compliance
 * officer already has.
 *
 * Expected CSV columns (header row required, order does not matter):
 *   alert_id        - any string/number identifying the alert
 *   amount           - transaction amount in USD (number)
 *   alert_type       - one of: structuring, high_risk_country, velocity,
 *                       large_cash, sanctions_match, other
 *   account_age_days - how long the account has existed (number)
 *   prior_alerts_90d - count of prior alerts on this account in last 90 days
 *
 * Scoring formula (fixed weights, documented so an examiner/officer can
 * audit exactly why an alert ranked where it did -- this is the whole
 * point of "explainable" vs a black-box model):
 *
 *   score = amount_component
 *         + type_component
 *         + tenure_component
 *         + repeat_component
 *
 *   amount_component   = min(amount / 1000, 40)        // caps at 40 pts, $40k+
 *   type_component      = TYPE_WEIGHTS[alert_type] || 5  // 0-35 pts
 *   tenure_component    = account_age_days < 90 ? 15
 *                        : account_age_days < 365 ? 7
 *                        : 0                              // newer accounts riskier
 *   repeat_component    = min(prior_alerts_90d * 5, 20)   // caps at 20 pts
 *
 *   Max possible score: 40 + 35 + 15 + 20 = 110
 */

const TYPE_WEIGHTS = {
  sanctions_match: 35,
  structuring: 28,
  high_risk_country: 22,
  velocity: 18,
  large_cash: 15,
  other: 5,
};

// A bank's CSV export commonly formats numeric fields as currency/with
// thousands separators ("$45,000", "45,000.00") rather than a bare number.
// Number("$45,000") is NaN, so every numeric component silently scored 0 for
// a perfectly valid, common real-world value -- the same "silently reads as
// 0" risk class detectMissingColumns() already exists to catch for a missing
// column, just one level deeper (a malformed value in a present column).
// Strips a leading "$" and thousands-separator commas before parsing; a
// value that still isn't numeric after that (typos, free text) correctly
// falls through to NaN, preserving the existing degrade-to-0 behavior below.
function toNumber(value) {
  if (typeof value === 'number') return value;
  if (value === undefined || value === null) return NaN;
  const cleaned = String(value).trim().replace(/^\$\s*/, '').replace(/,/g, '').trim();
  if (cleaned === '') return NaN;
  return Number(cleaned);
}

function amountComponent(amount) {
  const n = toNumber(amount);
  return Math.min((Number.isNaN(n) ? 0 : n) / 1000, 40);
}

function typeComponent(alertType) {
  const key = String(alertType || '').trim().toLowerCase();
  return TYPE_WEIGHTS[key] !== undefined ? TYPE_WEIGHTS[key] : 5;
}

function tenureComponent(accountAgeDays) {
  const n = toNumber(accountAgeDays);
  if (Number.isNaN(n)) return 0;
  if (n < 90) return 15;
  if (n < 365) return 7;
  return 0;
}

function repeatComponent(priorAlerts90d) {
  const n = toNumber(priorAlerts90d);
  return Math.min((Number.isNaN(n) ? 0 : n) * 5, 20);
}

function scoreAlert(alert) {
  const breakdown = {
    amount_component: round2(amountComponent(alert.amount)),
    type_component: round2(typeComponent(alert.alert_type)),
    tenure_component: round2(tenureComponent(alert.account_age_days)),
    repeat_component: round2(repeatComponent(alert.prior_alerts_90d)),
  };
  const total = round2(
    breakdown.amount_component +
      breakdown.type_component +
      breakdown.tenure_component +
      breakdown.repeat_component
  );
  return { ...alert, risk_score: total, score_breakdown: breakdown };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function rankAlerts(alerts) {
  return alerts.map(scoreAlert).sort((a, b) => b.risk_score - a.risk_score);
}

/**
 * Minimal CSV parser. Handles: header row, comma delimiter, double-quoted
 * fields with escaped "" quotes, \n or \r\n line endings, trailing blank
 * lines. Not a general RFC4180 parser -- adequate for a bank's simple
 * alert-export CSV, which is the stated scope.
 */
function parseCSVRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text).replace(/\r\n/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function parseCSV(text) {
  const nonEmptyRows = parseCSVRows(text);
  if (nonEmptyRows.length === 0) return [];

  const header = nonEmptyRows[0].map((h) => h.trim().toLowerCase());
  return nonEmptyRows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, idx) => {
      obj[h] = r[idx] !== undefined ? r[idx].trim() : '';
    });
    return obj;
  });
}

const EXPECTED_COLUMNS = ['alert_id', 'amount', 'alert_type', 'account_age_days', 'prior_alerts_90d'];

// A compliance officer's own CSV export may use different column names than
// this tool expects (e.g. "account_age" instead of "account_age_days") --
// parseCSV silently treats a missing column as absent on every row, which
// silently zeroes out that score component on every alert rather than
// erroring. That's a real risk for a tool whose whole value proposition is
// being explainable: a wrong-but-plausible-looking ranked queue is worse
// than an obvious upfront warning, especially for an AML/fraud triage tool
// where score components silently reading as 0 could hide real risk.
function detectMissingColumns(text) {
  const rows = parseCSVRows(text);
  if (rows.length === 0) return EXPECTED_COLUMNS.slice();
  const header = rows[0].map((h) => h.trim().toLowerCase());
  return EXPECTED_COLUMNS.filter((c) => !header.includes(c));
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// The dashboard renders parsed CSV fields into the DOM via innerHTML template
// strings. A CSV's alert_id/alert_type/etc. columns are not necessarily
// operator-authored -- they can carry through free text from an upstream
// case-management system -- so they must be escaped before interpolation,
// same as any other untrusted string rendered as HTML.
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

const EXPORT_COLUMNS = [
  'rank', 'alert_id', 'amount', 'alert_type', 'account_age_days',
  'prior_alerts_90d', 'risk_score', 'amount_component', 'type_component',
  'tenure_component', 'repeat_component',
];

// RFC4180-style field quoting: quote (and escape embedded quotes) whenever a
// field contains a comma, quote, or newline -- needed here because ranked
// alerts already carry free text from an upstream CSV (see escapeHtml above),
// and re-exporting that text has the same "not necessarily safe as-is" issue
// in the other direction (a value containing a comma would silently shift
// columns in the exported file if left unquoted).
function csvField(value) {
  const s = String(value === undefined || value === null ? '' : value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Ranked, scored alerts -> a CSV the compliance officer can save as their
// own audit trail for why the queue was triaged in this order (the same
// per-component breakdown shown in the dashboard, not just the total score).
// Pure string in, string out -- no DOM/Blob dependency, so it's testable
// under plain node:test the same as the rest of this module.
function toCSV(rankedAlerts) {
  const header = EXPORT_COLUMNS.join(',');
  const rows = rankedAlerts.map((a, i) => EXPORT_COLUMNS.map((col) => {
    if (col === 'rank') return i + 1;
    if (col in (a.score_breakdown || {})) return a.score_breakdown[col];
    return csvField(a[col]);
  }).join(','));
  return [header, ...rows].join('\n') + '\n';
}

// Export for both Node (testing) and browser (dashboard) use.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { scoreAlert, rankAlerts, parseCSV, escapeHtml, toCSV, TYPE_WEIGHTS, detectMissingColumns, EXPECTED_COLUMNS, toNumber };
}
if (typeof window !== 'undefined') {
  window.AlertScoring = { scoreAlert, rankAlerts, parseCSV, escapeHtml, toCSV, TYPE_WEIGHTS, detectMissingColumns, EXPECTED_COLUMNS, toNumber };
}
