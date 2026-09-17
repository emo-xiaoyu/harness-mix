import dalaoDianyanHero from "../../../../assets/skins/heige/themes/dalao-dianyan/hero.webp";
import deepspaceDawnHero from "../../../../assets/skins/heige/themes/deepspace-dawn/hero.webp";
import deepspaceStarHero from "../../../../assets/skins/heige/themes/deepspace-star/hero.webp";
import dragonballNimbusHero from "../../../../assets/skins/heige/themes/dragonball-nimbus/hero.webp";
import dragonballSuperSaiyanHero from "../../../../assets/skins/heige/themes/dragonball-super-saiyan/hero.webp";
import genshinDawnHero from "../../../../assets/skins/heige/themes/genshin-dawn/hero.webp";
import genshinNightHero from "../../../../assets/skins/heige/themes/genshin-night/hero.webp";
import mikuHero from "../../../../assets/skins/heige/themes/miku-488137/hero.webp";
import mikuLogo from "../../../../assets/skins/heige/themes/miku-488137/logo.webp";
import mikuPolaroid from "../../../../assets/skins/heige/themes/miku-488137/polaroid.webp";
import narutoHokageHero from "../../../../assets/skins/heige/themes/naruto-hokage/hero.webp";
import narutoSasukeHero from "../../../../assets/skins/heige/themes/naruto-sasuke/hero.webp";
import wutheringEchoHero from "../../../../assets/skins/heige/themes/wuthering-echo/hero.webp";
import wutheringTideHero from "../../../../assets/skins/heige/themes/wuthering-tide/hero.webp";
import gildedGrandeurHero from "../../../../assets/skins/codex-styler/themes/gilded-grandeur/hero.webp";
import merryBigTopHero from "../../../../assets/skins/codex-styler/themes/merry-big-top/hero.webp";
import nocturneStudioHero from "../../../../assets/skins/codex-styler/themes/nocturne-studio/hero.webp";
import quietGardenHero from "../../../../assets/skins/codex-styler/themes/quiet-garden/hero.webp";
import gothicVoidCrusadeHero from "../../../../assets/skins/dream-skin/themes/gothic-void-crusade/hero.webp";

export const RENDERER_SKIN_STORAGE_KEY = "harness-mix.renderer-skin.v1";
export const RENDERER_SKIN_STYLE_ID = "harness-mix-renderer-skin";
export const RENDERER_SKIN_ATTRIBUTE = "data-harness-mix-skin";

export const RENDERER_SKIN_IDS = [
  "native", "miku-488137", "genshin-dawn", "genshin-night", "wuthering-echo",
  "wuthering-tide", "naruto-hokage", "naruto-sasuke", "deepspace-dawn",
  "deepspace-star", "dragonball-nimbus", "dragonball-super-saiyan", "dalao-dianyan",
  "styler-gilded-grandeur", "styler-merry-big-top", "styler-nocturne-studio",
  "styler-quiet-garden", "dream-gothic-void-crusade",
  "palette-catppuccin-latte", "palette-catppuccin-mocha", "palette-claude-desktop-dark",
  "palette-claude-desktop-light", "palette-gruvbox-dark", "palette-gruvbox-light",
  "palette-nord-dark", "palette-nord-light", "palette-one-dark", "palette-one-light",
  "palette-tokyo-night-dark", "palette-tokyo-night-light",
] as const;

export type RendererSkinId = (typeof RENDERER_SKIN_IDS)[number];

export interface RendererSkinDefinition {
  readonly id: RendererSkinId;
  readonly name: string;
  readonly sourceName: string;
  readonly sourceUrl: string | null;
  readonly heroUrl: string | null;
  readonly logoUrl: string | null;
  readonly polaroidUrl: string | null;
  readonly palette: readonly [surface: string, secondary: string, accent: string, text: string];
  readonly preview: string;
  readonly focus: string;
  readonly dark: boolean;
}

const HEIGE_SOURCE_URL = "https://github.com/HeiGeAi/heige-codex-skin-studio";
const CODEX_STYLER_SOURCE_URL = "https://github.com/xuhuanstudio/codex-styler";
const DREAM_SKIN_SOURCE_URL = "https://github.com/Fei-Away/Codex-Dream-Skin";
const ANTHROPIC_THEME_SOURCE_URL = "https://github.com/miniLV/Anthropic-codex-theme";

function heigeSkin(
  id: Exclude<RendererSkinId, "native">,
  name: string,
  heroUrl: string,
  palette: RendererSkinDefinition["palette"],
  focus: string,
  dark: boolean,
  decorations: Pick<RendererSkinDefinition, "logoUrl" | "polaroidUrl"> = {
    logoUrl: null,
    polaroidUrl: null,
  },
): RendererSkinDefinition {
  return Object.freeze({
    id, name, heroUrl, palette, focus, dark, ...decorations,
    sourceName: "HeiGe Codex Skin Studio",
    sourceUrl: HEIGE_SOURCE_URL,
    preview: `linear-gradient(${dark ? "rgb(3 7 12 / 16%)" : "rgb(255 255 255 / 8%)"}, transparent)`,
  });
}

