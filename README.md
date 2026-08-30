# Agent Lantern（代理燈號）

Agent Lantern 是一個在 Windows 主機上顯示的輕量浮動覆蓋視窗（overlay）。Codex、Claude Code 或其他人工智慧（Artificial Intelligence，AI）命令列代理程式可以從 Windows Subsystem for Linux（WSL）、Remote Secure Shell（Remote SSH）或純命令列環境，經由 Tailscale 等虛擬私人網路（Virtual Private Network，VPN）把生命週期事件送回 Windows daemon。

目前版本是可執行的最小可行產品（Minimum Viable Product，MVP），包含：

- 具 Bearer token 驗證的超文字傳輸協定（Hypertext Transfer Protocol，HTTP）daemon。
- 可置頂、可拖曳、無系統邊框的 Tauri 2 Windows 視窗。
- 依 host、workspace、session 分組顯示 Codex 與 Claude 狀態。
- 可安裝於 Linux、WSL 與遠端主機的 `agent-status-reporter` 命令列介面（Command-Line Interface，CLI）。
- 會把 hook 合併寫入既有 Codex / Claude Code 設定的安裝器（`agent-status-reporter install`）與遠端一鍵安裝腳本。
- 共用、版本化的 normalized event schema，以及隔離的 agent integration mapping。

## 架構

```text
Codex hooks ─┐
             ├─> agent-status-reporter ──HTTP + Bearer token──┐
Claude hooks ┘                                                │
                                                              ▼
                                                     Windows daemon
                                                              │
                                                      normalized state
                                                              │
                                                              ▼
                                                    Tauri floating overlay
```

分層原則：

1. `packages/integrations` 是唯一理解 Codex 與 Claude 原始 hook 格式的地方。
2. `packages/protocol` 定義所有元件共用的 normalized event 與 session snapshot。
3. daemon 只驗證、儲存統一協定，不含代理程式特例。
4. overlay 只呈現 session snapshot，不解讀 hook payload。
5. reporter 不傳 prompt、transcript 或完整 tool input；預設只傳狀態所需的最少 metadata。

## 目錄結構

```text
agent-lantern/
├─ apps/
│  ├─ daemon/                 # Windows HTTP daemon 與 session state store
│  ├─ overlay/                # Tauri 2 + TypeScript 浮動視窗
│  │  └─ src-tauri/           # Rust 原生桌面殼層
│  └─ reporter/               # 可打包安裝的 hook reporter CLI
├─ packages/
│  ├─ integrations/           # Codex / Claude mapping 邊界
│  └─ protocol/               # normalized event schema 與型別
├─ examples/integrations/       # 由安裝器同一份定義產生的 hook 範例
│  ├─ codex/hooks.json
│  └─ claude/settings.json
├─ scripts/
│  └─ install-remote.sh       # 遠端主機一鍵安裝（合併寫入，不覆蓋）
├─ dist-packages/             # 所有可散布產物（安裝檔、tarball）集中於此
├─ .env.example
└─ pnpm-workspace.yaml
```

## 先決條件

Windows 主機需要：

- Windows 10 或 11。
- Node.js 20.19 以上版本；建議使用目前的長期支援版本（Long-Term Support，LTS）。
- pnpm 10，可透過 `corepack enable` 啟用。
- Git。
- 建置桌面視窗時需要 Rust stable 的 Microsoft Visual C++（MSVC）toolchain、Microsoft C++ Build Tools 的「Desktop development with C++」工作負載，以及 Microsoft Edge WebView2。Windows 10 1803 之後通常已有 WebView2。
- 若要跨主機連線，Windows 與遠端 Linux 主機需加入同一個 Tailscale tailnet。

Tauri 官方先決條件：<https://v2.tauri.app/start/prerequisites/>  
Tailscale 安裝入口：<https://tailscale.com/docs/install>

## 1. 在 Windows 建置

開啟 PowerShell：

```powershell
Set-Location C:\projects\agent-lantern
corepack enable
pnpm install
pnpm build
```

