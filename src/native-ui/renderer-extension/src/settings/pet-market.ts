// Pet market settings page: browse, install and select desktop companions.
// Selecting a pet drives Codex's own official pet setting through UI
// automation, then records the choice locally so this panel mirrors it.

import type { RendererSettingsMessages } from "./localization.js";
import type {
  RendererSettingsPageDefinition,
  RendererSettingsPageMountContext,
} from "./core.js";
import { createRendererSettingsIcon } from "./icons.js";
import {
  normalizeRendererPetSelection,
  type RendererPetItem,
  type RendererPetSelection,
  type RendererPetsClient,
} from "./pets-client.js";
import { switchOfficialCodexPet } from "../renderer-pet-switcher.js";

const PET_MARKET_COPY = {
  en: {
    title: "Pets",
    intro:
      "Add companion pets to Codex Desktop. Installed companions sync directly with Codex native pets directory and respond to agent state.",
    safe: "Native local integration",
    safeDetail:
      "Pets install into ~/.codex/pets/, containing only spritesheets and metadata without running external scripts. Instantly selectable in Codex settings.",
    all: "All",
    official: "Official Preload",
    community: "Community",
    installed: "Installed",
    searchPlaceholder: "Search pets by name or description...",
    install: "Install Pet",
    installing: "Installing...",
    installedBadge: "Installed",
    uninstall: "Uninstall",
    uninstalling: "Removing...",
    retry: "Retry",
    installFailed: "Install failed",
    uninstallFailed: "Uninstall failed",
    tip: "Select in Appearance > Pets or type /pet to wake",
    empty: "No pets match the current filter.",
    officialBadge: "Official",
    communityBadge: "Community",
    nowShowing: "Now showing",
    nowShowingEmpty:
      "No pet selected yet. Hit Use on an installed pet below and Harness Mix switches Codex's official pet for you.",
    panelNote:
      "Mirrors Codex's official pet. Show or hide the mascot with Codex's own Show pet command.",
    usePet: "Use",
    usingPet: "Switching...",
    activeBadge: "Active",
    hidePet: "Clear",
    hidingPet: "Clearing...",
    selectFailed: "Switch failed",
  },
  "zh-CN": {
    title: "桌宠市场",
    intro:
      "为 Codex 添加桌面萌宠伴侣。安装后自动同步至 Codex Desktop 原生桌宠目录，随 AI 状态实时交互动画。",
    safe: "本地原生集成",
    safeDetail:
      "桌宠安装于 ~/.codex/pets/，仅包含动画精灵图与元数据，不执行外部代码。在 Codex 官方外观设置中立即可选。",
    all: "全部",
    official: "官方预载",
    community: "社区精选",
    installed: "已安装",
    searchPlaceholder: "搜索桌宠名称或描述...",
    install: "安装桌宠",
    installing: "安装中...",
    installedBadge: "已安装",
    uninstall: "卸载",
    uninstalling: "卸载中...",
    retry: "重试",
    installFailed: "安装失败",
    uninstallFailed: "卸载失败",
    tip: "安装后在官方设置「外观 > 桌宠」或输入 /pet 指令唤醒伴侣",
    empty: "没有找到符合条件的桌宠。",
    officialBadge: "官方预载",
    communityBadge: "社区精选",
    nowShowing: "当前桌宠",
    nowShowingEmpty: "尚未选择桌宠。在下方已安装的桌宠上点击「使用」，Harness Mix 会为你切换 Codex 官方桌宠。",
    panelNote: "与 Codex 官方桌宠一致。官方吉祥物的显隐由 Codex 自己的「显示宠物」命令控制。",
    usePet: "使用",
    usingPet: "切换中...",
    activeBadge: "使用中",
    hidePet: "清除",
    hidingPet: "清除中...",
    selectFailed: "切换失败",
  },
} as const;

