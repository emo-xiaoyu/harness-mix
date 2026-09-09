import { resolveRendererSettingsLocale } from './settings/localization.js';
import type { RendererSettingsLifecycleOptions, RendererSettingsLifecycleControl } from './renderer-settings-lifecycle.js';

// Keep native Codex settings. Upstream account storage, self-update and session
// import are not owned by Harness Mix and must not be exposed as working actions.
export function installRendererSettingsLifecycle(ownerWindow: Window, _options: RendererSettingsLifecycleOptions): RendererSettingsLifecycleControl {
  return { locale: resolveRendererSettingsLocale(ownerWindow.navigator.languages), refresh: () => false, dispose() {} };
}
