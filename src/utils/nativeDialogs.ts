/**
 * Native dialogs belong to the desktop shell, not the Host: they need the user's window.
 * Everything that acts on the chosen path goes through Host RPC.
 */
export async function pickDirectory(): Promise<string | null> {
  if (!('__TAURI_INTERNALS__' in window)) throw new Error('浏览器中无法选择本机目录，请直接输入路径');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string | null>('pick_model_directory');
}
