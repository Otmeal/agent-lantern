import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildExampleDocument,
  buildHookInstallationPlan,
  isReporterHookCommand,
  quoteCommandPath,
} from "./hook-installation.js";

const repositoryRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

function readExample(relativePath: string): unknown {
  return JSON.parse(
    readFileSync(join(repositoryRoot, relativePath), "utf8"),
  ) as unknown;
}

describe("hook installation plans", () => {
  it("examples/integrations 與安裝器使用同一份定義", () => {
    // 範例檔是給想手動合併的人看的，必須和 install 命令實際寫入的內容一致。
    expect(readExample("examples/integrations/codex/hooks.json")).toEqual(
      buildExampleDocument("codex"),
    );
    expect(readExample("examples/integrations/claude/settings.json")).toEqual(
      buildExampleDocument("claude"),
    );
  });

  it("把 reporter 路徑寫進每個事件的 command", () => {
    const plan = buildHookInstallationPlan("codex", {
      commandPath: "/home/user/.local/bin/agent-status-reporter",
    });

    for (const groups of Object.values(plan.events)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          expect(hook.command).toBe(
            "/home/user/.local/bin/agent-status-reporter hook --agent codex",
          );
        }
      }
    }
  });

  it("路徑含空白時加上引號", () => {
    expect(quoteCommandPath("/usr/local/bin/agent-status-reporter")).toBe(
      "/usr/local/bin/agent-status-reporter",
    );
    expect(quoteCommandPath("/opt/my tools/agent-status-reporter")).toBe(
      '"/opt/my tools/agent-status-reporter"',
    );
  });

  it("沒有安裝計畫的代理程式會明確失敗", () => {
    expect(() => buildHookInstallationPlan("custom")).toThrow(
      /No hook installation plan/,
    );
  });
});

describe("isReporterHookCommand", () => {
  it("認得各種寫法的 reporter 命令", () => {
    expect(
      isReporterHookCommand("agent-status-reporter hook --agent codex"),
    ).toBe(true);
    expect(
      isReporterHookCommand(
        "/home/user/.local/bin/agent-status-reporter hook --agent claude",
      ),
    ).toBe(true);
    expect(
      isReporterHookCommand('"/opt/my tools/agent-status-reporter" hook'),
    ).toBe(true);
  });

  it("不會誤判使用者自己的 hook", () => {
    expect(isReporterHookCommand("notify-send done")).toBe(false);
    expect(isReporterHookCommand("my-agent-status-reporterx run")).toBe(false);
    expect(isReporterHookCommand(undefined)).toBe(false);
    expect(isReporterHookCommand(42)).toBe(false);
  });
});
