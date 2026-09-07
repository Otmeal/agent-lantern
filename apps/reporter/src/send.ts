import type { ReporterDestination } from "./destinations.js";

export interface DeliveryResult {
  destination: ReporterDestination;
  ok: boolean;
  error: string | undefined;
}

/**
 * 各目的地各自 try/catch，任何一個失敗都不能拖垮其他目的地的送出。
 */
export async function deliverEvent(
  destinations: readonly ReporterDestination[],
  event: unknown,
  timeoutMilliseconds = 2_500,
): Promise<DeliveryResult[]> {
  return Promise.all(
    destinations.map((destination) =>
      deliverToDestination(destination, event, timeoutMilliseconds),
    ),
  );
}

async function deliverToDestination(
  destination: ReporterDestination,
  event: unknown,
  timeoutMilliseconds: number,
): Promise<DeliveryResult> {
  try {
    const response = await fetch(`${destination.endpoint}/api/v1/events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${destination.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });

    if (!response.ok) {
      const responseText = await response.text();
      return {
        destination,
        ok: false,
        error: `Daemon rejected the event with ${response.status}: ${responseText}`,
      };
    }

    return { destination, ok: true, error: undefined };
  } catch (error) {
    return {
      destination,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