function codexStylerSkin(
  id: Exclude<RendererSkinId, "native">,
  name: string,
  heroUrl: string,
  palette: RendererSkinDefinition["palette"],
  focus: string,
): RendererSkinDefinition {
  return Object.freeze({
    id, name, heroUrl, logoUrl: null, polaroidUrl: null, palette, focus, dark: true,
    sourceName: "Codex Styler · CC BY 4.0",
    sourceUrl: CODEX_STYLER_SOURCE_URL,
    preview: "linear-gradient(rgb(3 7 12 / 16%), transparent)",
  });
}

function dreamSkin(
  id: Exclude<RendererSkinId, "native">,
  name: string,
  heroUrl: string,
  palette: RendererSkinDefinition["palette"],
  focus: string,
): RendererSkinDefinition {
  return Object.freeze({
    id, name, heroUrl, logoUrl: null, polaroidUrl: null, palette, focus, dark: true,
    sourceName: "Codex Dream Skin · MIT",
    sourceUrl: DREAM_SKIN_SOURCE_URL,
    preview: "linear-gradient(rgb(3 7 12 / 16%), transparent)",
  });
}

function paletteSkin(
  id: Exclude<RendererSkinId, "native">,
  name: string,
  palette: RendererSkinDefinition["palette"],
  panel: string,
  dark: boolean,
): RendererSkinDefinition {
  return Object.freeze({
    id, name, heroUrl: null, logoUrl: null, polaroidUrl: null, palette, focus: "50% 50%", dark,
    sourceName: "Anthropic Codex Theme · MIT",
    sourceUrl: ANTHROPIC_THEME_SOURCE_URL,
    preview: `linear-gradient(155deg, ${palette[0]} 0 58%, ${panel} 58% 100%)`,
  });
}

export const RENDERER_SKINS: readonly RendererSkinDefinition[] = Object.freeze([
  Object.freeze({
    id: "native", name: "Native Codex", sourceName: "OpenAI Codex", sourceUrl: null,
    heroUrl: null, logoUrl: null, polaroidUrl: null,
    palette: ["#f7f7f7", "#d7d7d7", "#171717", "#171717"] as const,
    preview: "linear-gradient(145deg, #f8f8f8 0 58%, #ececec 58% 100%)",
    focus: "50% 50%", dark: false,
  }),
  heigeSkin(
    "miku-488137",
    "Miku 488137",
    mikuHero,
    ["#f5f6fc", "#ed6ec1", "#19c9e5", "#122c60"],
    "50% 33%",
    false,
    { logoUrl: mikuLogo, polaroidUrl: mikuPolaroid },
  ),
  heigeSkin("genshin-dawn", "原神 · 晨曦", genshinDawnHero, ["#f2f1fb", "#e0aa3e", "#5b7fd6", "#2c3a6b"], "50% 24%", false),
  heigeSkin("genshin-night", "原神 · 星夜", genshinNightHero, ["#171a2e", "#7a86d8", "#e0b458", "#f0e6c8"], "50% 17%", true),
  heigeSkin("wuthering-echo", "鸣潮 · 共鸣", wutheringEchoHero, ["#16121f", "#a98fe8", "#56e0d8", "#e4def2"], "50% 27%", true),
  heigeSkin("wuthering-tide", "鸣潮 · 声骸", wutheringTideHero, ["#0d1418", "#9aa8b0", "#3fd6d0", "#d8eef0"], "50% 30%", true),
  heigeSkin("naruto-hokage", "火影 · 鸣人", narutoHokageHero, ["#17110b", "#ffd166", "#f2801e", "#ffe3c2"], "50% 27%", true),
  heigeSkin("naruto-sasuke", "火影 · 佐助", narutoSasukeHero, ["#171019", "#7fb3ff", "#d8443c", "#ffd9d2"], "50% 24%", true),
  heigeSkin("deepspace-dawn", "恋与深空 · 晨曦", deepspaceDawnHero, ["#f6f2fb", "#f097c8", "#8f7fe8", "#4a4668"], "50% 8%", false),
  heigeSkin("deepspace-star", "恋与深空 · 星辰", deepspaceStarHero, ["#201a40", "#f097c8", "#9d8bff", "#e8e2ff"], "50% 8%", true),
  heigeSkin("dragonball-nimbus", "龙珠 · 筋斗云", dragonballNimbusHero, ["#f3f7ff", "#f6c445", "#4fc3f7", "#14213d"], "72% 24%", false),
  heigeSkin("dragonball-super-saiyan", "龙珠 · 超级赛亚人", dragonballSuperSaiyanHero, ["#fff8e8", "#52c7f2", "#f5c451", "#282033"], "67% 3%", false),
  heigeSkin("dalao-dianyan", "大佬 · 点烟", dalaoDianyanHero, ["#111111", "#9aa3b0", "#e09a52", "#f2e8da"], "50% 8%", true),
  codexStylerSkin("styler-gilded-grandeur", "金辉盛境", gildedGrandeurHero, ["#090704", "#5b4721", "#e8bd55", "#fff2cd"], "54% 48%"),
  codexStylerSkin("styler-merry-big-top", "欢乐大帐篷", merryBigTopHero, ["#100b14", "#5a3d4b", "#ff755e", "#fff2dc"], "55% 48%"),
  codexStylerSkin("styler-nocturne-studio", "夜曲工作室", nocturneStudioHero, ["#090b0d", "#34383a", "#e9a066", "#f5efe6"], "58% 46%"),
  codexStylerSkin("styler-quiet-garden", "静谧花园", quietGardenHero, ["#101612", "#364339", "#9fc29a", "#edf2e8"], "52% 50%"),
  dreamSkin("dream-gothic-void-crusade", "哥特虚空远征", gothicVoidCrusadeHero, ["#0d0d0e", "#b5a386", "#c8a55a", "#f3ead7"], "76% 45%"),
  paletteSkin("palette-catppuccin-latte", "Catppuccin · 拿铁", ["#EFF1F5", "#5C5F77", "#FE640B", "#4C4F69"], "#E6E9EF", false),
  paletteSkin("palette-catppuccin-mocha", "Catppuccin · 摩卡", ["#181825", "#A6ADC8", "#FAB387", "#CDD6F4"], "#1E1E2E", true),
  paletteSkin("palette-claude-desktop-dark", "Claude · 墨夜", ["#1A1918", "#A8A49C", "#CA7554", "#E8E4DC"], "#222120", true),
  paletteSkin("palette-claude-desktop-light", "Claude · 素纸", ["#F8F6F1", "#605B54", "#CA7554", "#38342E"], "#F3EFE7", false),
  paletteSkin("palette-gruvbox-dark", "Gruvbox · 暖夜", ["#282828", "#D5C4A1", "#FE8019", "#EBDBB2"], "#32302F", true),
  paletteSkin("palette-gruvbox-light", "Gruvbox · 暖昼", ["#FBF1C7", "#504945", "#D65D0E", "#3C3836"], "#F2E5BC", false),
  paletteSkin("palette-nord-dark", "Nord · 极夜", ["#2E3440", "#C3CBD9", "#88C0D0", "#D8DEE9"], "#3B4252", true),
  paletteSkin("palette-nord-light", "Nord · 雪原", ["#ECEFF4", "#3B4252", "#5E81AC", "#2E3440"], "#E5E9F0", false),
  paletteSkin("palette-one-dark", "One Dark · 子夜", ["#282C34", "#9DA5B4", "#61AFEF", "#ABB2BF"], "#21252B", true),
  paletteSkin("palette-one-light", "One Light · 皓昼", ["#FAFAFA", "#4F525E", "#4078F2", "#383A42"], "#F0F0F1", false),
  paletteSkin("palette-tokyo-night-dark", "Tokyo Night · 夜", ["#1A1B26", "#A9B1D6", "#7AA2F7", "#C0CAF5"], "#16161E", true),
  paletteSkin("palette-tokyo-night-light", "Tokyo Night · 晨", ["#E1E2E7", "#4C505E", "#2E7DE9", "#343B59"], "#D5D6DB", false),
]);

