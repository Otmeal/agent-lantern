import { describe, expect, it } from "vitest";

import {
  collectDestinations,
  destinationEnvironmentValues,
  resolveDestinations,
} from "./destinations.js";

describe("resolveDestinations", () => {
  it("只有無後綴那組鍵時回傳一個目的地", () => {
    const destinations = resolveDestinations({
      AGENT_LANTERN_DAEMON_ENDPOINT: "http://100.80.10.15:48123",
      AGENT_LANTERN_TOKEN: "token-1",
    });

    expect(destinations).toEqual([
      { endpoint: "http://100.80.10.15:48123", token: "token-1" },
    ]);
  });

  it("有 _2、_3 時依編號排序回傳三個", () => {
    const destinations = resolveDestinations({
      AGENT_LANTERN_DAEMON_ENDPOINT: "http://host-1:48123",
      AGENT_LANTERN_TOKEN: "token-1",
      AGENT_LANTERN_DAEMON_ENDPOINT_2: "http://host-2:48123",
      AGENT_LANTERN_TOKEN_2: "token-2",
      AGENT_LANTERN_DAEMON_ENDPOINT_3: "http://host-3:48123",
      AGENT_LANTERN_TOKEN_3: "token-3",
    });

    expect(destinations).toEqual([
      { endpoint: "http://host-1:48123", token: "token-1" },
      { endpoint: "http://host-2:48123", token: "token-2" },
      { endpoint: "http://host-3:48123", token: "token-3" },
    ]);
  });

  it("只有 _1、_2、_3（沒有無後綴那組）時仍正確解析出三個目的地，token 各自對應", () => {
    const destinations = resolveDestinations({
      AGENT_LANTERN_DAEMON_ENDPOINT_1: "http://host-1:48123",
      AGENT_LANTERN_TOKEN_1: "token-1",
      AGENT_LANTERN_DAEMON_ENDPOINT_2: "http://host-2:48123",
      AGENT_LANTERN_TOKEN_2: "token-2",
      AGENT_LANTERN_DAEMON_ENDPOINT_3: "http://host-3:48123",
      AGENT_LANTERN_TOKEN_3: "token-3",
    });

    expect(destinations).toEqual([
      { endpoint: "http://host-1:48123", token: "token-1" },
      { endpoint: "http://host-2:48123", token: "token-2" },
      { endpoint: "http://host-3:48123", token: "token-3" },
    ]);
  });

  it("AGENT_LANTERN_DAEMON_ENDPOINT_0 存在時不 crash，且排在無後綴那組前面", () => {
    const destinations = resolveDestinations({
      AGENT_LANTERN_DAEMON_ENDPOINT_0: "http://host-0:48123",
      AGENT_LANTERN_TOKEN_0: "token-0",
      AGENT_LANTERN_DAEMON_ENDPOINT: "http://host-1:48123",
      AGENT_LANTERN_TOKEN: "token-1",
    });

    expect(destinations).toEqual([
      { endpoint: "http://host-0:48123", token: "token-0" },
      { endpoint: "http://host-1:48123", token: "token-1" },
    ]);
  });

  it("編號有缺口時仍讀得到兩個", () => {
    const destinations = resolveDestinations({
      AGENT_LANTERN_DAEMON_ENDPOINT: "http://host-1:48123",
      AGENT_LANTERN_TOKEN: "token-1",
      AGENT_LANTERN_DAEMON_ENDPOINT_3: "http://host-3:48123",
      AGENT_LANTERN_TOKEN_3: "token-3",
    });

    expect(destinations).toEqual([
      { endpoint: "http://host-1:48123", token: "token-1" },
      { endpoint: "http://host-3:48123", token: "token-3" },
    ]);
  });

  it("AGENT_LANTERN_TOKEN_2 缺漏時退回 AGENT_LANTERN_TOKEN，並標記 tokenIsFallback", () => {
    const destinations = resolveDestinations({
      AGENT_LANTERN_DAEMON_ENDPOINT: "http://host-1:48123",
      AGENT_LANTERN_TOKEN: "shared-token",
      AGENT_LANTERN_DAEMON_ENDPOINT_2: "http://host-2:48123",
    });

    expect(destinations).toEqual([
      { endpoint: "http://host-1:48123", token: "shared-token" },
      {
        endpoint: "http://host-2:48123",
        token: "shared-token",
        tokenIsFallback: true,
      },
    ]);
  });

  it("AGENT_LANTERN_TOKEN_2 是空字串時同樣退回 AGENT_LANTERN_TOKEN，不丟出也不記 problem", () => {
    const { destinations, problems } = collectDestinations({
      AGENT_LANTERN_DAEMON_ENDPOINT: "http://host-1:48123",
      AGENT_LANTERN_TOKEN: "shared-token",
      AGENT_LANTERN_DAEMON_ENDPOINT_2: "http://host-2:48123",
      AGENT_LANTERN_TOKEN_2: "",
    });

    expect(destinations).toEqual([
      { endpoint: "http://host-1:48123", token: "shared-token" },
      {
        endpoint: "http://host-2:48123",
        token: "shared-token",
        tokenIsFallback: true,
      },
    ]);
    expect(
      problems.some((problem) => problem.key === "AGENT_LANTERN_TOKEN_2"),
    ).toBe(false);
  });

  it("同時有無後綴與 _1 且 endpoint 相同時去重成一個", () => {
    const destinations = resolveDestinations({
      AGENT_LANTERN_DAEMON_ENDPOINT: "http://host-1:48123",
      AGENT_LANTERN_TOKEN: "token-1",
      AGENT_LANTERN_DAEMON_ENDPOINT_1: "http://host-1:48123",
      AGENT_LANTERN_TOKEN_1: "token-1-dup",
    });

    expect(destinations).toEqual([
      { endpoint: "http://host-1:48123", token: "token-1" },
    ]);
  });

  it("override 帶 endpoint 時只回傳那一個，設定檔的 _2 被完全忽略", () => {
    const destinations = resolveDestinations(
      {
        AGENT_LANTERN_DAEMON_ENDPOINT: "http://host-1:48123",
        AGENT_LANTERN_TOKEN: "token-1",
        AGENT_LANTERN_DAEMON_ENDPOINT_2: "http://host-2:48123",
        AGENT_LANTERN_TOKEN_2: "token-2",
      },
      { endpoint: "http://override:48123", token: "override-token" },
    );

    expect(destinations).toEqual([
      { endpoint: "http://override:48123", token: "override-token" },
    ]);
  });

  it("endpoint 尾斜線被去掉，兩個槽位正規化後相同時去重只留第一個", () => {
    const destinations = resolveDestinations({
      AGENT_LANTERN_DAEMON_ENDPOINT: "http://host-1:48123/",
      AGENT_LANTERN_TOKEN: "token-1",
      AGENT_LANTERN_DAEMON_ENDPOINT_2: "http://host-1:48123",
      AGENT_LANTERN_TOKEN_2: "token-2",
    });

    expect(destinations).toEqual([
      { endpoint: "http://host-1:48123", token: "token-1" },
    ]);
  });

  it("完全沒有 endpoint 時丟出錯誤", () => {
    expect(() => resolveDestinations({})).toThrow(
      "AGENT_LANTERN_DAEMON_ENDPOINT is required.",
    );
  });
});

