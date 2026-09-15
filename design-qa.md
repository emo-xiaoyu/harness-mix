# Skin visual and readability QA

- Source visual truth: `C:\Users\laofeng\AppData\Local\Temp\codex-clipboard-cecde24c-cc35-4fb5-8a06-f4d21f604567.png`
- Implementation screenshot: `E:\harness-mix\output\native-ui-smoke\skin-miku-full.png`
- Combined comparison: `C:\Users\laofeng\.codex\visualizations\2026\09\15\01a0a50c-06cc-7a50-8f95-647f7a7b9dc5\miku-reference-vs-harness-mix.png`
- Readability source: `C:\Users\laofeng\AppData\Local\Temp\codex-clipboard-23ec311a-e932-4318-a966-e70c980509ae.png`
- Readability implementation: `E:\harness-mix\output\native-ui-smoke\skin-conversation-readable.png`
- Readability comparison: `C:\Users\laofeng\.codex\visualizations\2026\09\15\01a0a50c-06cc-7a50-8f95-647f7a7b9dc5\skin-readability-before-after.png`
- Dark-theme issue sources: `C:\Users\laofeng\AppData\Local\Temp\codex-clipboard-ad951004-e4af-44c1-9879-15b93f4c8b95.png`, `C:\Users\laofeng\AppData\Local\Temp\codex-clipboard-0c5743c1-7578-41cf-a69a-49d53111cf56.png`
- Dark-theme implementation fixture: `E:\harness-mix\output\native-ui-smoke\skin-dark-all-surfaces.png`
- Dark-theme live Codex evidence: `C:\Users\laofeng\.codex\visualizations\2026\09\15\01a0a50c-06cc-7a50-8f95-647f7a7b9dc5\dark-skin-all-surfaces-live.png`
- Light-to-dark live switch evidence: `C:\Users\laofeng\.codex\visualizations\2026\09\15\01a0a50c-06cc-7a50-8f95-647f7a7b9dc5\light-to-dark-switch-live.png`
- Viewport: 1055 x 616 CSS pixels
- Source pixels: 1055 x 616
- Implementation pixels: 1055 x 616
- Density normalization: both compared at 1:1 pixel dimensions; Electron capture used device scale factor 1
- State: light Miku theme on the new-task surface, sidebar visible, suggestion cards and composer visible

## Full-view comparison evidence

The combined comparison shows the same supplied Miku hero filling the main work area, a pale translucent sidebar, readable translucent suggestion cards and composer, the supplied Miku logo in the sidebar header, and the supplied polaroid decoration at the lower right. Harness Mix intentionally retains the current Windows Codex layout and its Settings -> Skins entry instead of cloning HeiGe's separate top-center theme launcher.

## Focused-region comparison evidence

A separate crop was not required. At 1055 x 616, the full-view comparison keeps the logo, main-surface transparency, card treatment, composer treatment, and polaroid large enough to judge without ambiguity.

## Required fidelity surfaces

- Fonts and typography: native Codex typography remains owned by Codex; the theme does not replace application fonts. Foreground colors are mapped to the theme palette and remain legible over the automatic veils.
- Spacing and layout rhythm: native Codex layout remains unchanged. Theme decoration is responsive; the polaroid scales with viewport width and disappears below 760 px to avoid covering controls.
- Colors and visual tokens: Miku surface, secondary, accent, and text colors are applied to Codex and Harness Mix tokens. Main, sidebar, cards, messages, active task, and composer surfaces use bounded transparency.
- Image quality and asset fidelity: the original bundled `hero.webp`, `logo.webp`, and `polaroid.webp` are used directly. No placeholder, CSS drawing, or generated substitute is present.
- Copy and content: native Codex and Harness Mix copy is preserved. The theme changes appearance only.

## Comparison history

### Iteration 1

- P1: the main workspace remained opaque white, exposing the hero only through the sidebar.
- P2: Miku's supplied logo and polaroid assets were bundled but not rendered.
- Fixes: moved the layered hero to `#root`, added stable Codex main-surface selectors, made conversation/composer/card surfaces translucent, and wired the two Miku decoration assets.

