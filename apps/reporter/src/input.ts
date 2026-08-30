export async function readStandardInput(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8").trim();
}

export function parseJsonObject(value: string): Record<string, unknown> {
  const parsedValue: unknown = JSON.parse(value);
  if (
    typeof parsedValue !== "object" ||
    parsedValue === null ||
    Array.isArray(parsedValue)
  ) {
    throw new Error("Hook input must be a JSON object.");
  }

  return parsedValue as Record<string, unknown>;
}
