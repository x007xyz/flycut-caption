// 还开着的编辑会话（F-0004 AC-3）：每个会话占一把 Web Lock，窗口关闭或崩溃时浏览器自动释放。
// 打开项目时跳过仍被占用的会话，另一个窗口正在编辑的内容不会被当成待恢复的副本。
const PREFIX = 'flycut-recovery-session:';

type Locks = { request: (name: string, callback: () => Promise<void>) => Promise<void>; query: () => Promise<{ held?: Array<{ name?: string }> }> };
const locks = (): Locks | undefined => (typeof navigator !== 'undefined' ? (navigator as unknown as { locks?: Locks }).locks : undefined);

/** 占住这个会话的锁；返回释放函数。不支持 Web Locks 的环境什么都不做。 */
export function holdSession(sessionId: string): () => void {
  const api = locks();
  if (!api) return () => undefined;
  let release: () => void = () => undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  void api.request(PREFIX + sessionId, () => held).catch(() => undefined);
  return release;
}

/** 当前被占用的会话 ID（包括本窗口和其他窗口）。读不到时返回空集合：宁可多提示，不漏掉崩溃留下的副本。 */
export async function liveSessions(): Promise<Set<string>> {
  const api = locks();
  if (!api) return new Set();
  try {
    const { held = [] } = await api.query();
    return new Set(held.map(lock => lock.name ?? '').filter(name => name.startsWith(PREFIX)).map(name => name.slice(PREFIX.length)));
  } catch { return new Set(); }
}