如果 PowerShell 的執行原則阻擋 `pnpm`，請將上述命令改成 `pnpm.cmd`。

### Token 與連線設定：自動產生

不需要手動產生 token 或設定環境變數。daemon 第一次啟動時，若沒有偵測到 `AGENT_LANTERN_TOKEN` 環境變數，會自動產生一組 32 位元組的隨機 token，連同預設的 bind address（`0.0.0.0`，讓 WSL 與 Tailscale 介面可連入）與連接埠（`48123`）一起寫入：

```text
%APPDATA%\agent-lantern\config.json
```

之後每次啟動 daemon 或 overlay 都會沿用同一份設定，不會重新產生。overlay 會讀取同一份檔案；開啟 overlay 視窗後按下右上角的「設定」按鈕，就能看到 daemon endpoint 與 token，以及一行就能在遠端主機執行完畢的安裝指令，按「複製」貼過去執行即可（見下方第 3 節）。overlay 本身仍固定經由本機 `127.0.0.1` 連線 daemon，沒有必要連到外部位址。

> 進階／覆寫：如果你想手動指定 token（例如多台 Windows 主機共用同一組 token，或在 CI 中執行），設定 `AGENT_LANTERN_TOKEN`（至少 20 個字元）、`AGENT_LANTERN_BIND_ADDRESS`、`AGENT_LANTERN_PORT` 這幾個使用者環境變數即可覆蓋自動產生的設定：
>
> ```powershell
> [Environment]::SetEnvironmentVariable("AGENT_LANTERN_TOKEN", "<your-long-random-token>", "User")
> [Environment]::SetEnvironmentVariable("AGENT_LANTERN_BIND_ADDRESS", "0.0.0.0", "User")
> [Environment]::SetEnvironmentVariable("AGENT_LANTERN_PORT", "48123", "User")
> ```
>
> 關閉並重新開啟 PowerShell 讓新環境變數生效。設定了 `AGENT_LANTERN_TOKEN` 之後，daemon 就不會再寫入或讀取 `%APPDATA%\agent-lantern\config.json`。

### Windows 防火牆

以系統管理員身分開啟 PowerShell，只允許 Tailscale 使用的電信級網路位址轉譯（Carrier-Grade Network Address Translation，CGNAT）位址範圍連入 48123：

```powershell
New-NetFirewallRule `
  -DisplayName "Agent Lantern daemon from Tailscale" `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort 48123 `
  -RemoteAddress 100.64.0.0/10
