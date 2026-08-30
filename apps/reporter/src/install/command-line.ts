import { hostname } from "node:os";
import { parseArgs } from "node:util";

import { installableAgentKinds } from "@agent-lantern/integrations";
import type { AgentKind } from "@agent-lantern/protocol";

export interface InstallOptions {
  command: "install" | "uninstall";
  agentKinds: AgentKind[];
  scope: "user" | "project";
  projectDirectory: string;
  commandPath: string | undefined;
  daemonEndpoint: string | undefined;
  token: string | undefined;
  hostName: string;
  writeEnvironmentFile: boolean;
  verifyConnection: boolean;
  dryRun: boolean;
}

export const installUsage = `用法：
  agent-status-reporter install   [選項]   把 hook 合併寫入 Codex / Claude Code 設定
  agent-status-reporter uninstall [選項]   只移除 Agent Lantern 加入的 hook

install 選項：
  --endpoint <url>          daemon endpoint，例如 http://100.80.10.15:48123
  --token <token>           與 Windows daemon 相同的 token
  --token-stdin             從標準輸入讀一行當作 token，避免出現在 shell 歷史
  --host-name <name>        overlay 上顯示的主機名稱（預設：${hostname()}）
  --agent <codex|claude>    可重複指定；預設兩者都裝
  --scope <user|project>    寫入使用者層級或專案層級設定（預設 user）
  --project-directory <dir> --scope project 時的專案根目錄（預設目前目錄）
  --command-path <path>     hook 內要呼叫的 reporter 絕對路徑
  --skip-environment        不要動 ~/.config/agent-lantern/environment
  --skip-verify             跳過 /health 與測試事件
  --dry-run                 只顯示將要變更的內容，不寫入任何檔案

uninstall 額外行為：
  預設同時清掉 environment 檔中的 Agent Lantern 設定；加上 --skip-environment 可保留。`;

function parseAgentKinds(values: string[] | undefined): AgentKind[] {
  if (!values || values.length === 0) {
    return [...installableAgentKinds];
  }

  const selected = new Set<AgentKind>();
  for (const rawValue of values) {
    for (const part of rawValue.split(",")) {
      const value = part.trim();
      if (value === "") {
        continue;
      }
      if (value === "all") {
        for (const kind of installableAgentKinds) {
          selected.add(kind);
        }
        continue;
      }
      const match = installableAgentKinds.find((kind) => kind === value);
      if (!match) {
        throw new Error(
          `--agent 只接受 ${installableAgentKinds.join("、")} 或 all，收到 "${value}"。`,
        );
      }
      selected.add(match);
    }
  }

  if (selected.size === 0) {
    throw new Error("--agent 至少要指定一個代理程式。");
  }
  return [...selected];
}

export function parseInstallCommandLine(
  command: "install" | "uninstall",
  argumentValues: string[],
  environment: NodeJS.ProcessEnv,
  tokenFromStandardInput: string | undefined,
): InstallOptions {
  const parsedArguments = parseArgs({
    args: argumentValues,
    options: {
      endpoint: { type: "string" },
      "daemon-endpoint": { type: "string" },
      token: { type: "string" },
      "token-stdin": { type: "boolean", default: false },
      "host-name": { type: "string" },
      agent: { type: "string", multiple: true },
      scope: { type: "string" },
      "project-directory": { type: "string" },
      "command-path": { type: "string" },
      "skip-environment": { type: "boolean", default: false },
      "skip-verify": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  const scopeValue = parsedArguments.values.scope ?? "user";
  if (scopeValue !== "user" && scopeValue !== "project") {
    throw new Error(`--scope 只接受 user 或 project，收到 "${scopeValue}"。`);
  }

  const token = parsedArguments.values["token-stdin"]
    ? tokenFromStandardInput
    : (parsedArguments.values.token ?? environment.AGENT_LANTERN_TOKEN);

  if (parsedArguments.values["token-stdin"] && !token) {
    throw new Error("--token-stdin 沒有從標準輸入讀到 token。");
  }

  return {
    command,
    agentKinds: parseAgentKinds(parsedArguments.values.agent),
    scope: scopeValue,
    projectDirectory:
      parsedArguments.values["project-directory"] ?? process.cwd(),
    commandPath: parsedArguments.values["command-path"],
    daemonEndpoint: (
      parsedArguments.values.endpoint ??
      parsedArguments.values["daemon-endpoint"] ??
      environment.AGENT_LANTERN_DAEMON_ENDPOINT
    )?.replace(/\/$/, ""),
    token,
    hostName:
      parsedArguments.values["host-name"] ??
      environment.AGENT_LANTERN_HOST_NAME ??
      hostname(),
    writeEnvironmentFile: !parsedArguments.values["skip-environment"],
    verifyConnection: !parsedArguments.values["skip-verify"],
    dryRun: parsedArguments.values["dry-run"],
  };
}
