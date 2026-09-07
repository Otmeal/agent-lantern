/**
 * reporter 可以同時把事件送到多個 daemon。第一個目的地沿用原本沒有後綴的鍵，
 * 第二個之後改用 `_2`、`_3` 的編號後綴，既有的單一目的地設定因此完全不必動。
 */

export interface ReporterDestination {
  endpoint: string;
  token: string;
  /**
   * token 是從沒有後綴的 `AGENT_LANTERN_TOKEN` 退回來的，不是這個槽位自己設定
   * 的。安裝端必須據此避免把 daemon 1 的憑證寫死成 daemon 2 的 token。
   */
  tokenIsFallback?: boolean;
}

export const endpointKeyPrefix = "AGENT_LANTERN_DAEMON_ENDPOINT";
export const tokenKeyPrefix = "AGENT_LANTERN_TOKEN";

export interface DestinationEnvironmentKeys {
  endpointKey: string;
  tokenKey: string;
}

export function environmentKeysForSlot(
  slot: number,
): DestinationEnvironmentKeys {
  return environmentKeysForSuffix(slot <= 1 ? "" : `_${slot}`);
}

function environmentKeysForSuffix(suffix: string): DestinationEnvironmentKeys {
  return {
    endpointKey: `${endpointKeyPrefix}${suffix}`,
    tokenKey: `${tokenKeyPrefix}${suffix}`,
  };
}

const endpointKeyPattern = new RegExp(`^${endpointKeyPrefix}(_(\\d+))?$`);
const tokenKeyPattern = new RegExp(`^${tokenKeyPrefix}(_(\\d+))?$`);

/**
 * 認得的鍵回傳槽位編號，無後綴視為 1；不是目的地鍵則回傳 undefined。
 */
export function parseSlotFromKey(key: string): number | undefined {
  const match = endpointKeyPattern.exec(key) ?? tokenKeyPattern.exec(key);
  if (!match) {
    return undefined;
  }
  const slotValue = match[2];
  return slotValue === undefined ? 1 : Number.parseInt(slotValue, 10);
}

export function isDestinationKey(key: string): boolean {
  return parseSlotFromKey(key) !== undefined;
}

/**
 * 檔案裡實際存在的目的地鍵。安裝端要靠這份清單算出哪些編號鍵該被刪掉，
 * 用解析後的目的地數量回推會在編號有缺口或 endpoint 重複時漏刪。
 */
export function destinationKeysIn(environment: NodeJS.ProcessEnv): string[] {
  return Object.keys(environment).filter((key) => isDestinationKey(key));
}

export function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/$/, "");
}

export interface DestinationOverride {
  endpoint?: string | undefined;
  token?: string | undefined;
}

export interface DestinationProblem {
  key: string;
  message: string;
}

export interface DestinationResolution {
  destinations: ReporterDestination[];
  problems: DestinationProblem[];
}

function readTrimmed(
  environment: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const value = environment[key]?.trim();
  return value ? value : undefined;
}

/**
 * 單一槽位設定不良時只跳過那一個槽位並記下原因，不讓整批目的地一起失效 ——
 * 送出端的語意是「一個成功就算成功」，解析階段不該先 fail-closed。
 */
export function collectDestinations(
  environment: NodeJS.ProcessEnv,
  override?: DestinationOverride,
): DestinationResolution {
  const problems: DestinationProblem[] = [];
  const overrideToken = override?.token?.trim() || undefined;
  const baseToken = readTrimmed(environment, tokenKeyPrefix);

  if (override?.endpoint) {
    const token = overrideToken ?? baseToken;
    if (!token) {
      return {
        destinations: [],
        problems: [
          { key: tokenKeyPrefix, message: `${tokenKeyPrefix} is required.` },
        ],
      };
    }
    return {
      destinations: [{ endpoint: normalizeEndpoint(override.endpoint), token }],
      problems,
    };
  }

  // 使用者手動刪掉中間某一組時，後面的編號不應該跟著失效，所以逐鍵掃描而不是
  // 從 1 開始連續遞增。token 的鍵名由 endpoint 鍵的後綴推出來，`_1` 這種對稱
  // 寫法才不會被誤查成無後綴的那一組。
  const slots: { slot: number; endpointKey: string; tokenKey: string }[] = [];
  for (const key of Object.keys(environment)) {
    const match = endpointKeyPattern.exec(key);
    if (!match) {
      continue;
    }
    if (!readTrimmed(environment, key)) {
      // 鍵存在卻是空值是設定寫錯，靜靜跳過會讓人找不到原因。
      problems.push({
        key,
        message: `${key} 是空值，已略過這個目的地。`,
      });
      continue;
    }
    const suffix = match[1] ?? "";
    slots.push({
      slot: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
      ...environmentKeysForSuffix(suffix),
    });
  }
  slots.sort((left, right) => left.slot - right.slot);

  const destinations: ReporterDestination[] = [];
  const seenEndpoints = new Map<string, string | undefined>();
  for (const { endpointKey, tokenKey } of slots) {
    const endpoint = normalizeEndpoint(environment[endpointKey] ?? "");
    const ownToken = readTrimmed(environment, tokenKey);

    // 去重要在 token 解析之前，才不會為一個馬上要被丟掉的槽位發警告。
    if (seenEndpoints.has(endpoint)) {
      const keptToken = seenEndpoints.get(endpoint);
      if (ownToken && ownToken !== keptToken) {
        problems.push({
          key: tokenKey,
          message: `${endpoint} 重複設定且 ${tokenKey} 與先前的 token 不同，已沿用先出現的那一組。`,
        });
      }
      continue;
    }

    // 多台 daemon 常常共用同一組 token，缺編號 token 時退回第一組的；命令列
    // 的 --token 也在這裡生效，否則只給 --token 會救不回沒有 token 的槽位。
    const token = ownToken ?? overrideToken ?? baseToken;
    if (!token) {
      problems.push({
        key: tokenKey,
        message: `${endpointKey}=${endpoint} 沒有對應的 ${tokenKey}，已略過這個目的地。`,
      });
      continue;
    }

    seenEndpoints.set(endpoint, token);
    destinations.push({
      endpoint,
      // 命令列的 --token 是一次性覆寫，不算這個槽位自己的 token。
      token: overrideToken ?? token,
      // 退回來的 token 不屬於這個槽位，安裝端不可以把它寫死進設定檔。
      ...(ownToken === undefined ? { tokenIsFallback: true as const } : {}),
    });
  }

  return { destinations, problems };
}

/**
 * 一個有效目的地都湊不出來時才丟出，錯誤訊息沿用單一目的地時代的文字。
 */
export function resolveDestinations(
  environment: NodeJS.ProcessEnv,
  override?: DestinationOverride,
): ReporterDestination[] {
  const { destinations, problems } = collectDestinations(environment, override);
  if (destinations.length === 0) {
    const detail = problems.map((problem) => problem.message).join("\n");
    throw new Error(detail || `${endpointKeyPrefix} is required.`);
  }
  return destinations;
}

/**
 * 目的地清單轉回 environment 檔的鍵值，槽位一律重新編號成連續的 1..N。
 */
export function destinationEnvironmentValues(
  destinations: readonly ReporterDestination[],
): Record<string, string> {
  const values: Record<string, string> = {};
  destinations.forEach((destination, index) => {
    const { endpointKey, tokenKey } = environmentKeysForSlot(index + 1);
    values[endpointKey] = destination.endpoint;
    if (!destination.tokenIsFallback) {
      values[tokenKey] = destination.token;
    }
  });
  return values;
}
