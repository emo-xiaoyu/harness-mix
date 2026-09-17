import type { RendererSettingsMessages } from "./localization.js";
import type {
  RendererSettingsPageDefinition,
  RendererSettingsPageMountContext,
} from "./core.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererPetsClient, RendererPetItem } from "./pets-client.js";

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
  },
} as const;

type PetTab = "all" | "official" | "community" | "installed";
type PetOperation = "install" | "uninstall";
type PetOperationState =
  | { readonly status: "installing" | "uninstalling" }
  | { readonly status: "failed"; readonly op: PetOperation; readonly error: string };

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

  const parentCard = element.closest(".pet-card");
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

      context.content.append(heading, intro, safety, toolbar, grid);

      let allPets: RendererPetItem[] = [];
      const imageCache = new Map<string, string>(); // id -> dataUrl / url
      // 每个 pet 的操作状态机：installing / uninstalling / failed（含错误与失败操作类型）
      const petStates = new Map<string, PetOperationState>();
      // 渲染世代：重渲染后让在途的 preview 回调失效，避免给已分离的 DOM 节点挂动画
      let renderEpoch = 0;

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
        const onSuccess = () => settle(op === "install", null);
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
            b.textContent =
              opState.op === "install" ? copy.installFailed : copy.uninstallFailed;
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

          if (opState?.status === "installing" || opState?.status === "uninstalling") {
            // 操作进行中：按钮禁用，防止重复点击（runPetOperation 内还有 petStates 防重入）
            const busyBtn = document.createElement("button");
            busyBtn.type = "button";
            busyBtn.className =
              opState.status === "installing"
                ? "pet-btn pet-btn--primary"
                : "pet-btn pet-btn--danger";
            busyBtn.disabled = true;
            busyBtn.textContent =
              opState.status === "installing" ? copy.installing : copy.uninstalling;
            actions.append(busyBtn);
          } else if (opState?.status === "failed") {
            // 失败后错误显示在卡片内，重试按钮恢复对应操作
            const retryBtn = document.createElement("button");
            retryBtn.type = "button";
            retryBtn.className =
              opState.op === "install"
                ? "pet-btn pet-btn--primary"
                : "pet-btn pet-btn--danger";
            retryBtn.textContent = copy.retry;
            retryBtn.addEventListener("click", () => runPetOperation(pet, opState.op));
            actions.append(retryBtn);
          } else if (pet.installed) {
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
            statusLine.textContent =
              opState.status === "installing" ? copy.installing : copy.uninstalling;
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
      }

      return () => {
        renderEpoch += 1; // 使在途 preview 回调失效
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
