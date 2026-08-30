import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
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

/** 顯示模式：精簡（預設）或展開。存在 localStorage，跨啟動記住使用者選擇。 */
type ViewMode = "compact" | "expanded";

const tailscaleAddressPlaceholder = "<Windows-Tailscale-IP>";
const viewModeStorageKey = "agent-lantern.viewMode";
const minimumCompactWindowHeight = 96;
const maximumCompactWindowHeight = 432;

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
      <div class="compact-strip" data-tauri-drag-region>
        <span class="lantern-dot" data-tauri-drag-region></span>
        <span class="compact-summary" id="compact-summary-copy" data-tauri-drag-region>正在連線…</span>
        <div class="compact-actions">
          <button class="text-button compact-setup-button" id="toggle-setup-panel-compact" aria-expanded="false">設定</button>
          <button class="view-toggle-button compact-view-toggle-button" id="toggle-view-mode-compact">展開</button>
          <button class="refresh-button compact-refresh-button" id="refresh-sessions-compact" aria-label="重新整理">↻</button>
          <button class="window-button compact-window-button" id="minimize-window-compact" aria-label="最小化">−</button>
          <button class="window-button compact-window-button" id="close-window-compact" aria-label="關閉">×</button>
        </div>
      </div>
      <div class="brand-mark" data-tauri-drag-region></div>
      <div class="brand-copy" data-tauri-drag-region>
        <h1 class="brand-title" data-tauri-drag-region>Agent Lantern</h1>
        <p class="brand-subtitle" data-tauri-drag-region>遠端代理程式狀態</p>
      </div>
      <div class="window-actions">
        <button class="view-toggle-button" id="toggle-view-mode-expanded">精簡</button>
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
const compactSummaryCopyElement = document.querySelector<HTMLSpanElement>(
  "#compact-summary-copy",
)!;
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
const toggleSetupPanelCompactButton = document.querySelector<HTMLButtonElement>(
  "#toggle-setup-panel-compact",
)!;
const toggleViewModeExpandedButton = document.querySelector<HTMLButtonElement>(
  "#toggle-view-mode-expanded",
)!;
const toggleViewModeCompactButton = document.querySelector<HTMLButtonElement>(
  "#toggle-view-mode-compact",
)!;
const toggleTokenButton =
  document.querySelector<HTMLButtonElement>("#toggle-token")!;
let overlayConfiguration: OverlayConfiguration | undefined;
let isTokenRevealed = false;
let viewMode: ViewMode = loadViewMode();
let latestSessions: SessionSnapshot[] = [];
/**
 * sessionKey → 刪除當下那筆快照的 receivedAt。渲染時只要某個 session 目前的
 * receivedAt 小於等於這裡記錄的值，就代表它是刪除當下（或更舊、還在路上的輪詢
 * 結果）的快照，隱藏起來；但 daemon 刻意不留 tombstone，所以同一個 sessionKey
 * 若因為新事件重新出現，receivedAt 一定會比記錄的值新，比較的結果會讓它自動
 * 顯示回來——不能只用一個布林值卡住，否則會把「刻意重建」的 session 也擋掉。
 */
const deletedSessionReceivedAt = new Map<string, string>();
let lastAppliedCompactWindowHeight: number | null = null;
let isResizingCompactWindow = false;

document.documentElement.dataset.viewMode = viewMode;
updateViewModeButtons();

document
  .querySelector("#minimize-window")
  ?.addEventListener("click", () => void currentWindow.minimize());
document
  .querySelector("#close-window")
  ?.addEventListener("click", () => void currentWindow.close());
document
  .querySelector("#minimize-window-compact")
  ?.addEventListener("click", () => void currentWindow.minimize());
document
  .querySelector("#close-window-compact")
  ?.addEventListener("click", () => void currentWindow.close());
document
  .querySelector("#refresh-sessions")
  ?.addEventListener("click", () => void refreshSessions());
document
  .querySelector("#refresh-sessions-compact")
  ?.addEventListener("click", () => void refreshSessions());
