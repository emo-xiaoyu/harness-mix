const fs = require('node:fs');
const path = require('node:path');

// 团队模板的项目作用域文件源：.harness-mix/teams/*.md（Markdown + YAML frontmatter）。
// 编成随仓库走、可进 PR 评审；每次调用即时解析（mtime 缓存），文件改动无需重启。
// 坏文件跳过并记录 warning，绝不让单个模板文件拖垮 Host 启动或 # 菜单。

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---(?:\n|$)/;

function parseScalar(raw) {
  let value = String(raw).trim();
  if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2)
    || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) value = value.slice(1, -1);
  return value.trim();
}

/**
 * 解析模板 frontmatter 的受支持子集：顶层 name/description 标量 + members 列表
 * （`- name: x` 起项，缩进字段归属当前项）。超出该形状的行直接报错——文件模板
 * 是给用户手写的，宁可明确拒绝也不静默忽略一半内容。
 */
function parseTeamTemplateFrontmatter(source) {
  const normalized = String(source ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = FRONTMATTER_PATTERN.exec(normalized);
  if (!match) throw new Error('缺少 --- 包裹的 frontmatter');
  const data = { members: [] };
  let current = null;
  for (const line of match[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const dash = /^-\s+(.*)$/.exec(trimmed);
    if (dash) {
      const inline = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(dash[1].trim());
      if (!inline) throw new Error(`无法解析的列表项：${trimmed}`);
      current = { [inline[1]]: parseScalar(inline[2]) };
      data.members.push(current);
      continue;
    }
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(trimmed);
    if (!pair) throw new Error(`无法解析的行：${trimmed}`);
    if (current && /^\s/.test(line)) current[pair[1]] = parseScalar(pair[2]);
    else if (pair[1] === 'members') {
      if (pair[2].trim()) throw new Error('members 只支持列表形式（- name: …）');
      current = null;
    } else {
      current = null;
      data[pair[1]] = parseScalar(pair[2]);
    }
  }
  return data;
}

/** 与设置页 saveTeamTemplate 完全相同的成员校验：文件源与用户源共用一把尺子 */
function validateTemplateMembers(members, resolveHarnessId) {
  if (!Array.isArray(members) || members.length < 1 || members.length > 6) throw new Error('团队模板需要 1-6 个成员');
  const names = new Set();
  return members.map(member => {
    const name = String(member?.name ?? '').trim();
    const role = String(member?.role ?? '').trim();
    const agentInput = String(member?.agent ?? '').trim();
    if (!name || name.length > 80) throw new Error('成员名称需为 1-80 个字符');
    if (!role || role.length > 240) throw new Error('成员职责需为 1-240 个字符');
    if (!agentInput) throw new Error('每个成员都需要指定一个 Harness');
    // 文件模板允许引用当前未安装的 Harness（换机/重装后编成仍可保留），仅在实际
    // 展开为指令时才校验可用性
    const agent = resolveHarnessId(agentInput) || agentInput.toLowerCase();
    const model = member?.model && typeof member.model === 'object'
      ? { id: String(member.model.id ?? '').trim(), name: String(member.model.name ?? member.model.id ?? '').trim(), ...(member.model.provider ? { provider: String(member.model.provider).trim() } : {}) }
      : (member?.model ? { id: String(member.model).trim(), name: String(member.model).trim(), ...(member.provider ? { provider: String(member.provider).trim() } : {}) } : null);
    const thinking = String(member?.thinking ?? '').trim();
    if (model && (!model.id || model.id.length > 256)) throw new Error('成员模型 ID 无效');
    if (thinking.length > 80) throw new Error('成员思考强度 ID 无效');
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error('成员名称不能重复');
    names.add(key);
    return { name, role, agent, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
  });
}

const cache = new Map();

/**
 * 读取 <cwd>/.harness-mix/teams/ 下的 *.md 模板。返回 { templates, warnings }：
 * templates 每项带 source: 'project' 与文件路径；warnings 记录被跳过的坏文件。
 * 目录不存在返回空；单文件解析/校验失败只进 warnings。
 */
async function loadProjectTeamTemplates(cwd, { resolveHarnessId } = {}) {
  const result = { templates: [], warnings: [] };
  if (!cwd || typeof cwd !== 'string') return result;
  const dir = path.join(cwd, '.harness-mix', 'teams');
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return result;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    try {
      const stat = await fs.promises.stat(file);
      const key = path.normalize(file).toLowerCase();
      let cached = cache.get(key);
      // mtime+size 命中即复用解析结果；mtime 粒度粗的文件系统上有 size 兜底
      if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
        const parsed = parseTeamTemplateFrontmatter(await fs.promises.readFile(file, 'utf8'));
        const name = String(parsed.name ?? '').trim();
        if (!name || name.length > 80) throw new Error('模板名称需为 1-80 个字符');
        cached = {
          mtimeMs: stat.mtimeMs, size: stat.size,
          template: {
            id: entry.name.replace(/\.md$/i, ''),
            name,
            description: String(parsed.description ?? '').trim().slice(0, 240),
            members: validateTemplateMembers(parsed.members, resolveHarnessId ?? (input => input)),
            source: 'project',
            file,
          },
        };
        cache.set(key, cached);
      }
      result.templates.push({ ...cached.template, members: cached.template.members.map(member => ({ ...member })) });
    } catch (error) {
      result.warnings.push({ file: entry.name, error: error.message });
    }
  }
  return result;
}

module.exports = { parseTeamTemplateFrontmatter, validateTemplateMembers, loadProjectTeamTemplates };
