import { describe, expect, it } from "vitest";

import type { ReporterDestination } from "../destinations.js";
import { destinationKeysIn } from "../destinations.js";
import { planDestinationEnvironment } from "./destination-plan.js";
import {
  managedEnvironmentKeysIn,
  parseEnvironmentAssignments,
} from "./index.js";

const destinationA: ReporterDestination = {
  endpoint: "http://a:48123",
  token: "token-a",
};
const destinationB: ReporterDestination = {
  endpoint: "http://b:48123",
  token: "token-b",
};

const keysFor = (...slots: number[]): string[] =>
  slots.flatMap((slot) =>
    slot <= 1
      ? ["AGENT_LANTERN_DAEMON_ENDPOINT", "AGENT_LANTERN_TOKEN"]
      : [
          `AGENT_LANTERN_DAEMON_ENDPOINT_${slot}`,
          `AGENT_LANTERN_TOKEN_${slot}`,
        ],
  );

describe("planDestinationEnvironment", () => {
  it("追加新的 endpoint 到既有目的地之後", () => {
    const plan = planDestinationEnvironment({
      existingDestinations: [destinationA],
      existingKeys: keysFor(1),
      incoming: [destinationB],
      replace: false,
    });

    expect(plan.destinations).toEqual([destinationA, destinationB]);
    expect(plan.desiredValues).toEqual({
      AGENT_LANTERN_DAEMON_ENDPOINT: "http://a:48123",
      AGENT_LANTERN_TOKEN: "token-a",
      AGENT_LANTERN_DAEMON_ENDPOINT_2: "http://b:48123",
      AGENT_LANTERN_TOKEN_2: "token-b",
    });
    expect(plan.staleKeys).toEqual([]);
  });

  it("同一個 endpoint 就地更新 token，不新增槽位", () => {
    const plan = planDestinationEnvironment({
      existingDestinations: [destinationA, destinationB],
      existingKeys: keysFor(1, 2),
      incoming: [{ endpoint: "http://a:48123", token: "new-token" }],
      replace: false,
    });

    expect(plan.destinations).toEqual([
      { endpoint: "http://a:48123", token: "new-token" },
      destinationB,
    ]);
    expect(plan.staleKeys).toEqual([]);
  });

  it("replace 為真時捨棄既有目的地，只留下 incoming", () => {
    const plan = planDestinationEnvironment({
      existingDestinations: [destinationA, destinationB],
      existingKeys: keysFor(1, 2),
      incoming: [{ endpoint: "http://c:48123", token: "token-c" }],
      replace: true,
    });

    expect(plan.destinations).toEqual([
      { endpoint: "http://c:48123", token: "token-c" },
    ]);
    expect(plan.staleKeys).toEqual([
      "AGENT_LANTERN_DAEMON_ENDPOINT_2",
      "AGENT_LANTERN_TOKEN_2",
    ]);
  });

  it("replace 後既有目的地比合併結果多兩筆時，把多出來的 _2 與 _3 都列入 staleKeys", () => {
    const destinationC: ReporterDestination = {
      endpoint: "http://c:48123",
      token: "token-c",
    };
    const plan = planDestinationEnvironment({
      existingDestinations: [destinationA, destinationB, destinationC],
      existingKeys: keysFor(1, 2, 3),
      incoming: [destinationA],
      replace: true,
    });

    expect(plan.destinations).toEqual([destinationA]);
    expect(plan.staleKeys).toEqual([
      "AGENT_LANTERN_DAEMON_ENDPOINT_2",
      "AGENT_LANTERN_TOKEN_2",
      "AGENT_LANTERN_DAEMON_ENDPOINT_3",
      "AGENT_LANTERN_TOKEN_3",
    ]);
  });

  it("incoming 自身有重複 endpoint 時，後面的覆蓋前面的", () => {
    const plan = planDestinationEnvironment({
      existingDestinations: [],
      existingKeys: [],
      incoming: [
        { endpoint: "http://a:48123", token: "first" },
        { endpoint: "http://a:48123", token: "second" },
      ],
      replace: false,
    });

    expect(plan.destinations).toEqual([
      { endpoint: "http://a:48123", token: "second" },
    ]);
    expect(plan.staleKeys).toEqual([]);
  });

  it("既有檔案編號有缺口（無後綴與 _3），replace 只留一個新目的地時，_3 那組鍵仍要被列為 stale", () => {
    const plan = planDestinationEnvironment({
      existingDestinations: [destinationA, destinationB],
      existingKeys: [
        "AGENT_LANTERN_DAEMON_ENDPOINT",
        "AGENT_LANTERN_TOKEN",
        "AGENT_LANTERN_DAEMON_ENDPOINT_3",
        "AGENT_LANTERN_TOKEN_3",
      ],
      incoming: [{ endpoint: "http://d:48123", token: "token-d" }],
      replace: true,
    });

    expect(plan.destinations).toEqual([
      { endpoint: "http://d:48123", token: "token-d" },
    ]);
    // 無後綴的鍵仍會被寫入（值換成新的 d），只有 slot 3 完全沒有對應目的地。
    expect(plan.staleKeys).toEqual([
      "AGENT_LANTERN_DAEMON_ENDPOINT_3",
      "AGENT_LANTERN_TOKEN_3",
    ]);
  });

  it("既有兩個槽位 endpoint 重複去重後只剩一個目的地時，_2 那組鍵仍被列入 staleKeys", () => {
    // 檔案裡 slot 1 與 slot 2 都是 endpoint A（使用者手動編輯造成的重複），
    // collectDestinations 去重後只會回傳一個目的地，但兩組鍵在檔案裡都還在。
    const plan = planDestinationEnvironment({
      existingDestinations: [destinationA],
      existingKeys: keysFor(1, 2),
      incoming: [destinationA],
      replace: true,
    });

    expect(plan.destinations).toEqual([destinationA]);
    expect(plan.staleKeys).toEqual([
      "AGENT_LANTERN_DAEMON_ENDPOINT_2",
      "AGENT_LANTERN_TOKEN_2",
    ]);
  });

  it("非 replace 的追加情境下，既有編號比合併後多時也能正確列出 staleKeys（防禦）", () => {
    const plan = planDestinationEnvironment({
      existingDestinations: [destinationA, destinationB],
      existingKeys: keysFor(1, 2, 3),
      incoming: [],
      replace: false,
    });

    expect(plan.destinations).toEqual([destinationA, destinationB]);
    expect(plan.staleKeys).toEqual([
      "AGENT_LANTERN_DAEMON_ENDPOINT_3",
      "AGENT_LANTERN_TOKEN_3",
    ]);
  });

  // 問題 A：token 從無後綴的 AGENT_LANTERN_TOKEN 退回來的目的地，不能被合併路徑
  // 寫死進檔案，否則讀取期的退回就失去意義（daemon A 的憑證被固化成 daemon B
  // 的 token）。
  describe("tokenIsFallback 在合併路徑上的傳遞（問題 A）", () => {
    const fallbackB: ReporterDestination = {
      endpoint: "http://b:48123",
      token: "token-a", // 退回自 destinationA 的 token
      tokenIsFallback: true,
    };
    // 檔案裡本來就沒有 AGENT_LANTERN_TOKEN_2 這個鍵——fallback 的目的地從來
    // 不會把 token 寫進檔案。
    const existingKeysWithFallback = [
      "AGENT_LANTERN_DAEMON_ENDPOINT",
      "AGENT_LANTERN_TOKEN",
      "AGENT_LANTERN_DAEMON_ENDPOINT_2",
    ];

    it("既有目的地未被 incoming 命中時，原樣保留 tokenIsFallback，也不誤把它的 endpoint 鍵當 stale", () => {
      const plan = planDestinationEnvironment({
        existingDestinations: [destinationA, fallbackB],
        existingKeys: existingKeysWithFallback,
        incoming: [],
        replace: false,
      });

      expect(plan.destinations).toEqual([destinationA, fallbackB]);
      expect(plan.desiredValues).toEqual({
        AGENT_LANTERN_DAEMON_ENDPOINT: "http://a:48123",
        AGENT_LANTERN_TOKEN: "token-a",
        AGENT_LANTERN_DAEMON_ENDPOINT_2: "http://b:48123",
        // 沒有 AGENT_LANTERN_TOKEN_2：fallback 的 token 不寫回檔案。
      });
      // 既有檔案裡本來就沒有 TOKEN_2，staleKeys 不該憑空冒出一個要求移除它。
      expect(plan.staleKeys).toEqual([]);
    });

    it("既有目的地被 incoming 以相同 endpoint 命中時，改用 incoming 的 token 並清掉 tokenIsFallback", () => {
      const plan = planDestinationEnvironment({
        existingDestinations: [destinationA, fallbackB],
        existingKeys: existingKeysWithFallback,
        incoming: [{ endpoint: "http://b:48123", token: "explicit-token-b" }],
        replace: false,
      });

      expect(plan.destinations).toEqual([
        destinationA,
        { endpoint: "http://b:48123", token: "explicit-token-b" },
      ]);
      // 一旦清掉 tokenIsFallback，desiredValues 就必須真正寫入這個新 token，
      // 否則使用者顯式給的 token 會靜靜地不見。
      expect(plan.desiredValues).toEqual({
        AGENT_LANTERN_DAEMON_ENDPOINT: "http://a:48123",
        AGENT_LANTERN_TOKEN: "token-a",
        AGENT_LANTERN_DAEMON_ENDPOINT_2: "http://b:48123",
        AGENT_LANTERN_TOKEN_2: "explicit-token-b",
      });
      expect(plan.staleKeys).toEqual([]);
    });

    it("incoming 新增的目的地不帶 tokenIsFallback，desiredValues 會寫入它的 token", () => {
      const plan = planDestinationEnvironment({
        existingDestinations: [destinationA],
        existingKeys: keysFor(1),
        incoming: [{ endpoint: "http://c:48123", token: "token-c" }],
        replace: false,
      });

      expect(plan.destinations).toEqual([
        destinationA,
        { endpoint: "http://c:48123", token: "token-c" },
      ]);
      expect(plan.desiredValues).toEqual({
        AGENT_LANTERN_DAEMON_ENDPOINT: "http://a:48123",
        AGENT_LANTERN_TOKEN: "token-a",
        AGENT_LANTERN_DAEMON_ENDPOINT_2: "http://c:48123",
        AGENT_LANTERN_TOKEN_2: "token-c",
      });
    });

    it("replace 且 incoming 命中原本 fallback 的目的地時，新 token 會被寫入且不再是 fallback", () => {
      const plan = planDestinationEnvironment({
        existingDestinations: [destinationA, fallbackB],
        existingKeys: existingKeysWithFallback,
        incoming: [{ endpoint: "http://b:48123", token: "rotated-token" }],
        replace: true,
      });

      expect(plan.destinations).toEqual([
        { endpoint: "http://b:48123", token: "rotated-token" },
      ]);
      expect(plan.desiredValues).toEqual({
        AGENT_LANTERN_DAEMON_ENDPOINT: "http://b:48123",
        AGENT_LANTERN_TOKEN: "rotated-token",
      });
      // 原本 slot 1（destinationA）與 slot 2 的 endpoint 都要被清乾淨。
      expect(plan.staleKeys).toEqual(["AGENT_LANTERN_DAEMON_ENDPOINT_2"]);
    });
  });
});

