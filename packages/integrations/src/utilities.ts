export function readString(
  object: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

export function readNestedString(
  object: Record<string, unknown>,
  parentKey: string,
  childKey: string,
): string | undefined {
  const parent = object[parentKey];
  if (typeof parent !== "object" || parent === null || Array.isArray(parent)) {
    return undefined;
  }

  return readString(parent as Record<string, unknown>, childKey);
}
