/** Audit bundle entrypoint: expose the read-only contract audit entry used by
 * the Desktop contract inspector. */
import { inspectRendererContracts } from "./contract-audit.js";

window.__harnessmixContractAuditV1 = Object.freeze({
  inspect: () => inspectRendererContracts(window),
});
