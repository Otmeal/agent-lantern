import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { homedir, hostname } from "node:os";
import { delimiter, join, resolve } from "node:path";

import {
  buildHookInstallationPlan,
  reporterCommandName,
} from "@agent-lantern/integrations";
import { normalizedAgentEventSchema } from "@agent-lantern/protocol";

import { loadReporterEnvironment } from "../configuration-file.js";
import type { InstallOptions } from "./command-line.js";
import {
  mergeEnvironmentFile,
  removeEnvironmentKeys,
} from "./environment-file.js";
import {
  formatJsonDocument,
  readJsonFileIfPresent,
  readTextFileIfPresent,
  writeFileWithBackup,
} from "./file-io.js";
import { mergeHookDocument, removeHookDocument } from "./hook-merge.js";

const managedEnvironmentKeys = [
  "AGENT_LANTERN_DAEMON_ENDPOINT",
  "AGENT_LANTERN_TOKEN",
  "AGENT_LANTERN_HOST_NAME",
] as const;

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

async function verifyDaemonConnection(
  daemonEndpoint: string,
  token: string,
  hostName: string,
): Promise<void> {
  const healthResponse = await fetch(`${daemonEndpoint}/health`, {
    signal: AbortSignal.timeout(5_000),
  });
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

  const eventResponse = await fetch(`${daemonEndpoint}/api/v1/events`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(5_000),
  });

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

  // 1. environment 檔（合併寫入，只更新 Agent Lantern 的鍵）。
  const environmentPath = environmentFilePath();
  if (options.writeEnvironmentFile) {
    if (!options.daemonEndpoint || !options.token) {
      throw new Error(
        "缺少連線資訊。請加上 --endpoint 與 --token（可在 overlay 的「設定」面板複製），或改用 --skip-environment。",
      );
    }

    const existingContent = await readTextFileIfPresent(environmentPath);
    const merged = mergeEnvironmentFile(existingContent, {
      AGENT_LANTERN_DAEMON_ENDPOINT: options.daemonEndpoint,
      AGENT_LANTERN_TOKEN: options.token,
      AGENT_LANTERN_HOST_NAME: options.hostName,
    });

    if (!merged.changed) {
      lines.push(`${environmentPath}：內容已是最新，未變更。`);
    } else if (options.dryRun) {
      lines.push(
        `${prefix}${environmentPath}：將更新 ${merged.changes.map((change) => change.key).join("、")}。`,
      );
    } else {
      const written = await writeFileWithBackup(
        environmentPath,
        merged.content,
        { mode: 0o600, createBackup: true },
      );
      lines.push(
        `${environmentPath}：已更新 ${merged.changes.map((change) => change.key).join("、")}` +
          (written.backupPath ? `（備份：${written.backupPath}）` : "（新建）"),
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

  // 3. 連線驗證。
  if (options.verifyConnection && !options.dryRun) {
    const environment = await loadReporterEnvironment(process.env);
    const daemonEndpoint = (
      options.daemonEndpoint ?? environment.AGENT_LANTERN_DAEMON_ENDPOINT
    )?.replace(/\/$/, "");
    const token = options.token ?? environment.AGENT_LANTERN_TOKEN;

    if (!daemonEndpoint || !token) {
      lines.push("跳過連線驗證：找不到 endpoint 或 token。");
    } else {
      await verifyDaemonConnection(
        daemonEndpoint,
        token,
        options.hostName || hostname(),
      );
      lines.push(
        `連線驗證成功：${daemonEndpoint}，overlay 應出現一張 Custom agent 卡片。`,
      );
    }
  } else if (options.verifyConnection) {
    lines.push(`${prefix}跳過連線驗證。`);
  }

  console.log(lines.join("\n"));
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
    const removal = removeEnvironmentKeys(existingContent, [
      ...managedEnvironmentKeys,
    ]);
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
