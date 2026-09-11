const assert = require('node:assert/strict');
const {
  loadCompatibilityManifest,
  evaluateDesktopCompatibility,
  enforceDesktopCompatibility,
} = require('../src/main/native/compatibility');

const manifest = loadCompatibilityManifest();
assert.deepEqual(manifest.contractVersions, {
  rendererBinding: 1,
  controllerReadiness: 2,
  protocolFixture: 1,
});

const observed = evaluateDesktopCompatibility('26.901.2854.0', manifest);
assert.equal(observed.state, 'observed');
assert.equal(observed.evidence.level, 'protocol-and-smoke');
assert.doesNotThrow(() => enforceDesktopCompatibility(observed, {}));
assert.throws(
  () => enforceDesktopCompatibility(observed, { HARNESS_MIX_STRICT_COMPATIBILITY: '1' }),
  /full Desktop E2E/,
);

const verifiedManifest = {
  ...manifest,
  evidence: [...manifest.evidence, {
    desktopVersion: '26.999.1.0',
    level: 'desktop-e2e',
    checkedAt: '2026-09-11',
    notes: 'Synthetic verified version for policy testing.',
  }],
};
assert.equal(evaluateDesktopCompatibility('26.999.1.0', verifiedManifest).state, 'verified');
assert.equal(evaluateDesktopCompatibility('26.999.2.0', manifest).state, 'unverified');
assert.throws(() => evaluateDesktopCompatibility('latest', manifest), /Invalid/);

const blockedManifest = { ...manifest, blockedDesktopVersions: ['26.999.3.0'] };
const blocked = evaluateDesktopCompatibility('26.999.3.0', blockedManifest);
assert.equal(blocked.state, 'blocked');
assert.throws(() => enforceDesktopCompatibility(blocked, {}), /explicitly blocked/);

console.log('PASS: Codex Desktop compatibility evidence, strict mode and explicit block policy');
