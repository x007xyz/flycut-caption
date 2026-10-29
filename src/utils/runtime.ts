/** 当前是否运行在 Tauri 桌面客户端 */
export function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

/** 当前运行环境对应的 ASR 引擎类型 */
export function getRuntimeAsrEngineType(): 'transformers' | 'python-runtime' {
  return isTauriRuntime() ? 'python-runtime' : 'transformers';
}
