import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { protocolVersion } from "./index.js";

/**
 * `apps/overlay/src-tauri/src/lib.rs` 沒辦法直接 import 這個套件（它是 Rust
 * 程式碼），所以 `EXPECTED_PROTOCOL_VERSION` 只能手動抄一份常數。這個測試確保
 * 兩邊沒有漂移：只要有人改了其中一邊卻忘了改另一邊，這裡就會失敗。
 */
describe("protocolVersion", () => {
  it("matches EXPECTED_PROTOCOL_VERSION in the overlay's Rust source", () => {
    const overlayLibraryPath = fileURLToPath(
      new URL("../../../apps/overlay/src-tauri/src/lib.rs", import.meta.url),
    );
    const overlayLibrarySource = readFileSync(overlayLibraryPath, "utf-8");
    // 逐行掃描並跳過註解行，否則整行被註解掉的宣告（或說明文字裡提到這個常數）
    // 也會被當成宣告，守衛就形同虛設；同時要求「剛好一筆」，避免有人為了某個
    // 平台分支多加一份而讓這裡只驗到其中一份。
    const declaredVersions = overlayLibrarySource
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .map((line) => line.match(/EXPECTED_PROTOCOL_VERSION:\s*u32\s*=\s*(\d+)/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => Number(match[1]));

    if (declaredVersions.length !== 1) {
      throw new Error(
        `apps/overlay/src-tauri/src/lib.rs 裡的 EXPECTED_PROTOCOL_VERSION 宣告有 ` +
          `${declaredVersions.length} 筆，預期剛好 1 筆，才能跟 ` +
          "packages/protocol/src/index.ts 的 protocolVersion 對齊。",
      );
    }

    expect(declaredVersions[0]).toBe(protocolVersion);
  });
});
