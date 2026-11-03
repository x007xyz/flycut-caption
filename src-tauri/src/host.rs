//! Desktop owns the independent Host process; business calls use HTTP RPC/WebSocket.
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize, Deserialize)]
pub struct HostConnection {
    url: String,
    token: String,
}

struct OwnedHost { child: Child, connection: HostConnection }
static HOST: OnceLock<Mutex<Option<OwnedHost>>> = OnceLock::new();

#[tauri::command]
pub async fn ensure_host(app: AppHandle) -> Result<HostConnection, String> {
    tauri::async_runtime::spawn_blocking(move || start_host(app))
        .await.map_err(|error| error.to_string())?
}

/// Copies a Host result asset to a path the user chose in the native save dialog.
/// The bytes never cross the WebView IPC, and the Host RPC never receives arbitrary output paths.
#[tauri::command]
pub async fn save_host_asset(app: AppHandle, asset_id: String, output_path: String) -> Result<String, String> {
    let valid = asset_id.len() == 36 && asset_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    if !valid { return Err("Invalid asset ID".into()); }
    let source = app.path().app_data_dir().map_err(|error| error.to_string())?.join("host/assets").join(&asset_id);
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::copy(&source, &output_path).map_err(|error| format!("保存导出文件失败：{error}"))?;
        Ok(output_path)
    }).await.map_err(|error| error.to_string())?
}

fn start_host(app: AppHandle) -> Result<HostConnection, String> {
    let mut owned = HOST.get_or_init(|| Mutex::new(None)).lock().map_err(|error| error.to_string())?;
    if let Some(host) = owned.as_mut() {
        if host.child.try_wait().map_err(|error| error.to_string())?.is_none() { return Ok(host.connection.clone()); }
        *owned = None;
    }
    let resource = app.path().resource_dir().map_err(|error| error.to_string())?;
    let project = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
    let packaged_script = resource.join("host/lib/main.mjs");
    let script = if packaged_script.is_file() { packaged_script } else { project.join("dist-host/main.mjs") };
    if !script.is_file() { return Err("FlyCut Host 尚未构建，请运行 pnpm build:host".into()); }
    let resource_root = if resource.join("_up_/models.json").is_file() { resource.join("_up_") }
        else if resource.join("models.json").is_file() { resource.clone() } else { project.clone() };
    let node_name = if cfg!(windows) { "flycut-node.exe" } else { "flycut-node" };
    let bundled_node = resource.join("binaries").join(node_name);
    let dev_node = project.join("src-tauri/binaries").join(node_name);
    let node = std::env::var_os("FLYCUT_NODE").map(PathBuf::from)
        .or_else(|| bundled_node.is_file().then_some(bundled_node))
        .or_else(|| dev_node.is_file().then_some(dev_node))
        .unwrap_or_else(|| PathBuf::from("node"));
    let app_data = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let home = app_data.join("host");
    std::fs::create_dir_all(&home).map_err(|error| error.to_string())?;
    let mut command = Command::new(node);
    command.arg(script).current_dir(&resource_root)
        .env("FLYCUT_RESOURCE_ROOT", &resource_root).env("FLYCUT_APP_DATA", &app_data)
        .env("FLYCUT_HOST_HOME", &home).env("FLYCUT_HOST_PORT", "0").env("FLYCUT_HOST_STDIO", "1")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::inherit());
    let binary_root = if resource.join("binaries").is_dir() { resource.join("binaries") } else { project.join("src-tauri/binaries") };
    command.env("FLYCUT_FUNASR_SIDECAR", binary_root.join(if cfg!(windows) { "funasr-asr.exe" } else { "funasr-asr" }));
    command.env("FFMPEG_PATH", binary_root.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" }));
    let mut child = command.spawn().map_err(|error| format!("启动 Host 失败：{error}"))?;
    let stdout = child.stdout.take().ok_or("Host readiness pipe missing")?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let outcome = reader.read_line(&mut line).map_err(|error| error.to_string())
            .and_then(|_| serde_json::from_str::<HostConnection>(&line).map_err(|error| error.to_string()));
        let _ = sender.send(outcome);
        // Drain the pipe after readiness; never print the connection credential.
        std::io::copy(&mut reader, &mut std::io::sink()).ok();
    });
    let connection = match receiver.recv_timeout(Duration::from_secs(30)) {
        Ok(Ok(connection)) => connection,
        Ok(Err(error)) => { let _ = child.kill(); let _ = child.wait(); return Err(format!("Host readiness failed: {error}")); }
        Err(error) => { let _ = child.kill(); let _ = child.wait(); return Err(format!("Host readiness failed: {error}")); }
    };
    *owned = Some(OwnedHost { child, connection: connection.clone() });
    Ok(connection)
}

pub fn stop_host() {
    let Some(state) = HOST.get() else { return; };
    let Ok(mut guard) = state.lock() else { return; };
    let Some(mut owned) = guard.take() else { return; };
    if let Some(address) = owned.connection.url.strip_prefix("http://") {
        if let Ok(address) = address.parse() {
            if let Ok(mut stream) = std::net::TcpStream::connect_timeout(&address, Duration::from_millis(300)) {
                let body = r#"{"type":"client-request","rpcId":"desktop-shutdown","method":"host.shutdown","payload":{}}"#;
                let request = format!("POST /rpc HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", owned.connection.token, body.len(), body);
                let _ = stream.write_all(request.as_bytes());
            }
        }
    }
    for _ in 0..30 {
        if owned.child.try_wait().ok().flatten().is_some() { return; }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = owned.child.kill(); let _ = owned.child.wait();
}
