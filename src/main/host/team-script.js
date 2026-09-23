// 编排脚本解释器:受限 DSL 的词法/语法/求值。
// 语言面:const 声明、if/else、for-of(仅数组)、return、phase()/task()/state()/
// Promise.all、字面量(含对象/数组)、成员与索引访问、! / await、比较与 + 拼接、
// 逻辑短路、三元。刻意不支持:赋值、while/for(;;)、函数定义、任意方法调用——
// 循环只能遍历有界数组,死循环在语法上不可能;全部副作用只能经 task/phase/state
// 三个原语发生,journal 因此可重放。求值器逐语句检查 tick()(步数预算与中断),
// Host 关机/用户中断在语句边界立即生效。

const KEYWORDS = new Set(['const', 'let', 'if', 'else', 'for', 'of', 'return', 'await', 'true', 'false', 'null']);
const BUILTINS = new Set(['task', 'phase', 'state']);
const ARRAY_METHODS = new Set(['push', 'concat', 'includes', 'indexOf', 'slice', 'join']);
const MAX_LOOP_ITEMS = 64;

class ScriptSyntaxError extends Error {
  constructor(message, line) { super(`${message}（第 ${line} 行）`); this.name = 'ScriptSyntaxError'; this.line = line; }
}
class ScriptInterrupted extends Error {
  constructor() { super('Script interrupted'); this.name = 'ScriptInterrupted'; this.code = 'SCRIPT_INTERRUPTED'; }
}

function lex(source) {
  const tokens = [];
  let i = 0, line = 1, depth = 0;
  const push = (type, value) => tokens.push({ type, value, line });
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { line++; if (depth === 0) push('newline', '\n'); i++; continue; }
    if (ch === ' ' || ch === '\t') { i++; continue; }
    if (ch === '/' && source[i + 1] === '/') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) throw new ScriptSyntaxError('未闭合的块注释', line);
      line += (source.slice(i, end + 2).match(/\n/g) || []).length;
      i = end + 2; continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i; while (j < source.length && /[0-9.]/.test(source[j])) j++;
      const raw = source.slice(i, j);
      if ((raw.match(/\./g) || []).length > 1) throw new ScriptSyntaxError(`非法数字 ${raw}`, line);
      push('number', Number(raw)); i = j; continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1, out = '';
      while (j < source.length && source[j] !== ch && source[j] !== '\n') {
        if (source[j] === '\\') {
          const next = source[j + 1];
          out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          j += 2; continue;
        }
        out += source[j]; j++;
      }
      if (j >= source.length || source[j] !== ch) throw new ScriptSyntaxError('字符串未闭合', line);
      push('string', out); i = j + 1; continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i; while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j++;
      const word = source.slice(i, j); i = j;
      // 内建名按 ident 发:parsePrimary 生成 Ident 节点,validateCallee 才能识别;
      // 求值器拒绝把它们当值引用,不会与用户变量冲突
      push(KEYWORDS.has(word) ? 'keyword' : 'ident', word);
      continue;
    }
    const three = source.slice(i, i + 3);
    if (three === '===' || three === '!==') { push('punct', three); i += 3; continue; }
    const two = source.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '==' || two === '!=' || two === '<=' || two === '>=') { push('punct', two); i += 2; continue; }
    if ('()[]{},.;:?<>!+-='.includes(ch)) {
      if (ch === '(' || ch === '[') depth += 1;
      if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
      push('punct', ch); i += 1; continue;
    }
    throw new ScriptSyntaxError(`无法识别的字符 "${ch}"`, line);
  }
  push('eof', null);
  return tokens;
}

