import { describe, expect, it } from "vitest";

import {
  mergeEnvironmentFile,
  removeEnvironmentKeys,
} from "./environment-file.js";

const desired = {
  AGENT_LANTERN_DAEMON_ENDPOINT: "http://100.80.10.15:48123",
  AGENT_LANTERN_TOKEN: "0123456789abcdef0123456789abcdef",
  AGENT_LANTERN_HOST_NAME: "remote-build-01",
};

describe("mergeEnvironmentFile", () => {
  it("建立新檔案時寫入全部三個鍵", () => {
    const result = mergeEnvironmentFile(undefined, desired);

    expect(result.content).toBe(
      [
        "AGENT_LANTERN_DAEMON_ENDPOINT=http://100.80.10.15:48123",
        "AGENT_LANTERN_TOKEN=0123456789abcdef0123456789abcdef",
        "AGENT_LANTERN_HOST_NAME=remote-build-01",
        "",
      ].join("\n"),
    );
    expect(result.changes).toHaveLength(3);
  });

  it("就地更新既有鍵，保留註解、順序與其他變數", () => {
    const existing = [
      "# Agent Lantern",
      "AGENT_LANTERN_TOKEN=old-token",
      "MY_OWN_VARIABLE=keep-me",
      "AGENT_LANTERN_HOST_NAME=remote-build-01",
      "",
    ].join("\n");

    const result = mergeEnvironmentFile(existing, desired);

    expect(result.content).toBe(
      [
        "# Agent Lantern",
        "AGENT_LANTERN_TOKEN=0123456789abcdef0123456789abcdef",
        "MY_OWN_VARIABLE=keep-me",
        "AGENT_LANTERN_HOST_NAME=remote-build-01",
        "AGENT_LANTERN_DAEMON_ENDPOINT=http://100.80.10.15:48123",
        "",
      ].join("\n"),
    );
    expect(result.changes.map((change) => change.key)).toEqual([
      "AGENT_LANTERN_TOKEN",
      "AGENT_LANTERN_DAEMON_ENDPOINT",
    ]);
  });

  it("內容相同時回報未變更", () => {
    const first = mergeEnvironmentFile(undefined, desired);
    const second = mergeEnvironmentFile(first.content, desired);

    expect(second.changed).toBe(false);
    expect(second.changes).toHaveLength(0);
  });

  it("清掉重複的舊值，避免載入時後面覆蓋前面", () => {
    const existing = [
      "AGENT_LANTERN_TOKEN=first",
      "AGENT_LANTERN_TOKEN=second",
      "",
    ].join("\n");

    const result = mergeEnvironmentFile(existing, desired);

    expect(
      result.content
        .split("\n")
        .filter((line) => line.startsWith("AGENT_LANTERN_TOKEN=")),
    ).toHaveLength(1);
  });

  it("值含有空白時加上引號", () => {
    const result = mergeEnvironmentFile(undefined, {
      AGENT_LANTERN_HOST_NAME: "build box",
    });

    expect(result.content).toBe('AGENT_LANTERN_HOST_NAME="build box"\n');
  });
});

describe("removeEnvironmentKeys", () => {
  it("只刪掉指定的鍵", () => {
    const existing = [
      "# Agent Lantern",
      "AGENT_LANTERN_TOKEN=token",
      "MY_OWN_VARIABLE=keep-me",
      "",
    ].join("\n");

    const result = removeEnvironmentKeys(existing, ["AGENT_LANTERN_TOKEN"]);

    expect(result.content).toBe("# Agent Lantern\nMY_OWN_VARIABLE=keep-me\n");
    expect(result.removedKeys).toEqual(["AGENT_LANTERN_TOKEN"]);
  });

  it("檔案不存在時不算變更", () => {
    const result = removeEnvironmentKeys(undefined, ["AGENT_LANTERN_TOKEN"]);

    expect(result.changed).toBe(false);
  });
});
