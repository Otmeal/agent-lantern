import type {
  NormalizedAgentEvent,
  SessionSnapshot,
} from "@agent-lantern/protocol";

const maximumRememberedEventIdentifiers = 10_000;

function buildSessionKey(event: NormalizedAgentEvent): string {
  return JSON.stringify([
    event.host.name,
    event.workspace.path,
    event.agent.kind,
    event.session.identifier,
  ]);
}

function encodeSessionKey(rawKey: string): string {
  return Buffer.from(rawKey, "utf8").toString("base64url");
}

function decodeSessionKey(sessionKey: string): string {
  return Buffer.from(sessionKey, "base64url").toString("utf8");
}

type StoredSessionSnapshot = Omit<SessionSnapshot, "sessionKey">;

export class SessionStore {
  private readonly snapshotsBySession = new Map<
    string,
    StoredSessionSnapshot
  >();
  private readonly rememberedEventIdentifiers = new Set<string>();

  apply(event: NormalizedAgentEvent, receivedAt = new Date()): boolean {
    if (this.rememberedEventIdentifiers.has(event.eventIdentifier)) {
      return false;
    }

    this.rememberEventIdentifier(event.eventIdentifier);
    const sessionKey = buildSessionKey(event);
    this.snapshotsBySession.set(sessionKey, {
      agent: event.agent,
      host: event.host,
      workspace: event.workspace,
      session: event.session,
      status: event.status,
      eventType: event.eventType,
      ...(event.message === undefined ? {} : { message: event.message }),
      occurredAt: event.occurredAt,
      receivedAt: receivedAt.toISOString(),
    });

    return true;
  }

  list(): SessionSnapshot[] {
    return [...this.snapshotsBySession.entries()]
      .map(([rawKey, snapshot]) => ({
        sessionKey: encodeSessionKey(rawKey),
        ...snapshot,
      }))
      .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt));
  }

  // 刻意不保留刪除紀錄（tombstone/blocklist）：
  // 移除後若同一個 session 再次收到事件，會透過 apply() 正常重建。
  remove(sessionKey: string): boolean {
    let rawKey: string;
    try {
      rawKey = decodeSessionKey(sessionKey);
    } catch {
      return false;
    }

    // base64url 解碼很寬鬆，`key`、`key=`、`key!!!` 等變體都可能解出同一個
    // rawKey；用編碼回去比對，確保只有「正典」的 sessionKey 才會生效。
    if (encodeSessionKey(rawKey) !== sessionKey) {
      return false;
    }

    return this.snapshotsBySession.delete(rawKey);
  }

  private rememberEventIdentifier(eventIdentifier: string): void {
    this.rememberedEventIdentifiers.add(eventIdentifier);
    if (
      this.rememberedEventIdentifiers.size > maximumRememberedEventIdentifiers
    ) {
      const oldestIdentifier = this.rememberedEventIdentifiers.values().next()
        .value as string | undefined;
      if (oldestIdentifier) {
        this.rememberedEventIdentifiers.delete(oldestIdentifier);
      }
    }
  }
}