type MarketCopy = (typeof PET_MARKET_COPY)[keyof typeof PET_MARKET_COPY];
type PetTab = "all" | "official" | "community" | "installed";
type PetOperation = "install" | "uninstall" | "select";

type PetCardState =
  | { readonly status: "installing" | "uninstalling" | "selecting" }
  | { readonly status: "failed"; readonly op: PetOperation; readonly error: string };

// Sheet layout for the animated previews. Version 1 sheets use 9 rows, newer
// sheets use 11; only the top row (6 frames across 8 columns) animates.
const SHEET_COLUMNS = 8;
const SHEET_FRAMES = 6;
const FRAME_STEP_MS = 220;
const IDLE_PERIOD_MIN_MS = 4000;
const IDLE_PERIOD_JITTER_MS = 3000;

function busyLabelFor(
  status: "installing" | "uninstalling" | "selecting",
  copy: MarketCopy,
): string {
  if (status === "installing") return copy.installing;
  if (status === "uninstalling") return copy.uninstalling;
  return copy.usingPet;
}

function failureLabelFor(op: PetOperation, copy: MarketCopy): string {
  if (op === "install") return copy.installFailed;
  if (op === "uninstall") return copy.uninstallFailed;
  return copy.selectFailed;
}

// Drives a CSS background-position spritesheet animation on one element.
// Playback is hover-driven on the surrounding card, with a periodic idle
// wiggle so static grids still feel alive. Returns a disposer.
function mountSpriteAnimation(
  element: HTMLElement,
  imageUrl: string,
  spriteVersion = 2,
): () => void {
  const rowCount = spriteVersion === 1 ? 9 : 11;
  element.style.backgroundImage = `url("${imageUrl}")`;
  element.style.backgroundSize = `${SHEET_COLUMNS * 100}% ${rowCount * 100}%`;
  element.style.backgroundPosition = "0% 0%";

  let frame = 0;
  let loopTimer: number | null = null;
  let idleStopTimer: number | null = null;
  let hovering = false;

  const advance = (): void => {
    frame = (frame + 1) % SHEET_FRAMES;
    const posX = (frame / (SHEET_COLUMNS - 1)) * 100;
    element.style.backgroundPosition = `${posX}% 0%`;
  };

  const playLoop = (): void => {
    if (loopTimer !== null) return;
    loopTimer = window.setInterval(advance, FRAME_STEP_MS);
  };

  const stopLoop = (): void => {
    if (loopTimer !== null) {
      window.clearInterval(loopTimer);
      loopTimer = null;
    }
    if (!hovering) {
      frame = 0;
      element.style.backgroundPosition = "0% 0%";
    }
  };

  const onCardEnter = (): void => {
    hovering = true;
    playLoop();
  };

  const onCardLeave = (): void => {
    hovering = false;
    stopLoop();
  };

  const hostCard = element.closest(".pet-card, .pet-current");
  if (hostCard) {
    hostCard.addEventListener("mouseenter", onCardEnter);
    hostCard.addEventListener("mouseleave", onCardLeave);
  }

  // Occasional unsolicited blink/wiggle while idle.
  const idleKick = window.setInterval(() => {
    if (!hovering && loopTimer === null) {
      playLoop();
      if (idleStopTimer !== null) window.clearTimeout(idleStopTimer);
      idleStopTimer = window.setTimeout(() => {
        idleStopTimer = null;
        stopLoop();
      }, FRAME_STEP_MS * SHEET_FRAMES);
    }
  }, IDLE_PERIOD_MIN_MS + Math.random() * IDLE_PERIOD_JITTER_MS);

  return () => {
    stopLoop();
    window.clearInterval(idleKick);
    if (idleStopTimer !== null) {
      window.clearTimeout(idleStopTimer);
      idleStopTimer = null;
    }
    if (hostCard) {
      hostCard.removeEventListener("mouseenter", onCardEnter);
      hostCard.removeEventListener("mouseleave", onCardLeave);
    }
  };
}

