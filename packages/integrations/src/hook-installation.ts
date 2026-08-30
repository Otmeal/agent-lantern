import type { AgentKind } from "@agent-lantern/protocol";

/**
 * Codex 與 Claude Code 的 command hook 使用同一種結構，因此安裝器只需要一份
 * 合併演算法。這個模組是 hook 檔案格式的唯一來源；reporter 的 install 命令與
 * examples/integrations 下的範例都由此產生。
 */

export interface HookCommandDefinition {
  type: "command";
  command: string;
  timeout: number;
  async?: boolean;
}

export interface HookGroupDefinition {
  matcher?: string;
  hooks: HookCommandDefinition[];
}

export interface HookInstallationPlan {
  agentKind: AgentKind;
  displayName: string;
  /** 使用者層級設定檔，相對於 home 目錄。 */
  userConfigurationPath: readonly string[];
  /** 專案層級設定檔，相對於 workspace 根目錄。 */
  projectConfigurationPath: readonly string[];
  /** 從文件根節點走到 event map 的鍵路徑。 */
  hooksContainerPath: readonly string[];
  /** 只有在建立全新設定檔時才會寫入的預設欄位。 */
  documentDefaults: Readonly<Record<string, unknown>>;
  events: Readonly<Record<string, readonly HookGroupDefinition[]>>;
}

export const reporterCommandName = "agent-status-reporter";

interface EventTemplate {
  event: string;
  matcher?: string;
  timeout: number;
  async: boolean;
}

const codexEventTemplates: readonly EventTemplate[] = [
  { event: "SessionStart", timeout: 5, async: true },
  { event: "UserPromptSubmit", timeout: 5, async: true },
  { event: "PreToolUse", timeout: 5, async: true },
  { event: "PermissionRequest", timeout: 5, async: true },
  { event: "Stop", timeout: 5, async: true },
  { event: "SessionEnd", timeout: 3, async: false },
];

const claudeEventTemplates: readonly EventTemplate[] = [
  { event: "SessionStart", matcher: "", timeout: 5, async: true },
  { event: "UserPromptSubmit", matcher: "", timeout: 5, async: true },
  { event: "PreToolUse", matcher: "", timeout: 5, async: true },
  { event: "PermissionRequest", matcher: "", timeout: 5, async: true },
  {
    event: "Notification",
    matcher: "permission_prompt|idle_prompt|agent_needs_input",
    timeout: 5,
    async: true,
  },
  { event: "Stop", matcher: "", timeout: 5, async: true },
  { event: "StopFailure", matcher: "", timeout: 5, async: true },
  { event: "SessionEnd", matcher: "", timeout: 5, async: true },
];

const needsQuotingPattern = /[\s"'\\$`]/;
const quotableCharacterPattern = /(["\\$`])/g;

/**
 * 把安裝路徑包成可以直接放進 shell command 的字串。hook command 由代理程式交給
 * shell 執行，因此含有空白的路徑必須加引號。
 */
export function quoteCommandPath(commandPath: string): string {
  if (!needsQuotingPattern.test(commandPath)) {
    return commandPath;
  }
  return `"${commandPath.replace(quotableCharacterPattern, "\\$1")}"`;
}

function buildEvents(
  agentKind: AgentKind,
  templates: readonly EventTemplate[],
  commandPath: string,
): Record<string, HookGroupDefinition[]> {
  const command = `${quoteCommandPath(commandPath)} hook --agent ${agentKind}`;
  const events: Record<string, HookGroupDefinition[]> = {};

  for (const template of templates) {
    const hookCommand: HookCommandDefinition = {
      type: "command",
      command,
      timeout: template.timeout,
      ...(template.async ? { async: true } : {}),
    };
    events[template.event] = [
      {
        ...(template.matcher === undefined
          ? {}
          : { matcher: template.matcher }),
        hooks: [hookCommand],
      },
    ];
  }

  return events;
}

export interface HookInstallationPlanOptions {
  /**
   * reporter 執行檔的位置。若 `agent-status-reporter` 已經在代理程式看得到的
   * PATH 上就可以省略；否則傳入絕對路徑比較可靠。
   */
  commandPath?: string;
}

export function buildHookInstallationPlan(
  agentKind: AgentKind,
  options: HookInstallationPlanOptions = {},
): HookInstallationPlan {
  const commandPath = options.commandPath ?? reporterCommandName;

  if (agentKind === "codex") {
    return {
      agentKind,
      displayName: "Codex",
      userConfigurationPath: [".codex", "hooks.json"],
      projectConfigurationPath: [".codex", "hooks.json"],
      hooksContainerPath: ["hooks"],
      documentDefaults: {
        description: "Report Codex lifecycle events to Agent Lantern.",
      },
      events: buildEvents("codex", codexEventTemplates, commandPath),
    };
  }

  if (agentKind === "claude") {
    return {
      agentKind,
      displayName: "Claude Code",
      userConfigurationPath: [".claude", "settings.json"],
      projectConfigurationPath: [".claude", "settings.json"],
      hooksContainerPath: ["hooks"],
      documentDefaults: {},
      events: buildEvents("claude", claudeEventTemplates, commandPath),
    };
  }

  throw new Error(`No hook installation plan is defined for ${agentKind}.`);
}

export const installableAgentKinds: readonly AgentKind[] = ["codex", "claude"];

const reporterCommandPattern =
  /(^|[\s"'/\\])agent-status-reporter(\.(cmd|exe|ps1))?($|[\s"'])/;

/**
 * 判斷既有設定檔中的某個 command 是否由 Agent Lantern 管理。安裝與移除都只會
 * 動到符合這個判斷的項目，使用者自己的 hook 一律原封不動保留。
 */
export function isReporterHookCommand(command: unknown): boolean {
  return typeof command === "string" && reporterCommandPattern.test(command);
}

/**
 * 產生可直接寫成 examples/integrations 範例檔的完整文件，方便使用者在不安裝
 * reporter 的情況下也能手動比對要合併哪些內容。
 */
export function buildExampleDocument(
  agentKind: AgentKind,
  options: HookInstallationPlanOptions = {},
): Record<string, unknown> {
  const plan = buildHookInstallationPlan(agentKind, options);
  return { ...plan.documentDefaults, hooks: plan.events };
}
