import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export async function readTextFileIfPresent(
  filePath: string,
): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function readJsonFileIfPresent(
  filePath: string,
): Promise<unknown> {
  const content = await readTextFileIfPresent(filePath);
  if (content === undefined || content.trim() === "") {
    return undefined;
  }

  try {
    return JSON.parse(content) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${filePath} 不是有效的 JSON（${message}）。請先修正該檔案，安裝器不會覆蓋看不懂的內容。`,
    );
  }
}

export function backupFilePath(filePath: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${filePath}.agent-lantern-backup-${stamp}`;
}

export interface WriteResult {
  backupPath: string | undefined;
}

/**
 * 先備份既有檔案，再以 temp file + rename 的方式原子寫入，避免中途失敗留下
 * 半份設定。`mode` 只在建立新檔案時套用。
 */
export async function writeFileWithBackup(
  filePath: string,
  content: string,
  options: { mode?: number; createBackup: boolean } = { createBackup: true },
): Promise<WriteResult> {
  await mkdir(dirname(filePath), { recursive: true });

  let backupPath: string | undefined;
  if (options.createBackup) {
    const existing = await readTextFileIfPresent(filePath);
    if (existing !== undefined) {
      backupPath = backupFilePath(filePath);
      await writeFile(backupPath, existing, { mode: options.mode });
    }
  }

  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, content, { mode: options.mode });
  await rename(temporaryPath, filePath);
  if (options.mode !== undefined) {
    // rename 會保留 temp file 的權限，但既有檔案被覆蓋時要再確認一次。
    await chmod(filePath, options.mode).catch(() => undefined);
  }

  return { backupPath };
}

export function formatJsonDocument(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
