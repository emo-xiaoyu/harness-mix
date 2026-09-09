// AppX activation does not inherit arbitrary launcher environment variables.
// Reapply project defaults in the actual app-server process, before loading Host.
const { nativeEnvironment } = require('../src/main/native/config');
Object.assign(process.env, nativeEnvironment());
require('../src/main/native/host').runNativeHost().catch(error => {
  console.error('[Harness Mix native host]', error.message);
  process.exitCode = 1;
});
