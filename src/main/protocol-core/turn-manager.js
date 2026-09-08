const { createTurn, validateTurn, canTransition, TERMINAL_TURN_STATUS } = require('../shared-contracts');

// TurnManager：唯一允许修改 Turn 生命周期状态的模块（§8）。
// Renderer / Transcript / Adapter 都不得自行推进或推断 Turn 状态。
class TurnManager {
  constructor() {
    this.turns = new Map(); // turnId -> Turn
  }

  create({ id, threadId, nativeTurnRef } = {}, now = Date.now()) {
    const turn = createTurn({ id, threadId, nativeTurnRef }, now);
    const errors = validateTurn(turn);
    if (errors.length) throw new Error(`invalid turn: ${errors.join('; ')}`);
    this.turns.set(turn.id, turn);
    return turn;
  }

  get(turnId) {
    return this.turns.get(turnId) ?? null;
  }

  start(turnId, now = Date.now()) { return this.#transition(turnId, 'running', { startedAt: now }, now); }
  wait(turnId, now = Date.now()) { return this.#transition(turnId, 'waiting_interaction', {}, now); }
  resume(turnId, now = Date.now()) { return this.#transition(turnId, 'running', {}, now); }

  complete(turnId, info = {}, now = Date.now()) {
    return this.#transition(turnId, 'completed', { completedAt: now, ...info }, now);
  }

  cancel(turnId, info = {}, now = Date.now()) {
    return this.#transition(turnId, 'cancelled', { completedAt: now, ...info }, now);
  }

  fail(turnId, error, info = {}, now = Date.now()) {
    return this.#transition(turnId, 'error', { completedAt: now, error: String(error ?? 'unknown error'), ...info }, now);
  }

  #transition(turnId, to, extra = {}, now = Date.now()) {
    const turn = this.turns.get(turnId);
    if (!turn) throw new Error(`turn ${turnId} does not exist`);
    if (turn.status === to) return turn; // 幂等：重复完成/取消不报错
    // start() 允许从 created 经 starting 直接进入 running
    const from = turn.status === 'created' && to === 'running' ? 'starting' : turn.status;
    if (!canTransition(from, to)) {
      const terminal = TERMINAL_TURN_STATUS.includes(turn.status) ? ' (terminal status)' : '';
      throw new Error(`illegal turn transition: ${turn.status} → ${to}${terminal}`);
    }
    turn.status = to;
    turn.updatedAt = now;
    Object.assign(turn, extra);
    return turn;
  }

  turnsForThread(threadId) {
    return [...this.turns.values()].filter((t) => t.threadId === threadId);
  }

  clear() {
    this.turns.clear();
  }
}

module.exports = { TurnManager };
