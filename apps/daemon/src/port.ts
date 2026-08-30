import { createServer } from "node:net";

function probePort(host: string, port: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(undefined));
    probe.listen({ host, port, exclusive: true }, () => {
      const address = probe.address();
      const boundPort =
        address !== null && typeof address !== "string"
          ? address.port
          : undefined;
      probe.close(() => resolve(boundPort));
    });
  });
}

/**
 * Picks the port the daemon should listen on.
 *
 * Windows hosts running WSL 2 or Docker Desktop let the Hyper-V host network
 * service reserve large blocks of ports. Those reservations are invisible to
 * `netstat` and to `netsh ... show excludedportrange`, yet binding inside them
 * still fails with `EADDRINUSE`, and the blocks are re-picked on every reboot.
 * Falling back to an operating-system assigned port keeps automatic startup
 * working instead of failing silently; the caller persists and displays the
 * resolved port.
 */
export async function resolveListeningPort(
  host: string,
  preferredPort: number,
): Promise<number> {
  const preferred = await probePort(host, preferredPort);
  if (preferred !== undefined) {
    return preferred;
  }

  const assigned = await probePort(host, 0);
  if (assigned === undefined) {
    throw new Error("Could not find an available TCP port to listen on.");
  }
  return assigned;
}