```

若你的 WSL 不經由 Tailscale 位址連線，還要另外為實際 WSL 虛擬子網新增一條更窄的規則；不要把 48123 連接埠無條件開放給所有遠端位址。

### 啟動 daemon（overlay 會自動啟動，不需手動執行）

overlay 啟動時會自己把 daemon 一起帶起來，所以平常只要開啟 Agent Lantern 視窗即可，不需要另外開 PowerShell 執行 daemon。實際行為是：

1. overlay 先檢查設定檔中的連接埠有沒有人在監聽；已經有 daemon 在跑就直接沿用，不會重複啟動。
2. 沒有的話，就以 `node` 執行隨 overlay 一起打包的 `agent-lantern-daemon.cjs`（不會跳出主控台視窗）。
3. overlay 關閉時會一併結束自己啟動的 daemon。

因此 Windows 主機在執行期仍需要 Node.js 20.19 以上版本，且 `node` 要在 PATH 中。

若你想自己手動控制 daemon（例如想看即時記錄），仍可執行：

```powershell
Set-Location C:\projects\agent-lantern
pnpm --filter @agent-lantern/daemon start
```

此時 overlay 偵測到連接埠已被監聽，就不會再啟動第二份。若要完全停用自動啟動，設定環境變數 `AGENT_LANTERN_NO_AUTO_START=1`。

確認服務（請用 overlay「設定」面板顯示的實際連接埠）：

```powershell
Invoke-RestMethod http://127.0.0.1:48123/health
```

### 連接埠被 WSL 2 或 Docker Desktop 佔用時

在啟用 Hyper-V 的 Windows 上（安裝 WSL 2 或 Docker Desktop 就會啟用），主機網路服務會保留大段連接埠。這些保留**不會**出現在 `netstat`，也不一定出現在 `netsh interface ipv4 show excludedportrange`，但綁定時仍會失敗並回報 `EADDRINUSE`，而且每次重新開機保留的範圍都可能不同。

daemon 因此會在預設連接埠無法綁定時，自動改用一個可用的連接埠，寫回 `%APPDATA%\agent-lantern\config.json`，並顯示在 overlay 的「設定」面板；自動啟動不會因此失敗。

由於遠端 reporter 需要固定的 endpoint，若你要跨主機使用，建議以系統管理員身分把 48123 保留給自己，之後連接埠就不會再變動：

```powershell
netsh int ipv4 add excludedportrange protocol=tcp startport=48123 numberofports=1
```

如果該指令因為連接埠已被 Hyper-V 保留而失敗，請先 `net stop winnat`，執行上述指令後再 `net start winnat`。

### 開發模式啟動 overlay

```powershell
Set-Location C:\projects\agent-lantern
pnpm dev:overlay
```

### 建置 Windows 安裝程式

```powershell
Set-Location C:\projects\agent-lantern
pnpm build:overlay
```

建置結束後會自動把安裝檔收集到最外層的 `dist-packages\`：

- `dist-packages\Agent Lantern_0.1.0_x64_en-US.msi`
- `dist-packages\Agent Lantern_0.1.0_x64-setup.exe`

Tauri 原生輸出仍保留在 `apps\overlay\src-tauri\target\release\bundle\`；若只想重新收集而不重建，執行 `pnpm collect:artifacts`。

也可以直接執行 `apps\overlay\src-tauri\target\release\agent-lantern-overlay.exe`。

## 2. 打包 reporter 與遠端安裝腳本

在 Windows 專案根目錄：

```powershell
pnpm pack:reporter
```

`dist-packages\` 會得到兩個檔案：

- `agent-status-reporter-0.1.0.tgz`：已 bundle 執行期程式碼，不依賴 monorepo 中的私有套件。
- `install-remote.sh`：遠端主機的一鍵安裝腳本。

把這兩個檔案放到同一個目錄再複製到 WSL 或遠端 Linux 主機（scp、共用資料夾、`\\wsl$` 都可以）。remote 主機需要 Node.js 20.19 以上版本與 npm。

## 3. 在遠端主機一鍵安裝

開啟 overlay 視窗，按右上角「設定」，最下面的「遠端安裝指令」已經把 endpoint、token 都填好了，按「複製」再貼到遠端主機執行即可：

```bash
sh install-remote.sh --endpoint http://100.80.10.15:48123 --token <與_Windows_相同的_token>
```

endpoint 中的位址由 overlay 自動偵測 Windows 的 Tailscale IPv4 得出；偵測不到時指令會保留 `<Windows-Tailscale-IP>` 佔位字串，請自行以 `tailscale ip -4` 的輸出取代。

腳本會依序完成：

1. 檢查 Node.js 版本。
2. 安裝同目錄下的 `agent-status-reporter-*.tgz`。npm 全域目錄可寫就裝在全域，否則裝到 `~/.local`，因此預設不需要 `sudo`。
3. **合併**寫入 `~/.config/agent-lantern/environment`（權限 `600`）。
4. **合併**寫入 `~/.codex/hooks.json` 與 `~/.claude/settings.json`。
5. 呼叫 `/health` 並送出一筆測試事件；成功時 overlay 會出現一張 `Custom agent` 卡片。

常用選項：

```bash
sh install-remote.sh --help          # 全部選項
sh install-remote.sh ... --dry-run   # 只顯示會變更什麼，不寫檔
sh install-remote.sh ... --agent claude   # 只設定 Claude Code
sh install-remote.sh ... --skip-install   # reporter 已安裝，只重寫設定
```

### 設定是「合併」而不是覆蓋

安裝器不會用 `cp` 覆蓋既有設定檔，而是把 Agent Lantern 的 hook 併進去：

- 設定檔中其他欄位（Claude Code 的 `model`、`permissions`、`env`，Codex 的 `description` 等）原樣保留。
- 同一個事件下使用者自己的 hook 一律保留；matcher 相同時只把 reporter 的 hook 追加到同一組，matcher 不同時另外追加一組。
- `environment` 檔中的註解、順序與其他變數都保留，只更新 `AGENT_LANTERN_*` 三個鍵。
- 每次實際寫入前都會產生 `<原檔名>.agent-lantern-backup-<時間戳>` 備份。
- 重複執行不會產生重複項目；reporter 安裝路徑改變時會就地更新既有項目。

判斷依據是 hook 的 `command` 是否指向 `agent-status-reporter`，因此只有 Agent Lantern 自己加的東西會被動到。

### 移除

```bash
agent-status-reporter uninstall            # 兩個代理程式都移除
agent-status-reporter uninstall --dry-run  # 先看看會刪掉什麼
```

只會拔掉 `command` 指向 `agent-status-reporter` 的 hook，並清掉 `environment` 中的 `AGENT_LANTERN_*`；使用者自己的設定完整保留，事件全部清空時也不會留下空的 `hooks` 欄位。

### 不用腳本的等效做法

reporter 安裝好之後，設定的部分就是這個命令做的，可以單獨執行：

```bash
agent-status-reporter install \
  --endpoint http://100.80.10.15:48123 \
  --token <與_Windows_相同的_token> \
  --host-name remote-build-01 \
  --command-path "$(command -v agent-status-reporter)"
