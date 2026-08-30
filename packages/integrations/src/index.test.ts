import { describe, expect, it } from "vitest";

import { normalizeAgentHook } from "./index.js";

describe("normalizeAgentHook", () => {
  it("maps a Codex permission request to waiting", () => {
    const result = normalizeAgentHook("codex", {
      hook_event_name: "PermissionRequest",
      session_id: "codex-session",
      cwd: "/workspace/codex",
      tool_name: "Bash",
    });

    expect(result.status).toBe("waiting");
    expect(result.message).toContain("Bash");
  });

  it("maps a Claude stop failure to failed", () => {
    const result = normalizeAgentHook("claude", {
      hook_event_name: "StopFailure",
      session_id: "claude-session",
      cwd: "/workspace/claude",
    });

    expect(result.status).toBe("failed");
  });
});
