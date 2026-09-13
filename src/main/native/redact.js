// Best-effort redaction for log lines and diagnostics bundles. Pattern based and
// deliberately conservative: false positives are acceptable, leaks are not.
const PATTERNS = [
  /bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /sk-[A-Za-z0-9_-]{10,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[abpsr]-[A-Za-z0-9-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];
const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|authorization|credential|cookie)/i;
const REDACTED = '[redacted]';

function redactText(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

// Deep-walks plain objects/arrays. Keys that look secret are replaced wholesale.
function redact(value, depth = 0) {
  if (depth > 8) return REDACTED;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(item => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? REDACTED : redact(item, depth + 1),
    ]));
  }
  return value;
}

module.exports = { redact, redactText };