interface RendererSkinStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function documentSkinStorage(ownerDocument: Document): RendererSkinStorage | null {
  try { return ownerDocument.defaultView?.localStorage ?? null; } catch { return null; }
}

function isRendererSkinId(value: string | null): value is RendererSkinId {
  return (RENDERER_SKIN_IDS as readonly string[]).includes(value ?? "");
}

export function rendererSkinDefinition(id: RendererSkinId): RendererSkinDefinition {
  return RENDERER_SKINS.find((skin) => skin.id === id) ?? RENDERER_SKINS[0]!;
}

export function readRendererSkin(storage?: RendererSkinStorage | null): RendererSkinId {
  try {
    const stored = storage?.getItem(RENDERER_SKIN_STORAGE_KEY) ?? null;
    return isRendererSkinId(stored) ? stored : "native";
  } catch { return "native"; }
}

export function readActiveRendererSkin(ownerDocument: Document = document): RendererSkinId {
  const active = ownerDocument.documentElement.getAttribute(RENDERER_SKIN_ATTRIBUTE);
  return isRendererSkinId(active) ? active : readRendererSkin(documentSkinStorage(ownerDocument));
}

function skinCss(skin: RendererSkinDefinition): string {
  const [surface, secondary, accent, text] = skin.palette;
  const image = skin.heroUrl ? `url("${skin.heroUrl}")` : skin.preview;
  const sidebarVeil = skin.dark
    ? `color-mix(in srgb, ${surface} 91%, transparent)`
    : `color-mix(in srgb, ${surface} 88%, transparent)`;
  const lowerVeil = skin.dark
    ? `color-mix(in srgb, ${surface} 68%, transparent)`
    : `color-mix(in srgb, ${surface} 72%, transparent)`;
  const panelOpacity = skin.dark ? "84%" : "82%";
  const secondaryText = `color-mix(in srgb, ${text} 72%, transparent)`;
  const tertiaryText = `color-mix(in srgb, ${text} 54%, transparent)`;
  const logoCss = skin.logoUrl ? `
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] .app-shell-left-panel button[aria-haspopup="menu"][aria-label*="ChatGPT"],
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] .app-shell-left-panel button[aria-haspopup="menu"][aria-label*="Codex"] {
  width: min(214px, calc(100% - 12px)); height: 72px !important; margin: 4px 6px 0;
  background: url("${skin.logoUrl}") left center / contain no-repeat !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] .app-shell-left-panel button[aria-haspopup="menu"][aria-label*="ChatGPT"] > :where(span, svg),
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] .app-shell-left-panel button[aria-haspopup="menu"][aria-label*="Codex"] > :where(span, svg) { visibility: hidden !important; }
` : "";
  const polaroidCss = skin.polaroidUrl ? `
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] body::after {
  content: ""; position: fixed; right: clamp(12px, 2vw, 24px); bottom: clamp(72px, 11vh, 108px);
  width: clamp(108px, 11.5vw, 168px); aspect-ratio: 2 / 3;
  background: url("${skin.polaroidUrl}") center / contain no-repeat;
  filter: drop-shadow(0 12px 26px color-mix(in srgb, ${text} 24%, transparent));
  pointer-events: none; z-index: 15;
}
@media (max-width: 760px) {
  html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] body::after { display: none; }
}
` : "";
  return `
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] {
  color-scheme: ${skin.dark ? "dark" : "light"};
  --codex-titlebar-tint: transparent !important;
  --header-tint: transparent !important;
  --color-text: ${text}; --color-text-primary: ${text}; --color-token-text-primary: ${text};
  --color-token-foreground: ${text}; --color-text-prose: ${text}; --color-text-emphasis: ${text};
  --color-text-primary-surface: ${text}; --color-text-primary-soft: ${text};
  --color-text-primary-soft-alt: ${text}; --color-text-primary-ghost: ${text};
  --color-text-primary-ghost-hover: ${text}; --color-text-primary-outline: ${text};
  --color-text-primary-outline-hover: ${text};
  --color-text-secondary: ${secondaryText}; --color-token-text-secondary: ${secondaryText};
  --color-text-secondary-soft: ${secondaryText}; --color-text-secondary-soft-alt: ${secondaryText};
  --color-text-secondary-ghost: ${secondaryText}; --color-text-secondary-ghost-hover: ${text};
  --color-text-secondary-outline: ${secondaryText}; --color-text-secondary-outline-hover: ${text};
  --color-text-secondary-solid: ${secondaryText};
  --color-text-tertiary: ${tertiaryText}; --color-token-text-tertiary: ${tertiaryText};
  --color-token-description-foreground: ${tertiaryText};
  --color-token-dropdown-foreground: ${text};
  --app-color-text-foreground: ${text}; --app-color-text-foreground-secondary: ${secondaryText};
  --app-color-text-foreground-tertiary: ${tertiaryText};
  --app-color-foreground-application-menu: ${text};
  --app-color-text-button-secondary: ${text}; --app-color-text-button-tertiary: ${tertiaryText};
  --wb-text-primary: ${text}; --wb-text-secondary: ${secondaryText}; --wb-text-tertiary: ${tertiaryText};
  --color-control-thumb-foreground: ${text};
  --color-text-mode-toggle-inactive: ${secondaryText};
  --color-text-user-message: ${text} !important;
  --color-surface: color-mix(in srgb, ${surface} 92%, transparent);
  --color-surface-secondary: color-mix(in srgb, ${surface} 88%, transparent);
  --color-surface-tertiary: color-mix(in srgb, ${surface} 94%, transparent);
  --color-surface-elevated: color-mix(in srgb, ${surface} 96%, transparent);
  --color-surface-elevated-secondary: color-mix(in srgb, ${surface} 96%, transparent);
  --color-background-surface: color-mix(in srgb, ${surface} 90%, transparent);
  --color-background-panel: color-mix(in srgb, ${surface} 94%, transparent);
  --color-background-callout-surface: color-mix(in srgb, ${surface} 94%, transparent);
  --color-background-control-opaque: ${surface};
  --color-background-page-search: color-mix(in srgb, ${surface} 92%, transparent);
  --color-background-composer-action-bar: color-mix(in srgb, ${surface} 88%, transparent);
  --color-background-execution-output: color-mix(in srgb, ${surface} 88%, transparent);
  --color-background-primary-soft: color-mix(in srgb, ${surface} 92%, transparent);
  --color-background-primary-soft-alpha: color-mix(in srgb, ${surface} 88%, transparent);
  --color-background-primary-soft-hover: color-mix(in srgb, ${surface} 80%, ${accent});
  --color-background-primary-soft-active: color-mix(in srgb, ${surface} 72%, ${accent});
  --color-background-primary-ghost-hover: color-mix(in srgb, ${text} 8%, transparent);
  --color-background-secondary-soft: color-mix(in srgb, ${text} 7%, transparent);
  --color-background-secondary-soft-alpha: color-mix(in srgb, ${text} 7%, transparent);
  --color-background-secondary-soft-hover: color-mix(in srgb, ${text} 11%, transparent);
  --color-background-other-user-message: color-mix(in srgb, ${surface} 76%, transparent);
  --color-background-user-message: color-mix(in srgb, ${surface} 92%, transparent) !important;
  --color-background-user-message-compact: color-mix(in srgb, ${surface} 88%, transparent);
  --color-border: color-mix(in srgb, ${text} 16%, transparent);
  --color-border-subtle: color-mix(in srgb, ${text} 8%, transparent);
  --color-border-strong: color-mix(in srgb, ${text} 20%, transparent);
  --color-token-main-surface-primary: color-mix(in srgb, ${surface} 92%, transparent);
  --color-token-dropdown-background: color-mix(in srgb, ${surface} 96%, transparent);
  --color-token-list-hover-background: color-mix(in srgb, ${text} 8%, transparent);
  --color-token-border: color-mix(in srgb, ${text} 16%, transparent);
  --color-token-border-default: color-mix(in srgb, ${text} 16%, transparent);
  --color-token-border-light: color-mix(in srgb, ${text} 9%, transparent);
  --color-token-border-heavy: color-mix(in srgb, ${text} 22%, transparent);
  --color-token-input-border: color-mix(in srgb, ${text} 20%, transparent);
  --color-codex-diff-surface: color-mix(in srgb, ${surface} 94%, ${text});
  --color-token-diff-surface: color-mix(in srgb, ${surface} 94%, ${text});
  --color-codex-editor-inline-code-background: color-mix(in srgb, ${surface} 92%, transparent);
  --color-codex-terminal-background: ${surface};
  --codex-base-surface: ${surface};
  --app-color-background-surface: color-mix(in srgb, ${surface} 92%, transparent);
  --app-color-background-surface-under: color-mix(in srgb, ${surface} 88%, transparent);
  --app-color-background-control: color-mix(in srgb, ${surface} 96%, transparent);
  --app-color-background-elevated-primary: color-mix(in srgb, ${surface} 96%, transparent);
  --app-color-background-elevated-primary-opaque: ${surface};
  --app-color-background-elevated-secondary: color-mix(in srgb, ${surface} 96%, transparent);
  --app-color-background-elevated-secondary-opaque: ${surface};
  --app-color-background-editor-opaque: ${surface};
  --app-color-background-application-menu: color-mix(in srgb, ${surface} 96%, transparent);
  --app-color-background-button-secondary: color-mix(in srgb, ${text} 7%, transparent);
  --app-color-background-button-secondary-hover: color-mix(in srgb, ${text} 11%, transparent);
  --app-color-border: color-mix(in srgb, ${text} 16%, transparent);
  --app-color-border-light: color-mix(in srgb, ${text} 9%, transparent);
  --app-color-border-heavy: color-mix(in srgb, ${text} 22%, transparent);
  --wb-surface-primary: color-mix(in srgb, ${surface} 92%, transparent);
  --wb-surface-secondary: color-mix(in srgb, ${surface} 88%, transparent);
  --wb-border: color-mix(in srgb, ${text} 16%, transparent);
  --wb-border-hover: color-mix(in srgb, ${text} 22%, transparent);
  --vscode-foreground: ${text}; --vscode-descriptionForeground: ${secondaryText};
  --vscode-editor-foreground: ${text}; --vscode-input-foreground: ${text};
  --vscode-editor-background: ${surface}; --vscode-editorPane-background: ${surface};
  --vscode-input-background: color-mix(in srgb, ${surface} 96%, transparent);
  --vscode-dropdown-background: color-mix(in srgb, ${surface} 96%, transparent);
  --vscode-menu-background: color-mix(in srgb, ${surface} 96%, transparent);
  --vscode-panel-background: color-mix(in srgb, ${surface} 96%, transparent);
  --vscode-terminal-background: ${surface};
  --vscode-list-hoverBackground: color-mix(in srgb, ${text} 8%, transparent);
  --vscode-list-activeSelectionBackground: color-mix(in srgb, ${accent} 24%, transparent);
  --vscode-list-activeSelectionForeground: ${text};
  --vscode-list-inactiveSelectionBackground: color-mix(in srgb, ${accent} 16%, transparent);
  --vscode-list-inactiveSelectionForeground: ${text};
  --background: color-mix(in srgb, ${surface} ${panelOpacity}, transparent);
  --foreground: ${text}; --card: color-mix(in srgb, ${surface} 88%, transparent);
  --card-foreground: ${text}; --popover: color-mix(in srgb, ${surface} 94%, transparent);
  --popover-foreground: ${text}; --primary: ${accent}; --primary-foreground: ${surface};
  --secondary: color-mix(in srgb, ${surface} 82%, ${secondary}); --secondary-foreground: ${text};
  --muted: color-mix(in srgb, ${surface} 88%, ${secondary});
  --muted-foreground: color-mix(in srgb, ${text} 68%, ${surface});
  --accent: color-mix(in srgb, ${surface} 74%, ${accent}); --accent-foreground: ${text};
  --border: color-mix(in srgb, ${text} 16%, transparent); --input: color-mix(in srgb, ${text} 18%, transparent); --ring: ${accent};
  --sidebar: color-mix(in srgb, ${surface} 88%, transparent); --sidebar-background: color-mix(in srgb, ${surface} 88%, transparent);
  --sidebar-foreground: ${text}; --sidebar-primary: ${accent}; --sidebar-primary-foreground: ${surface};
  --sidebar-accent: color-mix(in srgb, ${surface} 74%, ${accent}); --sidebar-accent-foreground: ${text};
  --sidebar-border: color-mix(in srgb, ${text} 14%, transparent); --sidebar-ring: ${accent};
  --main-surface-primary: color-mix(in srgb, ${surface} 84%, transparent);
  --main-surface-secondary: color-mix(in srgb, ${surface} 72%, transparent);
  --sidebar-surface-primary: color-mix(in srgb, ${surface} 88%, transparent);
  --sidebar-surface-secondary: color-mix(in srgb, ${surface} 76%, transparent);
  --message-surface: color-mix(in srgb, ${surface} 82%, transparent);
  --composer-surface: color-mix(in srgb, ${surface} 88%, transparent);
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] body {
  color: ${text}; background: ${surface} !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] body > #root {
  min-height: 100vh; color: ${text} !important;
  background-color: transparent !important;
  background-image:
    linear-gradient(90deg, ${sidebarVeil} 0 22%, transparent 46%),
    linear-gradient(180deg, transparent 0 43%, ${lowerVeil} 100%),
    ${image} !important;
  background-position: left top, left top, ${skin.focus} !important;
  background-repeat: no-repeat !important;
  background-size: 100% 100%, 100% 100%, cover !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] :where(
  .main-surface,
  .browser-main-surface,
  [data-app-shell-main-surface="default"],
  main[class*="_MainContentSurface_"]
) {
  background: linear-gradient(180deg, transparent 0 40%, color-mix(in srgb, ${surface} 70%, transparent) 100%) !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] .app-shell-left-panel {
  background: color-mix(in srgb, ${surface} 88%, transparent) !important;
  border-right-color: color-mix(in srgb, ${accent} 32%, transparent) !important;
  backdrop-filter: none !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] :where(.bg-background, .bg-sidebar, .bg-card, .bg-token-main-surface-primary, .bg-token-sidebar-surface-primary) {
  background: color-mix(in srgb, ${surface} ${panelOpacity}, transparent) !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] :where(
  [data-response-annotation-conversation],
  [data-local-conversation-final-assistant]:not(:has([data-response-annotation-conversation]))
) {
  box-sizing: border-box;
  color: ${text} !important;
  background: color-mix(in srgb, ${surface} 96%, transparent) !important;
  border: 1px solid color-mix(in srgb, ${accent} 16%, transparent) !important;
  border-radius: 18px;
  padding: 14px 16px 12px;
  box-shadow: 0 8px 24px color-mix(in srgb, ${text} 8%, transparent) !important;
  backdrop-filter: blur(16px) saturate(120%) !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] :where(
  table,
  [data-markdown-table],
  [data-markdown-table] > div,
  .main-surface table,
  main table,
  article table,
  [data-response-annotation-conversation] table
) {
  background-color: color-mix(in srgb, ${surface} 95%, transparent) !important;
  backdrop-filter: blur(16px) saturate(120%) !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] :where(
  [data-markdown-table],
  .main-surface table,
  main table,
  article table,
  table
) {
  border: 1px solid color-mix(in srgb, ${accent} 24%, transparent) !important;
  border-radius: 12px !important;
  box-shadow: 0 4px 20px color-mix(in srgb, ${text} 8%, transparent) !important;
  overflow: hidden !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] :where(
  table th,
  [data-markdown-table] th,
  [data-response-annotation-conversation] th
) {
  background-color: color-mix(in srgb, ${surface} 98%, transparent) !important;
  border-bottom: 2px solid color-mix(in srgb, ${accent} 28%, transparent) !important;
  color: ${text} !important;
  font-weight: 600 !important;
  padding: 8px 14px !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] :where(
  table td,
  [data-markdown-table] td,
  [data-response-annotation-conversation] td,
  [data-response-annotation-conversation] :where(th, td)
) {
  border-bottom: 1px solid color-mix(in srgb, ${text} 12%, transparent) !important;
  border-right: 1px solid color-mix(in srgb, ${text} 6%, transparent) !important;
  color: ${text} !important;
  padding: 8px 14px !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] :where(
  table tr:last-child td,
  [data-markdown-table] tr:last-child td
) {
  border-bottom: none !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] :where(
  table tr:hover td,
  [data-markdown-table] tr:hover td
) {
  background-color: color-mix(in srgb, ${accent} 10%, transparent) !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] :where(.composer-surface-chrome, [data-user-message-bubble], [data-codex-approval-surface]) {
  color: ${text} !important;
  background: color-mix(in srgb, ${surface} 92%, transparent) !important;
  border-color: color-mix(in srgb, ${accent} 24%, transparent) !important;
  box-shadow: 0 8px 24px color-mix(in srgb, ${accent} 12%, transparent) !important;
  backdrop-filter: blur(16px) saturate(120%) !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-user-message-bubble],
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-user-message-bubble] :where(
  [data-markdown-text-tone="user-message"],
  [data-markdown-han-text],
  p,
  span,
  a,
  code
) {
  color: ${text} !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] :where(
  header,
  header > div,
  [data-pip-obstacle="app-shell-header"],
  [data-pip-obstacle="app-shell-header"] > div,
  [class*="_ApplicationMenuTopBar_"],
  [class*="_FloatingHeader_"],
  [class*="_TitleBar_"],
  [data-testid="app-shell-header-context-menu-surface"],
  [data-app-shell-header-toolbar],
  [data-app-shell-tab-row],
  [data-app-shell-application-menu-bar]
) {
  background: transparent !important;
  background-color: transparent !important;
  border-color: transparent !important;
  box-shadow: none !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] header :where(.bg-surface, .bg-surface-secondary, .bg-surface-elevated):not([data-tab-id], [data-tab-id] *),
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-pip-obstacle="app-shell-header"] :where(.bg-surface, .bg-surface-secondary, .bg-surface-elevated):not([data-tab-id], [data-tab-id] *) {
  background: transparent !important;
  background-color: transparent !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-app-shell-main-content-top-fade] {
  background: none !important;
  background-image: none !important;
  opacity: 0 !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-app-shell-page-header] > [data-app-shell-header-toolbar] > div:first-child {
  background: transparent !important;
  background-color: transparent !important;
  border: 0 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  backdrop-filter: none !important;
  color: color-mix(in srgb, ${text} 82%, ${accent}) !important;
  font-size: 13px !important;
  font-weight: 500 !important;
  text-shadow: 0 1px 2px color-mix(in srgb, ${surface} 72%, transparent) !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-app-shell-page-header] > [data-app-shell-header-toolbar] > div:first-child > div {
  background: transparent !important;
  background-color: transparent !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-app-shell-page-header] > [data-app-shell-header-toolbar] > div:first-child button {
  background: transparent !important;
  background-color: transparent !important;
  border-color: transparent !important;
  box-shadow: none !important;
  color: inherit !important;
  font-size: inherit !important;
  font-weight: inherit !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] header button:not([data-harnessmix-settings-trigger] *),
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-pip-obstacle="app-shell-header"] button:not([data-harnessmix-settings-trigger] *),
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-app-shell-header-obstacle] button:not([data-harnessmix-settings-trigger] *),
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-testid="app-shell-header-context-menu-surface"] button:not([data-harnessmix-settings-trigger] *),
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-app-shell-header-toolbar] button:not([data-harnessmix-settings-trigger] *),
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] header [role="button"]:not([data-harnessmix-settings-trigger] *) {
  background: transparent !important;
  background-color: transparent !important;
  border-color: transparent !important;
  box-shadow: none !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-app-shell-page-header] > [data-app-shell-header-toolbar] > button[aria-haspopup="menu"] {
  color: color-mix(in srgb, ${text} 62%, transparent) !important;
  background: transparent !important;
  background-color: transparent !important;
  border-color: transparent !important;
  box-shadow: none !important;
  filter: none !important;
  outline: none !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] header button:not([data-harnessmix-settings-trigger] *):hover,
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-pip-obstacle="app-shell-header"] button:not([data-harnessmix-settings-trigger] *):hover,
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-app-shell-header-obstacle] button:not([data-harnessmix-settings-trigger] *):hover,
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-testid="app-shell-header-context-menu-surface"] button:not([data-harnessmix-settings-trigger] *):hover,
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-app-shell-header-toolbar] button:not([data-harnessmix-settings-trigger] *):hover {
  background: color-mix(in srgb, ${text} 12%, transparent) !important;
  background-color: color-mix(in srgb, ${text} 12%, transparent) !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-app-shell-page-header] > [data-app-shell-header-toolbar] > button[aria-haspopup="menu"]:hover,
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-app-shell-page-header] > [data-app-shell-header-toolbar] > button[aria-haspopup="menu"]:focus-visible {
  color: ${text} !important;
  background: transparent !important;
  background-color: transparent !important;
  border-color: transparent !important;
  box-shadow: none !important;
  filter: none !important;
  outline: none !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] header button:not([data-harnessmix-settings-trigger] *):active,
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-pip-obstacle="app-shell-header"] button:not([data-harnessmix-settings-trigger] *):active,
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-app-shell-header-obstacle] button:not([data-harnessmix-settings-trigger] *):active,
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-testid="app-shell-header-context-menu-surface"] button:not([data-harnessmix-settings-trigger] *):active,
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-app-shell-header-toolbar] button:not([data-harnessmix-settings-trigger] *):active {
  background: color-mix(in srgb, ${text} 18%, transparent) !important;
  background-color: color-mix(in srgb, ${text} 18%, transparent) !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-app-shell-page-header] > [data-app-shell-header-toolbar] > button[aria-haspopup="menu"]:active,
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-app-shell-page-header] > [data-app-shell-header-toolbar] > button[aria-haspopup="menu"][data-state="open"] {
  color: ${text} !important;
  background: transparent !important;
  background-color: transparent !important;
  border-color: transparent !important;
  box-shadow: none !important;
  filter: none !important;
  outline: none !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] :where(
  [data-app-shell-tab-controller],
  [data-app-shell-tab-controller] [data-tab-id],
  .\@container\/app-shell-tab,
  [data-tab-id].group\/tab,
  .group\/tab[data-tab-id],
  [data-tab-id],
  [data-app-shell-tab-capture]
) {
  max-width: min(680px, 55vw) !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-tab-id] :where([class*="max-w-"], [class*="min-w-0"]) {
  max-width: none !important;
}
@media (min-width: 100rem) {
  html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] {
    --thread-content-max-width: min(72rem, calc(100vw - 22rem));
  }
  html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [class*="thread-content-max-width"] {
    --thread-content-max-width: min(72rem, calc(100vw - 22rem)) !important;
  }
  html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-local-conversation-final-assistant] {
    max-width: min(72rem, calc(100vw - 22rem)) !important;
  }
}
@container home-main-content (inline-size <= 52rem) {
  html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] div[role="main"]:has([data-composer-placement="home"]) [class*="_Hero_"] {
    min-block-size: clamp(8.5rem, 28cqh, 12.5rem) !important;
    flex-basis: auto !important;
    padding-block: 0.75rem 1rem !important;
  }
  html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] div[role="main"]:has([data-composer-placement="home"]) [data-feature="game-source"] {
    padding-inline: 1rem;
    font-size: clamp(1.35rem, 4cqw, 1.75rem) !important;
    line-height: 1.22 !important;
  }
}
@media (max-width: 68.75rem), (max-height: 47.5rem) {
  html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] div[role="main"]:has([data-composer-placement="home"]) [class*="_Hero_"] {
    min-block-size: clamp(8.5rem, 28vh, 12.5rem) !important;
    flex-basis: auto !important;
    padding-block: 0.75rem 1rem !important;
  }
  html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] div[role="main"]:has([data-composer-placement="home"]) [data-feature="game-source"] {
    padding-inline: 1rem;
    font-size: clamp(1.35rem, 3.2vw, 1.75rem) !important;
    line-height: 1.22 !important;
  }
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-app-action-sidebar-thread-active="true"] {
  background: linear-gradient(90deg, color-mix(in srgb, ${accent} 22%, transparent), color-mix(in srgb, ${secondary} 16%, transparent)) !important;
}
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] :where(.border-border, .border-sidebar-border) { border-color: color-mix(in srgb, ${text} 14%, transparent) !important; }
html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] [data-harnessmix-settings-shell] {
  --settings-bg: color-mix(in srgb, ${surface} 90%, transparent);
  --settings-sidebar: color-mix(in srgb, ${surface} 86%, ${secondary});
  --settings-panel: color-mix(in srgb, ${surface} 90%, transparent);
  --settings-surface: color-mix(in srgb, ${surface} 82%, ${secondary});
  --settings-surface-hover: color-mix(in srgb, ${surface} 72%, ${accent});
  --settings-inset: color-mix(in srgb, ${surface} 92%, ${secondary});
  --settings-text: ${text}; --settings-muted: color-mix(in srgb, ${text} 68%, ${surface});
  --settings-subtle: color-mix(in srgb, ${text} 52%, ${surface});
  --settings-border: color-mix(in srgb, ${text} 14%, transparent); --settings-focus: ${accent};
  --settings-primary: ${accent}; --settings-primary-hover: color-mix(in srgb, ${accent} 82%, white);
  --settings-primary-text: ${surface};
}
${logoCss}${polaroidCss}
@media (prefers-reduced-transparency: reduce) {
  html[${RENDERER_SKIN_ATTRIBUTE}="${skin.id}"] :where(.app-shell-left-panel, [data-response-annotation-conversation], .composer-surface-chrome, [data-user-message-bubble], [data-codex-approval-surface]) {
    background-color: ${surface} !important;
  }
}`;
}

