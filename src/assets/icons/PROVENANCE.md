# Icon provenance

33 brand marks are bundled in this directory and read by `src/main/native/icons.js`.
They exist so the UI can label the harnesses and models this project integrates with.
Every mark remains a trademark of its owner; see the trademark note at the end.

## Redistributed from lobehub/lobe-icons — 24 of 33 (MIT)

`@lobehub/icons-static-svg` v1.95.0, `Copyright (c) 2023 LobeHub`.
Source: https://github.com/lobehub/lobe-icons
License text: `licenses/lobe-icons-MIT.txt`

Fifteen files are byte-identical to the upstream package:

| local | upstream |
| --- | --- |
| `claude-color.svg` | `claude-color.svg` |
| `cline-color.svg` | `cline.svg` |
| `cursor-cli-color.svg` | `cursor.svg` |
| `deepseek-color.svg` | `deepseek-color.svg` |
| `grok-color.svg` | `grok.svg` |
| `model-claude.svg` | `claude.svg` |
| `model-deepseek.svg` | `deepseek.svg` |
| `model-kimi.svg` | `kimi.svg` |
| `model-minimax.svg` | `minimax.svg` |
| `model-openai.svg` | `openai.svg` |
| `model-qwen-color.svg` | `qwen-color.svg` |
| `model-xiaomimimo.svg` | `xiaomimimo.svg` |
| `openclaw-color.svg` | `openclaw-color.svg` |
| `opencode-color.svg` | `opencode.svg` |
| `pi.svg` | `pi.svg` |

Nine more carry the same artwork (identical `path` data) behind a slightly different
export wrapper, so they come from the same set:

| local | upstream |
| --- | --- |
| `antigravity-color.svg` | `antigravity-color.svg` |
| `cursor.svg` | `cursor.svg` |
| `model-gemini.svg` | `gemini.svg` |
| `model-grok.svg` | `grok.svg` |
| `model-zai.svg` | `zai.svg` |
| `qoder-color.svg` | `qoder-color.svg` |
| `trae-color.svg` | `trae-color.svg` |
| `workbuddy-color.svg` | `yuanbao-color.svg` |
| `zcode-color.svg` | `zai.svg` |

Note that two local file names do not match the mark they contain: `workbuddy-color.svg`
is the upstream *Yuanbao* mark, and `zcode-color.svg` is the upstream *Z.ai* mark.
The upstream `<title>` element in those files still carries the original names.

## Bundled from product brand marks — 8 of 33

| local | known origin |
| --- | --- |
| `kiro-cli-color.svg` | Official Kiro icon, `https://kiro.dev/icon.svg`. Byte-identical to `src/native-ui/renderer-extension/src/assets/kiro-agent.svg`, whose provenance is recorded in that directory's `README.md`. |
| `codex-color.svg`, `codex-harness.svg` | The Codex mark. Both names hold the same bytes and both are referenced (`adapters/codex.js` uses `codex-color.svg`, `native/icons.js` and `README.md` use `codex-harness.svg`). |
| `codebuddy-color.svg` | CodeBuddy harness mark. Source record not kept. |
| `hermes-color.svg` | Hermes harness mark. Source record not kept. |
| `omp-color.svg` | Oh My Pi harness mark whose source record was not kept. It is **not** the official mark: `omp-agent.svg` in the renderer assets has identical path data to the official Oh My Pi favicon (`packages/collab-web/public/favicon.svg`), while this file is a different, simpler shape. |
| `model-astra.svg` | Drawn in this repository (gradient disc), not third-party artwork. |
| `model-hunyuan.svg` | Drawn in this repository (rounded plate with a glyph), not third-party artwork. |

## Unknown provenance — 1 of 33

`pinumber1_80899.svg` is a pi glyph exported by Adobe Illustrator 18.1.1; the file name
matches the download naming of free icon sites. It is used as the Pi harness icon
(`src/main/adapters/pi.js`). The exact source and its license could not be established,
so it should be replaced with original artwork or have its source recorded.

## Usage

`src/main/native/icons.js` resolves icons through an explicit file list and nothing globs
this directory, so three files are currently referenced by no code path:

| file | why it is unused |
| --- | --- |
| `cursor-cli-color.svg` | Both the `cursor` and `cursor-cli` entries resolve to `cursor.svg`. |
| `model-grok.svg` | The `grok` model family resolves to `grok-color.svg`. The other eleven model families all use `model-*.svg`, so this is the convention-consistent file — either it should be wired up or the duplicate dropped. |
| `workbuddy-color.svg` | Every alias map resolves `workbuddy` to `codebuddy`, which uses `codebuddy-color.svg`. |

`grok-color.svg` and `model-grok.svg` carry identical path data, so despite the names they
are the same artwork under two file names.

Everything in this directory is published: `package.json` lists `src` in `files`.

## Trademarks

These marks are the property of their respective owners and are bundled only to identify
the harnesses and models this project integrates with. No trademark right, endorsement or
affiliation is claimed. Copyright licenses covering a mark (such as the MIT license above)
do not grant any trademark right.