```

`--scope project --project-directory <path>` 可改成只寫入某個專案的 `.claude/settings.json` 與 `.codex/hooks.json`。

### 手動驗證

```bash
curl http://100.80.10.15:48123/health
agent-status-reporter send \
  --agent custom \
  --status working \
  --session-identifier manual-test \
  --message '遠端連線測試'
```

第二個命令成功時不輸出內容，overlay 應出現一張 `Custom agent` 卡片。

## 4. WSL 設定

建議只在 Windows 主機執行 Tailscale，不要同時在 Windows 與同一個 WSL 2 發行版各跑一份 Tailscale。Tailscale 官方文件指出，這會造成封包再封裝與 Maximum Transmission Unit（MTU）問題：<https://tailscale.com/docs/install/windows/wsl2>

先從 WSL 測試 Windows Tailscale 位址：

```bash
curl http://100.80.10.15:48123/health
```

如果 Windows Tailscale 位址在你的 WSL 網路模式不可達，可改用 WSL 看到的 Windows gateway：

```bash
ip route show default
```

把輸出的 `default via` 位址寫入 `~/.config/agent-lantern/environment` 的 `AGENT_LANTERN_DAEMON_ENDPOINT`。同時確認 Windows 防火牆只放行該 WSL 子網。

## 5. Remote SSH 與 Tailscale 設定

1. 在 Windows 安裝並登入 Tailscale。
2. 在遠端 Linux 安裝 Tailscale，並加入同一個 tailnet。
3. 在遠端執行 `tailscale ping <Windows 的 Magic Domain Name System 名稱或 Tailscale Internet Protocol 位址>`。
4. 確認 `curl http://<Windows Tailscale Internet Protocol 位址>:48123/health` 成功。
5. 把 `agent-status-reporter-*.tgz` 與 `install-remote.sh` 放到遠端同一個目錄，執行第 3 節的安裝指令。
6. 不需要 VS Code bridge；VS Code Remote SSH、互動式 SSH、tmux 與純 CLI 都走相同 reporter 路徑。

VPN 只提供加密傳輸與網路可達性，不能取代應用層驗證。請搭配 Tailscale access controls 限制哪些節點能連到 Windows 的 48123 連接埠，並定期輪替 Agent Lantern token。

## 6. Codex hooks

