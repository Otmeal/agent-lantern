import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { homedir, hostname } from "node:os";
import { delimiter, join, resolve } from "node:path";

import {
  buildHookInstallationPlan,
  reporterCommandName,
} from "@agent-lantern/integrations";
import { normalizedAgentEventSchema } from "@agent-lantern/protocol";

import type { ReporterDestination } from "../destinations.js";
import {
  collectDestinations,
  destinationKeysIn,
  parseSlotFromKey,
} from "../destinations.js";
import type { InstallOptions } from "./command-line.js";
import { planDestinationEnvironment } from "./destination-plan.js";
import {
  assignmentPattern,
  mergeEnvironmentFile,
  removeEnvironmentKeys,
  stripMatchingQuotes,
} from "./environment-file.js";
import {
  formatJsonDocument,
  readJsonFileIfPresent,
  readTextFileIfPresent,
  writeFileWithBackup,
} from "./file-io.js";
import { mergeHookDocument, removeHookDocument } from "./hook-merge.js";

/**
 * 掃過檔案內容找出目前實際存在的目的地鍵（含編號後綴），uninstall 才能把它們
 * 一併清乾淨，而不是只認得未編號的第一組。
 */
export function managedEnvironmentKeysIn(
  content: string | undefined,
): string[] {
  const keys = new Set<string>();
  for (const line of (content ?? "").split(/\r?\n/)) {
    const match = assignmentPattern.exec(line);
    const key = match?.[2];
    if (key && parseSlotFromKey(key) !== undefined) {
      keys.add(key);
    }
  }
  keys.add("AGENT_LANTERN_HOST_NAME");
  return [...keys];
}

/**
 * 純粹解析成鍵值對，不像 loadReporterEnvironment 會混入 process.env，
 * 這裡只需要判斷「檔案裡目前寫了哪些目的地」。
 */
export function parseEnvironmentAssignments(
  content: string | undefined,
): NodeJS.ProcessEnv {
  const values: NodeJS.ProcessEnv = {};
  for (const line of (content ?? "").split(/\r?\n/)) {
    const match = assignmentPattern.exec(line);
    const key = match?.[2];
    if (!key) {
      continue;
    }
    values[key] = stripMatchingQuotes(match[4] ?? "");
  }
  return values;
}

function environmentFilePath(
  processEnvironment: NodeJS.ProcessEnv = process.env,
): string {
  const configurationHome =
    processEnvironment.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configurationHome, "agent-lantern", "environment");
}

function hookFilePath(
  options: InstallOptions,
  relativePath: readonly string[],
): string {
  const root =
    options.scope === "user" ? homedir() : resolve(options.projectDirectory);
  return join(root, ...relativePath);
}

/**
 * hook command 由代理程式交給 shell 執行，PATH 不一定和目前這個 shell 相同。
 * 找不到執行檔時提醒使用者改用 --command-path，而不是安裝完才靜靜失效。
 */
function findExecutableOnPath(
  commandName: string,
  processEnvironment: NodeJS.ProcessEnv,
): string | undefined {
  const pathValue = processEnvironment.PATH ?? processEnvironment.Path;
  if (!pathValue) {
    return undefined;
  }

  for (const directory of pathValue.split(delimiter)) {
    if (directory === "") {
      continue;
    }
    const candidate = join(directory, commandName);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function fetchDaemon(
  url: string,
  init: RequestInit,
  description: string,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `連不上 ${url}（${description}）：${reason}
請依序確認：
  1. Windows 上的 overlay 正在執行，daemon 有在監聽這個連接埠。
  2. 這個位址從本機連得到。WSL 若使用 mirrored networking，無法用 Windows
     自己的 LAN / Tailscale IP，請把 endpoint 改成 http://localhost:<port>。
  3. Windows 防火牆允許該連接埠的輸入連線。
設定檔已經寫好了，修正連線後可以加上 --skip-install 重跑來驗證。`,
    );
  }
}

