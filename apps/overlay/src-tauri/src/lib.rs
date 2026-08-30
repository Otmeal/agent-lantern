use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::thread::sleep;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, RunEvent};

const DEFAULT_PORT: u16 = 48123;
const DAEMON_READY_TIMEOUT: Duration = Duration::from_secs(20);
/// Must stay in sync with `protocolVersion` in `packages/protocol/src/index.ts`;
/// a test in `packages/protocol` (`protocol-version.test.ts`) reads this
/// constant back out of this file and fails if the two drift apart.
const EXPECTED_PROTOCOL_VERSION: u32 = 2;
/// How long we give a stale daemon to exit after we ask it to, before giving
/// up and reporting it as unkillable.
const STALE_DAEMON_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
/// Overall budget for reading one `/health` response, on top of the per-read
/// socket timeouts.
const PROBE_READ_BUDGET: Duration = Duration::from_millis(1_500);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayConfiguration {
    daemon_endpoint: String,
    token: String,
    setup_file_path: String,
    /// Endpoint a remote host should use, resolved from the Windows Tailscale
    /// address. `None` when Tailscale is not reachable, in which case the
    /// overlay asks the user to fill the address in themselves.
    remote_endpoint: Option<String>,
}

#[derive(Deserialize)]
struct SharedSetupConfiguration {
    token: String,
    #[serde(default)]
    port: Option<u16>,
}

#[derive(Default)]
struct DaemonProcess {
    child: Mutex<Option<Child>>,
    startup_error: Mutex<Option<String>>,
}

/// Mirrors `sharedConfigurationFilePath` in `apps/daemon/src/configuration.ts`;
/// the daemon auto-generates this file on first run so no manual token setup
/// is required.
fn shared_configuration_path() -> PathBuf {
    let app_data_root = env::var("APPDATA").unwrap_or_else(|_| {
        let profile = env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string());
        format!("{profile}\\AppData\\Roaming")
    });
    PathBuf::from(app_data_root)
        .join("agent-lantern")
        .join("config.json")
}

/// Resolves this machine's Tailscale IPv4 so the setup panel can show a
/// remote host the endpoint that actually works, instead of `127.0.0.1`.
fn tailscale_ipv4() -> Option<String> {
    let candidates = [
        "tailscale".to_string(),
        format!(
            "{}\\Tailscale\\tailscale.exe",
            env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string())
        ),
    ];

    for candidate in candidates {
        let mut command = Command::new(&candidate);
        command.args(["ip", "-4"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }

        let Ok(output) = command.output() else {
            continue;
        };
        if !output.status.success() {
            continue;
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let address = line.trim();
            // Tailscale hands out addresses from the CGNAT range 100.64.0.0/10.
            let Ok(parsed) = address.parse::<std::net::Ipv4Addr>() else {
                continue;
            };
            let octets = parsed.octets();
            if octets[0] == 100 && (64..128).contains(&octets[1]) {
                return Some(address.to_string());
            }
        }
    }

    None
}

fn read_shared_setup() -> Option<SharedSetupConfiguration> {
    let contents = fs::read_to_string(shared_configuration_path()).ok()?;
    serde_json::from_str(&contents).ok()
}

