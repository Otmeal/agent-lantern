import { describe, expect, it } from "vitest";

import { parseInstallCommandLine } from "./command-line.js";

describe("parseInstallCommandLine", () => {
  it("單一 --endpoint 加 --token 組成一個目的地", () => {
    const options = parseInstallCommandLine(
      "install",
      ["--endpoint", "http://a:48123", "--token", "token-a"],
      {},
      undefined,
    );

    expect(options.destinations).toEqual([
      { endpoint: "http://a:48123", token: "token-a" },
    ]);
  });

  it("多個 --endpoint 加對應數量的 --token 依命令列順序正確配對", () => {
    const options = parseInstallCommandLine(
      "install",
      [
        "--endpoint",
        "http://a:48123",
        "--token",
        "token-a",
        "--endpoint",
        "http://b:48123",
        "--token",
        "token-b",
      ],
      {},
      undefined,
    );

    expect(options.destinations).toEqual([
      { endpoint: "http://a:48123", token: "token-a" },
      { endpoint: "http://b:48123", token: "token-b" },
    ]);
  });

  it("多個 --endpoint 只給單一 --token 時套用到全部", () => {
    const options = parseInstallCommandLine(
      "install",
      [
        "--endpoint",
        "http://a:48123",
        "--endpoint",
        "http://b:48123",
        "--token",
        "token-shared",
      ],
      {},
      undefined,
    );

    expect(options.destinations).toEqual([
      { endpoint: "http://a:48123", token: "token-shared" },
      { endpoint: "http://b:48123", token: "token-shared" },
    ]);
  });

  it("token 數量既非 1 也不等於 endpoint 數時丟出", () => {
    expect(() =>
      parseInstallCommandLine(
        "install",
        [
          "--endpoint",
          "http://a:48123",
          "--endpoint",
          "http://b:48123",
          "--endpoint",
          "http://c:48123",
          "--token",
          "token-a",
          "--token",
          "token-b",
        ],
        {},
        undefined,
      ),
    ).toThrow(/--token 的數量/);
  });

  it("同時給 --endpoint 與 --daemon-endpoint 時丟出", () => {
    expect(() =>
      parseInstallCommandLine(
        "install",
        [
          "--daemon-endpoint",
          "http://b:48123",
          "--token",
          "token-b",
          "--endpoint",
          "http://a:48123",
          "--token",
          "token-a",
        ],
        {},
        undefined,
      ),
    ).toThrow(
      "--endpoint 與 --daemon-endpoint 不能混用，請統一使用 --endpoint。",
    );
  });

  it("--token-stdin 同時給 --token 時丟出", () => {
    expect(() =>
      parseInstallCommandLine(
        "install",
        ["--endpoint", "http://a:48123", "--token", "token-a", "--token-stdin"],
        {},
        "token-from-stdin",
      ),
    ).toThrow("--token-stdin 不能與 --token 同時使用。");
  });

  it("--token-stdin 沒讀到 token 時丟出既有訊息", () => {
    expect(() =>
      parseInstallCommandLine(
        "install",
        ["--endpoint", "http://a:48123", "--token-stdin"],
        {},
        undefined,
      ),
    ).toThrow("--token-stdin 沒有從標準輸入讀到 token。");
  });

  it("完全沒給 endpoint 時退回環境變數", () => {
    const options = parseInstallCommandLine(
      "install",
      [],
      {
        AGENT_LANTERN_DAEMON_ENDPOINT: "http://env:48123",
        AGENT_LANTERN_TOKEN: "token-env",
      },
      undefined,
    );

    expect(options.destinations).toEqual([
      { endpoint: "http://env:48123", token: "token-env" },
    ]);
  });

  it("--replace 反映到 replaceDestinations", () => {
    const options = parseInstallCommandLine(
      "install",
      ["--endpoint", "http://a:48123", "--token", "token-a", "--replace"],
      {},
      undefined,
    );

    expect(options.replaceDestinations).toBe(true);
  });

  it("沒有加 --replace 時 replaceDestinations 為 false", () => {
    const options = parseInstallCommandLine(
      "install",
      ["--endpoint", "http://a:48123", "--token", "token-a"],
      {},
      undefined,
    );

    expect(options.replaceDestinations).toBe(false);
  });

  it("--replace 沒給 --endpoint 時丟出，即使有其他選項或環境變數裡有 endpoint（問題 C）", () => {
    expect(() =>
      parseInstallCommandLine(
        "install",
        ["--replace", "--host-name", "foo"],
        {
          AGENT_LANTERN_DAEMON_ENDPOINT: "http://env:48123",
          AGENT_LANTERN_TOKEN: "token-env",
        },
        undefined,
      ),
    ).toThrow("--replace 必須至少搭配一個 --endpoint。");
  });

  it("--replace 加 --token 但沒給 --endpoint 一樣丟出（想輪替憑證也必須帶 --endpoint）", () => {
    expect(() =>
      parseInstallCommandLine(
        "install",
        ["--replace", "--token", "new-token"],
        {
          AGENT_LANTERN_DAEMON_ENDPOINT: "http://env:48123",
          AGENT_LANTERN_TOKEN: "token-env",
        },
        undefined,
      ),
    ).toThrow("--replace 必須至少搭配一個 --endpoint。");
  });

  it("--replace 有顯式 --endpoint 時放行", () => {
    const options = parseInstallCommandLine(
      "install",
      ["--replace", "--endpoint", "http://a:48123", "--token", "token-a"],
      {},
      undefined,
    );

    expect(options.replaceDestinations).toBe(true);
    expect(options.destinations).toEqual([
      { endpoint: "http://a:48123", token: "token-a" },
    ]);
  });

  it("全新 endpoint 沒給 --token 時丟出明確錯誤，不退回既有的 base token（問題 B）", () => {
    expect(() =>
      parseInstallCommandLine(
        "install",
        ["--endpoint", "http://newhost:48123"],
        {
          AGENT_LANTERN_DAEMON_ENDPOINT: "http://existing:48123",
          AGENT_LANTERN_TOKEN: "existing-token",
        },
        undefined,
      ),
    ).toThrow(
      "http://newhost:48123 是新的目的地，請用 --token 或 --token-stdin 指定它的 token。",
    );
  });

  it("既有 endpoint 沒給 --token 時仍可退回設定檔裡的 base token", () => {
    const options = parseInstallCommandLine(
      "install",
      ["--endpoint", "http://existing:48123"],
      {
        AGENT_LANTERN_DAEMON_ENDPOINT: "http://existing:48123",
        AGENT_LANTERN_TOKEN: "existing-token",
      },
      undefined,
    );

    expect(options.destinations).toEqual([
      { endpoint: "http://existing:48123", token: "existing-token" },
    ]);
  });

  it("同時給既有與全新 endpoint、沒帶 --token 時，錯誤訊息只點名新的那個", () => {
    expect(() =>
      parseInstallCommandLine(
        "install",
        [
          "--endpoint",
          "http://existing:48123",
          "--endpoint",
          "http://newhost:48123",
        ],
        {
          AGENT_LANTERN_DAEMON_ENDPOINT: "http://existing:48123",
          AGENT_LANTERN_TOKEN: "existing-token",
        },
        undefined,
      ),
    ).toThrow(
      "http://newhost:48123 是新的目的地，請用 --token 或 --token-stdin 指定它的 token。",
    );
  });

  it("全新 endpoint 顯式給 --token 時不受 base token 退回限制", () => {
    const options = parseInstallCommandLine(
      "install",
      ["--endpoint", "http://newhost:48123", "--token", "new-token"],
      {
        AGENT_LANTERN_DAEMON_ENDPOINT: "http://existing:48123",
        AGENT_LANTERN_TOKEN: "existing-token",
      },
      undefined,
    );

    expect(options.destinations).toEqual([
      { endpoint: "http://newhost:48123", token: "new-token" },
    ]);
  });
});