toggleSetupPanelButton.addEventListener("click", toggleSetupPanel);
toggleSetupPanelCompactButton.addEventListener("click", toggleSetupPanel);
toggleViewModeExpandedButton.addEventListener("click", toggleViewMode);
toggleViewModeCompactButton.addEventListener("click", toggleViewMode);
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
sessionListElement.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const deleteButton = target.closest<HTMLButtonElement>(
    ".delete-session-button",
  );
  const sessionKey = deleteButton?.dataset.sessionKey;
  if (sessionKey) {
    void deleteSession(sessionKey);
  }
});

/**
 * 讀取使用者上次選擇的顯示模式；讀不到（第一次啟動、儲存被封鎖等）一律
 * 回到精簡模式。
 */
function loadViewMode(): ViewMode {
  try {
    const storedValue = window.localStorage.getItem(viewModeStorageKey);
    return storedValue === "expanded" ? "expanded" : "compact";
  } catch {
    return "compact";
  }
}

function saveViewMode(mode: ViewMode): void {
  try {
    window.localStorage.setItem(viewModeStorageKey, mode);
  } catch {
    // 無法寫入（例如隱私瀏覽模式）時忽略，畫面仍以記憶體內的選擇運作。
  }
}

function setViewMode(mode: ViewMode): void {
  viewMode = mode;
  saveViewMode(mode);
  document.documentElement.dataset.viewMode = mode;
  updateViewModeButtons();
  // 切換顯示模式後，先前記住的精簡視窗高度不再有意義（使用者可能在展開模式下
  // 手動調整過視窗大小），一律清掉，避免下次切回精簡模式時因為「量到的高度剛好
  // 等於上次套用過的高度」而被誤判成不需要 resize。
  lastAppliedCompactWindowHeight = null;
  renderSessions();
  if (mode === "expanded") {
    void resizeToExpandedWindow();
  }
}

/**
 * 切回展開模式時，把視窗高度復原成合理的展開尺寸（寬度維持目前的邏輯寬度不變）。
 * 呼叫失敗（非 Tauri 環境等）時忽略，不影響畫面渲染。
 */
async function resizeToExpandedWindow(): Promise<void> {
  try {
    const currentPhysicalSize = await currentWindow.innerSize();
    const scaleFactor = await currentWindow.scaleFactor();
    const currentLogicalSize = currentPhysicalSize.toLogical(scaleFactor);
    await currentWindow.setSize(new LogicalSize(currentLogicalSize.width, 610));
  } catch {
    // 非 Tauri 環境（例如純瀏覽器預覽）或呼叫失敗時忽略，不影響畫面內容。
  }
}

function toggleViewMode(): void {
  setViewMode(viewMode === "compact" ? "expanded" : "compact");
}

function updateViewModeButtons(): void {
  const label = viewMode === "compact" ? "展開" : "精簡";
  const ariaLabel =
    viewMode === "compact" ? "切換為展開檢視" : "切換為精簡檢視";
  for (const button of [
    toggleViewModeCompactButton,
    toggleViewModeExpandedButton,
  ]) {
    button.textContent = label;
    button.setAttribute("aria-label", ariaLabel);
  }
}

function toggleSetupPanel(): void {
  const isHidden = !setupPanelElement.hidden;
  setupPanelElement.hidden = isHidden;
  toggleSetupPanelButton.setAttribute("aria-expanded", String(!isHidden));
  toggleSetupPanelCompactButton.setAttribute(
    "aria-expanded",
    String(!isHidden),
  );
  void maybeResizeCompactWindow();
}

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
    latestSessions = sessionsResponse.sessions;
    pruneDeletedSessionMarkers();
    renderSessions();
  } catch (error: unknown) {
    renderError(error);
  }
}

/**
 * 清掉不再需要的刪除標記：這個 sessionKey 已經不在最新的輪詢結果裡（daemon 端
 * 真的刪除了），或是它對應到一筆更新的 receivedAt（daemon 收到新事件、重建了
 * 這個 session），都代表標記已經完成任務。留著不清會讓這個 map 無限長大。
 */
