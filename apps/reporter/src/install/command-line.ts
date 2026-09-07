import { hostname } from "node:os";
import { parseArgs } from "node:util";

import { installableAgentKinds } from "@agent-lantern/integrations";
import type { AgentKind } from "@agent-lantern/protocol";

import type { ReporterDestination } from "../destinations.js";
import { collectDestinations, normalizeEndpoint } from "../destinations.js";

export interface InstallOptions {
  command: "install" | "uninstall";
  agentKinds: AgentKind[];
  scope: "user" | "project";
  projectDirectory: string;
  commandPath: string | undefined;
  destinations: ReporterDestination[];
  replaceDestinations: boolean;
  hostName: string;
  writeEnvironmentFile: boolean;
  verifyConnection: boolean;
  dryRun: boolean;
}

export const installUsage = `用法：
  agent-status-reporter install   [選項]   把 hook 合併寫入 Codex / Claude Code 設定
  agent-status-reporter uninstall [選項]   只移除 Agent Lantern 加入的 hook

install 選項：
  --endpoint <url>          daemon endpoint，可重複指定以送到多台 daemon；
                            預設是新增或更新既有目的地，例如 http://100.80.10.15:48123
  --token <token>           與 daemon 相同的 token；只給一個時套用到所有 --endpoint，
                            數量與 --endpoint 相同時則逐一對應
  --token-stdin             從標準輸入讀一行當作 token，避免出現在 shell 歷史
  --replace                 先清空既有的所有目的地，再寫入這次指定的
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

/**
 * 把 --endpoint／--daemon-endpoint 與 --token 這兩組可重複參數配對成目的地清單。
 * 兩者數量相同時逐一對應；token 只給一個時套用到所有 endpoint；endpoint 是空的
 * 就直接回空陣列，交給呼叫端判斷是否要退回既有設定。
 */
function resolveIncomingDestinations(
  endpoints: string[],
  tokens: string[],
): ReporterDestination[] {
  if (endpoints.length === 0 || tokens.length === 0) {
    return [];
  }
  if (tokens.length === endpoints.length) {
    return endpoints.map((endpoint, index) => ({
      endpoint,
      token: tokens[index]!,
    }));
  }
  if (tokens.length === 1) {
    return endpoints.map((endpoint) => ({ endpoint, token: tokens[0]! }));
  }
  throw new Error(
    `--token 的數量（${tokens.length}）必須是 1 個或與 --endpoint 相同（${endpoints.length}）。`,
  );
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
      endpoint: { type: "string", multiple: true },
      "daemon-endpoint": { type: "string", multiple: true },
      token: { type: "string", multiple: true },
      "token-stdin": { type: "boolean", default: false },
      replace: { type: "boolean", default: false },
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

  const endpointValues = parsedArguments.values.endpoint ?? [];
  const daemonEndpointValues = parsedArguments.values["daemon-endpoint"] ?? [];
  if (endpointValues.length > 0 && daemonEndpointValues.length > 0) {
    // 兩者都給時，命令列上的先後順序無從得知真正的配對關係（例如
    // --daemon-endpoint B --token t1 --endpoint A --token t2 會讓 A 誤配到
    // t1），--daemon-endpoint 只保留作單一別名，混用一律拒絕。
    throw new Error(
      "--endpoint 與 --daemon-endpoint 不能混用，請統一使用 --endpoint。",
    );
  }
  // 顯式給的 endpoint 與「完全沒給、退回環境變數」要分開追蹤：--replace 是否
  // 合法、以及 base token 的退回能否套用，都得看使用者是否真的打了 --endpoint，
  // 不能把退回來的那組也算進去，否則 --replace --host-name 這種打法會誤判成
  // 「有指定 endpoint」而清空既有的其他目的地（問題 C）。
  const explicitEndpoints = [...endpointValues, ...daemonEndpointValues]
    .map((endpoint) => normalizeEndpoint(endpoint))
    .filter((endpoint) => endpoint !== "");
  let endpoints = explicitEndpoints;
  if (endpoints.length === 0 && environment.AGENT_LANTERN_DAEMON_ENDPOINT) {
    endpoints = [normalizeEndpoint(environment.AGENT_LANTERN_DAEMON_ENDPOINT)];
  }

  if (parsedArguments.values.replace && explicitEndpoints.length === 0) {
    throw new Error("--replace 必須至少搭配一個 --endpoint。");
  }

  let tokens: string[];
  if (parsedArguments.values["token-stdin"]) {
    if ((parsedArguments.values.token ?? []).length > 0) {
      // 靜默丟掉顯式 --token 會讓使用者以為 stdin 的 token 套用到全部目的地，
      // 實際上原本要給某台 daemon 的 token 整組不見了，所以直接擋下來。
      throw new Error("--token-stdin 不能與 --token 同時使用。");
    }
    if (!tokenFromStandardInput) {
      throw new Error("--token-stdin 沒有從標準輸入讀到 token。");
    }
    tokens = [tokenFromStandardInput];
  } else {
    tokens = parsedArguments.values.token ?? [];
    if (tokens.length === 0 && environment.AGENT_LANTERN_TOKEN) {
      // base token 只能退回給「設定檔裡已經存在的 endpoint」——多目的地之後，
      // 對一個全新的 endpoint 這麼做等於把既有 daemon 的憑證送到別台主機
      // （問題 B）。新 endpoint 一定要顯式給 token。
      const existingEndpoints = new Set(
        collectDestinations(environment).destinations.map((destination) =>
          normalizeEndpoint(destination.endpoint),
        ),
      );
      const newEndpoints = endpoints.filter(
        (endpoint) => !existingEndpoints.has(endpoint),
      );
      if (newEndpoints.length > 0) {
        throw new Error(
          `${newEndpoints.join("、")} 是新的目的地，請用 --token 或 --token-stdin 指定它的 token。`,
        );
      }
      tokens = [environment.AGENT_LANTERN_TOKEN];
    }
  }

  const destinations = resolveIncomingDestinations(endpoints, tokens);

  return {
    command,
    agentKinds: parseAgentKinds(parsedArguments.values.agent),
    scope: scopeValue,
    projectDirectory:
      parsedArguments.values["project-directory"] ?? process.cwd(),
    commandPath: parsedArguments.values["command-path"],
    destinations,
    replaceDestinations: parsedArguments.values.replace,
    hostName:
      parsedArguments.values["host-name"] ??
      environment.AGENT_LANTERN_HOST_NAME ??
      hostname(),
    writeEnvironmentFile: !parsedArguments.values["skip-environment"],
    verifyConnection: !parsedArguments.values["skip-verify"],
    dryRun: parsedArguments.values["dry-run"],
  };
}
