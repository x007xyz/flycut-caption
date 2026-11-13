//! Desktop directory selection for F-0011. The native dialog is the only source of an output parent.
//! This module sends that path to the Host over the shell-only secret and returns only the opaque grant.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryGrant {
    grant: String,
    expires_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostDirectoryGrant {
    grant: String,
    expires_at: String,
}

fn canonical_output_directory(path: &Path) -> Result<PathBuf, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("无法读取所选输出目录：{error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("不能选择符号链接作为剪映输出目录".into());
    }
    if !metadata.is_dir() {
        return Err("剪映输出位置必须是目录".into());
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| format!("无法解析所选输出目录：{error}"))?;
    let canonical_metadata = std::fs::symlink_metadata(&canonical)
        .map_err(|error| format!("无法读取所选输出目录：{error}"))?;
    if canonical_metadata.file_type().is_symlink() || !canonical_metadata.is_dir() {
        return Err("剪映输出位置不是真实目录".into());
    }
    Ok(canonical)
}

/// Opens a native folder picker, registers the chosen parent with the Host, and returns an opaque grant.
/// Cancellation returns `None`; the filesystem path never reaches the WebView or ordinary RPC.
#[tauri::command]
pub async fn pick_jianying_output_directory() -> Result<Option<DirectoryGrant>, String> {
    let selected = rfd::AsyncFileDialog::new()
        .set_title("选择剪映草稿输出位置")
        .pick_folder()
        .await;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let parent = canonical_output_directory(selected.path())?;
    let (url, secret) = crate::host::shell_endpoint()?;
    let response = reqwest::Client::new()
        .post(format!("{url}/shell/jianying/directories"))
        .bearer_auth(secret)
        .header("Content-Type", "application/json")
        .body(serde_json::json!({ "path": parent.to_string_lossy() }).to_string())
        .send()
        .await
        .map_err(|error| format!("登记剪映输出目录失败：{error}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!("登记剪映输出目录失败（HTTP {status}）：{body}"));
    }
    let registered = serde_json::from_str::<HostDirectoryGrant>(&body)
        .map_err(|error| format!("Host 返回的目录授权无效：{error}"))?;
    Ok(Some(DirectoryGrant {
        grant: registered.grant,
        expires_at: registered.expires_at,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("flycut-jianying-{label}-{unique}"))
    }

    #[test]
    fn accepts_only_real_directories() {
        let dir = temp_dir("real");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("file.txt");
        std::fs::write(&file, "x").unwrap();
        assert_eq!(canonical_output_directory(&dir).unwrap(), std::fs::canonicalize(&dir).unwrap());
        assert!(canonical_output_directory(&file).unwrap_err().contains("必须是目录"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_directories() {
        use std::os::unix::fs::symlink;
        let root = temp_dir("link");
        let actual = root.join("actual");
        let link = root.join("link");
        std::fs::create_dir_all(&actual).unwrap();
        symlink(&actual, &link).unwrap();
        assert!(canonical_output_directory(&link).unwrap_err().contains("符号链接"));
        std::fs::remove_dir_all(&root).ok();
    }
}
