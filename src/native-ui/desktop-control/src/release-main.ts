/**
 * Bundled entrypoint (`desktop-controller.mjs`): parse launcher arguments,
 * run until SIGINT/SIGTERM, exit non-zero on failure.
 */
import { parseDesktopControllerArguments, runDesktopController } from "./production-controller.js";

// The launcher does not stay alive; when its (inherited or piped) stdio goes
// away, any later console write must degrade to a no-op instead of raising an
// unhandled EPIPE that kills the controller — recovery logging is exactly the
// kind of write that arrives after the parent is gone.
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.("error", () => undefined);
}

const abort = new AbortController();
const stop = (): void => abort.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  await runDesktopController(parseDesktopControllerArguments(process.argv.slice(2)), abort.signal);
} catch (error) {
  console.error(
    `harnessmix Desktop Controller: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