fn configured_port(setup: Option<&SharedSetupConfiguration>) -> u16 {
    env::var("AGENT_LANTERN_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .or_else(|| setup.and_then(|setup| setup.port))
        .unwrap_or(DEFAULT_PORT)
}

/// Result of probing whatever is listening on the configured port.
enum DaemonProbe {
    /// No connection, no HTTP, or a response that never identifies itself as
    /// `agent-lantern-daemon` — nothing we should touch.
    Absent,
    /// Identified itself as `agent-lantern-daemon` and reports the protocol
    /// version this overlay speaks.
    Compatible,
    /// Identified itself as `agent-lantern-daemon` but the protocol version is
    /// missing, older, or newer than `EXPECTED_PROTOCOL_VERSION`. Carries the
    /// reported version (absent on daemons predating the handshake) and the
    /// process identifier, which those same daemons cannot report either.
    Incompatible {
        reported_version: Option<u32>,
        process_identifier: Option<u32>,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponseBody {
    #[serde(default)]
    protocol_version: Option<u32>,
    #[serde(default)]
    process_identifier: Option<u32>,
}

/// Splits an HTTP response's body out of the raw bytes at the `\r\n\r\n`
/// header/body separator.
fn extract_http_body(raw_response: &str) -> Option<&str> {
    let separator_index = raw_response.find("\r\n\r\n")?;
    Some(&raw_response[separator_index + 4..])
}

/// Last-resort JSON recovery: the first `{` through the last `}`. Chunked
/// transfer encoding wraps the body in size markers, and the probe's read cap
/// can cut a response short, so a body sliced at the header boundary does not
/// always parse on its own.
fn extract_json_object(raw_response: &str) -> Option<&str> {
    let start = raw_response.find('{')?;
    let end = raw_response.rfind('}')?;
    if end < start {
        return None;
    }
    Some(&raw_response[start..=end])
}

/// Classifies a raw `/health` response. Split out from the socket handling
/// because this is what decides whether another process gets terminated, and
/// that decision is worth testing directly.
fn classify_health_response(raw_response: &str) -> DaemonProbe {
    if !raw_response.contains("agent-lantern-daemon") {
        return DaemonProbe::Absent;
    }

    let parsed_body = extract_http_body(raw_response)
        .and_then(|body| serde_json::from_str::<HealthResponseBody>(body).ok())
        .or_else(|| {
            extract_json_object(raw_response)
                .and_then(|body| serde_json::from_str::<HealthResponseBody>(body).ok())
        });

    match parsed_body {
        Some(body) if body.protocol_version == Some(EXPECTED_PROTOCOL_VERSION) => {
            DaemonProbe::Compatible
        }
        Some(body) => DaemonProbe::Incompatible {
            reported_version: body.protocol_version,
            process_identifier: body.process_identifier,
        },
        None => DaemonProbe::Incompatible {
            reported_version: None,
            process_identifier: None,
        },
    }
}

/// A `/health` response that arrives unreadable — truncated by the read
/// budget or the size cap, say — is indistinguishable from a daemon predating
/// the handshake: no version, no process identifier. That verdict is a dead
/// end for the user (the overlay refuses to start anything), so confirm it
/// with a second and third look before acting on it.
fn probe_daemon_settled(port: u16) -> DaemonProbe {
    let mut probe = probe_daemon(port);
    for _ in 0..2 {
        if !matches!(
            probe,
            DaemonProbe::Incompatible {
                reported_version: None,
                process_identifier: None,
            }
        ) {
            break;
        }
        sleep(Duration::from_millis(250));
        probe = probe_daemon(port);
    }
    probe
}

/// Whether the port has actually been given up. Deliberately a bare TCP
/// connect rather than `probe_daemon`: a daemon that is alive but too busy to
/// answer within the probe's read timeout reads as `Absent`, and treating that
/// as "the port is free" would start a second daemon on top of the first.
fn port_is_free(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&address, Duration::from_millis(300)).is_err()
}

/// Confirms an Agent Lantern daemon answers on the port, rather than merely
/// that something accepts connections there, and whether it speaks a protocol
/// version this overlay understands. On Windows hosts running WSL 2 or Docker
/// Desktop the Hyper-V host network service holds sockets that accept
/// connections without ever speaking HTTP, so a bare TCP connect would report
/// a daemon that is not there and suppress automatic startup.
fn probe_daemon(port: u16) -> DaemonProbe {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(300)) else {
        return DaemonProbe::Absent;
    };

    let timeout = Some(Duration::from_millis(500));
    if stream.set_read_timeout(timeout).is_err() || stream.set_write_timeout(timeout).is_err() {
        return DaemonProbe::Absent;
    }
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return DaemonProbe::Absent;
    }

    // The per-read timeout alone does not bound this loop: a peer that dribbles
    // one byte every few hundred milliseconds never trips it. Cap the whole
    // read instead, because callers run this on the startup path.
    let read_deadline = Instant::now() + PROBE_READ_BUDGET;
    let mut response = Vec::new();
    let mut chunk = [0u8; 512];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                response.extend_from_slice(&chunk[..read]);
                if response.len() > 4096 || Instant::now() >= read_deadline {
                    break;
                }
            }
            Err(_) => break,
        }
    }

    classify_health_response(&String::from_utf8_lossy(&response))
}