Codex 目前可從 `~/.codex/hooks.json`、`~/.codex/config.toml`、專案的 `.codex/hooks.json` 或 `.codex/config.toml` 載入 lifecycle hooks。command hook 會從標準輸入收到 JavaScript Object Notation（JSON）；Agent Lantern reporter 正是讀取這個輸入。官方說明：<https://learn.chatgpt.com/codex/hooks>

第 3 節的安裝器已經把這些 hook 合併寫進 `~/.codex/hooks.json` 了，這一節只說明它寫了什麼、以及要如何確認。想單獨重跑：

```bash
agent-status-reporter install --agent codex
```

`examples/integrations/codex/hooks.json` 是同一份定義產生的範例，適合想完全手動合併的人參考；請把各 event 併進既有 `hooks` object，不要整份覆蓋。

重新啟動 Codex 後：

1. 執行 `/hooks`。
2. 檢查來源與命令。
3. 明確信任新 hook；未受信任的非 managed hook 會被跳過。
4. 開始一個 session，確認 overlay 顯示 `啟動中`、`工作中`、`等待操作`、`已完成` 等狀態。

範例刻意使用新的 lifecycle `hooks.json`，而非舊的 `notify` command，因為 lifecycle hooks 能提供 SessionStart、PermissionRequest、Stop 與 SessionEnd 等較完整的狀態。

## 7. Claude Code hooks

Claude Code 的 command hook 同樣從標準輸入接收 JSON。使用者層級設定在 `~/.claude/settings.json`；專案共用設定在 `.claude/settings.json`。官方說明：<https://code.claude.com/docs/en/hooks>

同樣由第 3 節的安裝器合併寫入；想單獨重跑：

```bash
agent-status-reporter install --agent claude
```

`examples/integrations/claude/settings.json` 是同一份定義產生的範例。因為 `settings.json` 通常還放著 `model`、`permissions`、`env` 等設定，請務必用安裝器或手動合併，不要整份覆蓋。

重新啟動 Claude Code，執行 `/hooks` 檢查設定。內容包含：

- `SessionStart`：啟動中。
- `UserPromptSubmit`、`PreToolUse`：工作中。
- `PermissionRequest`、部分 `Notification`：等待操作。
- `Stop`：已完成。
- `StopFailure`：發生錯誤。
- `SessionEnd`：已停止。

## 8. 開發命令

```powershell
# TypeScript 型別檢查
pnpm typecheck

# 單元與 API 測試
pnpm test

# TypeScript、daemon、reporter 與 overlay 前端建置
pnpm build

# 只啟動 daemon，修改後自動重啟
pnpm dev:daemon

# 啟動 Tauri overlay 開發模式
pnpm dev:overlay

# 檢查格式
pnpm format:check
```

## HTTP 應用程式介面（Application Programming Interface，API）

### `GET /health`

不需要 token，只回傳服務是否存活，不包含 session 資訊。

### `POST /api/v1/events`

需要 `Authorization: Bearer <token>`。接受 `schemaVersion: 1` 的 normalized event；相同 `eventIdentifier` 會去重。

### `GET /api/v1/sessions`

需要 `Authorization: Bearer <token>`。回傳每個 `host + workspace + agent + session` 的最新 snapshot。

## MVP 限制與後續方向

- daemon 狀態目前存放在記憶體，重新啟動後會清空；下一階段可在 daemon infrastructure layer 加入 SQLite adapter，不需更動 integrations 或 overlay。
- overlay 每兩秒輪詢一次；下一階段可新增伺服器傳送事件（Server-Sent Events，SSE）或 WebSocket transport。
- token 是單一預共享密鑰；多使用者情境應改為每個 host 獨立 token、撤銷清單與 audit log。
- HTTP 在 Tailscale tunnel 內已受到 WireGuard 加密，但若將 daemon 暴露到 Tailscale 之外，必須在前方加入傳輸層安全性（Transport Layer Security，TLS）反向代理；不要直接把 48123 連接埠發布到公網。
- MVP 沒有擷取 prompt 或 transcript，這是刻意的資料最小化設計。若未來新增詳細活動紀錄，應採 opt-in 並先定義 retention policy。
