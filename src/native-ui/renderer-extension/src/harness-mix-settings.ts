import {
  rendererSettingsMessages,
  resolveRendererSettingsLocale,
  type RendererSettingsLocale,
} from './settings/localization.js';
import {
  createConnectionsSettingsPage,
} from './settings/connections-page.js';
import { aboutPage } from './settings/pages.js';
import { installRendererSettingsShell, type RendererSettingsShell } from './settings/shell.js';
import {
  installRendererSettingsHeaderTrigger,
  type RendererSettingsHeaderTriggerControl,
} from './settings/trigger.js';
import type {
  RendererSettingsLifecycleOptions,
  RendererSettingsLifecycleControl,
} from './renderer-settings-lifecycle.js';

export function installRendererSettingsLifecycle(
  ownerWindow: Window,
  options: RendererSettingsLifecycleOptions = {},
): RendererSettingsLifecycleControl {
  let locale: RendererSettingsLocale = resolveRendererSettingsLocale(ownerWindow.navigator.languages);
  let shell: RendererSettingsShell | null = null;
  let trigger: RendererSettingsHeaderTriggerControl | null = null;
  let disposed = false;

  const mount = () => {
    const messages = rendererSettingsMessages(locale);
    const pages = [
      createConnectionsSettingsPage(messages, options.getConnectionDiagnostics ?? (() => null)),
      aboutPage(messages),
    ];
    const nextShell = installRendererSettingsShell(pages, messages, ownerWindow.document);
    const nextTrigger = installRendererSettingsHeaderTrigger({
      available: nextShell.supported,
      messages,
      ownerDocument: ownerWindow.document,
      onOpen(opener, pageId) {
        if (disposed) return;
        const currentOpener = opener?.isConnected
          ? opener
          : (nextTrigger.root?.querySelector<HTMLButtonElement>('button') ?? undefined);
        nextShell.openSettings(currentOpener, pageId ?? 'connections');
      },
    });
    shell = nextShell;
    trigger = nextTrigger;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key === ',') {
      event.preventDefault();
      shell?.openSettings(undefined, 'connections');
    }
  };

  mount();
  ownerWindow.addEventListener('keydown', onKeyDown);

  return {
    get locale() {
      return locale;
    },
    refresh() {
      if (disposed) return false;
      return trigger?.refresh() ?? false;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ownerWindow.removeEventListener('keydown', onKeyDown);
      trigger?.dispose();
      shell?.dispose();
      trigger = null;
      shell = null;
    },
  };
}