function pruneDeletedSessionMarkers(): void {
  for (const [
    sessionKey,
    deletedSessionSnapshotReceivedAt,
  ] of deletedSessionReceivedAt) {
    const matchingSession = latestSessions.find(
      (session) => session.sessionKey === sessionKey,
    );
    if (
      !matchingSession ||
      matchingSession.receivedAt > deletedSessionSnapshotReceivedAt
    ) {
      deletedSessionReceivedAt.delete(sessionKey);
    }
  }
}

/**
 * 刪除單一工作階段：不直接修改 latestSessions，改成在
 * deletedSessionReceivedAt 記下這筆快照的 receivedAt，讓 renderSessions() 把它
 * 濾掉。發出 DELETE 後才確認結果；失敗時（404 除外，代表本來就已經不在了）把
 * 標記清掉即可自動復原——不需要任何以陣列索引為準的還原邏輯，也就不會因為
 * refreshSessions() 已經把 latestSessions 換成新陣列而插入重複的列。
 */
async function deleteSession(sessionKey: string): Promise<void> {
  if (!overlayConfiguration) {
    return;
  }

  const session = latestSessions.find(
    (candidate) => candidate.sessionKey === sessionKey,
  );
  if (!session) {
    return;
  }

  deletedSessionReceivedAt.set(sessionKey, session.receivedAt);
  renderSessions();

  try {
    const response = await fetch(
      `${overlayConfiguration.daemonEndpoint}/api/v1/sessions/${encodeURIComponent(sessionKey)}`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${overlayConfiguration.token}`,
        },
        signal: AbortSignal.timeout(2_500),
      },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`Daemon 回應 ${response.status}`);
    }
  } catch (error: unknown) {
    deletedSessionReceivedAt.delete(sessionKey);
    showDeleteFailureNotice(error);
  }
}

function renderSessions(): void {
  const visibleSessions = latestSessions.filter((session) => {
    const deletedSessionSnapshotReceivedAt = deletedSessionReceivedAt.get(
      session.sessionKey,
    );
    return (
      deletedSessionSnapshotReceivedAt === undefined ||
      session.receivedAt > deletedSessionSnapshotReceivedAt
    );
  });
  const summaryText = `${visibleSessions.length} 個工作階段`;
  summaryCopyElement.textContent = summaryText;
  compactSummaryCopyElement.textContent = summaryText;

  if (visibleSessions.length === 0) {
    sessionListElement.innerHTML =
      viewMode === "compact"
        ? `<div class="compact-empty-state">尚未收到代理程式事件</div>`
        : `
      <div class="empty-state">
        <div>
          <strong>尚未收到代理程式事件</strong>
          <p>啟動 Codex 或 Claude 的 hook 後，狀態會自動出現在這裡。</p>
        </div>
      </div>
    `;
    void maybeResizeCompactWindow();
    return;
  }

  sessionListElement.innerHTML =
    viewMode === "compact"
      ? renderCompactSessionList(visibleSessions)
      : renderExpandedSessionList(visibleSessions);
  void maybeResizeCompactWindow();
}

function renderCompactSessionList(sessions: SessionSnapshot[]): string {
  const rows = sessions.map(renderSessionRow).join("");
  return `<div class="session-row-list">${rows}</div>`;
}

function renderExpandedSessionList(sessions: SessionSnapshot[]): string {
  const sessionsByHost = groupBy(sessions, (session) => session.host.name);
  return [...sessionsByHost.entries()]
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

function renderSessionRow(session: SessionSnapshot): string {
  const presentation = statusPresentation[session.status];
  const agentInitial = session.agent.kind === "claude" ? "CL" : "CX";
  const shortSessionIdentifier = session.session.identifier.slice(0, 8);
  return `
    <div
      class="session-row"
      data-status="${session.status}"
      style="--status-color: ${presentation.color}"
      title="${escapeHtml(session.host.name)}"
    >
      <span class="row-status-dot"></span>
      <span class="row-agent-initial">${agentInitial}</span>
      <span class="row-workspace" title="${escapeHtml(session.workspace.name)}">${escapeHtml(session.workspace.name)}</span>
      <span class="row-session-id">${escapeHtml(shortSessionIdentifier)}</span>
      <span class="row-status-label">${presentation.label}</span>
      <span class="row-last-seen">${formatRelativeTime(session.receivedAt)}</span>
      <button
        class="delete-session-button row-delete-button"
        data-session-key="${escapeHtml(session.sessionKey)}"
        aria-label="刪除此工作階段"
      >×</button>
    </div>
  `;
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
      <button
        class="delete-session-button card-delete-button"
        data-session-key="${escapeHtml(session.sessionKey)}"
        aria-label="刪除此工作階段"
      >×</button>
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

function escapeHtml(value: unknown): string {
  // 用 String(value ?? "") 防禦性轉換：即使某個欄位因為 schema 不一致（例如
  // protocol 套件的 dist 沒重建、缺了必填欄位）而變成 undefined，也只會讓單一
  // 儲存格顯示空字串，而不是整份清單直接丟出例外、被上層 catch 誤判成連線中斷。
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const summaryText = "連線中斷";
  summaryCopyElement.textContent = summaryText;
  compactSummaryCopyElement.textContent = summaryText;
  sessionListElement.innerHTML =
    viewMode === "compact"
      ? `<div class="compact-error-state" title="${escapeHtml(message)}">無法讀取 daemon：${escapeHtml(message)}</div>`
      : `
    <div class="error-state">
      <div>
        <strong>無法讀取 daemon</strong>
        <p>${escapeHtml(message)}。請確認 daemon 已啟動，且 endpoint 與 token 相同。</p>
      </div>
    </div>
  `;
  void maybeResizeCompactWindow();
}

/**
 * 單一列的刪除失敗只是那一次 DELETE 請求沒成功，連線本身沒事，所以不套用
 * renderError() 那種整份清單替換成「連線中斷」的畫面，改成在摘要列放一則簡短
 * 提示；下一次輪詢成功時 renderSessions() 會用實際的工作階段數量覆蓋掉它，
 * 提示因此會自動消失。
 */
function showDeleteFailureNotice(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  renderSessions();
  const noticeText = `刪除失敗：${message}`;
  summaryCopyElement.textContent = noticeText;
  compactSummaryCopyElement.textContent = noticeText;
}

/**
 * 精簡模式下讓視窗高度貼合內容：量測目前畫面實際高度，夾在
 * [minimumCompactWindowHeight, maximumCompactWindowHeight] 之間後才套用，
 * 高度沒變就跳過，避免每次輪詢都呼叫一次 setSize。展開模式一律不自動調整。
 * 用 isResizingCompactWindow 擋掉重入：resize 呼叫本身要 await 好幾個
 * Tauri IPC 往返，若在它完成前又觸發一次（例如輪詢剛好疊到使用者操作），沒有
 * 這個旗標的話兩次呼叫可能都判斷「高度有變」而各自呼叫一次 setSize。
 */
async function maybeResizeCompactWindow(): Promise<void> {
  if (viewMode !== "compact" || isResizingCompactWindow) {
    return;
  }

  const measuredHeight = document.body.scrollHeight;
  const clampedHeight = Math.min(
    maximumCompactWindowHeight,
    Math.max(minimumCompactWindowHeight, measuredHeight),
  );
  if (lastAppliedCompactWindowHeight === clampedHeight) {
    return;
  }

  isResizingCompactWindow = true;
  try {
    const currentPhysicalSize = await currentWindow.innerSize();
    const scaleFactor = await currentWindow.scaleFactor();
    const currentLogicalSize = currentPhysicalSize.toLogical(scaleFactor);
    await currentWindow.setSize(
      new LogicalSize(currentLogicalSize.width, clampedHeight),
    );
    lastAppliedCompactWindowHeight = clampedHeight;
  } catch {
    // 非 Tauri 環境（例如純瀏覽器預覽）或呼叫失敗時忽略，不影響畫面內容。
  } finally {
    isResizingCompactWindow = false;
  }
}

void initialize();
