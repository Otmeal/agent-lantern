import type { AgentStatus } from "@agent-lantern/protocol";

import type { AgentIntegration, AgentIntegrationResult } from "./types.js";
import { readNestedString, readString } from "./utilities.js";

const statusByHookEvent: Readonly<Record<string, AgentStatus>> = {
  SessionStart: "starting",
  UserPromptSubmit: "working",
  PreToolUse: "working",
  PostToolUse: "working",
  PostToolBatch: "working",
  PreCompact: "working",
  PostCompact: "working",
  SubagentStart: "working",
  SubagentStop: "working",
  PermissionRequest: "waiting",
  PermissionDenied: "waiting",
  Notification: "waiting",
  Stop: "completed",
  StopFailure: "failed",
  SessionEnd: "stopped",
};

export class ClaudeIntegration implements AgentIntegration {
  normalize(hookPayload: Record<string, unknown>): AgentIntegrationResult {
    const hookEventName =
      readString(hookPayload, "hook_event_name") ?? "Unknown";
    const notificationType = readString(hookPayload, "notification_type");

    return {
      agentKind: "claude",
      agentDisplayName: "Claude",
      eventType: `claude.${hookEventName}`,
      status: statusByHookEvent[hookEventName] ?? "working",
      sessionIdentifier: readString(hookPayload, "session_id"),
      workspacePath: readString(hookPayload, "cwd"),
      message: this.buildMessage(hookEventName, notificationType, hookPayload),
      metadata: {
        hookEventName,
        notificationType,
        toolName: readString(hookPayload, "tool_name"),
        error: readNestedString(hookPayload, "error", "message"),
      },
    };
  }

  private buildMessage(
    hookEventName: string,
    notificationType: string | undefined,
    hookPayload: Record<string, unknown>,
  ): string {
    if (hookEventName === "Notification") {
      const notificationMessage = readString(hookPayload, "message");
      return notificationMessage ?? notificationType ?? "等待使用者操作";
    }

    if (hookEventName === "PermissionRequest") {
      const toolName = readString(hookPayload, "tool_name");
      return toolName ? `等待核准：${toolName}` : "等待使用者核准";
    }

    const messages: Readonly<Record<string, string>> = {
      SessionStart: "工作階段已啟動",
      UserPromptSubmit: "正在處理提示",
      PreToolUse: "正在使用工具",
      PostToolUse: "工具執行完成，繼續工作",
      PostToolBatch: "批次工具執行完成",
      PreCompact: "正在整理上下文",
      PostCompact: "已整理上下文",
      SubagentStart: "子代理程式已啟動",
      SubagentStop: "子代理程式已完成",
      PermissionDenied: "工具權限遭拒",
      Stop: "本回合已完成",
      StopFailure: "本回合因錯誤停止",
      SessionEnd: "工作階段已結束",
    };

    return messages[hookEventName] ?? `收到 ${hookEventName} 事件`;
  }
}
