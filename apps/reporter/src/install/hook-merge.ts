import {
  type HookGroupDefinition,
  type HookInstallationPlan,
  isReporterHookCommand,
} from "@agent-lantern/integrations";

/**
 * 合併策略：只有「由 Agent Lantern 管理」的 hook 項目會被新增、更新或移除，
 * 使用者原本寫在同一份設定檔中的任何欄位、事件、matcher 與 hook 一律原樣保留。
 *
 * 每個事件的處理順序是「先移除舊的 reporter 項目、再插入目前版本」，因此重複
 * 執行安裝不會產生重複項目，也能在 reporter 安裝路徑或事件清單改變時自動收斂。
 */

export interface HookMergeResult {
  document: Record<string, unknown>;
  changed: boolean;
  /** 這次才新增 reporter hook 的事件名稱。 */
  addedEvents: string[];
  /** 原本就有 reporter hook、這次內容被更新的事件名稱。 */
  updatedEvents: string[];
  /** 已經是目標狀態、完全沒有變動的事件名稱。 */
  unchangedEvents: string[];
  /** 保留下來、不屬於 Agent Lantern 的 hook 項目數量。 */
  preservedForeignHookCount: number;
}

export interface HookRemovalResult {
  document: Record<string, unknown>;
  changed: boolean;
  removedHookCount: number;
  preservedForeignHookCount: number;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

function normalizeMatcher(group: unknown): string {
  if (!isJsonObject(group)) {
    return "";
  }
  const matcher = group.matcher;
  return typeof matcher === "string" ? matcher : "";
}

/**
 * 走訪（必要時建立）事件 map 所在的物件。遇到型別不符的既有值直接失敗，
 * 而不是覆蓋使用者的資料。
 */
function resolveHooksContainer(
  document: JsonObject,
  containerPath: readonly string[],
  filePath: string,
): JsonObject {
  let cursor: JsonObject = document;
  const walked: string[] = [];

  for (const key of containerPath) {
    walked.push(key);
    const existing = cursor[key];
    if (existing === undefined) {
      const created: JsonObject = {};
      cursor[key] = created;
      cursor = created;
      continue;
    }
    if (!isJsonObject(existing)) {
      throw new Error(
        `${filePath} 的 "${walked.join(".")}" 不是 JSON object，為避免破壞既有設定已中止。`,
      );
    }
    cursor = existing;
  }

  return cursor;
}

function readGroups(
  container: JsonObject,
  eventName: string,
  filePath: string,
): unknown[] {
  const existing = container[eventName];
  if (existing === undefined) {
    return [];
  }
  if (!Array.isArray(existing)) {
    throw new Error(
      `${filePath} 的 hooks."${eventName}" 不是陣列，為避免破壞既有設定已中止。`,
    );
  }
  return existing;
}

interface StripResult {
  groups: unknown[];
  removedHookCount: number;
  foreignHookCount: number;
}

/**
 * 從事件的 group 陣列中拔掉所有 reporter hook，並清掉因此變空的 group。
 * group 上使用者自訂的其他欄位會讓該 group 被保留下來。
 */
function stripReporterHooks(groups: readonly unknown[]): StripResult {
  const keptGroups: unknown[] = [];
  let removedHookCount = 0;
  let foreignHookCount = 0;

  for (const group of groups) {
    if (!isJsonObject(group) || !Array.isArray(group.hooks)) {
      // 看不懂的項目維持原狀，交給代理程式自己判斷。
      keptGroups.push(group);
      continue;
    }

    const keptHooks = group.hooks.filter((hook) => {
      const owned = isJsonObject(hook) && isReporterHookCommand(hook.command);
      if (owned) {
        removedHookCount += 1;
      } else {
        foreignHookCount += 1;
      }
      return !owned;
    });

    const hasOtherKeys = Object.keys(group).some(
      (key) => key !== "hooks" && key !== "matcher",
    );
    if (keptHooks.length === 0 && !hasOtherKeys) {
      // 這個 group 原本只放 Agent Lantern 的 hook，整組移除。
      continue;
    }

    keptGroups.push({ ...group, hooks: keptHooks });
  }

  return { groups: keptGroups, removedHookCount, foreignHookCount };
}

/**
 * 把目標 group 併回事件陣列：matcher 相同的既有 group 就沿用（只加 hook），
 * 否則追加一個新的 group。
 */
function insertDesiredGroups(
  groups: unknown[],
  desiredGroups: readonly HookGroupDefinition[],
): void {
  for (const desired of desiredGroups) {
    const desiredMatcher = desired.matcher ?? "";
    const target = groups.find(
      (group) =>
        isJsonObject(group) &&
        Array.isArray(group.hooks) &&
        normalizeMatcher(group) === desiredMatcher,
    );

    if (target && isJsonObject(target) && Array.isArray(target.hooks)) {
      target.hooks.push(...cloneJson([...desired.hooks]));
      continue;
    }

    groups.push(cloneJson({ ...desired }));
  }
}

export function mergeHookDocument(
  existingDocument: unknown,
  plan: HookInstallationPlan,
  filePath: string,
): HookMergeResult {
  if (existingDocument !== undefined && !isJsonObject(existingDocument)) {
    throw new Error(
      `${filePath} 的內容不是 JSON object，為避免破壞既有設定已中止。`,
    );
  }

  const isNewDocument = existingDocument === undefined;
  const document: JsonObject = isNewDocument
    ? cloneJson({ ...plan.documentDefaults })
    : cloneJson(existingDocument);
  const before = JSON.stringify(document);

  const container = resolveHooksContainer(
    document,
    plan.hooksContainerPath,
    filePath,
  );

  const addedEvents: string[] = [];
  const updatedEvents: string[] = [];
  const unchangedEvents: string[] = [];
  let preservedForeignHookCount = 0;

  // 先把不在本次計畫內、卻仍掛著 reporter hook 的事件清乾淨，讓安裝結果等於
  // 目前版本的完整狀態（例如舊版安裝過、新版已不再使用的事件）。
  for (const eventName of Object.keys(container)) {
    if (eventName in plan.events) {
      continue;
    }
    const stripped = stripReporterHooks(
      readGroups(container, eventName, filePath),
    );
    preservedForeignHookCount += stripped.foreignHookCount;
    if (stripped.removedHookCount === 0) {
      continue;
    }
    if (stripped.groups.length === 0) {
      delete container[eventName];
    } else {
      container[eventName] = stripped.groups;
    }
    updatedEvents.push(eventName);
  }

  for (const [eventName, desiredGroups] of Object.entries(plan.events)) {
    const originalGroups = readGroups(container, eventName, filePath);
    const originalSerialized = JSON.stringify(originalGroups);

    const stripped = stripReporterHooks(originalGroups);
    preservedForeignHookCount += stripped.foreignHookCount;
    const hadReporterHook = stripped.removedHookCount > 0;

    const groups = stripped.groups;
    insertDesiredGroups(groups, desiredGroups);
    container[eventName] = groups;

    if (JSON.stringify(groups) === originalSerialized) {
      unchangedEvents.push(eventName);
    } else if (hadReporterHook) {
      updatedEvents.push(eventName);
    } else {
      addedEvents.push(eventName);
    }
  }

  return {
    document,
    changed: isNewDocument || JSON.stringify(document) !== before,
    addedEvents,
    updatedEvents,
    unchangedEvents,
    preservedForeignHookCount,
  };
}

export function removeHookDocument(
  existingDocument: unknown,
  plan: HookInstallationPlan,
  filePath: string,
): HookRemovalResult {
  if (!isJsonObject(existingDocument)) {
    throw new Error(
      `${filePath} 的內容不是 JSON object，無法安全移除 Agent Lantern hook。`,
    );
  }

  const document = cloneJson(existingDocument);
  const before = JSON.stringify(document);
  const container = resolveHooksContainer(
    document,
    plan.hooksContainerPath,
    filePath,
  );

  let removedHookCount = 0;
  let preservedForeignHookCount = 0;

  for (const eventName of Object.keys(container)) {
    const stripped = stripReporterHooks(
      readGroups(container, eventName, filePath),
    );
    removedHookCount += stripped.removedHookCount;
    preservedForeignHookCount += stripped.foreignHookCount;

    if (stripped.groups.length === 0) {
      delete container[eventName];
    } else {
      container[eventName] = stripped.groups;
    }
  }

  // 事件全部清空時才收掉 hooks 這個鍵，避免留下空殼。
  const [containerKey] = plan.hooksContainerPath;
  if (
    containerKey !== undefined &&
    plan.hooksContainerPath.length === 1 &&
    Object.keys(container).length === 0
  ) {
    delete document[containerKey];
  }

  return {
    document,
    changed: JSON.stringify(document) !== before,
    removedHookCount,
    preservedForeignHookCount,
  };
}