function parseScript(source) {
  const tokens = lex(String(source ?? ''));
  let pos = 0;
  const peek = offset => tokens[Math.min(pos + (offset ?? 0), tokens.length - 1)];
  const next = () => tokens[pos++];
  const isPunct = (value, offset) => peek(offset).type === 'punct' && peek(offset).value === value;
  const isKeyword = (value, offset) => peek(offset).type === 'keyword' && peek(offset).value === value;
  const expectPunct = value => {
    if (!isPunct(value)) throw new ScriptSyntaxError(` expected "${value}"，got "${peek().value ?? peek().type}"`, peek().line);
    return next();
  };
  const skipSeparators = () => { while (isPunct(';') || peek().type === 'newline') next(); };
  const skipNewlines = () => { while (peek().type === 'newline') next(); };

  function parseProgram() {
    const body = [];
    skipSeparators();
    while (peek().type !== 'eof') { body.push(parseStatement()); skipSeparators(); }
    return { type: 'Program', body };
  }

  function parseBlock() {
    expectPunct('{');
    const body = [];
    skipSeparators();
    while (!isPunct('}') && peek().type !== 'eof') { body.push(parseStatement()); skipSeparators(); }
    if (!isPunct('}')) throw new ScriptSyntaxError('缺少 "}"', peek().line);
    next();
    return body;
  }

  function parseStatement() {
    if (isKeyword('const') || isKeyword('let')) {
      const kind = next().value;
      if (peek().type !== 'ident') throw new ScriptSyntaxError('声明需要变量名', peek().line);
      const id = next().value;
      expectPunct('=');
      const init = parseExpression();
      return { type: 'Decl', kind, id, init, line: tokens[pos - 1].line };
    }
    if (isKeyword('if')) {
      next(); expectPunct('(');
      const test = parseExpression();
      expectPunct(')');
      const cons = parseBlock();
      let alt = null;
      if (isKeyword('else')) {
        next();
        alt = isKeyword('if') ? [parseStatement()] : parseBlock();
      }
      return { type: 'If', test, cons, alt };
    }
    if (isKeyword('for')) {
      next(); expectPunct('(');
      if (isKeyword('const') || isKeyword('let')) next();
      if (peek().type !== 'ident') throw new ScriptSyntaxError('for-of 需要变量名', peek().line);
      const id = next().value;
      if (!isKeyword('of')) throw new ScriptSyntaxError('仅支持 for-of 循环', peek().line);
      next();
      const iter = parseExpression();
      expectPunct(')');
      const body = parseBlock();
      return { type: 'ForOf', id, iter, body };
    }
    if (isKeyword('return')) {
      const line = next().line;
      if (isPunct(';') || peek().type === 'newline' || isPunct('}') || peek().type === 'eof') return { type: 'Return', argument: null, line };
      return { type: 'Return', argument: parseExpression(), line };
    }
    const expr = parseExpression();
    if (isPunct(';')) next();
    else if (peek().type !== 'newline' && !isPunct('}') && peek().type !== 'eof') {
      throw new ScriptSyntaxError('语句需要以换行或分号结束', peek().line);
    }
    return { type: 'ExprStmt', expr };
  }

  function parseExpression() { return parseTernary(); }

  function parseTernary() {
    const test = parseOr();
    if (isPunct('?')) {
      next();
      const cons = parseTernary();
      expectPunct(':');
      const alt = parseTernary();
      return { type: 'Ternary', test, cons, alt };
    }
    return test;
  }

  function parseBinary(operators, nextLevel) {
    let left = nextLevel();
    while (peek().type === 'punct' && operators.includes(peek().value)) {
      const op = next().value;
      const right = nextLevel();
      left = { type: 'Logical', op, left, right };
    }
    return left;
  }
  const parseOr = () => parseBinary(['||'], parseAnd);
  const parseAnd = () => parseBinary(['&&'], parseEquality);
  const parseEquality = () => parseBinary(['===', '!==', '==', '!='], parseRelational);
  const parseRelational = () => parseBinary(['<', '>', '<=', '>='], parseAdditive);
  const parseAdditive = () => parseBinary(['+'], parseUnary);

  function parseUnary() {
    if (isPunct('!') || isKeyword('await')) {
      const op = next();
      const argument = parseUnary();
      return { type: 'Unary', op: op.value, argument };
    }
    return parsePostfix();
  }

  function parsePostfix() {
    let node = parsePrimary();
    for (;;) {
      if (isPunct('.')) {
        next();
        if (peek().type !== 'ident' && peek().type !== 'keyword') throw new ScriptSyntaxError('成员访问需要属性名', peek().line);
        node = { type: 'Member', object: node, property: next().value, computed: false };
      } else if (isPunct('[')) {
        next();
        const property = parseExpression();
        expectPunct(']');
        node = { type: 'Member', object: node, property, computed: true };
      } else if (isPunct('(')) {
        next();
        const args = [];
        skipNewlines();
        while (!isPunct(')')) {
          args.push(parseExpression());
          skipNewlines();
          if (isPunct(',')) { next(); skipNewlines(); }
          else if (!isPunct(')')) throw new ScriptSyntaxError('参数列表需要 "," 或 ")"', peek().line);
        }
        expectPunct(')');
        validateCallee(node);
        node = { type: 'Call', callee: node, args };
      } else break;
    }
    return node;
  }

  function validateCallee(callee) {
    if (callee.type === 'Ident' && BUILTINS.has(callee.name)) return;
    if (callee.type === 'Member' && !callee.computed && callee.object.type === 'Ident' && callee.object.name === 'Promise' && callee.property === 'all') return;
    // 数组方法按名字放行(静态无法判型),求值时校验基对象确实是数组
    if (callee.type === 'Member' && !callee.computed && ARRAY_METHODS.has(callee.property)) return;
    throw new ScriptSyntaxError('只能调用 task(...)、phase(...)、state()、Promise.all(...) 或数组方法', callee.line ?? peek().line);
  }

  function parsePrimary() {
    const token = peek();
    if (token.type === 'number' || token.type === 'string') { next(); return { type: 'Literal', value: token.value }; }
    if (token.type === 'keyword' && (token.value === 'true' || token.value === 'false')) { next(); return { type: 'Literal', value: token.value === 'true' }; }
    if (token.type === 'keyword' && token.value === 'null') { next(); return { type: 'Literal', value: null }; }
    if (token.type === 'ident') { next(); return { type: 'Ident', name: token.value, line: token.line }; }
    if (isPunct('(')) {
      next();
      const expr = parseExpression();
      expectPunct(')');
      return expr;
    }
    if (isPunct('[')) {
      next();
      const elements = [];
      skipNewlines();
      while (!isPunct(']')) {
        elements.push(parseExpression());
        skipNewlines();
        if (isPunct(',')) { next(); skipNewlines(); }
        else if (!isPunct(']')) throw new ScriptSyntaxError('数组需要 "," 或 "]"', peek().line);
      }
      expectPunct(']');
      return { type: 'Array', elements };
    }
    if (isPunct('{')) {
      next();
      const entries = [];
      skipNewlines();
      while (!isPunct('}')) {
        if (peek().type !== 'ident' && peek().type !== 'string') throw new ScriptSyntaxError('对象键需要标识符或字符串', peek().line);
        const key = next().value;
        expectPunct(':');
        skipNewlines();
        entries.push({ key, value: parseExpression() });
        skipNewlines();
        if (isPunct(',')) { next(); skipNewlines(); }
        else if (!isPunct('}')) throw new ScriptSyntaxError('对象需要 "," 或 "}"', peek().line);
      }
      expectPunct('}');
      return { type: 'Object', entries };
    }
    throw new ScriptSyntaxError(`unexpected "${token.value ?? token.type}"`, token.line);
  }

  const program = parseProgram();
  if (peek().type !== 'eof') throw new ScriptSyntaxError('多余的输入', peek().line);
  return program;
}

