const { randomUUID } = require('node:crypto');

// One UI question at a time; keep the native request pending until all answers
// are validated and (for CodeBuddy) the native interruption has been resolved.
class AcpInteractions {
  constructor(session, vendor) { this.session = session; this.vendor = vendor; this.pending = new Map(); this.generation = 0; }
  ask(view, validate, finish, cancelValue) {
    const requestId = randomUUID();
    return new Promise(resolve => {
      this.pending.set(requestId, { validate, finish, cancelValue, resolve, busy: false });
      this.session.emit({ kind: 'approval', requestId, ...view });
    });
  }
  async respond(id, response) {
    const p = this.pending.get(id);
    if (!p || p.busy) throw new Error('Native interaction is not awaiting a response');
    p.busy = true;
    try {
      const value = response.cancelled ? p.cancelValue : p.validate(response);
      const result = p.finish ? await p.finish(value) : value;
      if (!this.pending.has(id)) throw new Error('Native interaction was cancelled');
      this.pending.delete(id);
      p.resolve(result);
    } finally { p.busy = false; }
  }
  close() {
    this.generation++;
    for (const [requestId, p] of this.pending) {
      p.resolve(p.cancelValue);
      this.session.emit({ kind: 'interaction-responded', requestId });
    }
    this.pending.clear();
  }
  async questions(questions, title, onComplete) {
    if (!Array.isArray(questions) || !questions.length || questions.length > 20) throw new Error('Invalid native questions');
    const answers = {};
    for (const q of questions) {
      if (!q.id || !q.prompt || Object.hasOwn(answers, q.id)) throw new Error('Invalid native question identity');
      const values = (q.options || []).map(o => o.id);
      if (new Set(values).size !== values.length || values.some(v => typeof v !== 'string' || !v)) throw new Error('Invalid native choices');
      const selected = await this.ask({
        title, message: q.prompt, method: q.multiple || !values.length ? 'input' : 'select',
        ...(!q.multiple ? { options: q.options } : {}),
        placeholder: q.multiple ? `输入 JSON 数组选择多项：${JSON.stringify(values)}` : '请输入回答',
        ...(q.multiple ? { message: q.prompt + '\n' + q.options.map(o => `${o.id}: ${o.label}`).join('\n') } : {}),
      }, response => {
        const raw = response.optionId ?? response.value;
        const list = q.multiple ? (Array.isArray(raw) ? raw : JSON.parse(raw)) : [raw];
        if (!Array.isArray(list) || !list.length || list.some(v => typeof v !== 'string' || !v.trim()) || new Set(list).size !== list.length) throw new Error('A native answer is required');
        if (values.length && !q.other && list.some(v => !values.includes(v))) throw new Error('Select an option offered by the native agent');
        return list;
      }, onComplete && q === questions.at(-1) ? async list => {
        if (list) await onComplete({ ...answers, [q.id]: list });
        return list;
      } : null, null);
      if (!selected || !this.session.active) return null;
      answers[q.id] = selected;
    }
    return answers;
  }
  permission(params) {
    const tool = params.toolCall || {};
    if (this.vendor === 'codebuddy' && tool._meta?.['codebuddy.ai/toolName'] === 'AskUserQuestion') {
      return this.codeBuddyQuestion(tool.rawInput, async answers => {
        const result = await this.session.request('_codebuddy.ai/resolveInterruption', {
          sessionId: this.session.nativeSessionId, toolCallId: tool.toolCallId,
          decision: answers ? 'allow' : 'deny', ...(answers ? { answers } : {}),
        });
        if (result.resolved !== true) throw new Error('CodeBuddy did not resolve the question');
        return { outcome: { outcome: 'cancelled' } };
      });
    }
    const nativeOptions = (params.options || []).filter(o => ['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(o.kind));
    const options = [];
    for (const o of nativeOptions) {
      const consent = this.vendor === 'kiro-cli' ? params._meta?.kiro?.consent : null;
      if (this.vendor === 'kiro-cli' && o.kind === 'allow_always') {
        const resource = consent?.triggeringResource ?? consent?.resource;
        if (!consent?.capability || typeof resource !== 'string' || consent.persistableConsent === false || consent.askType === 'explicit') continue;
        for (const scope of ['session', ...(consent.workspaceRoot ? ['workspace'] : [])]) options.push({ ...o,
          optionId: JSON.stringify([o.optionId, scope]), name: `${o.name || '允许'} (${scope === 'session' ? '本会话' : '工作区'}) · ${resource}`,
          response: { outcome: { outcome: 'selected', optionId: o.optionId }, _meta: { kiro: { consent: {
            capability: consent.capability, scope, resource, ...(consent.workspaceRoot ? { workspaceRoot: consent.workspaceRoot } : {}),
          } } } },
        });
      } else options.push(o);
    }
    if (!options.length) throw new Error('Native agent supplied no usable approval choices');
    return this.ask({ method: 'select', title: tool.title || 'Native tool approval', message: JSON.stringify(tool.rawInput ?? {}).slice(0, 16000),
      options: options.map(o => ({ id: o.optionId, label: o.name || o.optionId, kind: o.kind.startsWith('reject') ? 'reject' : undefined })),
    }, response => {
      const selected = response.optionId ?? response.value;
      const option = options.find(o => o.optionId === selected);
      if (!option) throw new Error('Choose an exact native approval option');
      return option.response || { outcome: { outcome: 'selected', optionId: option.optionId } };
    }, null, { outcome: { outcome: 'cancelled' } });
  }
  async codeBuddyQuestion(schema, finish) {
    const generation = this.generation;
    const questions = (schema?.questions || []).map((q, i) => ({ id: q.id || `q_${i}`, prompt: q.question,
      options: (q.options || []).map(o => ({ id: o.label, label: o.label })), multiple: q.multiSelect === true, other: true }));
    let result;
    const answers = await this.questions(questions, 'CodeBuddy', async answers => { result = await finish(answers); });
    if (!answers) return this.session.active && generation === this.generation ? finish(null) : { outcome: { outcome: 'cancelled' } };
    return result;
  }
  async request(method, params) {
    if (!this.session.active) throw new Error('Native interaction outside active turn');
    if (params.sessionId && params.sessionId !== this.session.nativeSessionId) throw new Error('Native interaction session mismatch');
    if (method === 'session/request_permission') return this.permission(params);
    if (this.vendor === 'codebuddy' && method === '_codebuddy.ai/question') return this.codeBuddyQuestion(params.schema, answers => answers ? { outcome: 'submitted', answers } : { outcome: 'cancelled' });
    if (this.vendor === 'kiro-cli' && method === '_kiro/userInput') {
      const answers = await this.questions([{ id: 'q', prompt: params.question, options: params.options?.map(o => ({ id: o.title, label: o.title })) }], 'Kiro');
      return answers ? { action: 'answered', answer: answers.q[0] } : { action: 'dismissed' };
    }
    if (this.vendor === 'cursor-cli' && method === 'cursor/ask_question') {
      const answers = await this.questions((params.questions || []).map(q => ({ id: q.id, prompt: q.prompt, options: q.options, multiple: q.allowMultiple === true })), params.title || 'Cursor');
      return { outcome: answers ? { outcome: 'answered', answers: Object.entries(answers).map(([questionId, selectedOptionIds]) => ({ questionId, selectedOptionIds })) } : { outcome: 'cancelled' } };
    }
    if (this.vendor === 'cursor-cli' && method === 'cursor/create_plan' && typeof params.plan === 'string') {
      return this.ask({ method: 'select', title: params.name || 'Cursor plan', message: params.plan,
        options: [{ id: 'accept', label: '接受计划' }, { id: 'reject', label: '拒绝计划', kind: 'reject' }],
      }, response => {
        const selected = response.optionId ?? response.value;
        if (!['accept', 'reject'].includes(selected)) throw new Error('Choose accept or reject');
        return { outcome: { outcome: selected === 'accept' ? 'accepted' : 'rejected' } };
      }, null, { outcome: { outcome: 'cancelled' } });
    }
    throw new Error(`Unsupported native ACP client request: ${method}`);
  }
}
module.exports = { AcpInteractions };