// 問題 G：parseEnvironmentAssignments → destinationKeysIn → existingKeys 這條
// 接線先前完全沒有測試覆蓋，純函式各自測得再好也擋不住接線本身接錯。
describe("parseEnvironmentAssignments 與 destinationKeysIn 的接線（問題 G）", () => {
  it("從真實檔案內容解析出的鍵，經 destinationKeysIn 篩選後剛好是所有目的地鍵", () => {
    const content = [
      "# 這是一段註解",
      "AGENT_LANTERN_DAEMON_ENDPOINT=http://a:48123",
      "AGENT_LANTERN_TOKEN=token-a",
      "AGENT_LANTERN_DAEMON_ENDPOINT_2=http://b:48123",
      "AGENT_LANTERN_TOKEN_2=token-b",
      "AGENT_LANTERN_DAEMON_ENDPOINT_3=http://c:48123",
      "AGENT_LANTERN_TOKEN_3=token-c",
      "AGENT_LANTERN_HOST_NAME=my-host",
      "MY_OWN_VARIABLE=keep-me",
    ].join("\n");

    const existingKeys = destinationKeysIn(
      parseEnvironmentAssignments(content),
    );

    expect(new Set(existingKeys)).toEqual(
      new Set([
        "AGENT_LANTERN_DAEMON_ENDPOINT",
        "AGENT_LANTERN_TOKEN",
        "AGENT_LANTERN_DAEMON_ENDPOINT_2",
        "AGENT_LANTERN_TOKEN_2",
        "AGENT_LANTERN_DAEMON_ENDPOINT_3",
        "AGENT_LANTERN_TOKEN_3",
      ]),
    );
    expect(existingKeys).not.toContain("AGENT_LANTERN_HOST_NAME");
    expect(existingKeys).not.toContain("MY_OWN_VARIABLE");
  });
});