// 求值器。task 句柄以不透明 Box({__taskHandle}) 贯穿求值——async 函数返回裸
// thenable 会被 await 语义自动"收养"成等待结算,声明处即串行化;Box 是普通对象,
// 只有在「取值」处(条件、运算数、属性/索引基对象、for-of 迭代对象、return 值、
// Promise.all 元素)才经 deref 解引用。数组/对象字面量元素与数组方法参数保持
// Box 原样,以便收集后并发 join 与 dependsOn 传句柄。
const truthy = value => !(value === null || value === false || value === 0 || value === '');
async function deref(value) {
  let current = value;
  for (;;) {
    if (current && typeof current === 'object' && current.__taskHandle) current = await current.__taskHandle;
    else if (current && typeof current === 'object' && typeof current.then === 'function') current = await current;
    else return current;
  }
}

async function evaluate(node, scope, api) {
  switch (node.type) {
    case 'Literal': return node.value;
    case 'Ident': {
      for (let env = scope; env; env = env.parent) if (env.values.has(node.name)) return env.values.get(node.name);
      if (BUILTINS.has(node.name) || node.name === 'Promise') throw new Error(`${node.name} 只能调用，不能作为值引用${node.line ? `（第 ${node.line} 行）` : ''}`);
      throw new Error(`未定义的变量 "${node.name}"${node.line ? `（第 ${node.line} 行）` : ''}`);
    }
    case 'Array': {
      const values = [];
      for (const element of node.elements) values.push(await evaluate(element, scope, api));
      return values;
    }
    case 'Object': {
      const value = {};
      for (const entry of node.entries) value[entry.key] = await evaluate(entry.value, scope, api);
      return value;
    }
    case 'Unary': {
      if (node.op === 'await') return deref(await evaluate(node.argument, scope, api));
      return !truthy(await deref(await evaluate(node.argument, scope, api)));
    }
    case 'Logical': {
      if (node.op !== '&&' && node.op !== '||') return evaluateBinary(node, scope, api);
      const left = await deref(await evaluate(node.left, scope, api));
      if (node.op === '&&') return truthy(left) ? await deref(await evaluate(node.right, scope, api)) : left;
      return truthy(left) ? left : await deref(await evaluate(node.right, scope, api));
    }
    case 'Ternary':
      return truthy(await deref(await evaluate(node.test, scope, api)))
        ? await evaluate(node.cons, scope, api)
        : await evaluate(node.alt, scope, api);
    case 'Member': {
      const base = await deref(await evaluate(node.object, scope, api));
      const key = node.computed ? await deref(await evaluate(node.property, scope, api)) : node.property;
      if (base === null || base === undefined) throw new Error(`对空值读取 "${String(key)}"`);
      if (typeof base !== 'object' && typeof base !== 'string') throw new Error(`只有对象/字符串支持属性访问`);
      return base[key];
    }
    case 'Call': {
      const args = [];
      for (const arg of node.args) args.push(await evaluate(arg, scope, api));
      if (node.callee.type === 'Ident') {
        if (node.callee.name === 'task') {
          if (args.length !== 1 || !args[0] || typeof args[0] !== 'object') throw new Error('task({...}) 需要一个对象参数');
          return { __taskHandle: api.task(args[0]) };
        }
        if (node.callee.name === 'phase') {
          const name = await deref(args[0]);
          if (typeof name !== 'string' || !name.trim()) throw new Error('phase("...") 需要非空名称');
          return api.phase(name);
        }
        return api.state();
      }
      if (node.callee.type === 'Member' && !node.callee.computed
        && node.callee.object.type === 'Ident' && node.callee.object.name === 'Promise' && node.callee.property === 'all') {
        const list = await deref(args[0]);
        if (!Array.isArray(list)) throw new Error('Promise.all 只接受数组');
        return Promise.all(list.map(item => deref(item)));
      }
      // 数组方法:jobs.push(handle) / xs.concat(ys) 等;静态按方法名放行,此处校验类型。
      // 参数不解引用:收集场景需要保持 Box,后续 Promise.all 再 join
      const base = await deref(await evaluate(node.callee.object, scope, api));
      if (!Array.isArray(base) || !ARRAY_METHODS.has(node.callee.property)) {
        throw new Error(`只有数组支持 .${String(node.callee.property)}() 调用`);
      }
      if (node.callee.property === 'push') { for (const item of args) base.push(item); return base.length; }
      return base[node.callee.property](...args);
    }
    default: throw new Error(`无法求值的节点 ${node.type}`);
  }
}

