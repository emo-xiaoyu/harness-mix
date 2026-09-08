# Harness Mix 首页设计 QA

- Source visual truth: `E:\每日汇总\Codex 图像 2026年9月8日 16_30_29.png`
- Implementation screenshot: `E:\harness-mix\output\playwright\home-reference.png`
- Header/tab screenshot: `E:\harness-mix\output\playwright\transcript.png`
- Side-by-side evidence: `E:\harness-mix\output\playwright\home-comparison-final.png`
- Viewport: implementation 1280 × 960 CSS px, device scale factor 1
- Source pixels: 1450 × 1087; normalized to 1280 × 960 for comparison
- Implementation pixels: 1280 × 960
- State: empty home with Codex selected; the second capture exercises a real open task tab

## Full-view comparison

The implementation matches the selected direction: warm ivory desktop shell, dark primary new-chat action, named Harness pills, copper headline accent, low-contrast landscape hero, four capability cards, compact tagline, and a wide bottom composer. The source includes saved projects and open tabs while the deterministic implementation capture uses an empty project state; those are data-state differences and the existing project/tab components retain their behavior.

## Focused region comparison

- Brand/header region: the former split-circle placeholder was replaced by the dedicated black sculptural-H app asset. The name stays on one line at the target width. Open task tabs now use a conversation symbol, Fork tabs use a branch symbol, and the active tab joins the content edge with the same raised white shape as the source. A many-tab pressure state confirms that only the tab strip scrolls; command, share and window controls retain their width and never wrap vertically.
- Harness region: Claude, Codex, DeepSeek Harness and Pi appear as labeled pills in the source hierarchy. Codex and Pi use the exact user-supplied SVG files; the model selectors continue using model-provider marks.
- Hero/cards region: headline scale, copper accent, four-column card grid, icon color families, landscape crop, translucent panels, and card spacing align with the reference at the normalized viewport.
- Composer region: attachment, permission, model, Harness, microphone, terminal/command and dark send controls remain functional and align to the source grouping.
- Sidebar region: proportions, dark new-chat button, navigation rhythm, project divider, archive area, and account footer match. Project rows are absent only because this capture intentionally starts with no stored tasks.

## Required fidelity surfaces

- Fonts and typography: Segoe UI / Microsoft YaHei preserves the native Windows desktop appearance; hierarchy, weight and wrapping are close to the reference. No clipped headline or control labels.
- Spacing and layout rhythm: major tracks, header heights, hero margins, four-card grid and bottom composer are aligned; no horizontal overflow at 1280 × 960.
- Colors and visual tokens: warm white, stone borders, charcoal actions, copper accent and green connection status match the reference palette.
- Image quality and asset fidelity: generated hero is a sharp 2120 × 742 source asset displayed with a responsive cover crop; the app mark is a dedicated 1024 × 1024 asset, and Harness/model marks use local vector assets.
- Copy and content: homepage heading, supporting copy, four capability titles, connection status, command palette and composer labels match the selected design intent.

## Comparison history

1. Initial implementation used the purple Codex placeholder, icon-only Harness buttons, a blue-white shell, two simple cards and no hero image. Replaced those with labeled Harness pills, warm material system, generated landscape asset, four capability cards and source-aligned composer.
2. First visual pass used unrelated compact/Qwen icons for project and chat cards. Replaced them with dedicated folder and conversation assets and captured the neutral, OpenAI-selected state again.
3. The focused correction replaced the sidebar placeholder mark, prevented the brand name from wrapping, gave normal and forked tasks separate tab symbols, and matched the source tab border/radius/spacing.
4. Final side-by-side and live-task comparisons found no actionable P0, P1 or P2 mismatch. Remaining differences are dynamic project/task content and Windows frame treatment outside the app-owned renderer.

## Interactions and runtime validation

- `npm run smoke`: Harness selection, lazy model loading, model/thinking/permission menus, message send/cancel, approvals, project actions, fork, command menu, responsive overflow and asset loading passed.
- `npm run smoke:app`: real Electron main/preload/Renderer startup, reload, history migration and awaited shutdown passed.
- `npm run smoke:workbench`: running and completed activity collapse, live review, reopen, responsive layout, file preview, terminal and Git interactions passed.
- No Renderer exception or broken asset was reported during the final capture.

final result: passed
