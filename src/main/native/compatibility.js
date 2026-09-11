const fs = require('node:fs');
const path = require('node:path');

const MANIFEST_PATH = path.resolve(__dirname, '../../../config/codex-desktop-compatibility.json');
const VERSION_PATTERN = /^\d+(?:\.\d+){3}$/;
const EVIDENCE_LEVELS = new Set(['protocol-fixture', 'protocol-and-smoke', 'desktop-e2e']);

function loadCompatibilityManifest(file = MANIFEST_PATH) {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest?.schemaVersion !== 1) throw new Error('Unsupported Codex Desktop compatibility manifest');
  if (!manifest.contractVersions || typeof manifest.contractVersions !== 'object') {
    throw new Error('Compatibility contract versions are missing');
  }
  if (!Array.isArray(manifest.blockedDesktopVersions) ||
      manifest.blockedDesktopVersions.some(version => !VERSION_PATTERN.test(version))) {
    throw new Error('Compatibility blocked version list is invalid');
  }
  if (!Array.isArray(manifest.evidence) || manifest.evidence.some(item =>
    !VERSION_PATTERN.test(item?.desktopVersion) || !EVIDENCE_LEVELS.has(item?.level) ||
    typeof item?.checkedAt !== 'string' || typeof item?.notes !== 'string')) {
    throw new Error('Compatibility evidence is invalid');
  }
  return manifest;
}

function evaluateDesktopCompatibility(desktopVersion, manifest = loadCompatibilityManifest()) {
  if (!VERSION_PATTERN.test(desktopVersion)) throw new Error('Invalid Codex Desktop version');
  if (manifest.blockedDesktopVersions.includes(desktopVersion)) {
    return { state: 'blocked', desktopVersion, evidence: null };
  }
  const matches = manifest.evidence.filter(item => item.desktopVersion === desktopVersion);
  const evidence = matches.find(item => item.level === 'desktop-e2e') || matches.at(-1) || null;
  return {
    state: evidence?.level === 'desktop-e2e' ? 'verified' : evidence ? 'observed' : 'unverified',
    desktopVersion,
    evidence,
  };
}

function enforceDesktopCompatibility(result, environment = process.env) {
  if (result.state === 'blocked') {
    throw new Error(`Codex Desktop ${result.desktopVersion} is explicitly blocked by the compatibility manifest`);
  }
  if (environment.HARNESS_MIX_STRICT_COMPATIBILITY === '1' && result.state !== 'verified') {
    throw new Error(`Codex Desktop ${result.desktopVersion} has not passed full Desktop E2E acceptance`);
  }
  return result;
}

module.exports = {
  MANIFEST_PATH,
  loadCompatibilityManifest,
  evaluateDesktopCompatibility,
  enforceDesktopCompatibility,
};