async function evaluateBinary(node, scope, api) {
  const left = await deref(await evaluate(node.left, scope, api));
  const right = await deref(await evaluate(node.right, scope, api));
  switch (node.op) {
    case '+':
      if (typeof left === 'string' || typeof right === 'string') return String(left ?? '') + String(right ?? '');
      if (typeof left === 'number' && typeof right === 'number') return left + right;
      throw new Error('+ 只支持字符串拼接或数字相加');
    case '===': return left === right;
    case '!==': return left !== right;
    case '==': return left == right; // eslint-disable-line eqeqeq
    case '!=': return left != right; // eslint-disable-line eqeqeq
    case '<': case '>': case '<=': case '>=':
      if (typeof left !== typeof right || (typeof left !== 'number' && typeof left !== 'string')) throw new Error('比较运算需要两个数字或两个字符串');
      return node.op === '<' ? left < right : node.op === '>' ? left > right : node.op === '<=' ? left <= right : left >= right;
    default: throw new Error(`不支持的运算符 ${node.op}`);
  }
}

async function evalStatement(node, scope, api) {
  api.tick();
  switch (node.type) {
    case 'Decl': {
      const value = await evaluate(node.init, scope, api);
      if (scope.values.has(node.id)) throw new Error(`重复声明 "${node.id}"`);
      scope.values.set(node.id, value);
      return;
    }
    case 'ExprStmt': await evaluate(node.expr, scope, api); return;
    case 'If':
      if (truthy(await deref(await evaluate(node.test, scope, api)))) await evalBlock(node.cons, scope, api);
      else if (node.alt) await evalBlock(node.alt, scope, api);
      return;
    case 'ForOf': {
      const iterable = await deref(await evaluate(node.iter, scope, api));
      if (!Array.isArray(iterable)) throw new Error('for-of 只能遍历数组');
      if (iterable.length > MAX_LOOP_ITEMS) throw new Error(`单次循环最多 ${MAX_LOOP_ITEMS} 项`);
      for (const item of iterable) {
        api.tick();
        await evalBlock(node.body, { parent: scope, values: new Map([[node.id, await deref(item)]]) }, api);
      }
      return;
    }
    case 'Return': throw new ReturnSignal(await evaluate(node.argument, scope, api));
    default: throw new Error(`无法执行的语句 ${node.type}`);
  }
}

