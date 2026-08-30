import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  sessionsResponseSchema,
  type SessionSnapshot,
} from "@agent-lantern/protocol";

import "./styles.css";

interface OverlayConfiguration {
  daemonEndpoint: string;
  token: string;
  setupFilePath: string;
  /** 遠端主機該用的 endpoint；找不到 Tailscale 位址時為 null。 */
  remoteEndpoint: string | null;
}

const tailscaleAddressPlaceholder = "<Windows-Tailscale-IP>";

const statusPresentation = {
  starting: { label: "啟動中", color: "#66b8ff" },
  working: { label: "工作中", color: "#ffb84d" },
  waiting: { label: "等待操作", color: "#c494ff" },
  completed: { label: "已完成", color: "#5dd49b" },
  failed: { label: "發生錯誤", color: "#ff6574" },
  stopped: { label: "已停止", color: "#858d99" },
} as const;

const applicationElement =
  document.querySelector<HTMLDivElement>("#application");
if (!applicationElement) {
  throw new Error("Application mount point is missing.");
}

applicationElement.innerHTML = `
  <section class="lantern-shell">
    <header class="title-bar" data-tauri-drag-region>
      <div class="brand-mark" data-tauri-drag-region></div>
      <div class="brand-copy" data-tauri-drag-region>
        <h1 class="brand-title" data-tauri-drag-region>Agent Lantern</h1>
        <p class="brand-subtitle" data-tauri-drag-region>遠端代理程式狀態</p>
      </div>
      <div class="window-actions">
        <button class="window-button" id="minimize-window" aria-label="最小化">−</button>
        <button class="window-button" id="close-window" aria-label="關閉">×</button>
      </div>
    </header>
    <div class="content">
      <div class="summary">
        <span class="summary-copy" id="summary-copy">正在連線…</span>
        <div class="summary-actions">
          <button class="text-button" id="toggle-setup-panel" aria-expanded="false">設定</button>
          <button class="refresh-button" id="refresh-sessions" aria-label="重新整理">↻</button>
        </div>
      </div>
      <div class="setup-panel" id="setup-panel" hidden>
        <div class="setup-row">
          <span class="setup-label">Daemon endpoint</span>
          <div class="setup-value-row">
            <code class="setup-value" id="setup-endpoint">–</code>
            <button class="copy-button" id="copy-endpoint">複製</button>
          </div>
        </div>
        <div class="setup-row">
          <span class="setup-label">Token</span>
          <div class="setup-value-row">
            <code class="setup-value setup-value-token" id="setup-token">–</code>
            <button class="copy-button" id="toggle-token">顯示</button>
            <button class="copy-button" id="copy-token">複製</button>
          </div>
        </div>
        <div class="setup-row">
          <span class="setup-label">遠端安裝指令</span>
          <div class="setup-value-row">
            <code class="setup-value setup-value-command" id="setup-install-command">–</code>
            <button class="copy-button" id="copy-install-command">複製</button>
          </div>
        </div>
        <p class="setup-hint" id="setup-install-hint">
          把 <code>dist-packages</code> 內的 <code>agent-status-reporter-*.tgz</code> 與
          <code>install-remote.sh</code> 放到遠端主機同一個目錄，執行上面這行就會安裝 reporter，
          並把 hook 合併寫入既有的 Codex / Claude Code 設定。
        </p>
        <p class="setup-hint">
          設定檔位置：<code id="setup-file-path">–</code>
        </p>
      </div>
      <div id="session-list"></div>
    </div>
  </section>
`;

const currentWindow = getCurrentWindow();
const sessionListElement =
  document.querySelector<HTMLDivElement>("#session-list")!;
const summaryCopyElement =
  document.querySelector<HTMLSpanElement>("#summary-copy")!;
const setupPanelElement =
  document.querySelector<HTMLDivElement>("#setup-panel")!;
const setupEndpointElement =
  document.querySelector<HTMLElement>("#setup-endpoint")!;
const setupTokenElement = document.querySelector<HTMLElement>("#setup-token")!;
const setupFilePathElement =
  document.querySelector<HTMLElement>("#setup-file-path")!;
