import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export async function loadReporterEnvironment(
  processEnvironment: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const configurationHome =
    processEnvironment.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const configurationPath = join(
    configurationHome,
    "agent-lantern",
    "environment",
  );

  let content: string;
  try {
    content = await readFile(configurationPath, "utf8");
  } catch (error: unknown) {
    const errorCode =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
    if (errorCode === "ENOENT") {
      return processEnvironment;
    }
    throw error;
  }

  const fileEnvironment: NodeJS.ProcessEnv = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf("=");
    if (separatorIndex <= 0) {
      throw new Error(`Invalid configuration line in ${configurationPath}.`);
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    const value = trimmedLine.slice(separatorIndex + 1).trim();
    fileEnvironment[key] = stripMatchingQuotes(value);
  }

  return { ...fileEnvironment, ...processEnvironment };
}

function stripMatchingQuotes(value: string): string {
  const firstCharacter = value[0];
  const lastCharacter = value.at(-1);
  if (
    value.length >= 2 &&
    (firstCharacter === '"' || firstCharacter === "'") &&
    firstCharacter === lastCharacter
  ) {
    return value.slice(1, -1);
  }
  return value;
}
