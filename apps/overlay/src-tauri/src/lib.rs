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
use tauri::{AppHandle, Manager, RunEvent, State};

const DEFAULT_PORT: u16 = 48123;
const DAEMON_READY_TIMEOUT: Duration = Duration::from_secs(20);

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

/// Confirms an Agent Lantern daemon answers on the port, rather than merely
/// that something accepts connections there. On Windows hosts running WSL 2 or
/// Docker Desktop the Hyper-V host network service holds sockets that accept
/// connections without ever speaking HTTP, so a bare TCP connect would report
/// a daemon that is not there and suppress automatic startup.
fn is_daemon_healthy(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(300)) else {
        return false;
    };

    let timeout = Some(Duration::from_millis(500));
    if stream.set_read_timeout(timeout).is_err() || stream.set_write_timeout(timeout).is_err() {
        return false;
    }
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }

    let mut response = Vec::new();
    let mut chunk = [0u8; 512];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                response.extend_from_slice(&chunk[..read]);
                if response.len() > 4096 {
                    break;
                }
            }
            Err(_) => break,
        }
    }

    String::from_utf8_lossy(&response).contains("agent-lantern-daemon")
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

fn start_daemon(app: &AppHandle, state: &DaemonProcess) {
    if env::var("AGENT_LANTERN_NO_AUTO_START").is_ok() {
        eprintln!("[agent-lantern] 自動啟動已由 AGENT_LANTERN_NO_AUTO_START 停用。");
        return;
    }

    let setup = read_shared_setup();
    let port = configured_port(setup.as_ref());
    if is_daemon_healthy(port) {
        eprintln!("[agent-lantern] 連接埠 {port} 已有 daemon 回應，沿用既有的 daemon。");
        return;
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
fn wait_for_daemon(startup_error: Option<String>) -> Result<OverlayConfiguration, String> {
    let deadline = Instant::now() + DAEMON_READY_TIMEOUT;

    loop {
        let setup = read_shared_setup();
        let token = env::var("AGENT_LANTERN_TOKEN")
            .ok()
            .or_else(|| setup.as_ref().map(|setup| setup.token.clone()));

        if let Some(token) = token {
            let explicit_endpoint = env::var("AGENT_LANTERN_DAEMON_ENDPOINT").ok();
            let port = configured_port(setup.as_ref());

            if explicit_endpoint.is_some() || is_daemon_healthy(port) {
                let daemon_endpoint =
                    explicit_endpoint.unwrap_or_else(|| format!("http://127.0.0.1:{port}"));
                return Ok(OverlayConfiguration {
                    daemon_endpoint: daemon_endpoint.trim_end_matches('/').to_string(),
                    token,
                    setup_file_path: shared_configuration_path().display().to_string(),
                    remote_endpoint: tailscale_ipv4()
                        .map(|address| format!("http://{address}:{port}")),
                });
            }
        }

        if Instant::now() >= deadline {
            return Err(startup_error.unwrap_or_else(|| {
                "daemon 沒有在時限內啟動。請確認已安裝 Node.js，並在專案根目錄執行過 `pnpm build`。"
                    .to_string()
            }));
        }

        sleep(Duration::from_millis(250));
    }
}

#[tauri::command]
async fn get_overlay_configuration(
    state: State<'_, DaemonProcess>,
) -> Result<OverlayConfiguration, String> {
    let startup_error = state.startup_error.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || wait_for_daemon(startup_error))
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
            start_daemon(&handle, &app.state::<DaemonProcess>());
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
