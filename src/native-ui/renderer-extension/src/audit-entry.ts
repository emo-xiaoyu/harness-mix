import { inspectRendererContracts } from "./contract-audit.js";

window.__harnessmixContractAuditV1 = Object.freeze({
  inspect: () => inspectRendererContracts(window),
});
