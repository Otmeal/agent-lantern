import { buildHookInstallationPlan } from "@agent-lantern/integrations";
import { describe, expect, it } from "vitest";

import { mergeHookDocument, removeHookDocument } from "./hook-merge.js";

const claudePlan = buildHookInstallationPlan("claude");
const codexPlan = buildHookInstallationPlan("codex");
const filePath = "/home/user/.claude/settings.json";

function reporterHookCount(document: Record<string, unknown>): number {
  const hooks = document.hooks as Record<string, unknown[]> | undefined;
  if (!hooks) {
    return 0;
  }
  let count = 0;
  for (const groups of Object.values(hooks)) {
    for (const group of groups) {
      const groupHooks = (group as { hooks?: { command?: string }[] }).hooks;
      count += (groupHooks ?? []).filter((hook) =>
        hook.command?.includes("agent-status-reporter"),
      ).length;
    }
  }
  return count;
}

describe("mergeHookDocument", () => {
  it("建立全新檔案時套用該代理程式的預設欄位", () => {
    const result = mergeHookDocument(undefined, codexPlan, filePath);

    expect(result.changed).toBe(true);
    expect(result.document.description).toBe(
      "Report Codex lifecycle events to Agent Lantern.",
    );
    expect(Object.keys(result.document.hooks as object)).toEqual(
      Object.keys(codexPlan.events),
    );
  });

  it("保留設定檔中與 hook 無關的既有欄位", () => {
    const existing = {
      model: "opus",
      permissions: { allow: ["Bash(git status)"] },
      env: { FOO: "bar" },
    };

    const result = mergeHookDocument(existing, claudePlan, filePath);

    expect(result.document.model).toBe("opus");
    expect(result.document.permissions).toEqual({
      allow: ["Bash(git status)"],
    });
    expect(result.document.env).toEqual({ FOO: "bar" });
  });

  it("把 hook 併進使用者既有的同名事件，且不動使用者自己的 hook", () => {
    const existing = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "my-audit-log" }],
          },
        ],
      },
    };

    const result = mergeHookDocument(existing, claudePlan, filePath);
    const preToolUse = (result.document.hooks as Record<string, unknown[]>)
      .PreToolUse as { matcher?: string; hooks: { command: string }[] }[];

    // 使用者原本的 Bash matcher 群組完全保留。
    expect(preToolUse[0]).toEqual({
      matcher: "Bash",
      hooks: [{ type: "command", command: "my-audit-log" }],
    });
    // Agent Lantern 使用自己的 matcher，追加成另一個群組。
    expect(preToolUse[1]?.matcher).toBe("");
    expect(preToolUse[1]?.hooks[0]?.command).toContain(
      "agent-status-reporter hook --agent claude",
    );
    expect(result.preservedForeignHookCount).toBe(1);
  });

  it("matcher 相同時只把 hook 加進既有群組", () => {
    const existing = {
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [{ type: "command", command: "notify-send done" }],
          },
        ],
      },
    };

    const result = mergeHookDocument(existing, claudePlan, filePath);
    const stop = (result.document.hooks as Record<string, unknown[]>).Stop as {
      hooks: { command: string }[];
    }[];

    expect(stop).toHaveLength(1);
    expect(stop[0]?.hooks).toHaveLength(2);
    expect(stop[0]?.hooks[0]?.command).toBe("notify-send done");
  });

  it("重複執行安裝不會產生重複項目", () => {
    const first = mergeHookDocument(undefined, claudePlan, filePath);
    const second = mergeHookDocument(first.document, claudePlan, filePath);

    expect(second.changed).toBe(false);
    expect(second.addedEvents).toHaveLength(0);
    expect(second.unchangedEvents).toEqual(Object.keys(claudePlan.events));
    expect(reporterHookCount(second.document)).toBe(
      reporterHookCount(first.document),
    );
  });

  it("reporter 路徑改變時就地更新，而不是再加一份", () => {
    const first = mergeHookDocument(undefined, claudePlan, filePath);
    const relocatedPlan = buildHookInstallationPlan("claude", {
      commandPath: "/home/user/.local/bin/agent-status-reporter",
    });

    const second = mergeHookDocument(first.document, relocatedPlan, filePath);
    const sessionStart = (second.document.hooks as Record<string, unknown[]>)
      .SessionStart as { hooks: { command: string }[] }[];

    expect(second.changed).toBe(true);
    expect(sessionStart[0]?.hooks).toHaveLength(1);
    expect(sessionStart[0]?.hooks[0]?.command).toBe(
      "/home/user/.local/bin/agent-status-reporter hook --agent claude",
    );
    expect(reporterHookCount(second.document)).toBe(
      reporterHookCount(first.document),
    );
  });

  it("既有 hooks 欄位型別不符時拒絕寫入", () => {
    expect(() =>
      mergeHookDocument({ hooks: "nope" }, claudePlan, filePath),
    ).toThrow(/不是 JSON object/);
    expect(() =>
      mergeHookDocument({ hooks: { Stop: "nope" } }, claudePlan, filePath),
    ).toThrow(/不是陣列/);
  });
});

describe("removeHookDocument", () => {
  it("只移除 Agent Lantern 的 hook，其餘保持原樣", () => {
    const existing = {
      model: "opus",
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [{ type: "command", command: "notify-send done" }],
          },
        ],
      },
    };
    const installed = mergeHookDocument(existing, claudePlan, filePath);

    const result = removeHookDocument(installed.document, claudePlan, filePath);

    expect(result.changed).toBe(true);
    expect(result.document.model).toBe("opus");
    expect(reporterHookCount(result.document)).toBe(0);
    expect((result.document.hooks as Record<string, unknown>).Stop).toEqual([
      {
        matcher: "",
        hooks: [{ type: "command", command: "notify-send done" }],
      },
    ]);
  });

  it("全部移除後不留下空的 hooks 欄位", () => {
    const installed = mergeHookDocument(
      { model: "opus" },
      claudePlan,
      filePath,
    );

    const result = removeHookDocument(installed.document, claudePlan, filePath);

    expect(result.document).toEqual({ model: "opus" });
  });

  it("沒有安裝過時回報未變更", () => {
    const result = removeHookDocument({ model: "opus" }, claudePlan, filePath);

    expect(result.changed).toBe(false);
    expect(result.removedHookCount).toBe(0);
  });
});