const setupInstallCommandElement = document.querySelector<HTMLElement>(
  "#setup-install-command",
)!;
const setupInstallHintElement = document.querySelector<HTMLElement>(
  "#setup-install-hint",
)!;
const toggleSetupPanelButton = document.querySelector<HTMLButtonElement>(
  "#toggle-setup-panel",
)!;
const toggleTokenButton =
  document.querySelector<HTMLButtonElement>("#toggle-token")!;
let overlayConfiguration: OverlayConfiguration | undefined;
let isTokenRevealed = false;

document
  .querySelector("#minimize-window")
  ?.addEventListener("click", () => void currentWindow.minimize());
document
  .querySelector("#close-window")
  ?.addEventListener("click", () => void currentWindow.close());
document
  .querySelector("#refresh-sessions")
  ?.addEventListener("click", () => void refreshSessions());
toggleSetupPanelButton.addEventListener("click", () => {
  const isHidden = !setupPanelElement.hidden;
  setupPanelElement.hidden = isHidden;
  toggleSetupPanelButton.setAttribute("aria-expanded", String(!isHidden));
});
toggleTokenButton.addEventListener("click", () => {
  isTokenRevealed = !isTokenRevealed;
  renderSetupPanel();
});
document
  .querySelector("#copy-endpoint")
  ?.addEventListener(
    "click",
    () =>
      void copyToClipboard(
        overlayConfiguration?.daemonEndpoint,
        "#copy-endpoint",
      ),
  );
document
  .querySelector("#copy-token")
  ?.addEventListener(
    "click",
    () => void copyToClipboard(overlayConfiguration?.token, "#copy-token"),
  );
document
  .querySelector("#copy-install-command")
  ?.addEventListener(
    "click",
    () =>
      void copyToClipboard(
        buildInstallCommand({ revealToken: true }),
        "#copy-install-command",
      ),
  );

/**
 * 一行就能在遠端主機跑完的安裝指令。畫面上的 token 會遮起來，但複製出去的是
 * 完整內容，使用者不必自己拼湊。
 */
function buildInstallCommand(options: {
  revealToken: boolean;
}): string | undefined {
  if (!overlayConfiguration) {
    return undefined;
  }

  const endpoint =
    overlayConfiguration.remoteEndpoint ??
    overlayConfiguration.daemonEndpoint.replace(
      /\/\/[^:/]+/,
      `//${tailscaleAddressPlaceholder}`,
    );
  const token = options.revealToken
    ? overlayConfiguration.token
    : "•".repeat(24);

  return `sh install-remote.sh --endpoint ${endpoint} --token ${token}`;
}

async function initialize(): Promise<void> {
  try {
    overlayConfiguration = await invoke<OverlayConfiguration>(
      "get_overlay_configuration",
    );
    renderSetupPanel();
    await refreshSessions();
    window.setInterval(() => void refreshSessions(), 2_000);
  } catch (error: unknown) {
    renderError(error);
  }
}

function renderSetupPanel(): void {
  if (!overlayConfiguration) {
    return;
  }

  setupEndpointElement.textContent = overlayConfiguration.daemonEndpoint;
  setupTokenElement.textContent = isTokenRevealed
    ? overlayConfiguration.token
    : "•".repeat(24);
  setupFilePathElement.textContent = overlayConfiguration.setupFilePath;
  toggleTokenButton.textContent = isTokenRevealed ? "隱藏" : "顯示";
  setupInstallCommandElement.textContent =
    buildInstallCommand({ revealToken: isTokenRevealed }) ?? "–";

  if (!overlayConfiguration.remoteEndpoint) {
    setupInstallHintElement.textContent =
      `找不到 Tailscale 位址，指令中的 ${tailscaleAddressPlaceholder} 請自行換成 Windows 的 Tailscale IPv4` +
      "（在 PowerShell 執行 tailscale ip -4）。把 tarball 與 install-remote.sh 放到遠端主機同一個目錄再執行。";
  }
}

async function copyToClipboard(
  value: string | undefined,
  buttonSelector: string,
): Promise<void> {
  if (!value) {
    return;
  }

  const button = document.querySelector<HTMLButtonElement>(buttonSelector);
  try {
    await navigator.clipboard.writeText(value);
    if (button) {
      const originalLabel = button.textContent;
      button.textContent = "已複製";
      window.setTimeout(() => {
        button.textContent = originalLabel;
      }, 1_500);
    }
  } catch (error: unknown) {
    renderError(error);
  }
}