### Iteration 2

- P2: the first Electron fixture retained outer padding and dark generic button styling, which made the comparison misleading and allowed the polaroid to crowd the rightmost card.
- Fixes: normalized the fixture to the exact viewport, exercised Codex token classes on cards, removed inherited outer padding, and reduced the responsive decoration width.
- Post-fix evidence: `skin-miku-full.png` and the combined comparison show the complete background with readable native surfaces and both decorations.

### Iteration 3

- P1: conversation text was rendered directly over high-contrast artwork, so dark text crossed dark areas and became difficult to read.
- Fixes: conversation content now receives a 90% theme-surface reading card, bounded border, padding, and shadow. Nested assistant wrappers avoid double cards, and reduced-transparency mode makes the card fully opaque.
- Post-fix evidence: `skin-readability-before-after.png` shows the formerly low-contrast Dragon Ball conversation beside the corrected reading-card treatment at the same 1020 x 716 dimensions.

### Iteration 4

- P1: the current Codex Desktop release introduced a broader semantic token set. Dark skins changed the artwork and legacy foregrounds, while the title bar, sidebar labels, tool/status content, review card, file rows, composer, menus, editor and workbench surfaces continued to resolve through official light-theme tokens. This produced both dark text over dark artwork and light text over opaque white cards.
- Fixes: mapped the current `--color-*`, `--app-color-*`, `--wb-*`, and relevant `--vscode-*` neutral foreground, surface, border and interaction tokens to each skin palette. Success, warning, danger and info colors remain semantic; no blanket descendant color rule was added.
- Interaction safety: the production DOM retained 276 buttons and 8 input/editable controls before and after the live token patch. No node, event handler, hit target, focus behavior, model route, Harness route or permission path was changed.
- Post-fix evidence: `dark-skin-all-surfaces-live.png` shows the real running Codex Desktop with readable title bar, sidebar, conversation, review card, file rows, status values and composer. The review surface resolves to dark theme color at 48% alpha and the composer to the same family at 82.8% alpha, both with `rgb(240, 230, 200)` foreground.

### Iteration 5

- P1: switching skins in the already-running pre-build Renderer replaced the primary skin style node and removed the earlier one-theme live patch. The selected background changed, but `--color-text-primary` reverted to official light-theme `#1a1c1f` and elevated surfaces reverted to white.
- Fixes: the production stylesheet already emits the complete foreground and surface mapping on every `applyRendererSkin()` call. The Electron smoke now explicitly applies a light skin and then a dark skin in the same DOM, asserting the active skin, changed surface color, preserved control counts and non-white dark review/composer surfaces.
- Live-session recovery: installed a separate palette-token style node for every bundled non-native skin, then exercised the actual Settings skin action from Miku to Gilded Grandeur. Because this node is separate from the replaceable hero stylesheet, subsequent skin changes in the current pre-restart session keep the contrast mapping.
- Post-fix evidence: `light-to-dark-switch-live.png` shows the real running Codex Desktop after the light-to-dark action with readable chrome, navigation, message, status and composer text. The DOM retained 276 buttons and 8 input/editable controls.

## Validation

- Target interaction: Settings -> Skins -> switch from Nocturne to Miku -> `data-harness-mix-skin="miku-488137"` and the generated skin stylesheet are active.
- Renderer behavior: Electron smoke passed with hero, logo, and polaroid computed as bundled WebP backgrounds.
- Framework/error overlay: none present in the captured implementation.
- Console/runtime health: no renderer exception escaped the Electron smoke flow.
- Automated checks: 67 Native UI test files / 591 tests passed; native UI typecheck passed; core suite passed; native build passed.

## Residual limits

- A restarted production Codex Desktop was not used because doing so would terminate the active Codex session. The Electron renderer fixture verifies the CSS and asset composition, but a separate reopened-window pass is still required for final production-version selector compatibility.
- Exact card placement and application chrome differ between the reference macOS build and the current Windows Codex build by design.

final result: passed
