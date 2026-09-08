// Event Router：CoreEvent 入口。顺序校验（去重/回退警告）→ Projector → 订阅者。
class EventRouter {
  constructor({ projector, validator }) {
    this.projector = projector;
    this.validator = validator;
    this.listeners = new Set();
    this.warnings = [];
  }

  /**
   * @returns {{ accepted: boolean, ignored: boolean, warnings: string[], projected: object }}
   */
  route(event) {
    const verdict = this.validator.check(event);
    if (verdict.warnings.length) this.warnings.push(...verdict.warnings);
    if (verdict.action === 'ignore') return { accepted: false, ignored: true, warnings: verdict.warnings, projected: {} };
    const projected = this.projector.apply(event);
    for (const listener of this.listeners) listener({ type: 'core/event', event, projected });
    return { accepted: true, ignored: false, warnings: verdict.warnings, projected };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear() {
    this.warnings = [];
  }
}

module.exports = { EventRouter };