async function refreshSessions(): Promise<void> {
  if (!overlayConfiguration) {
    return;
  }

  try {
    const response = await fetch(
      `${overlayConfiguration.daemonEndpoint}/api/v1/sessions`,
      {
        headers: {
          authorization: `Bearer ${overlayConfiguration.token}`,
        },
        signal: AbortSignal.timeout(2_500),
      },
    );
    if (!response.ok) {
      throw new Error(`Daemon 回應 ${response.status}`);
    }

    const sessionsResponse = sessionsResponseSchema.parse(
      await response.json(),
    );
    renderSessions(sessionsResponse.sessions);
  } catch (error: unknown) {
    renderError(error);
  }
}

function renderSessions(sessions: SessionSnapshot[]): void {
  summaryCopyElement.textContent = `${sessions.length} 個工作階段`;
  if (sessions.length === 0) {
    sessionListElement.innerHTML = `
      <div class="empty-state">
        <div>
          <strong>尚未收到代理程式事件</strong>
          <p>啟動 Codex 或 Claude 的 hook 後，狀態會自動出現在這裡。</p>
        </div>
      </div>
    `;
    return;
  }

  const sessionsByHost = groupBy(sessions, (session) => session.host.name);
  sessionListElement.innerHTML = [...sessionsByHost.entries()]
    .map(([hostName, hostSessions]) => {
      const sessionsByWorkspace = groupBy(
        hostSessions,
        (session) => session.workspace.path,
      );
      const workspaceMarkup = [...sessionsByWorkspace.entries()]
        .map(([workspacePath, workspaceSessions]) => {
          const cards = workspaceSessions.map(renderSessionCard).join("");
          return `
            <section class="workspace-block">
              <p class="workspace-name" title="${escapeHtml(workspacePath)}">${escapeHtml(workspaceSessions[0]?.workspace.name ?? workspacePath)}</p>
              ${cards}
            </section>
          `;
        })
        .join("");

      return `
        <section class="host-section">
          <h2 class="host-heading">${escapeHtml(hostName)}</h2>
          ${workspaceMarkup}
        </section>
      `;
    })
    .join("");
}

function renderSessionCard(session: SessionSnapshot): string {
  const presentation = statusPresentation[session.status];
  const agentInitial = session.agent.kind === "claude" ? "CL" : "CX";
  const shortSessionIdentifier = session.session.identifier.slice(0, 8);
  return `
    <article
      class="session-card"
      data-status="${session.status}"
      style="--status-color: ${presentation.color}"
    >
      <div class="agent-icon">${agentInitial}</div>
      <div class="session-copy">
        <div class="session-title-row">
          <span class="agent-name">${escapeHtml(session.agent.displayName)}</span>
          <span class="session-identifier" title="${escapeHtml(session.session.identifier)}">${escapeHtml(shortSessionIdentifier)}</span>
        </div>
        <div class="session-message">${escapeHtml(session.message ?? session.eventType)}</div>
      </div>
      <div class="status-column">
        <div class="status-label">${presentation.label}</div>
        <div class="last-seen">${formatRelativeTime(session.receivedAt)}</div>
      </div>
    </article>
  `;
}

function groupBy<T>(
  values: T[],
  keySelector: (value: T) => string,
): Map<string, T[]> {
  const groupedValues = new Map<string, T[]>();
  for (const value of values) {
    const key = keySelector(value);
    const group = groupedValues.get(key) ?? [];
    group.push(value);
    groupedValues.set(key, group);
  }
  return groupedValues;
}

function formatRelativeTime(timestamp: string): string {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(timestamp).getTime()) / 1_000),
  );
  if (elapsedSeconds < 10) return "剛剛";
  if (elapsedSeconds < 60) return `${elapsedSeconds} 秒前`;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分前`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  return `${elapsedHours} 小時前`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  summaryCopyElement.textContent = "連線中斷";
  sessionListElement.innerHTML = `
    <div class="error-state">
      <div>
        <strong>無法讀取 daemon</strong>
        <p>${escapeHtml(message)}。請確認 daemon 已啟動，且 endpoint 與 token 相同。</p>
      </div>
    </div>
  `;
}

void initialize();
