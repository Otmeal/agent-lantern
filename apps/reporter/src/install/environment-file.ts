/**
 * `~/.config/agent-lantern/environment` 也採用合併寫入：只覆寫 Agent Lantern
 * 自己的鍵，使用者加在同一份檔案裡的其他變數、註解與排列順序都保留。
 */

export interface EnvironmentChange {
  key: string;
  previousValue: string | undefined;
  nextValue: string;
}

export interface EnvironmentMergeResult {
  content: string;
  changed: boolean;
  changes: EnvironmentChange[];
}

const assignmentPattern = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*)=(.*)$/;

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  const firstCharacter = trimmed[0];
  const lastCharacter = trimmed.at(-1);
  if (
    trimmed.length >= 2 &&
    (firstCharacter === '"' || firstCharacter === "'") &&
    firstCharacter === lastCharacter
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * 值裡有空白或引號時才加引號，讓一般情況下的檔案內容維持易讀。
 */
function formatValue(value: string): string {
  if (value === "" || /[\s"'#]/.test(value)) {
    return `"${value.replace(/(["\\])/g, "\\$1")}"`;
  }
  return value;
}

export function mergeEnvironmentFile(
  existingContent: string | undefined,
  desiredValues: Readonly<Record<string, string>>,
): EnvironmentMergeResult {
  const lines = (existingContent ?? "").split(/\r?\n/);
  const changes: EnvironmentChange[] = [];
  const remainingKeys = new Set(Object.keys(desiredValues));
  const seenKeys = new Set<string>();
  const outputLines: string[] = [];

  for (const line of lines) {
    const match = assignmentPattern.exec(line);
    const key = match?.[2];
    if (!key || !(key in desiredValues)) {
      outputLines.push(line);
      continue;
    }

    if (seenKeys.has(key)) {
      // 同一個鍵重複出現時只保留第一行，避免後面的舊值蓋掉新值。
      continue;
    }
    seenKeys.add(key);
    remainingKeys.delete(key);

    const previousValue = stripMatchingQuotes(match[4] ?? "");
    const nextValue = desiredValues[key]!;
    if (previousValue !== nextValue) {
      changes.push({ key, previousValue, nextValue });
    }
    outputLines.push(`${match[1] ?? ""}${key}=${formatValue(nextValue)}`);
  }

  // 移除結尾的空行，追加完新鍵之後再統一補上換行。
  while (outputLines.length > 0 && outputLines.at(-1)!.trim() === "") {
    outputLines.pop();
  }

  for (const key of Object.keys(desiredValues)) {
    if (!remainingKeys.has(key)) {
      continue;
    }
    const nextValue = desiredValues[key]!;
    changes.push({ key, previousValue: undefined, nextValue });
    outputLines.push(`${key}=${formatValue(nextValue)}`);
  }

  const content = `${outputLines.join("\n")}\n`;
  return {
    content,
    changed: content !== existingContent,
    changes,
  };
}

export interface EnvironmentRemovalResult {
  content: string;
  changed: boolean;
  removedKeys: string[];
}

/**
 * 移除時只刪掉 Agent Lantern 自己的鍵，其餘行（含註解）保持原樣。
 */
export function removeEnvironmentKeys(
  existingContent: string | undefined,
  keys: readonly string[],
): EnvironmentRemovalResult {
  if (existingContent === undefined) {
    return { content: "", changed: false, removedKeys: [] };
  }

  const managedKeys = new Set(keys);
  const removedKeys: string[] = [];
  const outputLines: string[] = [];

  for (const line of existingContent.split(/\r?\n/)) {
    const match = assignmentPattern.exec(line);
    const key = match?.[2];
    if (key && managedKeys.has(key)) {
      removedKeys.push(key);
      continue;
    }
    outputLines.push(line);
  }

  while (outputLines.length > 0 && outputLines.at(-1)!.trim() === "") {
    outputLines.pop();
  }

  const content = outputLines.length === 0 ? "" : `${outputLines.join("\n")}\n`;
  return {
    content,
    changed: content !== existingContent,
    removedKeys,
  };
}