export function applyRendererSkin(
  id: RendererSkinId,
  ownerDocument: Document = document,
  storage?: RendererSkinStorage | null,
): RendererSkinId {
  const resolvedStorage = storage === undefined ? documentSkinStorage(ownerDocument) : storage;
  const currentStyle = ownerDocument.getElementById(RENDERER_SKIN_STYLE_ID);
  if (id === "native") {
    currentStyle?.remove();
    ownerDocument.documentElement.removeAttribute(RENDERER_SKIN_ATTRIBUTE);
    try { resolvedStorage?.removeItem(RENDERER_SKIN_STORAGE_KEY); } catch { /* visual reset succeeded */ }
    return id;
  }
  const skin = rendererSkinDefinition(id);
  const style = currentStyle ?? ownerDocument.createElement("style");
  style.id = RENDERER_SKIN_STYLE_ID;
  style.textContent = skinCss(skin);
  if (!currentStyle) ownerDocument.head.append(style);
  ownerDocument.documentElement.setAttribute(RENDERER_SKIN_ATTRIBUTE, id);
  try { resolvedStorage?.setItem(RENDERER_SKIN_STORAGE_KEY, id); } catch { /* session-only fallback */ }
  return id;
}

export function restoreRendererSkin(ownerWindow: Window = window): RendererSkinId {
  const storage = documentSkinStorage(ownerWindow.document);
  const id = readRendererSkin(storage);
  if (id === "native") return id;
  return applyRendererSkin(id, ownerWindow.document, storage);
}
