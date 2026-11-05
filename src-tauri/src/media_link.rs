//! Desktop project media (ADR-0002): the shell remembers files the user picked or dropped during this run
//! and registers them with the Host over a shell-only channel. The frontend only ever gets an opaque `mediaRef`,
//! so Host RPC never accepts a local path.
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

static ALLOWED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

fn normalize(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Called for paths from the native picker and window drop events only.
pub fn allow(path: &Path) {
    if let Ok(mut allowed) = ALLOWED.get_or_init(|| Mutex::new(HashSet::new())).lock() {
        allowed.insert(normalize(path));
    }
}

pub fn is_allowed(path: &Path) -> bool {
    ALLOWED
        .get()
        .and_then(|allowed| allowed.lock().ok().map(|set| set.contains(&normalize(path))))
        .unwrap_or(false)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedMedia {
    media_ref: String,
    name: String,
    size: u64,
}

/// Registers a file the user chose in this run with the Host and returns its `mediaRef`.
#[tauri::command]
pub async fn link_project_media(path: String) -> Result<LinkedMedia, String> {
    let file = PathBuf::from(&path);
    if !is_allowed(&file) {
        return Err("只能登记本次运行中选择或拖入的文件".into());
    }
    let (url, secret) = crate::host::shell_endpoint()?;
    let response = reqwest::Client::new()
        .post(format!("{url}/shell/projects/media"))
        .bearer_auth(secret)
        .header("Content-Type", "application/json")
        .body(serde_json::json!({ "path": normalize(&file).to_string_lossy() }).to_string())
        .send()
        .await
        .map_err(|error| format!("登记媒体失败：{error}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!("登记媒体失败（HTTP {status}）：{body}"));
    }
    serde_json::from_str::<LinkedMedia>(&body).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_picked_paths_are_allowed() {
        let dir = std::env::temp_dir().join(format!("flycut-media-link-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let picked = dir.join("picked.mp4");
        let other = dir.join("other.mp4");
        std::fs::write(&picked, b"a").unwrap();
        std::fs::write(&other, b"b").unwrap();
        allow(&picked);
        assert!(is_allowed(&picked));
        // The same file through a non-canonical spelling still matches.
        assert!(is_allowed(&dir.join(".").join("picked.mp4")));
        assert!(!is_allowed(&other));
        assert!(!is_allowed(Path::new("/etc/passwd")));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn link_rejects_paths_not_chosen_by_the_user() {
        let error = link_project_media("/etc/hosts".into()).await.err().unwrap();
        assert!(error.contains("只能登记"));
    }
}