/// Terminates a daemon process. Only ever call this with a process identifier
/// that came from a `/health` response on 127.0.0.1 that identified itself as
/// `agent-lantern-daemon` — this kills an arbitrary PID on the strength of
/// that check alone, so it must never be reachable with an attacker- or
/// user-controlled identifier.
#[cfg(windows)]
fn terminate_daemon_process(process_identifier: u32) -> bool {
    let mut command = Command::new("taskkill");
    // No `/T`: the daemon spawns no children, and killing a whole process tree
    // turns a stale process identifier into collateral damage.
    command.args(["/PID", &process_identifier.to_string(), "/F"]);
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW: keep the termination from flashing a console window.
    command.creation_flags(0x0800_0000);
    command
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// Non-Windows equivalent, primarily so `pnpm dev:overlay` on Linux still
/// builds and behaves; the shipped overlay only ever targets Windows.
#[cfg(not(windows))]
fn terminate_daemon_process(process_identifier: u32) -> bool {
    // `--` keeps the identifier from being read as a process-group argument.
    Command::new("kill")
        .args(["-TERM", "--", &process_identifier.to_string()])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// A process identifier the overlay is willing to terminate. `0` is never a
/// real daemon and means "every process in my group" to POSIX `kill`, and the
/// overlay must not shoot itself if a confused daemon reports our identifier.
fn is_terminable_process_identifier(process_identifier: u32) -> bool {
    process_identifier != 0 && process_identifier != std::process::id()
}

/// Second gate before terminating: the identifier must belong to a `node`
/// process. The number arrives from an unauthenticated `/health` on a port any
/// local process can bind, and it can be recycled between the probe and the
/// kill; the daemon always runs under node, so anything else is not ours to
/// terminate. This narrows the blast radius rather than proving ownership —
/// confirming the process actually holds the listening socket would need
/// `GetExtendedTcpTable`.
#[cfg(windows)]
fn is_node_process(process_identifier: u32) -> bool {
    let mut command = Command::new("tasklist");
    command.args([
        "/FI",
        &format!("PID eq {process_identifier}"),
        "/FO",
        "CSV",
        "/NH",
    ]);
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000);

    let Ok(output) = command.output() else {
        return false;
    };
    String::from_utf8_lossy(&output.stdout)
        .to_lowercase()
        .contains("\"node.exe\"")
}

#[cfg(not(windows))]
fn is_node_process(process_identifier: u32) -> bool {
    fs::read_to_string(format!("/proc/{process_identifier}/comm"))
        .map(|command_name| command_name.trim() == "node")
        .unwrap_or(false)
}

/// The bundled daemon ships as a Tauri resource in an installed build; when
/// running `pnpm dev:overlay` straight from the workspace it is read from the
/// daemon's build output instead.
fn resolve_daemon_script(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(resource) = app
        .path()
        .resolve("daemon/agent-lantern-daemon.cjs", BaseDirectory::Resource)
    {
        candidates.push(resource);
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("daemon")
            .join("dist-bundle")
            .join("agent-lantern-daemon.cjs"),
    );

    candidates
        .into_iter()
        .find(|candidate| candidate.exists())
        .map(strip_extended_length_prefix)
}

/// Tauri resolves resources to Windows extended-length paths (`\\?\C:\...`).
/// Node cannot load a script through one of those: it stops at the prefix and
/// fails with `EISDIR: illegal operation on a directory, lstat 'C:'`.
fn strip_extended_length_prefix(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().into_owned();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

/// Shared tail for every "you have to close it yourself" message.
fn stale_daemon_instruction() -> String {
    "請關閉該 daemon 後重新開啟 Agent Lantern。\n\
若不確定是哪個程序，可在 PowerShell 執行：\n\
Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*agent-lantern-daemon*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
        .to_string()
}

fn start_daemon(app: &AppHandle, state: &DaemonProcess) {
    if env::var("AGENT_LANTERN_NO_AUTO_START").is_ok() {
        eprintln!("[agent-lantern] 自動啟動已由 AGENT_LANTERN_NO_AUTO_START 停用。");
        return;
    }

    if let Ok(explicit_endpoint) = env::var("AGENT_LANTERN_DAEMON_ENDPOINT") {
        // The caller pointed the overlay somewhere specific, possibly at
        // another machine. Whatever holds the local port is then none of our
        // business — and certainly not something to terminate.
        eprintln!(
            "[agent-lantern] 已指定 daemon endpoint（{explicit_endpoint}），不管理本機 daemon。"
        );
        return;
    }

    let setup = read_shared_setup();
    let port = configured_port(setup.as_ref());
    match probe_daemon_settled(port) {
        DaemonProbe::Compatible => {
            eprintln!("[agent-lantern] 連接埠 {port} 已有 daemon 回應，沿用既有的 daemon。");
            return;
        }
        DaemonProbe::Incompatible {
            reported_version: Some(reported_version),
            ..
        } if reported_version > EXPECTED_PROTOCOL_VERSION => {
            // A newer daemon means someone is deliberately running a newer
            // build; killing it would throw away its in-memory sessions, and
            // two overlay versions started in turn would kill each other's
            // daemon forever.
            eprintln!(
                "[agent-lantern] 連接埠 {port} 上的 daemon 協定版本較新（v{reported_version}），不予終止。"
            );
            *state.startup_error.lock().unwrap() = Some(format!(
                "連接埠 {port} 上的 daemon 使用較新的協定版本（v{reported_version}），這個 overlay 只支援 v{EXPECTED_PROTOCOL_VERSION}。請更新 overlay。"
            ));
            return;
        }
        DaemonProbe::Incompatible {
            process_identifier: Some(process_identifier),
            ..
        } if is_terminable_process_identifier(process_identifier) => {
            eprintln!(
                "[agent-lantern] 連接埠 {port} 上的 daemon（pid {process_identifier}）版本不符，準備終止並替換。"
            );
            if !is_node_process(process_identifier) {
                eprintln!("[agent-lantern] pid {process_identifier} 不是 node 行程，不予終止。");
                *state.startup_error.lock().unwrap() = Some(format!(
                    "連接埠 {port} 上的 daemon 回報的 pid（{process_identifier}）不是 node 行程，為了安全起見不會自動終止它。\n{}",
                    stale_daemon_instruction()
                ));
                return;
            }
            if !terminate_daemon_process(process_identifier) {
                eprintln!("[agent-lantern] 終止 pid {process_identifier} 的指令執行失敗。");
                *state.startup_error.lock().unwrap() = Some(format!(
                    "無法終止連接埠 {port} 上的舊版 daemon（pid {process_identifier}）。\n{}",
                    stale_daemon_instruction()
                ));
                return;
            }

            let shutdown_deadline = Instant::now() + STALE_DAEMON_SHUTDOWN_TIMEOUT;
            loop {
                sleep(Duration::from_millis(250));
                if port_is_free(port) {
                    break;
                }
                if Instant::now() >= shutdown_deadline {
                    eprintln!(
                        "[agent-lantern] 連接埠 {port} 上的舊版 daemon（pid {process_identifier}）沒有讓出連接埠。"
                    );
                    *state.startup_error.lock().unwrap() = Some(format!(
                        "連接埠 {port} 上的舊版 daemon（pid {process_identifier}）沒有在時限內關閉。\n{}",
                        stale_daemon_instruction()
                    ));
                    return;
                }
            }
        }
        DaemonProbe::Incompatible { .. } => {
            // Either a daemon predating the handshake (it cannot report its
            // pid) or one reporting an identifier we refuse to act on. Do not
            // start a second daemon: it would fall back to another port and
            // silently strand every remote reporter still posting to this one.
            eprintln!(
                "[agent-lantern] 連接埠 {port} 上的 daemon 版本過舊、無法回報可用的 pid，不會另外啟動第二份 daemon。"
            );
            *state.startup_error.lock().unwrap() = Some(format!(
                "連接埠 {port} 上的 daemon 版本過舊，與這個版本的 overlay 不相容。\n{}",
                stale_daemon_instruction()
            ));
            return;
        }
        DaemonProbe::Absent => {}
    }

    let Some(script) = resolve_daemon_script(app) else {
        eprintln!("[agent-lantern] 找不到 agent-lantern-daemon.cjs。");
        *state.startup_error.lock().unwrap() = Some(
            "找不到 daemon 程式（agent-lantern-daemon.cjs）。請先執行 `pnpm build`。".to_string(),
        );
        return;
    };
    eprintln!("[agent-lantern] 準備啟動 daemon：{}", script.display());

    let mut command = Command::new("node");
    command.arg(&script);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: keep the daemon from flashing a console window.
        command.creation_flags(0x0800_0000);
    }

    match command.spawn() {
        Ok(child) => {
            eprintln!("[agent-lantern] daemon 已啟動（pid {}）。", child.id());
            *state.child.lock().unwrap() = Some(child);
        }
        Err(error) => {
            eprintln!("[agent-lantern] 啟動 daemon 失敗：{error}");
            *state.startup_error.lock().unwrap() = Some(format!(
                "無法啟動 daemon：{error}。請確認已安裝 Node.js 20.19 以上版本且 node 在 PATH 中。"
            ));
        }
    }
}

/// Waits for the daemon to publish its token and accept connections. The port
/// is re-read on every attempt because the daemon rewrites it when the
/// preferred port turns out to be unavailable.
fn wait_for_daemon(app: &AppHandle) -> Result<OverlayConfiguration, String> {
    let deadline = Instant::now() + DAEMON_READY_TIMEOUT;
    let mut last_probe_was_incompatible = false;

    loop {
        let setup = read_shared_setup();
        let token = env::var("AGENT_LANTERN_TOKEN")
            .ok()
            .or_else(|| setup.as_ref().map(|setup| setup.token.clone()));

        if let Some(token) = token {
            let explicit_endpoint = env::var("AGENT_LANTERN_DAEMON_ENDPOINT").ok();
            let port = configured_port(setup.as_ref());

            // An explicit endpoint bypasses the probe entirely, same as before
            // this handshake existed — the caller is asserting the endpoint is
            // reachable and compatible.
            if let Some(explicit_endpoint) = explicit_endpoint {
                return Ok(OverlayConfiguration {
                    daemon_endpoint: explicit_endpoint.trim_end_matches('/').to_string(),
                    token,
                    setup_file_path: shared_configuration_path().display().to_string(),
                    remote_endpoint: tailscale_ipv4()
                        .map(|address| format!("http://{address}:{port}")),
                });
            }

            match probe_daemon(port) {
                DaemonProbe::Compatible => {
                    return Ok(OverlayConfiguration {
                        daemon_endpoint: format!("http://127.0.0.1:{port}"),
                        token,
                        setup_file_path: shared_configuration_path().display().to_string(),
                        remote_endpoint: tailscale_ipv4()
                            .map(|address| format!("http://{address}:{port}")),
                    });
                }
                DaemonProbe::Incompatible { .. } => last_probe_was_incompatible = true,
                DaemonProbe::Absent => last_probe_was_incompatible = false,
            }
        }

        // Only once this round found no usable daemon: `start_daemon` runs on
        // a background thread, so re-read its verdict every round rather than
        // snapshotting it once, and surface it as soon as it appears instead
        // of burning the whole timeout on a daemon that will never come up.
        // Checking it after the probe keeps a daemon that did come up (or an
        // explicit endpoint) winning over a stale error from this run.
        let startup_error = app
            .state::<DaemonProcess>()
            .startup_error
            .lock()
            .unwrap()
            .clone();
        if let Some(startup_error) = startup_error {
            return Err(startup_error);
        }

        if Instant::now() >= deadline {
            if last_probe_was_incompatible {
                return Err(format!(
                    "daemon 版本與這個 overlay 不相容。\n{}",
                    stale_daemon_instruction()
                ));
            }
            return Err(
                "daemon 沒有在時限內啟動。請確認已安裝 Node.js，並在專案根目錄執行過 `pnpm build`。"
                    .to_string(),
            );
        }

        sleep(Duration::from_millis(250));
    }
}

#[tauri::command]
async fn get_overlay_configuration(app: AppHandle) -> Result<OverlayConfiguration, String> {
    tauri::async_runtime::spawn_blocking(move || wait_for_daemon(&app))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(DaemonProcess::default())
        .invoke_handler(tauri::generate_handler![get_overlay_configuration])
        .setup(|app| {
            let handle = app.handle().clone();
            // `setup` runs on the main thread, and replacing a stale daemon can
            // take seconds (terminate, then wait for the port to come free).
            // Blocking here leaves the user staring at a window that has not
            // been drawn yet, so the startup work moves off the main thread and
            // reports back through `DaemonProcess`.
            std::thread::spawn(move || {
                let state = handle.state::<DaemonProcess>();
                start_daemon(&handle, &state);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Agent Lantern overlay")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                let state = app_handle.state::<DaemonProcess>();
                let child = state.child.lock().unwrap().take();
                if let Some(mut child) = child {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn http_response(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
            body.len()
        )
    }

    #[test]
    fn classifies_a_matching_daemon_as_compatible() {
        let raw = http_response(
            r#"{"status":"ok","service":"agent-lantern-daemon","protocolVersion":2,"processIdentifier":4242}"#,
        );
        assert!(matches!(
            classify_health_response(&raw),
            DaemonProbe::Compatible
        ));
    }

    #[test]
    fn classifies_a_pre_handshake_daemon_as_incompatible_without_a_process_identifier() {
        let raw = http_response(r#"{"status":"ok","service":"agent-lantern-daemon"}"#);
        assert!(matches!(
            classify_health_response(&raw),
            DaemonProbe::Incompatible {
                reported_version: None,
                process_identifier: None,
            }
        ));
    }

    #[test]
    fn keeps_the_process_identifier_of_an_older_daemon() {
        let raw = http_response(
            r#"{"status":"ok","service":"agent-lantern-daemon","protocolVersion":1,"processIdentifier":31337}"#,
        );
        assert!(matches!(
            classify_health_response(&raw),
            DaemonProbe::Incompatible {
                reported_version: Some(1),
                process_identifier: Some(31337),
            }
        ));
    }

    #[test]
    fn recovers_the_body_from_a_chunked_response() {
        let body = r#"{"status":"ok","service":"agent-lantern-daemon","protocolVersion":2}"#;
        let raw = format!(
            "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n{:x}\r\n{body}\r\n0\r\n\r\n",
            body.len()
        );
        assert!(matches!(
            classify_health_response(&raw),
            DaemonProbe::Compatible
        ));
    }

    #[test]
    fn treats_a_body_truncated_mid_json_as_incompatible() {
        let raw = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"status\":\"ok\",\"service\":\"agent-lantern-daemon\",\"protocolVer";
        assert!(matches!(
            classify_health_response(raw),
            DaemonProbe::Incompatible {
                reported_version: None,
                process_identifier: None,
            }
        ));
    }

    /// Cut before the body, nothing identifies the responder, so this is the
    /// `Absent` path — the same verdict as a socket that never speaks HTTP.
    /// `probe_daemon_settled` re-probes before anyone acts on a truncated
    /// read, and a daemon that is really there answers the next attempt.
    #[test]
    fn treats_a_response_truncated_before_its_body_as_absent() {
        let raw = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 96";
        assert!(matches!(classify_health_response(raw), DaemonProbe::Absent));
    }

    #[test]
    fn treats_anything_that_does_not_identify_itself_as_absent() {
        let raw = http_response(r#"{"status":"ok","service":"something-else"}"#);
        assert!(matches!(
            classify_health_response(&raw),
            DaemonProbe::Absent
        ));
        assert!(matches!(classify_health_response(""), DaemonProbe::Absent));
    }

    #[test]
    fn refuses_to_terminate_zero_or_our_own_process() {
        assert!(!is_terminable_process_identifier(0));
        assert!(!is_terminable_process_identifier(std::process::id()));
    }

    #[test]
    fn accepts_an_unrelated_process_identifier() {
        assert!(is_terminable_process_identifier(std::process::id() + 1));
    }
}
