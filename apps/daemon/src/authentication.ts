import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function hasValidBearerToken(
  authorizationHeader: string | undefined,
  expectedToken: string,
): boolean {
  if (!authorizationHeader?.startsWith("Bearer ")) {
    return false;
  }

  const suppliedToken = authorizationHeader.slice("Bearer ".length);
  return timingSafeEqual(digest(suppliedToken), digest(expectedToken));
}
