/** Compatibility entrypoint for the live renderer binding: a single settings
 * registry shared by the injected UI and the tests. */
export { installRendererSettingsLifecycle } from "./renderer-settings-lifecycle.js";
export type {
  RendererSettingsLifecycleControl,
  RendererSettingsLifecycleOptions,
} from "./renderer-settings-lifecycle.js";