async function verifyDaemonConnection(
  daemonEndpoint: string,
  token: string,
  hostName: string,
): Promise<void> {
  const healthResponse = await fetchDaemon(
    `${daemonEndpoint}/health`,
    { signal: AbortSignal.timeout(5_000) },
    "健康檢查",
  );
  if (!healthResponse.ok) {
    throw new Error(
      `daemon ${daemonEndpoint}/health 回應 ${healthResponse.status}。請確認 overlay 已啟動、endpoint 與防火牆設定正確。`,
    );
  }

  const workspacePath = process.cwd();
  const event = normalizedAgentEventSchema.parse({
    schemaVersion: 1,
    eventIdentifier: randomUUID(),
    occurredAt: new Date().toISOString(),
    eventType: "manual.status",
    status: "completed",
    agent: { kind: "custom", displayName: "Custom agent" },
    host: { name: hostName },
    workspace: { path: workspacePath, name: "agent-lantern-install" },
    session: { identifier: `install-${process.pid}` },
    message: "安裝驗證",
    metadata: {},
  });

  const eventResponse = await fetchDaemon(
    `${daemonEndpoint}/api/v1/events`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5_000),
    },
    "測試事件",
  );

  if (!eventResponse.ok) {
    const responseText = await eventResponse.text();
    throw new Error(
      `daemon 拒絕測試事件（${eventResponse.status}）：${responseText}。token 可能與 Windows 上的不一致。`,
    );
  }
}