class ReturnSignal { constructor(value) { this.value = value; } }

async function evalBlock(body, scope, api) {
  for (const statement of body) await evalStatement(statement, scope, api);
}

/**
 * 执行脚本。api 契约:
 *  - tick(): 每条语句/每次循环迭代调用一次,驱动器在此抛出步数超限或中断
 *  - task(spec): 同步返回任务句柄(含 taskId 与 then),结算由驱动器异步推进
 *  - phase(name) / state(): 异步原语
 * 返回脚本 return 值(已解引用);语法/运行错误原样抛出。
 */
async function executeScript(program, api) {
  const scope = { parent: null, values: new Map() };
  try {
    await evalBlock(program.body, scope, api);
    return null;
  } catch (signal) {
    if (signal instanceof ReturnSignal) return deref(signal.value);
    throw signal;
  }
}

// 执行前静态门:遍历 AST,统计 task 调用并校验 member 为字符串字面量且能解析、
// 引用的变量在作用域内已声明。resolveMember(label) 在未知成员时抛错(错误信息由
// 调用方组织)。未定义变量在派发前拦截——脚本先声明任务再写错变量时,不至于烧掉
// 前几个任务的 token 才发现。
function validateScript(program, resolveMember, { maxTasks = 16 } = {}) {
  const checkExpr = (node, scope) => {
    if (!node || typeof node !== 'object') return;
    switch (node.type) {
      case 'Literal': return;
      case 'Ident':
        if (BUILTINS.has(node.name) || node.name === 'Promise') throw new ScriptSyntaxError(`${node.name} 只能调用，不能作为值引用`, node.line);
        if (!scope.has(node.name)) throw new ScriptSyntaxError(`未定义的变量 "${node.name}"`, node.line);
        return;
      case 'Array': node.elements.forEach(element => checkExpr(element, scope)); return;
      case 'Object': node.entries.forEach(entry => checkExpr(entry.value, scope)); return;
      case 'Unary': checkExpr(node.argument, scope); return;
      case 'Logical': checkExpr(node.left, scope); checkExpr(node.right, scope); return;
      case 'Ternary': checkExpr(node.test, scope); checkExpr(node.cons, scope); checkExpr(node.alt, scope); return;
      case 'Member':
        checkExpr(node.object, scope);
        if (node.computed) checkExpr(node.property, scope);
        return;
      case 'Call': {
        const callee = node.callee;
        if (callee.type === 'Ident') {
          if (!BUILTINS.has(callee.name)) throw new ScriptSyntaxError(`只能调用 task(...)、phase(...)、state()、Promise.all(...) 或数组方法`, callee.line);
        } else if (callee.type === 'Member') {
          // Promise.all 的基对象是内建命名空间，不按变量检查；数组方法基对象照常检查
          const isPromiseAll = !callee.computed && callee.object.type === 'Ident' && callee.object.name === 'Promise' && callee.property === 'all';
          if (!isPromiseAll) {
            checkExpr(callee.object, scope);
            if (callee.computed) checkExpr(callee.property, scope);
          }
        }
        node.args.forEach(arg => checkExpr(arg, scope));
        return;
      }
      default: throw new ScriptSyntaxError(`无法检查的表达式 ${node.type}`, node.line);
    }
  };
  const checkStmt = (node, scope) => {
    switch (node.type) {
      case 'Decl': checkExpr(node.init, scope); scope.add(node.id); return;
      case 'If': {
        checkExpr(node.test, scope);
        for (const statement of node.cons) checkStmt(statement, scope);
        if (node.alt) for (const statement of node.alt) checkStmt(statement, scope);
        return;
      }
      case 'ForOf': {
        checkExpr(node.iter, scope);
        const inner = new Set(scope);
        inner.add(node.id);
        for (const statement of node.body) checkStmt(statement, inner);
        return;
      }
      case 'Return': if (node.argument) checkExpr(node.argument, scope); return;
      case 'ExprStmt': checkExpr(node.expr, scope); return;
      default: throw new ScriptSyntaxError(`无法检查的语句 ${node.type}`, node.line);
    }
  };
  const root = new Set();
  for (const statement of program.body) checkStmt(statement, root);

  let taskCount = 0, nodeCount = 0;
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    nodeCount += 1;
    if (nodeCount > 3000) throw new Error('编排脚本过大(超过 3000 个语法节点)');
    if (node.type === 'Call' && node.callee?.type === 'Ident' && node.callee.name === 'task') {
      taskCount += 1;
      if (taskCount > maxTasks) throw new Error(`编排脚本最多声明 ${maxTasks} 个 task(...)`);
      const spec = node.args[0];
      if (!spec || spec.type !== 'Object') throw new Error('task(...) 的参数必须是对象字面量，且 member 为字符串字面量');
      const memberEntry = spec.entries.find(entry => entry.key === 'member');
      if (!memberEntry || memberEntry.value.type !== 'Literal' || typeof memberEntry.value.value !== 'string') {
        throw new Error('task(...) 的 member 必须是字符串字面量(不支持动态成员)');
      }
      resolveMember(memberEntry.value.value);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'callee') continue;
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object' && typeof value.type === 'string') walk(value);
    }
  };
  walk(program);
  return { taskCount };
}

/** 已结算任务句柄:thenable,立即解析为快照(供重放路径使用) */
function settledTaskHandle(summary) {
  const snapshot = { ...summary };
  return { ...snapshot, then(onFulfilled, onRejected) { return Promise.resolve(snapshot).then(onFulfilled, onRejected); } };
}

module.exports = { parseScript, validateScript, executeScript, settledTaskHandle, ScriptSyntaxError, ScriptInterrupted };
