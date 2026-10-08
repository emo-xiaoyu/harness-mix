/** Small, theme-aware team glyphs shared by the mention menu and chips. */
import type { IconNode } from 'lucide';
import createElement from 'lucide/dist/esm/createElement.mjs';
import Bug from 'lucide/dist/esm/icons/bug.mjs';
import Blocks from 'lucide/dist/esm/icons/blocks.mjs';
import FileCheck from 'lucide/dist/esm/icons/file-check.mjs';
import Workflow from 'lucide/dist/esm/icons/workflow.mjs';
import ShieldCheck from 'lucide/dist/esm/icons/shield-check.mjs';
import ScanSearch from 'lucide/dist/esm/icons/scan-search.mjs';
import UsersRound from 'lucide/dist/esm/icons/users-round.mjs';

const TEAM_ICONS: Readonly<Record<string, IconNode>> = {
  'builtin-bug-review': Bug,
  'builtin-feature-squad': Blocks,
  'builtin-code-review': FileCheck,
  'builtin-refactor': Workflow,
  'builtin-test-hardening': ShieldCheck,
  'builtin-research': ScanSearch,
};

export function collaborationTeamIcon(id: string, size = 18): HTMLElement {
  const root = document.createElement('span');
  root.setAttribute('data-harness-mix-team-icon', id);
  root.setAttribute('aria-hidden', 'true');
  root.style.cssText = `display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;flex:none;color:inherit;`;
  const svg = createElement(TEAM_ICONS[id] ?? UsersRound, {
    width: size, height: size, 'stroke-width': 1.75,
    'aria-hidden': 'true', focusable: 'false',
  });
  svg.style.display = 'block';
  root.append(svg);
  return root;
}
