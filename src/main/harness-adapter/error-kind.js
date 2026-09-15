// 失败回合错误分类（借鉴 codeg 的失败分类 UX）：
// 诚实优先——适配器从原生结构化错误显式给出 errorKind / codexErrorInfo 时直接使用；
// 否则按 HTTP 状态码与消息特征归类；都不中则 'unknown'，绝不虚构原因。
const ERROR_KINDS = ['network', 'auth', 'quota', 'refused', 'server', 'unknown'];

// 每类只配真正帮得上忙的动作；login 由调用方按 Harness 真实登录能力（loginCommand）再过滤
const ERROR_ACTIONS = {
  network: ['retry'],
  auth: ['login', 'newSession'],
  quota: ['newSession'],
  refused: ['retry', 'newSession'],
  server: ['retry'],
  unknown: ['retry', 'newSession'],
};

// Codex app-server 原生 CodexErrorInfo 变体 → 分类（仅映射已确认语义的变体）
const CODEX_ERROR_INFO_KINDS = {
  usageLimitExceeded: 'quota',
  unauthorized: 'auth',
  httpConnectionFailed: 'network',
  responseStreamDisconnected: 'network',
  internalServerError: 'server',
  badRequest: 'refused',
  contextWindowExceeded: 'refused',
};

/** CodexErrorInfo 线格式防御性读取：字符串变体或单键对象都打平成变体名 */
function codexErrorInfoKey(info) {
  if (typeof info === 'string' && info) return info;
  if (info && typeof info === 'object') {
    const key = Object.keys(info)[0];
    if (typeof key === 'string' && key) return key;
  }
  return null;
}

function mapCodexErrorInfo(info) {
  const key = codexErrorInfoKey(info);
  if (!key) return null;
  const normalized = key.toLowerCase();
  for (const [variant, kind] of Object.entries(CODEX_ERROR_INFO_KINDS)) {
    if (variant.toLowerCase() === normalized) return kind;
  }
  return null;
}

// 顺序即优先级：'connection refused' 必须命中 network 而非 refused，故 refused 模式保持具体
const PATTERNS = [
  ['auth', /unauthorized|invalid[ _]api[ _]key|api[ _]key.*(invalid|missing|expired)|authentication|not logged in|log(?:ged)? in (?:first|required)|token.*(expired|invalid)|登录|未授权|凭据/i],
  ['quota', /rate.?limit|usage.?limit|quota|insufficient|billing|credits?|额度|用量超限|\b429\b/i],
  ['network', /econn(refused|reset|aborted)|etimedout|enotfound|eai_again|socket hang up|network error|fetch failed|connection (refused|reset|closed|lost)|stream (disconnected|error)|timed? ?out|断开|超时|连接失败/i],
  ['server', /internal server error|bad gateway|service unavailable|gateway timeout|overloaded|\b5\d{2}\b|服务异常|服务器错误/i],
  ['refused', /request (was )?(refused|rejected)|bad request|malformed|被拒绝|无效的请求/i],
];

/**
 * 归类一次失败。输入可带适配器显式字段：errorKind（已归类）、codexErrorInfo（Codex 原生
 * 结构化错误）、statusCode（HTTP 状态码）；都没有时按 message 特征匹配，兜底 'unknown'。
 */
function classifyError({ errorKind, codexErrorInfo, statusCode, message } = {}) {
  if (ERROR_KINDS.includes(errorKind)) return errorKind;
  const fromInfo = mapCodexErrorInfo(codexErrorInfo);
  if (fromInfo) return fromInfo;
  const status = Number(statusCode);
  if (Number.isFinite(status)) {
    if (status === 401 || status === 403) return 'auth';
    if (status === 402 || status === 429) return 'quota';
    if (status === 400 || status === 404 || status === 413 || status === 422) return 'refused';
    if (status >= 500 && status < 600) return 'server';
  }
  const text = String(message ?? '');
  for (const [kind, pattern] of PATTERNS) if (pattern.test(text)) return kind;
  return 'unknown';
}

/** 按分类推导动作按钮；canLogin 为假时摘除 login，不让 UI 摆出做不到的按钮 */
function errorActions(kind, { canLogin = false } = {}) {
  const actions = ERROR_ACTIONS[ERROR_KINDS.includes(kind) ? kind : 'unknown'];
  return actions.filter(action => action !== 'login' || canLogin);
}

module.exports = { ERROR_KINDS, ERROR_ACTIONS, classifyError, errorActions, mapCodexErrorInfo, codexErrorInfoKey };
