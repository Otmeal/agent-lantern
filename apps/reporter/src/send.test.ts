import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReporterDestination } from "./destinations.js";
import { deliverEvent } from "./send.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const destinationA: ReporterDestination = {
  endpoint: "http://host-a:48123",
  token: "token-a",
};
const destinationB: ReporterDestination = {
  endpoint: "http://host-b:48123",
  token: "token-b",
};

describe("deliverEvent", () => {
  it("兩個目的地全部 200 時回傳兩筆 ok，且 fetch 被呼叫兩次、URL 與 header 正確", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const results = await deliverEvent([destinationA, destinationB], {
      hello: "world",
    });

    expect(results).toEqual([
      { destination: destinationA, ok: true, error: undefined },
      { destination: destinationB, ok: true, error: undefined },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://host-a:48123/api/v1/events",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer token-a",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://host-b:48123/api/v1/events",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer token-b",
        }),
      }),
    );
  });

  it("一個 200 一個丟出網路錯誤時，回傳含一筆 ok 一筆非 ok 且順序與輸入相同", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("http://host-a")) {
        return new Response(null, { status: 200 });
      }
      throw new Error("connect ECONNREFUSED");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const results = await deliverEvent([destinationA, destinationB], {});

    expect(results).toEqual([
      { destination: destinationA, ok: true, error: undefined },
      {
        destination: destinationB,
        ok: false,
        error: "connect ECONNREFUSED",
      },
    ]);
  });

  it("回 401 帶 body 時 ok 為 false 且 error 含狀態碼與內容", async () => {
    const fetchMock = vi.fn(
      async () => new Response("invalid token", { status: 401 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const results = await deliverEvent([destinationA], {});

    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toContain("Daemon rejected the event with 401");
    expect(results[0]?.error).toContain("invalid token");
  });

  it("全部失敗時 deliverEvent 本身不 reject，兩筆都 ok 為 false", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("timeout");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const results = await deliverEvent([destinationA, destinationB], {});

    expect(results).toHaveLength(2);
    expect(results.every((result) => !result.ok)).toBe(true);
  });

  it("兩個目的地平行送出，同一時刻確實有兩個請求在進行中", async () => {
    // 用 in-flight 計數器直接證明併發，不依賴掛鐘計時，避免測試變得 flaky。
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn(
      async () =>
        new Promise<Response>((resolvePromise) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          setTimeout(() => {
            inFlight -= 1;
            resolvePromise(new Response(null, { status: 200 }));
          }, 10);
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const results = await deliverEvent([destinationA, destinationB], {});

    expect(results.every((result) => result.ok)).toBe(true);
    expect(maxInFlight).toBe(2);
  });
});
