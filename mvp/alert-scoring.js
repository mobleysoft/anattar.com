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

function amountComponent(amount) {
  const n = Number(amount) || 0;
  return Math.min(n / 1000, 40);
}

function typeComponent(alertType) {
  const key = String(alertType || '').trim().toLowerCase();
  return TYPE_WEIGHTS[key] !== undefined ? TYPE_WEIGHTS[key] : 5;
}

function tenureComponent(accountAgeDays) {
  const n = Number(accountAgeDays);
  if (Number.isNaN(n)) return 0;
  if (n < 90) return 15;
  if (n < 365) return 7;
  return 0;
}

function repeatComponent(priorAlerts90d) {
  const n = Number(priorAlerts90d) || 0;
  return Math.min(n * 5, 20);
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
function parseCSV(text) {
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

  const nonEmptyRows = rows.filter((r) => r.some((cell) => cell.trim() !== ''));
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

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// The dashboard renders parsed CSV fields into the DOM via innerHTML template
// strings. A CSV's alert_id/alert_type/etc. columns are not necessarily
// operator-authored -- they can carry through free text from an upstream
// case-management system -- so they must be escaped before interpolation,
// same as any other untrusted string rendered as HTML.
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// Export for both Node (testing) and browser (dashboard) use.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { scoreAlert, rankAlerts, parseCSV, escapeHtml, TYPE_WEIGHTS };
}
if (typeof window !== 'undefined') {
  window.AlertScoring = { scoreAlert, rankAlerts, parseCSV, escapeHtml, TYPE_WEIGHTS };
}
