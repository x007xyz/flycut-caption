//! Desktop project backup shell commands (F-0023, ADR-0015):
//! keeps user-chosen backup paths in memory on the desktop shell and streams
//! staging through the shell-only Host endpoint without sending raw local paths over RPC.
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

static ALLOWED_BACKUPS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

fn normalize(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Called only from native backup file picker dialogs or window drop events.
pub fn allow(path: &Path) {
    if let Ok(mut allowed) = ALLOWED_BACKUPS.get_or_init(|| Mutex::new(HashSet::new())).lock() {
        allowed.insert(normalize(path));
    }
}

pub fn is_allowed(path: &Path) -> bool {
    ALLOWED_BACKUPS
        .get()
        .and_then(|allowed| allowed.lock().ok().map(|set| set.contains(&normalize(path))))
        .unwrap_or(false)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedBackup {
    pub staging_id: String,
    pub size: u64,
    pub sha256: String,
    pub created_at: String,
}

#[tauri::command]
pub async fn pick_backup_file() -> Option<String> {
    use rfd::AsyncFileDialog;

    let file = AsyncFileDialog::new()
        .add_filter("FlyCut Backup", &["zip", "flycut"])
        .pick_file()
        .await;

    file.map(|f| {
        allow(f.path());
        f.path().to_string_lossy().to_string()
    })
}

#[tauri::command]
pub async fn pick_save_backup_file(default_name: String) -> Option<String> {
    use rfd::AsyncFileDialog;

    let file = AsyncFileDialog::new()
        .set_file_name(&default_name)
        .add_filter("FlyCut Backup", &["zip"])
        .save_file()
        .await;

    file.map(|f| f.path().to_string_lossy().to_string())
}

/// Stages a user-chosen backup file into Host staging via the shell-only route.
#[tauri::command]
pub async fn stage_host_backup(path: String) -> Result<StagedBackup, String> {
    let file = PathBuf::from(&path);
    if !is_allowed(&file) {
        return Err("只能导入本次运行中选择或拖入的备份文件".into());
    }
    let (url, secret) = crate::host::shell_endpoint()?;
    let response = reqwest::Client::new()
        .post(format!("{url}/shell/projects/backups"))
        .bearer_auth(secret)
        .header("Content-Type", "application/json")
        .body(serde_json::json!({ "path": normalize(&file).to_string_lossy() }).to_string())
        .send()
        .await
        .map_err(|error| format!("暂存备份文件失败：{error}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!("暂存备份文件失败（HTTP {status}）：{body}"));
    }
    serde_json::from_str::<StagedBackup>(&body).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_picked_backup_paths_are_allowed() {
        let dir = std::env::temp_dir().join(format!("flycut-backup-allow-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let picked = dir.join("project.flycut.zip");
        let other = dir.join("other.flycut.zip");
        std::fs::write(&picked, b"pk").unwrap();
        std::fs::write(&other, b"pk").unwrap();
        allow(&picked);
        assert!(is_allowed(&picked));
        assert!(is_allowed(&dir.join(".").join("project.flycut.zip")));
        assert!(!is_allowed(&other));
        assert!(!is_allowed(Path::new("/etc/passwd")));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn stage_rejects_paths_not_chosen_by_the_user() {
        let error = stage_host_backup("/etc/hosts".into()).await.err().unwrap();
        assert!(error.contains("只能导入"));
    }
}
