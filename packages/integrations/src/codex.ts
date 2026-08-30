import type { AgentStatus } from "@agent-lantern/protocol";

import type { AgentIntegration, AgentIntegrationResult } from "./types.js";
import { readString } from "./utilities.js";

const statusByHookEvent: Readonly<Record<string, AgentStatus>> = {
  SessionStart: "starting",
  UserPromptSubmit: "working",
  PreToolUse: "working",
  PostToolUse: "working",
  PreCompact: "working",
  PostCompact: "working",
  SubagentStart: "working",
  SubagentStop: "working",
  PermissionRequest: "waiting",
  Stop: "completed",
  SessionEnd: "stopped",
};

export class CodexIntegration implements AgentIntegration {
  normalize(hookPayload: Record<string, unknown>): AgentIntegrationResult {
    const hookEventName =
      readString(hookPayload, "hook_event_name", "type") ?? "Unknown";
    const status = statusByHookEvent[hookEventName] ?? "working";

    return {
      agentKind: "codex",
      agentDisplayName: "Codex",
      eventType: `codex.${hookEventName}`,
      status,
      sessionIdentifier: readString(
        hookPayload,
        "session_id",
        "thread-id",
        "thread_id",
      ),
      workspacePath: readString(hookPayload, "cwd"),
      message: this.buildMessage(hookEventName, hookPayload),
      metadata: {
        hookEventName,
        model: readString(hookPayload, "model"),
        turnIdentifier: readString(hookPayload, "turn_id", "turn-id"),
      },
    };
  }

  private buildMessage(
    hookEventName: string,
    hookPayload: Record<string, unknown>,
  ): string {
    if (hookEventName === "PermissionRequest") {
      const toolName = readString(hookPayload, "tool_name");
      return toolName ? `等待核准：${toolName}` : "等待使用者核准";
    }

    const messages: Readonly<Record<string, string>> = {
      SessionStart: "工作階段已啟動",
      UserPromptSubmit: "正在處理提示",
      PreToolUse: "正在使用工具",
      PostToolUse: "工具執行完成，繼續工作",
      PreCompact: "正在整理上下文",
      PostCompact: "已整理上下文",
      SubagentStart: "子代理程式已啟動",
      SubagentStop: "子代理程式已完成",
      Stop: "本回合已完成",
      SessionEnd: "工作階段已結束",
    };

    return messages[hookEventName] ?? `收到 ${hookEventName} 事件`;
  }
}