async function runInstall(options: InstallOptions): Promise<void> {
  const prefix = options.dryRun ? "[dry-run] " : "";
  const lines: string[] = [];

  // sudo 會把 HOME 換成 /root，hook 與 environment 就會寫到 root 的家目錄，
  // 而代理程式通常是以原本的使用者身分執行，根本讀不到。
  const sudoUser = process.env.SUDO_USER;
  if (process.getuid?.() === 0 && sudoUser) {
    lines.push(
      `注意：目前透過 sudo 以 root 執行，設定會寫進 ${homedir()}，` +
        `而不是 ${sudoUser} 的家目錄。若 Codex / Claude Code 是以 ${sudoUser} ` +
        `執行，請不要加 sudo 重跑一次（reporter 已安裝好，可加 --skip-install）。`,
    );
  }

  if (options.commandPath === undefined) {
    const resolved = findExecutableOnPath(reporterCommandName, process.env);
    if (resolved) {
      lines.push(`reporter 執行檔：${resolved}（hook 以 PATH 呼叫）`);
    } else {
      lines.push(
        `注意：目前的 PATH 找不到 ${reporterCommandName}。若代理程式啟動時 PATH 不同，請改用 --command-path <絕對路徑> 重新安裝。`,
      );
    }
  } else {
    lines.push(`reporter 執行檔：${options.commandPath}（寫入絕對路徑）`);
  }

  // 1. environment 檔（合併寫入，只更新 Agent Lantern 的鍵，可能對應多台 daemon）。
  const environmentPath = environmentFilePath();
  // 只帶一台 endpoint 重跑 install 時，設定檔裡原本那幾台仍然要一起驗證，
  // 否則畫面會說「已寫入 3 個目的地」卻只驗了一個。
  let destinationsToVerify: readonly ReporterDestination[] =
    options.destinations;
  if (options.writeEnvironmentFile) {
    if (options.destinations.length === 0) {
      throw new Error(
        "缺少連線資訊。請加上 --endpoint 與 --token（可在 overlay 的「設定」面板複製），或改用 --skip-environment。",
      );
    }

    const existingContent = await readTextFileIfPresent(environmentPath);
    const existingEnvironment = parseEnvironmentAssignments(existingContent);

    // collectDestinations 不會因為單一槽位設定不良就整批丟出，problems 逐筆
    // 印出來讓使用者看得到，而不是像過去的 try/catch 那樣把真正的 bug 也一起
    // 吞掉、只留下「視為沒有既有目的地」造成孤兒鍵殘留。
    const { destinations: existingDestinations, problems } =
      collectDestinations(existingEnvironment);
    for (const problem of problems) {
      lines.push(`注意：${problem.message}`);
    }
    const existingKeys = destinationKeysIn(existingEnvironment);

    const plan = planDestinationEnvironment({
      existingDestinations,
      existingKeys,
      incoming: options.destinations,
      replace: options.replaceDestinations,
    });

    const removal =
      plan.staleKeys.length > 0
        ? removeEnvironmentKeys(existingContent, plan.staleKeys)
        : undefined;
    const merged = mergeEnvironmentFile(removal?.content ?? existingContent, {
      ...plan.desiredValues,
      AGENT_LANTERN_HOST_NAME: options.hostName,
    });
    const changed = (removal?.changed ?? false) || merged.changed;
    destinationsToVerify = plan.destinations;
    const endpointSummary = plan.destinations
      .map((destination) => destination.endpoint)
      .join("、");
    // --replace 之前先讓使用者從 --dry-run 看出哪些鍵會消失、哪些鍵會被改寫，
    // 不然畫面只報「N 個目的地」看不出實際刪了什麼。
    const removalSummary =
      removal && removal.removedKeys.length > 0
        ? `
  將移除：${removal.removedKeys.join("、")}`
        : "";
    const changesSummary =
      merged.changes.length > 0
        ? `
  將變更的鍵：${merged.changes.map((change) => change.key).join("、")}`
        : "";

    if (!changed) {
      lines.push(`${environmentPath}：內容已是最新，未變更。`);
    } else if (options.dryRun) {
      lines.push(
        `${prefix}${environmentPath}：將寫入 ${plan.destinations.length} 個目的地（${endpointSummary}）。` +
          removalSummary +
          changesSummary,
      );
    } else {
      const written = await writeFileWithBackup(
        environmentPath,
        merged.content,
        { mode: 0o600, createBackup: true },
      );
      lines.push(
        `${environmentPath}：已寫入 ${plan.destinations.length} 個目的地（${endpointSummary}）` +
          (written.backupPath
            ? `（備份：${written.backupPath}）`
            : "（新建）") +
          removalSummary +
          changesSummary,
      );
    }
  } else {
    lines.push(`${environmentPath}：依 --skip-environment 保持原狀。`);
  }

  // 2. hook 設定檔（合併寫入，只動 Agent Lantern 自己的項目）。
  for (const agentKind of options.agentKinds) {
    const plan = buildHookInstallationPlan(agentKind, {
      ...(options.commandPath === undefined
        ? {}
        : { commandPath: options.commandPath }),
    });
    const filePath = hookFilePath(
      options,
      options.scope === "user"
        ? plan.userConfigurationPath
        : plan.projectConfigurationPath,
    );
    const existingDocument = await readJsonFileIfPresent(filePath);
    const merged = mergeHookDocument(existingDocument, plan, filePath);

    const summary = [
      merged.addedEvents.length > 0
        ? `新增 ${merged.addedEvents.length} 個事件`
        : undefined,
      merged.updatedEvents.length > 0
        ? `更新 ${merged.updatedEvents.length} 個事件`
        : undefined,
      merged.unchangedEvents.length > 0
        ? `${merged.unchangedEvents.length} 個事件已是最新`
        : undefined,
    ]
      .filter(Boolean)
      .join("、");

    if (!merged.changed) {
      lines.push(`${plan.displayName} ${filePath}：內容已是最新，未變更。`);
    } else if (options.dryRun) {
      lines.push(`${prefix}${plan.displayName} ${filePath}：${summary}。`);
    } else {
      const written = await writeFileWithBackup(
        filePath,
        formatJsonDocument(merged.document),
        { createBackup: true },
      );
      lines.push(
        `${plan.displayName} ${filePath}：${summary}` +
          (written.backupPath ? `（備份：${written.backupPath}）` : "（新建）"),
      );
    }

    if (merged.preservedForeignHookCount > 0) {
      lines.push(
        `  已原樣保留 ${merged.preservedForeignHookCount} 個非 Agent Lantern 的 hook。`,
      );
    }
  }

  // 寫檔結果先輸出，連線驗證失敗時使用者才知道設定其實已經寫好了。
  console.log(lines.join("\n"));
  lines.length = 0;

  // 3. 連線驗證：多個目的地並行驗證，避免離線的機器一台一台序列等 timeout
  // （3 台離線就要卡約 30 秒）；任一台離線不擋安裝，全部失敗才報錯。輸出順序
  // 仍依 destinationsToVerify 原本的順序，不受完成先後影響。
  if (options.verifyConnection && !options.dryRun) {
    if (destinationsToVerify.length === 0) {
      lines.push("跳過連線驗證：找不到 endpoint 或 token。");
    } else {
      const results = await Promise.all(
        destinationsToVerify.map(async (destination) => {
          try {
            await verifyDaemonConnection(
              destination.endpoint,
              destination.token,
              options.hostName || hostname(),
            );
            return {
              line: `連線驗證成功：${destination.endpoint}，overlay 應出現一張 Custom agent 卡片。`,
              failureMessage: undefined as string | undefined,
            };
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);
            return {
              line: `連線驗證失敗：${destination.endpoint}：${reason}`,
              failureMessage: reason,
            };
          }
        }),
      );

      const failureMessages: string[] = [];
      for (const result of results) {
        lines.push(result.line);
        if (result.failureMessage !== undefined) {
          failureMessages.push(result.failureMessage);
        }
      }
      if (failureMessages.length === destinationsToVerify.length) {
        // 逐台的結果先印出來，否則丟出後使用者只看得到錯誤訊息本身。
        console.log(lines.join("\n"));
        lines.length = 0;
        throw new Error(failureMessages.join("\n\n"));
      }
    }
  } else if (options.verifyConnection) {
    lines.push(`${prefix}跳過連線驗證。`);
  }

  if (lines.length > 0) {
    console.log(lines.join("\n"));
  }
  if (!options.dryRun) {
    console.log(
      "\n請重新啟動 Codex / Claude Code，並執行 /hooks 確認新的 hook 已被信任。",
    );
  }
}

