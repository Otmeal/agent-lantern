import type { ReporterDestination } from "../destinations.js";
import {
  destinationEnvironmentValues,
  normalizeEndpoint,
} from "../destinations.js";

export interface DestinationPlan {
  destinations: ReporterDestination[];
  desiredValues: Record<string, string>;
  staleKeys: string[];
}

/**
 * 把「既有目的地 + 命令列傳入的目的地 + 是否整批取代」算成最終要寫入 environment
 * 檔的內容，抽成純函式方便單獨測試，寫檔前也能先知道完整結果。
 */
export function planDestinationEnvironment(options: {
  existingDestinations: readonly ReporterDestination[];
  existingKeys: readonly string[];
  incoming: readonly ReporterDestination[];
  replace: boolean;
}): DestinationPlan {
  const { existingDestinations, existingKeys, incoming, replace } = options;

  const destinations: ReporterDestination[] = replace
    ? []
    : existingDestinations.map((destination) => ({ ...destination }));

  for (const candidate of incoming) {
    const endpoint = normalizeEndpoint(candidate.endpoint);
    const existingIndex = destinations.findIndex(
      (destination) => normalizeEndpoint(destination.endpoint) === endpoint,
    );
    if (existingIndex === -1) {
      destinations.push({ endpoint, token: candidate.token });
    } else {
      // 就地更新 token，保留原本的槽位順序。
      destinations[existingIndex] = { endpoint, token: candidate.token };
    }
  }

  const desiredValues = destinationEnvironmentValues(destinations);

  // 用「檔案裡實際存在的目的地鍵」回推該刪的鍵，而不是用既有目的地的數量去猜
  // 編號區間 —— 編號有缺口、endpoint 重複去重、或某槽位解析失敗時，用數量回推
  // 都會漏刪，留下孤兒鍵讓舊 daemon 繼續收到事件與 token。順序沿用 existingKeys
  // 原本的順序，維持穩定。
  const staleKeys = existingKeys.filter((key) => !(key in desiredValues));

  return {
    destinations,
    desiredValues,
    staleKeys,
  };
}
