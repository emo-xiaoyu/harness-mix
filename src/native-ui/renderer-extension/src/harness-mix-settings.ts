// Compatibility entrypoint for the live Harness Mix renderer binding.
// Keeping this as a re-export prevents the injected UI and tests from drifting
// into separate settings page registries.
export {
  installRendererSettingsLifecycle,
} from './renderer-settings-lifecycle.js';
export type {
  RendererSettingsLifecycleControl,
  RendererSettingsLifecycleOptions,
} from './renderer-settings-lifecycle.js';