async function runUninstall(options: InstallOptions): Promise<void> {
  const prefix = options.dryRun ? "[dry-run] " : "";
  const lines: string[] = [];

  for (const agentKind of options.agentKinds) {
    const plan = buildHookInstallationPlan(agentKind);
    const filePath = hookFilePath(
      options,
      options.scope === "user"
        ? plan.userConfigurationPath
        : plan.projectConfigurationPath,
    );
    const existingDocument = await readJsonFileIfPresent(filePath);
    if (existingDocument === undefined) {
      lines.push(`${plan.displayName} ${filePath}：檔案不存在，略過。`);
      continue;
    }

    const removal = removeHookDocument(existingDocument, plan, filePath);
    if (!removal.changed) {
      lines.push(
        `${plan.displayName} ${filePath}：沒有 Agent Lantern 的 hook，未變更。`,
      );
      continue;
    }

    if (options.dryRun) {
      lines.push(
        `${prefix}${plan.displayName} ${filePath}：將移除 ${removal.removedHookCount} 個 hook，保留 ${removal.preservedForeignHookCount} 個其他 hook。`,
      );
      continue;
    }

    const written = await writeFileWithBackup(
      filePath,
      formatJsonDocument(removal.document),
      { createBackup: true },
    );
    lines.push(
      `${plan.displayName} ${filePath}：已移除 ${removal.removedHookCount} 個 hook，保留 ${removal.preservedForeignHookCount} 個其他 hook（備份：${written.backupPath}）。`,
    );
  }

  const environmentPath = environmentFilePath();
  if (options.writeEnvironmentFile) {
    const existingContent = await readTextFileIfPresent(environmentPath);
    const removal = removeEnvironmentKeys(
      existingContent,
      managedEnvironmentKeysIn(existingContent),
    );
    if (!removal.changed) {
      lines.push(`${environmentPath}：沒有需要移除的設定。`);
    } else if (options.dryRun) {
      lines.push(
        `${prefix}${environmentPath}：將移除 ${removal.removedKeys.join("、")}。`,
      );
    } else {
      const written = await writeFileWithBackup(
        environmentPath,
        removal.content,
        { mode: 0o600, createBackup: true },
      );
      lines.push(
        `${environmentPath}：已移除 ${removal.removedKeys.join("、")}（備份：${written.backupPath}）。`,
      );
    }
  } else {
    lines.push(`${environmentPath}：依 --skip-environment 保持原狀。`);
  }

  console.log(lines.join("\n"));
}

export async function runInstallCommand(
  options: InstallOptions,
): Promise<void> {
  if (options.command === "install") {
    await runInstall(options);
    return;
  }
  await runUninstall(options);
}
