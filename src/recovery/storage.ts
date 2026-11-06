// 崩溃恢复副本的存储（F-0004，ADR-0004）。两端都用 IndexedDB：Web 是当前站点的浏览器存储，桌面端是 Tauri WebView 的应用存储。
// 每次写入是一个事务，整份替换这个会话的副本：事务失败时上一份完整副本保留。不写 localStorage，不新增 Tauri command。
import { parseRecord, type RecoveryCopy, type StoredRecord } from './copy';

export interface RecoveryStorage {
  /** 一个视频的全部记录（含解析不了的） */
  list(scope: string): Promise<StoredRecord[]>;
  /** 写入或整份替换 `copy.key` 的记录；事务提交后才算成功 */
  put(copy: RecoveryCopy): Promise<void>;
  /** 删除；给了 `sequence` 时只在记录仍是这个序号时删除，返回是否删除（记录已不存在也算删除） */
  delete(key: string, sequence?: number): Promise<boolean>;
}

const DB_NAME = 'flycut-recovery';
const STORE = 'copies';

const request = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error ?? new Error('IndexedDB 请求失败'));
});
const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'));
  tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务已中止'));
});

export class IndexedDbRecoveryStorage implements RecoveryStorage {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(new Error('此环境不支持 IndexedDB')); return; }
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const store = req.result.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('scope', 'scope');
        };
        req.onsuccess = () => {
          const db = req.result;
          // 别的窗口升级数据库时让出连接，下次重新打开
          db.onversionchange = () => { db.close(); this.db = null; };
          resolve(db);
        };
        req.onerror = () => reject(req.error ?? new Error('无法打开恢复副本数据库'));
        req.onblocked = () => reject(new Error('恢复副本数据库被占用'));
      });
      // 打开失败不缓存：下次重试时重新打开（AC-10 的「重试」）
      this.db.catch(() => { this.db = null; });
    }
    return this.db;
  }

  async list(scope: string) {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readonly');
    const rows = await request(tx.objectStore(STORE).index('scope').getAll(scope));
    return rows.map(parseRecord);
  }

  async put(copy: RecoveryCopy) {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
    tx.objectStore(STORE).put(copy);
    await done(tx);
  }

  async delete(key: string, sequence?: number) {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
    const store = tx.objectStore(STORE);
    let deleted = true;
    // 读和删在同一个事务里：其他窗口不会在两步之间写入
    const current = await request(store.get(key)) as { sequence?: unknown } | undefined;
    if (current && sequence !== undefined && current.sequence !== sequence) deleted = false;
    else if (current) store.delete(key);
    await done(tx);
    return deleted;
  }
}