describe("collectDestinations", () => {
  it("_2 有 endpoint 但完全沒有任何 token（含 base）可用時，該槽位被略過並記進 problems，其他槽位照常回傳", () => {
    const { destinations, problems } = collectDestinations({
      AGENT_LANTERN_DAEMON_ENDPOINT_2: "http://host-2:48123",
      AGENT_LANTERN_DAEMON_ENDPOINT_3: "http://host-3:48123",
      AGENT_LANTERN_TOKEN_3: "token-3",
    });

    expect(destinations).toEqual([
      { endpoint: "http://host-3:48123", token: "token-3" },
    ]);
    expect(
      problems.some((problem) => problem.key === "AGENT_LANTERN_TOKEN_2"),
    ).toBe(true);
  });

  it("_2 沒設自己的 token 而退回 base token 時，該目的地標記 tokenIsFallback 且不記 problem", () => {
    const { destinations, problems } = collectDestinations({
      AGENT_LANTERN_DAEMON_ENDPOINT: "http://host-1:48123",
      AGENT_LANTERN_TOKEN: "shared-token",
      AGENT_LANTERN_DAEMON_ENDPOINT_2: "http://host-2:48123",
    });

    expect(destinations[1]?.tokenIsFallback).toBe(true);
    expect(
      problems.some(
        (problem) =>
          problem.key === "AGENT_LANTERN_TOKEN_2" &&
          problem.message.includes("沿用"),
      ),
    ).toBe(false);
  });

  it("override 只給 token 時，設定檔解析出的所有目的地 token 都被換掉，endpoint 不變", () => {
    const { destinations } = collectDestinations(
      {
        AGENT_LANTERN_DAEMON_ENDPOINT: "http://host-1:48123",
        AGENT_LANTERN_TOKEN: "token-1",
        AGENT_LANTERN_DAEMON_ENDPOINT_2: "http://host-2:48123",
        AGENT_LANTERN_TOKEN_2: "token-2",
      },
      { token: "override-token" },
    );

    expect(destinations).toEqual([
      { endpoint: "http://host-1:48123", token: "override-token" },
      { endpoint: "http://host-2:48123", token: "override-token" },
    ]);
  });

  it("override 只給 endpoint 且沒有任何 token 時，destinations 為空、problems 非空；resolveDestinations 則丟出", () => {
    const { destinations, problems } = collectDestinations(
      {},
      { endpoint: "http://override:48123" },
    );

    expect(destinations).toEqual([]);
    expect(problems.length).toBeGreaterThan(0);
    expect(() =>
      resolveDestinations({}, { endpoint: "http://override:48123" }),
    ).toThrow();
  });

  it("設定檔只有 endpoint、完全沒有任何 token，override 給 token 時仍能解析出一個目的地", () => {
    const { destinations, problems } = collectDestinations(
      { AGENT_LANTERN_DAEMON_ENDPOINT: "http://host-1:48123" },
      { token: "override-token" },
    );

    expect(destinations).toEqual([
      {
        endpoint: "http://host-1:48123",
        token: "override-token",
        tokenIsFallback: true,
      },
    ]);
    expect(problems).toEqual([]);
  });

  it("endpoint 鍵存在但為空字串時記一筆 problem，訊息含「是空值」", () => {
    const { destinations, problems } = collectDestinations({
      AGENT_LANTERN_DAEMON_ENDPOINT: "",
      AGENT_LANTERN_TOKEN: "token-1",
    });

    expect(destinations).toEqual([]);
    expect(
      problems.some(
        (problem) =>
          problem.key === "AGENT_LANTERN_DAEMON_ENDPOINT" &&
          problem.message.includes("是空值"),
      ),
    ).toBe(true);
  });

  it("重複 endpoint 且第二個槽位的 own token 不同時，只回傳一個目的地並記一筆提到 token 不同的 problem", () => {
    const { destinations, problems } = collectDestinations({
      AGENT_LANTERN_DAEMON_ENDPOINT: "http://host-1:48123",
      AGENT_LANTERN_TOKEN: "token-1",
      AGENT_LANTERN_DAEMON_ENDPOINT_2: "http://host-1:48123",
      AGENT_LANTERN_TOKEN_2: "token-2",
    });

    expect(destinations).toEqual([
      { endpoint: "http://host-1:48123", token: "token-1" },
    ]);
    expect(
      problems.some(
        (problem) =>
          problem.key === "AGENT_LANTERN_TOKEN_2" &&
          problem.message.includes("不同"),
      ),
    ).toBe(true);
  });
});