export function createPetSettingsPage(
  messages: RendererSettingsMessages,
  getClient: () => RendererPetsClient | null,
): RendererSettingsPageDefinition {
  const copy = PET_MARKET_COPY[messages.locale];

  return Object.freeze({
    id: "pets",
    label: messages.pageLabels.pets,
    icon: "pets",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const cardAnimationDisposers: Array<() => void> = [];

      // Static page scaffolding: heading, intro, safety note, active-pet
      // panel, tab/search toolbar and the card grid.
      const heading = document.createElement("div");
      heading.className = "settings-section-label";
      heading.textContent = copy.title;

      const intro = document.createElement("p");
      intro.className = "pet-market__intro";
      intro.textContent = copy.intro;

      const safety = document.createElement("aside");
      safety.className = "pet-safety-note";
      safety.append(createRendererSettingsIcon("shield", 18));
      const safetyBody = document.createElement("span");
      const safetyTitle = document.createElement("strong");
      safetyTitle.textContent = copy.safe;
      const safetyDetail = document.createElement("span");
      safetyDetail.textContent = copy.safeDetail;
      safetyBody.append(safetyTitle, safetyDetail);
      safety.append(safetyBody);

      // Current-pet panel at the top, driven by the local selection record.
      const currentPanel = document.createElement("section");
      currentPanel.className = "pet-current";
      currentPanel.dataset.active = "false";

      const toolbar = document.createElement("div");
      toolbar.className = "pet-market__toolbar";
      const tabsWrap = document.createElement("div");
      tabsWrap.className = "pet-market__tabs";

      let activeTab: PetTab = "all";
      let searchQuery = "";
      const tabButtons = new Map<PetTab, HTMLButtonElement>();
      const tabs: Array<{ id: PetTab; label: string }> = [
        { id: "all", label: copy.all },
        { id: "official", label: copy.official },
        { id: "community", label: copy.community },
        { id: "installed", label: copy.installed },
      ];

      const searchWrap = document.createElement("div");
      searchWrap.className = "pet-market__search-wrap";
      searchWrap.append(createRendererSettingsIcon("search", 15));
      const searchInput = document.createElement("input");
      searchInput.type = "search";
      searchInput.className = "pet-market__search";
      searchInput.placeholder = copy.searchPlaceholder;
      searchWrap.append(searchInput);

      toolbar.append(tabsWrap, searchWrap);

      const grid = document.createElement("div");
      grid.className = "pet-market-grid";

      context.content.append(heading, intro, safety, currentPanel, toolbar, grid);

      // Mutable page state.
      let allPets: RendererPetItem[] = [];
      const imageCache = new Map<string, string>();
      // Per-pet operation state machine: installing / uninstalling /
      // selecting, or failed with the failing operation and error text.
      const cardStates = new Map<string, PetCardState>();
      // Render generation counter: stale preview callbacks from an older
      // grid must not attach animations to detached nodes.
      let gridEpoch = 0;
      let currentSelection: RendererPetSelection = { id: null };
      let selectionReady = false;
      let hidePending = false;
      let panelError: string | null = null;
      let panelEpoch = 0;
      const panelAnimationDisposers: Array<() => void> = [];

      const runPetOperation = (pet: RendererPetItem, op: PetOperation) => {
        const client = getClient();
        const state = cardStates.get(pet.id);
        // Re-entrant guard: busy pets are locked, failed ones may retry.
        if (!client || (state && state.status !== "failed")) return;
        cardStates.set(pet.id, {
          status: op === "install" ? "installing" : "uninstalling",
        });
        renderGrid();
        const settle = (installed: boolean, failure: string | null) => {
          if (failure === null) {
            cardStates.delete(pet.id);
          } else {
            cardStates.set(pet.id, { status: "failed", op, error: failure });
          }
          allPets = allPets.map((p) => (p.id === pet.id ? { ...p, installed } : p));
          renderGrid();
        };
        const onSuccess = () => {
          settle(op === "install", null);
          // Uninstalling the active pet: the Host already cleared the stored
          // selection, so mirror that here in panel and badges.
          if (op === "uninstall" && currentSelection.id === pet.id) {
            applySelection({ id: null });
          }
        };
        const onFailure = (err: unknown) =>
          settle(pet.installed, err instanceof Error ? err.message : String(err));
        if (op === "install") {
          void client
            .install({
              id: pet.id,
              displayName: pet.displayName,
              description: pet.description,
              spritesheetUrl: pet.spritesheetUrl,
              spriteVersionNumber: pet.spriteVersionNumber,
            })
            .then(onSuccess, onFailure);
        } else {
          void client.uninstall(pet.id).then(onSuccess, onFailure);
        }
      };

      const matchesActiveTab = (pet: RendererPetItem): boolean => {
        if (activeTab === "official" && pet.source !== "official") return false;
        if (activeTab === "community" && pet.source !== "community") return false;
        if (activeTab === "installed" && !pet.installed) return false;
        return true;
      };

      const matchesQuery = (pet: RendererPetItem, query: string): boolean => {
        if (!query) return true;
        const haystack = [pet.displayName, pet.description || "", pet.id];
        return haystack.some((part) => part.toLowerCase().includes(query));
      };

      // Card badges: failure notice outranks everything, then installed,
      // then provenance; the Active badge is additive.
      const buildBadges = (pet: RendererPetItem, state: PetCardState | undefined) => {
        const badges = document.createElement("div");
        badges.className = "pet-card__badges";
        if (state?.status === "failed") {
          const b = document.createElement("span");
          b.className = "pet-card__badge pet-card__badge--failed";
          b.textContent = failureLabelFor(state.op, copy);
          badges.append(b);
        } else if (pet.installed) {
          const b = document.createElement("span");
          b.className = "pet-card__badge pet-card__badge--installed";
          b.append(createRendererSettingsIcon("check", 12), copy.installedBadge);
          badges.append(b);
        } else if (pet.source === "official") {
          const b = document.createElement("span");
          b.className = "pet-card__badge pet-card__badge--official";
          b.textContent = copy.officialBadge;
          badges.append(b);
        } else if (pet.source === "community") {
          const b = document.createElement("span");
          b.className = "pet-card__badge pet-card__badge--community";
          b.textContent = copy.communityBadge;
          badges.append(b);
        }
        if (pet.installed && currentSelection.id === pet.id && state?.status !== "failed") {
          const activeBadge = document.createElement("span");
          activeBadge.className = "pet-card__badge pet-card__badge--active";
          activeBadge.textContent = copy.activeBadge;
          badges.append(activeBadge);
        }
        return badges;
      };

      const actionButton = (
        label: string,
        tone: "primary" | "danger" | "secondary",
        onClick: () => void,
        disabled = false,
      ): HTMLButtonElement => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `pet-btn pet-btn--${tone}`;
        btn.textContent = label;
        btn.disabled = disabled;
        btn.addEventListener("click", onClick);
        return btn;
      };

      const buildActions = (pet: RendererPetItem, state: PetCardState | undefined) => {
        const actions = document.createElement("div");
        actions.className = "pet-card__actions";
        if (state && state.status !== "failed") {
          // Operation in flight: one disabled button blocks double clicks.
          const tone = state.status === "uninstalling" ? "danger" : "primary";
          actions.append(actionButton(busyLabelFor(state.status, copy), tone, () => {}, true));
        } else if (state?.status === "failed") {
          // Errors render inside the card; Retry re-runs the failed operation.
          actions.append(actionButton(copy.retry, state.op === "uninstall" ? "danger" : "primary", () => {
            if (state.op === "select") runSelectOperation(pet);
            else runPetOperation(pet, state.op);
          }));
        } else if (pet.installed) {
          // Installed: offer switching (the active pet shows a badge instead
          // of a Use button) plus removal.
          if (currentSelection.id !== pet.id) {
            actions.append(actionButton(copy.usePet, "primary", () => runSelectOperation(pet)));
          }
          actions.append(actionButton(copy.uninstall, "danger", () => runPetOperation(pet, "uninstall")));
        } else {
          actions.append(actionButton(copy.install, "primary", () => runPetOperation(pet, "install")));
        }
        return actions;
      };

      const attachCardArt = (
        pet: RendererPetItem,
        sprite: HTMLElement,
        epoch: number,
      ): void => {
        const cached = imageCache.get(pet.id);
        if (cached) {
          cardAnimationDisposers.push(mountSpriteAnimation(sprite, cached, pet.spriteVersionNumber));
          return;
        }
        if (pet.spritesheetUrl) {
          imageCache.set(pet.id, pet.spritesheetUrl);
          cardAnimationDisposers.push(
            mountSpriteAnimation(sprite, pet.spritesheetUrl, pet.spriteVersionNumber),
          );
          return;
        }
        // Fallback preview path: static poster if present, otherwise fetch a
        // base64 preview through the client.
        const showStatic = (): void => {
          if (!pet.previewUrl) return;
          sprite.style.backgroundImage = `url("${pet.previewUrl}")`;
          sprite.style.backgroundSize = "contain";
          sprite.style.backgroundPosition = "center";
        };
        const client = getClient();
        if (!client) {
          showStatic();
          return;
        }
        void client.preview(pet.id).then(
          (res) => {
            if (epoch !== gridEpoch || !sprite.isConnected) return;
            if (res && res.dataBase64) {
              const dataUrl = `data:${res.mime};base64,${res.dataBase64}`;
              imageCache.set(pet.id, dataUrl);
              cardAnimationDisposers.push(
                mountSpriteAnimation(sprite, dataUrl, pet.spriteVersionNumber),
              );
            }
          },
          () => {
            if (epoch !== gridEpoch || !sprite.isConnected) return;
            showStatic();
          },
        );
      };

      const renderGrid = () => {
        gridEpoch += 1;
        const epoch = gridEpoch;
        for (const dispose of cardAnimationDisposers) dispose();
        cardAnimationDisposers.length = 0;
        grid.replaceChildren();

        const query = searchQuery.trim().toLowerCase();
        const filtered = allPets.filter((pet) => matchesActiveTab(pet) && matchesQuery(pet, query));

        if (filtered.length === 0) {
          const empty = document.createElement("div");
          empty.className = "pet-market__empty";
          empty.textContent = copy.empty;
          grid.append(empty);
          return;
        }

        for (const pet of filtered) {
          const state = cardStates.get(pet.id);
          const card = document.createElement("article");
          card.className = "pet-card";
          card.dataset.petId = pet.id;
          card.dataset.installed = String(pet.installed);
          if (state) card.dataset.state = state.status;

          const stage = document.createElement("div");
          stage.className = "pet-card__stage";
          const sprite = document.createElement("div");
          sprite.className = "pet-card__sprite";
          stage.append(sprite);

          const body = document.createElement("div");
          body.className = "pet-card__body";

          const cardHeader = document.createElement("div");
          cardHeader.className = "pet-card__header";
          const title = document.createElement("strong");
          title.className = "pet-card__title";
          title.textContent = pet.displayName;
          cardHeader.append(title, buildBadges(pet, state));

          const desc = document.createElement("p");
          desc.className = "pet-card__description";
          desc.textContent = pet.description || "";

          const footer = document.createElement("div");
          footer.className = "pet-card__footer";
          const hint = document.createElement("span");
          hint.className = "pet-card__dir-hint";
          hint.textContent = copy.tip;
          footer.append(hint, buildActions(pet, state));

          // Operation feedback lives inside the card, not in a global dialog.
          if (state?.status === "failed") {
            const errorBox = document.createElement("div");
            errorBox.className = "pet-card__error";
            errorBox.textContent = state.error;
            body.append(cardHeader, desc, errorBox, footer);
          } else if (state) {
            const statusLine = document.createElement("div");
            statusLine.className = "pet-card__status";
            statusLine.textContent = busyLabelFor(state.status, copy);
            body.append(cardHeader, desc, statusLine, footer);
          } else {
            body.append(cardHeader, desc, footer);
          }
          card.append(stage, body);
          grid.append(card);

          // Artwork must attach after the card is in the DOM because the
          // animation controller walks up to .pet-card for hover events.
          attachCardArt(pet, sprite, epoch);
        }
      };

      // Current-pet panel: empty hint, or animated selection with its Clear
      // action, plus an optional panel-level error line.
      const renderPanel = () => {
        panelEpoch += 1;
        const epoch = panelEpoch;
        for (const dispose of panelAnimationDisposers) dispose();
        panelAnimationDisposers.length = 0;
        currentPanel.replaceChildren();
        currentPanel.dataset.active = String(currentSelection.id !== null);

        const label = document.createElement("span");
        label.className = "pet-current__label";
        label.textContent = copy.nowShowing;

        if (currentSelection.id === null) {
          const emptyWrap = document.createElement("div");
          emptyWrap.className = "pet-current__empty";
          emptyWrap.append(createRendererSettingsIcon("pets", 22));
          const hint = document.createElement("span");
          hint.className = "pet-current__hint";
          hint.textContent = selectionReady ? copy.nowShowingEmpty : "";
          emptyWrap.append(hint);
          currentPanel.append(label, emptyWrap);
        } else {
          const selectedId = currentSelection.id;
          const stage = document.createElement("div");
          stage.className = "pet-current__stage";
          const sprite = document.createElement("div");
          sprite.className = "pet-current__sprite";
          stage.append(sprite);

          const info = document.createElement("div");
          info.className = "pet-current__info";
          const name = document.createElement("strong");
          name.className = "pet-current__name";
          name.textContent = currentSelection.displayName ?? selectedId;
          const note = document.createElement("span");
          note.className = "pet-current__note";
          note.textContent = copy.panelNote;
          info.append(label, name, note);

          const hideBtn = document.createElement("button");
          hideBtn.type = "button";
          hideBtn.className = "pet-btn pet-btn--secondary";
          hideBtn.disabled = hidePending;
          hideBtn.textContent = hidePending ? copy.hidingPet : copy.hidePet;
          hideBtn.addEventListener("click", () => runHideOperation());

          currentPanel.append(stage, info, hideBtn);

          const attach = (imageUrl: string): void => {
            panelAnimationDisposers.push(
              mountSpriteAnimation(sprite, imageUrl, currentSelection.spriteVersionNumber),
            );
          };
          const cached = imageCache.get(selectedId);
          if (cached) {
            attach(cached);
          } else {
            const client = getClient();
            if (client) {
              // Same lazy preview loading as cards; a failed preview only
              // costs the animation, the textual panel stays valid.
              void client.preview(selectedId).then(
                (res) => {
                  if (epoch !== panelEpoch || !sprite.isConnected) return;
                  if (res && res.dataBase64) {
                    const dataUrl = `data:${res.mime};base64,${res.dataBase64}`;
                    imageCache.set(selectedId, dataUrl);
                    attach(dataUrl);
                  }
                },
                () => {
                  /* preview is cosmetic here */
                },
              );
            }
          }
        }

        if (panelError) {
          const errorBox = document.createElement("div");
          errorBox.className = "pet-current__error";
          errorBox.textContent = panelError;
          currentPanel.append(errorBox);
        }
      };

      // Single entry point for selection changes so panel and badges agree.
      const applySelection = (selection: RendererPetSelection) => {
        currentSelection = selection;
        selectionReady = true;
        panelError = null;
        renderPanel();
        renderGrid();
      };

      const runHideOperation = () => {
        const client = getClient();
        if (!client || hidePending || currentSelection.id === null) return;
        hidePending = true;
        panelError = null;
        renderPanel();
        void client.select(null).then(
          () => {
            hidePending = false;
            applySelection({ id: null });
          },
          (err) => {
            hidePending = false;
            panelError = err instanceof Error ? err.message : String(err);
            renderPanel();
          },
        );
      };

      const runSelectOperation = (pet: RendererPetItem) => {
        const client = getClient();
        const state = cardStates.get(pet.id);
        if (!client || !pet.installed || (state && state.status !== "failed")) return;
        if (currentSelection.id === pet.id) return;
        cardStates.set(pet.id, { status: "selecting" });
        renderGrid();
        // First drive Codex's own pet setting through UI automation (its own
        // click path, never the account API); only after that succeeds is the
        // local record written, which drives this panel and the badges.
        void switchOfficialCodexPet({ id: pet.id, displayName: pet.displayName })
          .then(() => client.select(pet.id))
          .then(
            (result) => {
              // The switch can take seconds; the page may be gone by now, so
              // never touch detached DOM after an abort.
              if (context.signal.aborted) return;
              cardStates.delete(pet.id);
              const applied = normalizeRendererPetSelection(result);
              applySelection(
                applied.id !== null
                  ? applied
                  : {
                      id: pet.id,
                      displayName: pet.displayName,
                      ...(pet.spriteVersionNumber !== undefined
                        ? { spriteVersionNumber: pet.spriteVersionNumber }
                        : {}),
                    },
              );
            },
            (err) => {
              if (context.signal.aborted) return;
              cardStates.set(pet.id, {
                status: "failed",
                op: "select",
                error: err instanceof Error ? err.message : String(err),
              });
              renderGrid();
            },
          );
      };

      for (const t of tabs) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "pet-market__tab";
        btn.textContent = t.label;
        btn.dataset.active = String(t.id === activeTab);
        btn.addEventListener("click", () => {
          activeTab = t.id;
          for (const [tabId, b] of tabButtons) {
            b.dataset.active = String(tabId === activeTab);
          }
          renderGrid();
        });
        tabButtons.set(t.id, btn);
        tabsWrap.append(btn);
      }

      searchInput.addEventListener("input", () => {
        searchQuery = searchInput.value;
        renderGrid();
      });

      // Initial paint with the empty panel, then hydrate from the client.
      const client = getClient();
      renderPanel();
      if (client) {
        void context.runLatest(
          () => client.catalog(),
          {
            success(result) {
              allPets = [...result.data];
              renderGrid();
            },
            failure(error) {
              grid.textContent =
                error instanceof Error ? error.message : String(error);
            },
          },
        );
        // Fill the panel from the persisted selection; if the user already
        // interacted meanwhile (panelEpoch moved on), drop the stale result.
        const selectionFetchEpoch = panelEpoch;
        void client.selection().then(
          (result) => {
            if (selectionFetchEpoch !== panelEpoch) return;
            currentSelection = normalizeRendererPetSelection(result);
            selectionReady = true;
            renderPanel();
            // Badges and Use buttons depend on the selection, so the grid
            // needs one more pass once it arrives.
            renderGrid();
          },
          () => {
            if (selectionFetchEpoch !== panelEpoch) return;
            selectionReady = true;
            renderPanel();
          },
        );
      }

      return () => {
        gridEpoch += 1; // invalidate in-flight card preview callbacks
        panelEpoch += 1; // and panel animation/selection callbacks
        for (const dispose of panelAnimationDisposers) dispose();
        panelAnimationDisposers.length = 0;
        for (const dispose of cardAnimationDisposers) dispose();
        cardAnimationDisposers.length = 0;
        // blob: URLs need an explicit revoke; data: URLs just drop the ref.
        for (const url of imageCache.values()) {
          if (url.startsWith("blob:")) {
            try {
              URL.revokeObjectURL(url);
            } catch {
              /* revocation is best-effort */
            }
          }
        }
        imageCache.clear();
      };
    },
  });
}
