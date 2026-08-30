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

export class SessionStore {
  private readonly snapshotsBySession = new Map<string, SessionSnapshot>();
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
    return [...this.snapshotsBySession.values()].sort((left, right) =>
      right.receivedAt.localeCompare(left.receivedAt),
    );
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
