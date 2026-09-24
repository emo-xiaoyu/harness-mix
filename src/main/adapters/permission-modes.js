// 从原生会话自己声明的权限档位里挑选“免询问/完全访问”档。只选择原生程序
// 提供的档位（等价于用户在原生 UI 里手动选择），不伪造任何审批决定；没有
// 匹配档位时返回 null，会话保持原生默认（审批仍经 respond() 走 Desktop）。
const FULL_ACCESS_MODE_IDS = new Set([
  'yolo', 'bypass', 'bypasspermissions', 'bypass-permissions', 'bypass_permissions',
  'full-access', 'fullaccess', 'full_access', 'dontask', 'dont-ask', 'dont-ask-permissions',
  'danger-full-access', 'dangerfullaccess', 'skip', 'auto-accept', 'accept-all', 'acceptall',
]);

const FULL_ACCESS_LABEL_HINTS = ['完全访问', '绕过', '免询问', '不询问', '无需批准', 'yolo', 'bypass', 'full access', 'full-access', 'danger'];

function pickFullAccessPermissionMode(modes) {
  if (!Array.isArray(modes)) return null;
  const normalized = modes.filter(mode => mode && typeof mode.id === 'string' && mode.id && mode.id !== 'default');
  const byId = normalized.find(mode => FULL_ACCESS_MODE_IDS.has(mode.id.toLowerCase()));
  if (byId) return byId.id;
  const byLabel = normalized.find(mode => {
    const label = String(mode.label ?? '').toLowerCase();
    return label && FULL_ACCESS_LABEL_HINTS.some(hint => label.includes(hint));
  });
  return byLabel?.id ?? null;
}

module.exports = { pickFullAccessPermissionMode };