describe("managedEnvironmentKeysIn", () => {
  it("只收目的地鍵與 HOST_NAME，不誤收使用者自己的變數或非編號的類似鍵", () => {
    const content = [
      "# 這是一段註解",
      "AGENT_LANTERN_DAEMON_ENDPOINT=http://a:48123",
      "AGENT_LANTERN_TOKEN=token-a",
      "AGENT_LANTERN_DAEMON_ENDPOINT_2=http://b:48123",
      "AGENT_LANTERN_TOKEN_2=token-b",
      "AGENT_LANTERN_DAEMON_ENDPOINT_3=http://c:48123",
      "AGENT_LANTERN_TOKEN_3=token-c",
      "AGENT_LANTERN_HOST_NAME=my-host",
      "MY_OWN_VARIABLE=keep-me",
      "AGENT_LANTERN_DAEMON_ENDPOINT_BACKUP=http://not-a-slot:1",
    ].join("\n");

    const keys = managedEnvironmentKeysIn(content);

    expect(new Set(keys)).toEqual(
      new Set([
        "AGENT_LANTERN_DAEMON_ENDPOINT",
        "AGENT_LANTERN_TOKEN",
        "AGENT_LANTERN_DAEMON_ENDPOINT_2",
        "AGENT_LANTERN_TOKEN_2",
        "AGENT_LANTERN_DAEMON_ENDPOINT_3",
        "AGENT_LANTERN_TOKEN_3",
        "AGENT_LANTERN_HOST_NAME",
      ]),
    );
    expect(keys).not.toContain("MY_OWN_VARIABLE");
    expect(keys).not.toContain("AGENT_LANTERN_DAEMON_ENDPOINT_BACKUP");
  });
});
