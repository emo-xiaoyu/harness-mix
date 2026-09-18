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

const COPY = {
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

type PetTab = "all" | "official" | "community" | "installed";
type PetOperation = "install" | "uninstall" | "select";
type PetOperationState =
  | { readonly status: "installing" | "uninstalling" | "selecting" }
  | { readonly status: "failed"; readonly op: PetOperation; readonly error: string };

function petOperationBusyLabel(
  status: "installing" | "uninstalling" | "selecting",
  copy: (typeof COPY)[keyof typeof COPY],
): string {
  if (status === "installing") return copy.installing;
  if (status === "uninstalling") return copy.uninstalling;
  return copy.usingPet;
}

function petOperationFailedLabel(
  op: PetOperation,
  copy: (typeof COPY)[keyof typeof COPY],
): string {
  if (op === "install") return copy.installFailed;
  if (op === "uninstall") return copy.uninstallFailed;
  return copy.selectFailed;
}

const SPRITE_COLUMNS = 8;
const SPRITE_FRAMES = 6;
const FRAME_DURATION_MS = 220;

function setupSpriteAnimation(
  element: HTMLElement,
  imageUrl: string,
  spriteVersion = 2,
): () => void {
  const rows = spriteVersion === 1 ? 9 : 11;
  element.style.backgroundImage = `url("${imageUrl}")`;
  element.style.backgroundSize = `${SPRITE_COLUMNS * 100}% ${rows * 100}%`;
  element.style.backgroundPosition = "0% 0%";

  let currentFrame = 0;
  let timer: number | null = null;
  let idleTimeout: number | null = null;
  let isHovered = false;

  const tick = () => {
    currentFrame = (currentFrame + 1) % SPRITE_FRAMES;
    const posX = (currentFrame / (SPRITE_COLUMNS - 1)) * 100;
    element.style.backgroundPosition = `${posX}% 0%`;
  };

  const startLoop = () => {
    if (timer !== null) return;
    timer = window.setInterval(tick, FRAME_DURATION_MS);
  };

  const stopLoop = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (!isHovered) {
      currentFrame = 0;
      element.style.backgroundPosition = "0% 0%";
    }
  };

  const onMouseEnter = () => {
    isHovered = true;
    startLoop();
  };

  const onMouseLeave = () => {
    isHovered = false;
    stopLoop();
  };

  const parentCard = element.closest(".pet-card, .pet-current");
  if (parentCard) {
    parentCard.addEventListener("mouseenter", onMouseEnter);
    parentCard.addEventListener("mouseleave", onMouseLeave);
  }

  // Periodic idle blink/movement every few seconds
  const idleInterval = window.setInterval(() => {
    if (!isHovered && timer === null) {
      startLoop();
      if (idleTimeout !== null) window.clearTimeout(idleTimeout);
      idleTimeout = window.setTimeout(() => {
        idleTimeout = null;
        stopLoop();
      }, FRAME_DURATION_MS * SPRITE_FRAMES);
    }
  }, 4000 + Math.random() * 3000);

  return () => {
    stopLoop();
    clearInterval(idleInterval);
    if (idleTimeout !== null) {
      window.clearTimeout(idleTimeout);
      idleTimeout = null;
    }
    if (parentCard) {
      parentCard.removeEventListener("mouseenter", onMouseEnter);
      parentCard.removeEventListener("mouseleave", onMouseLeave);
    }
  };
}

