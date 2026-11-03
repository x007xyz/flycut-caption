/** 当前是否运行在 Tauri 桌面客户端 */
export function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in window;
}
