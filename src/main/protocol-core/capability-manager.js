const { createCapabilities, validateCapabilities } = require('../shared-contracts');

class CapabilityManager {
  constructor() { this.adapters = new Map(); }
  register(id, capabilities) {
    const errors = validateCapabilities(capabilities);
    if (errors.length) throw new Error(errors.join('; '));
    this.adapters.set(id, createCapabilities(capabilities));
  }
  get(id) { return structuredClone(this.adapters.get(id) ?? createCapabilities()); }
  require(id, group, name) {
    if (this.get(id)[group]?.[name] !== true) throw new Error(`原生接口不支持 ${group}.${name}`);
  }
}

module.exports = { CapabilityManager };