export function createPetSettingsPage(
  messages: RendererSettingsMessages,
  getClient: () => RendererPetsClient | null,
): RendererSettingsPageDefinition {
  const copy = COPY[messages.locale];

  return Object.freeze({
    id: "pets",
    label: messages.pageLabels.pets,
    icon: "pets",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const disposers: Array<() => void> = [];

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

      // 当前桌宠面板（Harness Mix 本地选择状态驱动的展示面，置顶显示）
      const currentPanel = document.createElement("section");
      currentPanel.className = "pet-current";
      currentPanel.dataset.active = "false";

      // Toolbar: tabs + search
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

      let allPets: RendererPetItem[] = [];
      const imageCache = new Map<string, string>(); // id -> dataUrl / url
      // 每个 pet 的操作状态机：installing / uninstalling / selecting / failed（含错误与失败操作类型）
      const petStates = new Map<string, PetOperationState>();
      // 渲染世代：重渲染后让在途的 preview 回调失效，避免给已分离的 DOM 节点挂动画
      let renderEpoch = 0;
      // 当前桌宠面板状态：选择结果 + 隐藏操作进行中 + 面板级错误（选择失败显示在卡片内）
      let currentSelection: RendererPetSelection = { id: null };
      let selectionReady = false;
      let hidePending = false;
      let panelError: string | null = null;
      let panelEpoch = 0;
      const panelDisposers: Array<() => void> = [];

      const runPetOperation = (pet: RendererPetItem, op: PetOperation) => {
        const client = getClient();
        const current = petStates.get(pet.id);
        // 操作进行中禁止重复触发；failed 状态允许重试
        if (!client || (current && current.status !== "failed")) return;
        petStates.set(pet.id, {
          status: op === "install" ? "installing" : "uninstalling",
        });
        renderGrid();
        const settle = (installed: boolean, failure: string | null) => {
          if (failure === null) {
            petStates.delete(pet.id);
          } else {
            petStates.set(pet.id, { status: "failed", op, error: failure });
          }
          allPets = allPets.map((p) =>
            p.id === pet.id ? { ...p, installed } : p,
          );
          renderGrid();
        };
        const onSuccess = () => {
          settle(op === "install", null);
          // 卸载当前选中的桌宠：Host 端已自动清除持久化选择，这里同步面板与悬浮层
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

      const renderGrid = () => {
        renderEpoch += 1;
        const epoch = renderEpoch;
        // Clear previous animations
        for (const d of disposers) d();
        disposers.length = 0;
        grid.replaceChildren();

        const query = searchQuery.trim().toLowerCase();
        const filtered = allPets.filter((pet) => {
          if (activeTab === "official" && pet.source !== "official") return false;
          if (activeTab === "community" && pet.source !== "community") return false;
          if (activeTab === "installed" && !pet.installed) return false;
          if (query) {
            const matchesName = pet.displayName.toLowerCase().includes(query);
            const matchesDesc = (pet.description || "").toLowerCase().includes(query);
            const matchesId = pet.id.toLowerCase().includes(query);
            if (!matchesName && !matchesDesc && !matchesId) return false;
          }
          return true;
        });

        if (filtered.length === 0) {
          const empty = document.createElement("div");
          empty.className = "pet-market__empty";
          empty.textContent = copy.empty;
          grid.append(empty);
          return;
        }

        for (const pet of filtered) {
          const opState = petStates.get(pet.id);
          const card = document.createElement("article");
          card.className = "pet-card";
          card.dataset.petId = pet.id;
          card.dataset.installed = String(pet.installed);
          if (opState) card.dataset.state = opState.status;

          // Stage
          const stage = document.createElement("div");
          stage.className = "pet-card__stage";

          const sprite = document.createElement("div");
          sprite.className = "pet-card__sprite";
          stage.append(sprite);

          // Body
          const body = document.createElement("div");
          body.className = "pet-card__body";

          const cardHeader = document.createElement("div");
          cardHeader.className = "pet-card__header";

          const title = document.createElement("strong");
          title.className = "pet-card__title";
          title.textContent = pet.displayName;

          const badges = document.createElement("div");
          badges.className = "pet-card__badges";

          if (opState?.status === "failed") {
            const b = document.createElement("span");
            b.className = "pet-card__badge pet-card__badge--failed";
            b.textContent = petOperationFailedLabel(opState.op, copy);
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

          if (pet.installed && currentSelection.id === pet.id && opState?.status !== "failed") {
            const activeBadge = document.createElement("span");
            activeBadge.className = "pet-card__badge pet-card__badge--active";
            activeBadge.textContent = copy.activeBadge;
            badges.append(activeBadge);
          }

          cardHeader.append(title, badges);

          const desc = document.createElement("p");
          desc.className = "pet-card__description";
          desc.textContent = pet.description || "";

          // Footer & Actions
          const footer = document.createElement("div");
          footer.className = "pet-card__footer";

          const hint = document.createElement("span");
          hint.className = "pet-card__dir-hint";
          hint.textContent = copy.tip;

          const actions = document.createElement("div");
          actions.className = "pet-card__actions";

          if (opState && opState.status !== "failed") {
            // 操作进行中：按钮禁用，防止重复点击（runPetOperation/runSelectOperation 内还有 petStates 防重入）
            const busyBtn = document.createElement("button");
            busyBtn.type = "button";
            busyBtn.className =
              opState.status === "uninstalling"
                ? "pet-btn pet-btn--danger"
                : "pet-btn pet-btn--primary";
            busyBtn.disabled = true;
            busyBtn.textContent = petOperationBusyLabel(opState.status, copy);
            actions.append(busyBtn);
          } else if (opState?.status === "failed") {
            // 失败后错误显示在卡片内，重试按钮恢复对应操作
            const retryBtn = document.createElement("button");
            retryBtn.type = "button";
            retryBtn.className =
              opState.op === "uninstall"
                ? "pet-btn pet-btn--danger"
                : "pet-btn pet-btn--primary";
            retryBtn.textContent = copy.retry;
            retryBtn.addEventListener("click", () => {
              if (opState.op === "select") runSelectOperation(pet);
              else runPetOperation(pet, opState.op);
            });
            actions.append(retryBtn);
          } else if (pet.installed) {
            // 已安装：可切换为当前桌宠（已在使用中的不再显示 Use，用 Active 徽标表达）
            if (currentSelection.id !== pet.id) {
              const useBtn = document.createElement("button");
              useBtn.type = "button";
              useBtn.className = "pet-btn pet-btn--primary";
              useBtn.textContent = copy.usePet;
              useBtn.addEventListener("click", () => runSelectOperation(pet));
              actions.append(useBtn);
            }
            const uninstallBtn = document.createElement("button");
            uninstallBtn.type = "button";
            uninstallBtn.className = "pet-btn pet-btn--danger";
            uninstallBtn.textContent = copy.uninstall;
            uninstallBtn.addEventListener("click", () =>
              runPetOperation(pet, "uninstall"),
            );
            actions.append(uninstallBtn);
          } else {
            const installBtn = document.createElement("button");
            installBtn.type = "button";
            installBtn.className = "pet-btn pet-btn--primary";
            installBtn.textContent = copy.install;
            installBtn.addEventListener("click", () =>
              runPetOperation(pet, "install"),
            );
            actions.append(installBtn);
          }

          footer.append(hint, actions);

          // 操作状态/错误显示在卡片内（而非全局弹窗）
          if (opState?.status === "failed") {
            const errorBox = document.createElement("div");
            errorBox.className = "pet-card__error";
            errorBox.textContent = opState.error;
            body.append(cardHeader, desc, errorBox, footer);
          } else if (opState) {
            const statusLine = document.createElement("div");
            statusLine.className = "pet-card__status";
            statusLine.textContent = petOperationBusyLabel(opState.status, copy);
            body.append(cardHeader, desc, statusLine, footer);
          } else {
            body.append(cardHeader, desc, footer);
          }
          card.append(stage, body);
          grid.append(card);

          // Load visual asset（必须在 card 挂载后进行，setupSpriteAnimation 依赖 closest('.pet-card')）
          const cachedImg = imageCache.get(pet.id);
          if (cachedImg) {
            disposers.push(
              setupSpriteAnimation(sprite, cachedImg, pet.spriteVersionNumber),
            );
          } else if (pet.spritesheetUrl) {
            imageCache.set(pet.id, pet.spritesheetUrl);
            disposers.push(
              setupSpriteAnimation(sprite, pet.spritesheetUrl, pet.spriteVersionNumber),
            );
          } else {
            const showStaticPreview = () => {
              if (!pet.previewUrl) return;
              sprite.style.backgroundImage = `url("${pet.previewUrl}")`;
              sprite.style.backgroundSize = "contain";
              sprite.style.backgroundPosition = "center";
            };
            const client = getClient();
            if (client) {
              // Load base64 preview on demand；重渲染/卸载后丢弃过期回调，避免泄漏动画定时器
              void client.preview(pet.id).then(
                (res) => {
                  if (epoch !== renderEpoch || !sprite.isConnected) return;
                  if (res && res.dataBase64) {
                    const dataUrl = `data:${res.mime};base64,${res.dataBase64}`;
                    imageCache.set(pet.id, dataUrl);
                    disposers.push(
                      setupSpriteAnimation(sprite, dataUrl, pet.spriteVersionNumber),
                    );
                  }
                },
                () => {
                  if (epoch !== renderEpoch || !sprite.isConnected) return;
                  showStaticPreview();
                },
              );
            } else {
              showStaticPreview();
            }
          }
        }
      };

      // 当前桌宠面板渲染：空态提示 / 选中态（精灵图动画 + 名称 + 隐藏按钮），面板级错误行
      const renderPanel = () => {
        panelEpoch += 1;
        const epoch = panelEpoch;
        for (const d of panelDisposers) d();
        panelDisposers.length = 0;
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
          const selectionId = currentSelection.id;
          const stage = document.createElement("div");
          stage.className = "pet-current__stage";
          const sprite = document.createElement("div");
          sprite.className = "pet-current__sprite";
          stage.append(sprite);

          const info = document.createElement("div");
          info.className = "pet-current__info";
          const name = document.createElement("strong");
          name.className = "pet-current__name";
          name.textContent = currentSelection.displayName ?? selectionId;
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

          const attachAnimation = (imageUrl: string) => {
            panelDisposers.push(
              setupSpriteAnimation(sprite, imageUrl, currentSelection.spriteVersionNumber),
            );
          };
          const cachedImg = imageCache.get(selectionId);
          if (cachedImg) {
            attachAnimation(cachedImg);
          } else {
            const client = getClient();
            if (client) {
              // 与卡片一致的按需加载；面板重渲染/页面卸载后丢弃过期回调
              void client.preview(selectionId).then(
                (res) => {
                  if (epoch !== panelEpoch || !sprite.isConnected) return;
                  if (res && res.dataBase64) {
                    const dataUrl = `data:${res.mime};base64,${res.dataBase64}`;
                    imageCache.set(selectionId, dataUrl);
                    attachAnimation(dataUrl);
                  }
                },
                () => {
                  /* 预览加载失败仅影响动画，面板文字信息仍有效 */
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

      // 选择变更的统一入口：更新面板与卡片徽标
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
        const current = petStates.get(pet.id);
        // 操作进行中禁止重复触发；failed 状态允许重试；当前选中的 pet 无需再选
        if (!client || !pet.installed || (current && current.status !== "failed")) return;
        if (currentSelection.id === pet.id) return;
        petStates.set(pet.id, { status: "selecting" });
        renderGrid();
        // 先通过 DOM 自动化切换 Codex 官方桌宠（应用自己的点击链路，不碰账号 API），
        // 确认成功后写入 Harness Mix 本地记录（驱动面板与徽标）
        void switchOfficialCodexPet({ id: pet.id, displayName: pet.displayName })
          .then(() => client.select(pet.id))
          .then(
            (result) => {
              // 切换耗时数秒，页面可能已经卸载：中止后不再触碰已分离的 DOM
              if (context.signal.aborted) return;
              petStates.delete(pet.id);
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
              petStates.set(pet.id, {
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

      // Fetch catalog
      const client = getClient();
      renderPanel(); // 首次渲染（空态），随后拉取选择填充
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
        // 拉取当前选择填充面板；若期间用户已完成一次切换（panelEpoch 变化），丢弃过期结果
        const selectionFetchEpoch = panelEpoch;
        void client.selection().then(
          (result) => {
            if (selectionFetchEpoch !== panelEpoch) return;
            currentSelection = normalizeRendererPetSelection(result);
            selectionReady = true;
            renderPanel();
            renderGrid(); // 卡片的 Active 徽标 / Use 按钮依赖 currentSelection，需随选择到位重渲染
          },
          () => {
            if (selectionFetchEpoch !== panelEpoch) return;
            selectionReady = true;
            renderPanel();
          },
        );
      }

      return () => {
        renderEpoch += 1; // 使在途 preview 回调失效
        panelEpoch += 1; // 面板动画与在途 selection/preview 回调一并失效
        for (const d of panelDisposers) d();
        panelDisposers.length = 0;
        for (const d of disposers) d();
        disposers.length = 0;
        // 释放图片缓存（blob: URL 需要显式 revoke；data: URL 仅释放引用）
        for (const url of imageCache.values()) {
          if (url.startsWith("blob:")) {
            try {
              URL.revokeObjectURL(url);
            } catch {
              /* 忽略撤销失败 */
            }
          }
        }
        imageCache.clear();
      };
    },
  });
}
