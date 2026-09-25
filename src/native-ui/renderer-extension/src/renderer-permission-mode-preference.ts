/**
 * Remembers the user's Claude Code permission-mode choice in localStorage so
 * new threads can preselect it. Persistence failures are swallowed — a broken
 * storage must never block the native mode selection itself.
 */
import {
  harnessPermissionModeIdSchema,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
} from "@harnessmix/shared-contracts";

export const CLAUDE_PERMISSION_MODE_PREFERENCE_KEY = "harnessmix.claude-code.permission-mode.v1";

export interface PermissionModePreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function rendererStorage(): PermissionModePreferenceStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readClaudePermissionModePreference(
  catalog: HarnessPermissionModeCatalog,
  storage: PermissionModePreferenceStorage | null = rendererStorage(),
): HarnessPermissionModeId | undefined {
  if (!storage) return undefined;
  try {
    const parsed = harnessPermissionModeIdSchema.safeParse(
      storage.getItem(CLAUDE_PERMISSION_MODE_PREFERENCE_KEY),
    );
    return parsed.success && catalog.modes.some(({ id }) => id === parsed.data)
      ? parsed.data
      : undefined;
  } catch {
    return undefined;
  }
}

export function writeClaudePermissionModePreference(
  permissionModeId: HarnessPermissionModeId,
  storage: PermissionModePreferenceStorage | null = rendererStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(CLAUDE_PERMISSION_MODE_PREFERENCE_KEY, permissionModeId);
  } catch {
    // Preference persistence must not prevent native mode selection.
  }
}
