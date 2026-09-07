import { describe, expect, it } from "vitest";

import { parseCommandLine } from "./command-line.js";

describe("parseCommandLine", () => {
  it("既非 hook 也非 send 的 command 會丟出 usage 錯誤", () => {
    expect(() => parseCommandLine(["bogus"], {})).toThrow(
      "Usage: agent-status-reporter <hook|send> --agent <codex|claude|custom>",
    );
  });

  it("send 沒給 --status 時丟出", () => {
    expect(() =>
      parseCommandLine(["send", "--agent", "codex"], {
        AGENT_LANTERN_DAEMON_ENDPOINT: "http://host-1:48123",
        AGENT_LANTERN_TOKEN: "token-1",
      }),
    ).toThrow("The send command requires --status.");
  });

  it("環境只有無後綴 endpoint 與 token 時，解析出一個目的地", () => {
    const options = parseCommandLine(["hook", "--agent", "codex"], {
      AGENT_LANTERN_DAEMON_ENDPOINT: "http://host-1:48123",
      AGENT_LANTERN_TOKEN: "token-1",
    });

    expect(options.destinations).toEqual([
      { endpoint: "http://host-1:48123", token: "token-1" },
    ]);
  });

  it("環境有 _2 時，解析出兩個目的地", () => {
    const options = parseCommandLine(["hook", "--agent", "codex"], {
      AGENT_LANTERN_DAEMON_ENDPOINT: "http://host-1:48123",
      AGENT_LANTERN_TOKEN: "token-1",
      AGENT_LANTERN_DAEMON_ENDPOINT_2: "http://host-2:48123",
      AGENT_LANTERN_TOKEN_2: "token-2",
    });

    expect(options.destinations).toEqual([
      { endpoint: "http://host-1:48123", token: "token-1" },
      { endpoint: "http://host-2:48123", token: "token-2" },
    ]);
  });

  it("回歸：環境只有 endpoint、完全沒有任何 token，命令列給 --token 時仍能成功解析", () => {
    const options = parseCommandLine(
      ["hook", "--agent", "codex", "--token", "cli-token"],
      { AGENT_LANTERN_DAEMON_ENDPOINT: "http://host-1:48123" },
    );

    expect(options.destinations).toEqual([
      {
        endpoint: "http://host-1:48123",
        token: "cli-token",
        tokenIsFallback: true,
      },
    ]);
  });

  it("環境有兩個各自有 own token 的目的地，命令列給 --token 時兩個都被換掉，endpoint 不變", () => {
    const options = parseCommandLine(
      ["hook", "--agent", "codex", "--token", "cli-token"],
      {
        AGENT_LANTERN_DAEMON_ENDPOINT: "http://host-1:48123",
        AGENT_LANTERN_TOKEN: "token-1",
        AGENT_LANTERN_DAEMON_ENDPOINT_2: "http://host-2:48123",
        AGENT_LANTERN_TOKEN_2: "token-2",
      },
    );

    expect(options.destinations).toEqual([
      { endpoint: "http://host-1:48123", token: "cli-token" },
      { endpoint: "http://host-2:48123", token: "cli-token" },
    ]);
  });

  it("命令列給 --daemon-endpoint（不給 token），環境有 base token 時，endpoint 來自命令列、token 來自環境", () => {
    const options = parseCommandLine(
      [
        "hook",
        "--agent",
        "codex",
        "--daemon-endpoint",
        "http://override:48123",
      ],
      { AGENT_LANTERN_TOKEN: "token-1" },
    );

    expect(options.destinations).toEqual([
      { endpoint: "http://override:48123", token: "token-1" },
    ]);
  });

  it("完全沒有 endpoint 時丟出", () => {
    expect(() => parseCommandLine(["hook", "--agent", "codex"], {})).toThrow(
      "AGENT_LANTERN_DAEMON_ENDPOINT is required.",
    );
  });

  it("endpoint 尾斜線被去除", () => {
    const options = parseCommandLine(["hook", "--agent", "codex"], {
      AGENT_LANTERN_DAEMON_ENDPOINT: "http://host-1:48123/",
      AGENT_LANTERN_TOKEN: "token-1",
    });

    expect(options.destinations).toEqual([
      { endpoint: "http://host-1:48123", token: "token-1" },
    ]);
  });

  it("destinationProblems 有正確帶出來，例如 _2 缺 token 且無 base token 時", () => {
    const options = parseCommandLine(["hook", "--agent", "codex"], {
      AGENT_LANTERN_DAEMON_ENDPOINT_1: "http://host-1:48123",
      AGENT_LANTERN_TOKEN_1: "token-1",
      AGENT_LANTERN_DAEMON_ENDPOINT_2: "http://host-2:48123",
    });

    expect(options.destinations).toEqual([
      { endpoint: "http://host-1:48123", token: "token-1" },
    ]);
    expect(
      options.destinationProblems.some(
        (problem) => problem.key === "AGENT_LANTERN_TOKEN_2",
      ),
    ).toBe(true);
  });
});
