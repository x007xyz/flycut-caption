mod commands;
mod host;
mod jianying_output;
mod media_link;

#[tauri::command]
fn app_ready() -> &'static str {
    "ok"
}

/// 弹出原生文件选择对话框，返回选中文件的本地路径。
/// 原生对话框属于桌面外壳；对文件的处理都经由 Host RPC。
#[tauri::command]
async fn pick_media_file() -> Option<String> {
    use rfd::AsyncFileDialog;

    let file = AsyncFileDialog::new()
        .add_filter(
            "Media files",
            &[
                "mp4", "webm", "mov", "avi", "mkv", "ogg", "mp3", "wav", "m4a", "flac", "aac",
            ],
        )
        .pick_file()
        .await;

    file.map(|f| {
        // Only files the user chose here may later be linked into a project (ADR-0002).
        media_link::allow(f.path());
        f.path().to_string_lossy().to_string()
    })
}

/// 多选媒体文件（F-0003：往项目里一次添加多个视频）。取消时返回空列表。
#[tauri::command]
async fn pick_media_files() -> Vec<String> {
    let files = rfd::AsyncFileDialog::new()
        .add_filter(
            "Media files",
            &[
                "mp4", "webm", "mov", "avi", "mkv", "ogg", "mp3", "wav", "m4a", "flac", "aac",
            ],
        )
        .pick_files()
        .await
        .unwrap_or_default();
    files
        .iter()
        .map(|f| {
            media_link::allow(f.path());
            f.path().to_string_lossy().to_string()
        })
        .collect()
}

/// 弹出原生保存对话框，返回用户选定的输出文件路径。
#[tauri::command]
async fn pick_save_media_file(default_name: String) -> Option<String> {
    use rfd::AsyncFileDialog;

    let file = AsyncFileDialog::new()
        .set_file_name(&default_name)
        .add_filter("Video files", &["mp4", "webm", "mov", "mkv"])
        .save_file()
        .await;

    file.map(|f| f.path().to_string_lossy().to_string())
}

/// 选择本地模型目录；扫描与登记由 Host `models.*` RPC 完成。
#[tauri::command]
async fn pick_model_directory() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .pick_folder()
        .await
        .map(|f| f.path().to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            app_ready,
            host::ensure_host,
            pick_media_file,
            pick_media_files,
            pick_save_media_file,
            commands::media::stage_media_file,
            commands::media::download_media_to_temp,
            pick_model_directory,
            jianying_output::pick_jianying_output_directory,
            host::save_host_asset,
            media_link::link_project_media,
        ])
        .on_window_event(|_, event| {
            // Files dropped onto the window count as chosen by the user, like the picker.
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                paths.iter().for_each(|path| media_link::allow(path));
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                host::stop_host();

            }
        });
}