describe("destinationEnvironmentValues", () => {
  it("兩個目的地會產生無後綴那組與 _2 那組共四個鍵", () => {
    const values = destinationEnvironmentValues([
      { endpoint: "http://host-1:48123", token: "token-1" },
      { endpoint: "http://host-2:48123", token: "token-2" },
    ]);

    expect(values).toEqual({
      AGENT_LANTERN_DAEMON_ENDPOINT: "http://host-1:48123",
      AGENT_LANTERN_TOKEN: "token-1",
      AGENT_LANTERN_DAEMON_ENDPOINT_2: "http://host-2:48123",
      AGENT_LANTERN_TOKEN_2: "token-2",
    });
  });

  it("tokenIsFallback 為 true 的目的地不會寫出 token 鍵，只寫 endpoint", () => {
    const values = destinationEnvironmentValues([
      { endpoint: "http://host-1:48123", token: "token-1" },
      {
        endpoint: "http://host-2:48123",
        token: "shared-token",
        tokenIsFallback: true,
      },
    ]);

    expect(values).toEqual({
      AGENT_LANTERN_DAEMON_ENDPOINT: "http://host-1:48123",
      AGENT_LANTERN_TOKEN: "token-1",
      AGENT_LANTERN_DAEMON_ENDPOINT_2: "http://host-2:48123",
    });
  });
});
