import type {
  RendererSettingsPageDefinition,
  RendererSettingsPageMountContext,
} from "./core.js";
import type { RendererSettingsMessages } from "./localization.js";

export interface RendererCollaborationPreferences {
  collaboration: boolean;
  agentTeam: boolean;
}

export interface RendererCollaborationClient {
  getCollaborationPreferences(): Promise<RendererCollaborationPreferences>;
  saveCollaborationPreferences(
    input: Partial<RendererCollaborationPreferences>,
  ): Promise<RendererCollaborationPreferences>;
}

interface ToggleSpec {
  readonly key: keyof RendererCollaborationPreferences;
  readonly title: string;
  readonly description: string;
}

// 设置 → 协作：多 Agent 协作与 Agent Team 是两个独立开关，默认都开启。
// 关闭多 Agent 协作会一并停用 Agent Team（团队建立在协作运行时之上），
// 界面通过禁用联动明确表达这层依赖。
export function createCollaborationSettingsPage(
  messages: RendererSettingsMessages,
  getClient: () => RendererCollaborationClient | null,
): RendererSettingsPageDefinition {
  const zh = messages.locale === "zh-CN";
  return Object.freeze({
    id: "collaboration",
    label: messages.pageLabels.collaboration,
    icon: "collaboration",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const heading = document.createElement("div");
      heading.className = "settings-section-label";
      heading.textContent = messages.pageLabels.collaboration;

      const panel = document.createElement("section");
      panel.className = "settings-about-panel";
      panel.setAttribute("aria-live", "polite");

      const specs: readonly ToggleSpec[] = [
        {
          key: "collaboration",
          title: zh ? "多 Agent 协作" : "Multi-Agent collaboration",
          description: zh
            ? "在输入框输入 # 选择协同 Harness，主任务可将子任务委派给它们并行执行。"
            : "Type # in the composer to pick collaborator Harnesses; the lead task can delegate subtasks to them.",
        },
        {
          key: "agentTeam",
          title: zh ? "Agent Team" : "Agent Team",
          description: zh
            ? "允许主任务创建持久的多成员团队：共享任务图、成员邮箱与 Team Workbench。依赖多 Agent 协作。"
            : "Let the lead create a persistent named team with a shared task graph, member mailboxes and the Team Workbench. Requires Multi-Agent collaboration.",
        },
      ];

      const inputs = new Map<keyof RendererCollaborationPreferences, HTMLInputElement>();
      for (const spec of specs) {
        const row = document.createElement("label");
        row.className = "settings-collab-toggle";
        const text = document.createElement("span");
        const title = document.createElement("strong");
        title.textContent = spec.title;
        const description = document.createElement("small");
        description.textContent = spec.description;
        text.append(title, description);
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = true;
        input.disabled = true;
        input.setAttribute("aria-label", spec.title);
        inputs.set(spec.key, input);
        row.append(text, input);
        panel.append(row);
      }

      const status = document.createElement("p");
      status.className = "settings-update-summary";
      panel.append(status);
      context.content.append(heading, panel);

      let current: RendererCollaborationPreferences = { collaboration: true, agentTeam: true };
      const syncInputs = () => {
        for (const [key, input] of inputs) input.checked = current[key];
        // Agent Team 依附于协作运行时：协作关闭时团队开关一并禁用
        const team = inputs.get("agentTeam");
        if (team) team.disabled = !current.collaboration;
      };

      const client = getClient();
      if (!client) {
        status.textContent = zh ? "当前 Host 不支持协作开关。" : "Collaboration preferences are unavailable on this Host.";
        return undefined;
      }

      const saving = new Set<keyof RendererCollaborationPreferences>();
      for (const spec of specs) {
        const input = inputs.get(spec.key)!;
        input.addEventListener("change", () => {
          if (saving.has(spec.key)) return;
          saving.add(spec.key);
          input.disabled = true;
          const patch = { [spec.key]: input.checked };
          void context.runLatest(() => client.saveCollaborationPreferences(patch), {
            success(value) {
              saving.delete(spec.key);
              current = value;
              syncInputs();
              status.textContent = "";
            },
            failure(error) {
              saving.delete(spec.key);
              syncInputs();
              status.textContent = error instanceof Error ? error.message : String(error);
            },
          });
        });
      }

      void context.runLatest(() => client.getCollaborationPreferences(), {
        success(value) {
          current = value;
          syncInputs();
        },
        failure(error) {
          status.textContent = error instanceof Error ? error.message : String(error);
        },
      });
      return undefined;
    },
  });
}
