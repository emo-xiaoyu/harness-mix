import type { RendererSettingsMessages } from "./localization.js";
import type {
  RendererSettingsPageDefinition,
  RendererSettingsPageMountContext,
} from "./core.js";
import { createRendererSettingsIcon } from "./icons.js";
import {
  RENDERER_SKINS,
  applyRendererSkin,
  readActiveRendererSkin,
  type RendererSkinDefinition,
  type RendererSkinId,
} from "./skin-runtime.js";

// Per-locale card copy for the skins market. Skins are a strictly visual
// layer; the safety note spells that out for users.
const COPY = {
  en: {
    title: "Skins",
    intro: "Change the atmosphere, not the app. Every skin keeps Codex controls and native Harness behavior intact.",
    safe: "Visual layer only",
    safeDetail: "No replacement controls, scripts, credentials, model routes, tools, or permission changes.",
    selected: "Current skin",
    apply: "Apply skin",
    applied: "Applied",
    native: "The untouched Codex appearance. Select it anytime to remove every Harness Mix skin override.",
    included: "Bundled theme from",
    light: "Light",
    dark: "Dark",
    attribution: "Open source reference",
  },
  "zh-CN": {
    title: "皮肤",
    intro: "只换氛围，不换内核。所有皮肤都保留 Codex 原生控件与各 Harness 的真实行为。",
    safe: "仅视觉层",
    safeDetail: "不替换控件，不运行主题脚本，不改变凭据、模型路由、工具或权限。",
    selected: "当前皮肤",
    apply: "应用皮肤",
    applied: "已应用",
    native: "未经修改的 Codex 外观。随时选择它，即可移除 Harness Mix 的全部皮肤覆盖。",
    included: "内置主题来自",
    light: "浅色",
    dark: "深色",
    attribution: "开源参考项目",
  },
} as const;

// Miniature window mock drawn behind each skin card.
function previewChrome(document: Document, skin: RendererSkinDefinition): HTMLElement {
  const preview = document.createElement("div");
  preview.className = "skin-preview";
  preview.style.backgroundImage = skin.heroUrl
    ? `${skin.preview}, url("${skin.heroUrl}")`
    : skin.preview;
  preview.style.backgroundPosition = `center, ${skin.focus}`;
  preview.style.backgroundSize = "cover";
  preview.setAttribute("aria-hidden", "true");
  const dots = document.createElement("span");
  dots.className = "skin-preview__dots";
  const sidebar = document.createElement("span");
  sidebar.className = "skin-preview__sidebar";
  const conversation = document.createElement("span");
  conversation.className = "skin-preview__conversation";
  const composer = document.createElement("span");
  composer.className = "skin-preview__composer";
  preview.append(dots, sidebar, conversation, composer);
  return preview;
}

export function createSkinSettingsPage(
  messages: RendererSettingsMessages,
): RendererSettingsPageDefinition {
  const copy = COPY[messages.locale];
  return Object.freeze({
    id: "skins",
    label: messages.pageLabels.skins,
    icon: "palette",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const heading = document.createElement("div");
      heading.className = "settings-section-label";
      heading.textContent = copy.title;
      const introduction = document.createElement("p");
      introduction.className = "skin-market__intro";
      introduction.textContent = copy.intro;
      const safety = document.createElement("aside");
      safety.className = "skin-safety-note";
      safety.append(createRendererSettingsIcon("shield", 17));
      const safetyCopy = document.createElement("span");
      const safetyTitle = document.createElement("strong");
      safetyTitle.textContent = copy.safe;
      const safetyDetail = document.createElement("span");
      safetyDetail.textContent = copy.safeDetail;
      safetyCopy.append(safetyTitle, safetyDetail);
      safety.append(safetyCopy);

      const grid = document.createElement("div");
      grid.className = "skin-market-grid";
      let selected = readActiveRendererSkin(document);
      const cards = new Map<RendererSkinId, HTMLElement>();

      const syncSelection = (): void => {
        for (const [id, card] of cards) {
          const active = id === selected;
          card.toggleAttribute("data-selected", active);
          const button = card.querySelector<HTMLButtonElement>("button[data-skin-action]");
          if (button) {
            button.disabled = active;
            button.textContent = active ? copy.applied : copy.apply;
          }
          const badge = card.querySelector<HTMLElement>("[data-skin-current]");
          if (badge) badge.hidden = !active;
        }
      };

      for (const skin of RENDERER_SKINS) {
        const card = document.createElement("article");
        card.className = "skin-card";
        card.dataset.skinId = skin.id;
        card.append(previewChrome(document, skin));
        const body = document.createElement("div");
        body.className = "skin-card__body";
        const titleRow = document.createElement("div");
        titleRow.className = "skin-card__title-row";
        const title = document.createElement("strong");
        title.className = "skin-card__title";
        title.textContent = skin.name;
        const current = document.createElement("span");
        current.className = "skin-card__current";
        current.dataset.skinCurrent = "true";
        current.textContent = copy.selected;
        titleRow.append(title, current);
        const description = document.createElement("p");
        description.className = "skin-card__description";
        if (skin.sourceUrl) {
          // Bundled theme: credit the upstream open-source project it came from.
          description.append(`${copy.included} `);
          const source = document.createElement("a");
          source.href = skin.sourceUrl;
          source.target = "_blank";
          source.rel = "noopener noreferrer";
          source.textContent = skin.sourceName;
          source.title = copy.attribution;
          description.append(source);
          description.append(` · ${skin.dark ? copy.dark : copy.light}`);
        } else {
          description.textContent = copy.native;
        }
        const footer = document.createElement("div");
        footer.className = "skin-card__footer";
        const palette = document.createElement("span");
        palette.className = "skin-card__palette";
        palette.setAttribute("aria-hidden", "true");
        for (const color of skin.palette) {
          const swatch = document.createElement("i");
          swatch.style.backgroundColor = color;
          palette.append(swatch);
        }
        const apply = document.createElement("button");
        apply.type = "button";
        apply.className = "settings-command-button skin-card__apply";
        apply.dataset.skinAction = skin.id;
        apply.addEventListener("click", () => {
          selected = applyRendererSkin(skin.id, document);
          syncSelection();
        });
        footer.append(palette, apply);
        body.append(titleRow, description, footer);
        card.append(body);
        cards.set(skin.id, card);
        grid.append(card);
      }
      syncSelection();
      context.content.append(heading, introduction, safety, grid);
      return undefined;
    },
  });
}
