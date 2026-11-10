import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const SECRET_REF = /^[0-9a-f-]{36}$/i;
const AAD = Buffer.from('flycut-ai-settings-v1');

export interface AISecretStore {
  get(ref: string): Promise<string | undefined>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

function checkRef(ref: string) {
  if (!SECRET_REF.test(ref)) throw new Error('Invalid AI secret reference');
}

export class MemoryAISecretStore implements AISecretStore {
  private values = new Map<string, string>();
  async get(ref: string) { checkRef(ref); return this.values.get(ref); }
  async set(ref: string, value: string) { checkRef(ref); this.values.set(ref, value); }
  async delete(ref: string) { checkRef(ref); this.values.delete(ref); }
}

interface EncryptedSecrets { version: 1; salt: string; iv: string; tag: string; data: string }

/** Remote Host fallback: encrypted at rest with an operator-supplied high-entropy key. */
export class EncryptedFileAISecretStore implements AISecretStore {
  private writes = Promise.resolve();
  constructor(private file: string, private encryptionKey: string | undefined) {}

  /** Serialize mutations here as well as in the settings plugin; snapshots may read concurrently. */
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const task = this.writes.then(run); this.writes = task.then(() => undefined, () => undefined); return task;
  }

  private key() {
    const value = this.encryptionKey;
    if (!value || value.length < 32) {
      throw new Error('远程 Host 未配置安全的 AI 密钥存储，请设置至少 32 个字符的 FLYCUT_AI_SECRET_KEY');
    }
    return value;
  }

  private async readMap(): Promise<Record<string, string>> {
    this.key();
    let parsed: EncryptedSecrets;
    try { parsed = JSON.parse(await readFile(this.file, 'utf8')) as EncryptedSecrets; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error('AI 密钥存储文件已损坏');
    }
    if (parsed.version !== 1) throw new Error('AI 密钥存储版本不受支持');
    try {
      const salt = Buffer.from(parsed.salt, 'base64');
      const derived = await scrypt(this.key(), salt, 32) as Buffer;
      const decipher = createDecipheriv('aes-256-gcm', derived, Buffer.from(parsed.iv, 'base64'));
      decipher.setAAD(AAD); decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
      const clear = Buffer.concat([decipher.update(Buffer.from(parsed.data, 'base64')), decipher.final()]);
      return JSON.parse(clear.toString('utf8')) as Record<string, string>;
    } catch { throw new Error('AI 密钥存储无法解密，请检查 FLYCUT_AI_SECRET_KEY'); }
  }

  private async writeMap(values: Record<string, string>) {
    const salt = randomBytes(16); const iv = randomBytes(12);
    const derived = await scrypt(this.key(), salt, 32) as Buffer;
    const cipher = createCipheriv('aes-256-gcm', derived, iv); cipher.setAAD(AAD);
    const data = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()]);
    const payload: EncryptedSecrets = { version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    try { await writeFile(tmp, JSON.stringify(payload), { mode: 0o600 }); await rename(tmp, this.file); }
    catch (error) { await rm(tmp, { force: true }).catch(() => undefined); throw error; }
  }

  async get(ref: string) { checkRef(ref); return (await this.readMap())[ref]; }
  set(ref: string, value: string) { checkRef(ref); return this.exclusive(async () => { const values = await this.readMap(); values[ref] = value; await this.writeMap(values); }); }
  delete(ref: string) { checkRef(ref); return this.exclusive(async () => { const values = await this.readMap(); if (ref in values) { delete values[ref]; await this.writeMap(values); } }); }
}

function run(command: string, args: string[], input?: string, timeoutMs = 10_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', chunk => { if (stdout.length < 64 * 1024) stdout += String(chunk); });
    let stderr = '';
    child.stderr.on('data', chunk => { if (stderr.length < 64 * 1024) stderr += String(chunk); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs); timer.unref();
    child.on('error', () => { clearTimeout(timer); reject(new Error('系统凭据存储不可用')); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
    // Secrets or their reversible encoding travel over stdin, never a process argument.
    child.stdin.end(input);
  });
}

/** Desktop secret store. Commands are fixed platform helpers; user values never enter argv. */
export class OsAISecretStore implements AISecretStore {
  private readonly service = 'com.flycut.caption.ai-settings';
  constructor(private accountPrefix = this.service) {}

  private account(ref: string) { checkRef(ref); return `${this.accountPrefix}:${ref}`; }

  async get(ref: string) {
    const account = this.account(ref);
    if (process.platform === 'darwin') {
      const result = await run('/usr/bin/security', ['find-generic-password', '-s', this.service, '-a', account, '-w']);
      if (result.code === 0) return Buffer.from(result.stdout.trim(), 'base64url').toString('utf8');
      if (/could not be found/i.test(result.stderr)) return undefined;
      throw new Error('macOS 系统凭据存储不可用或拒绝访问');
    }
    if (process.platform === 'linux') {
      const result = await run('secret-tool', ['lookup', 'service', this.service, 'account', account]);
      if (result.code === 0) return result.stdout.replace(/\r?\n$/, '');
      if (result.code === 1 && !result.stderr.trim()) return undefined;
      throw new Error('Linux 系统凭据存储不可用或拒绝访问');
    }
    if (process.platform === 'win32') {
      const protectedFile = join(process.env.LOCALAPPDATA ?? process.cwd(), 'FlyCut', 'ai-settings', `${ref}.dpapi`);
      let encoded: string;
      try { encoded = await readFile(protectedFile, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
      const script = "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'); [Text.Encoding]::UTF8.GetString($p)";
      const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], encoded);
      if (result.code !== 0) throw new Error('Windows 系统凭据存储不可用');
      return result.stdout;
    }
    throw new Error('当前平台没有可用的系统凭据存储');
  }

  async set(ref: string, value: string) {
    const account = this.account(ref);
    if (process.platform === 'darwin') {
      // `security -i` reads the command from stdin. The Key is base64url encoded in that stdin stream.
      const encoded = Buffer.from(value).toString('base64url');
      const result = await run('/usr/bin/security', ['-i'],
        `add-generic-password -U -s ${this.service} -a ${account} -w ${encoded}\n`);
      if (result.code !== 0) throw new Error('macOS 系统凭据存储不可用或未授权');
      // `security -i` can report success at process level when the inner command failed. Verify the
      // exact immutable ref by reading it back before the metadata can point at it.
      const written = await this.get(ref);
      if (written !== value) {
        // The expected raw value itself is never included in an error message.
        throw new Error('macOS 系统凭据写入未生效');
      }
      return;
    }
    if (process.platform === 'linux') {
      const result = await run('secret-tool', ['store', '--label', 'FlyCut AI settings', 'service', this.service, 'account', account], value);
      if (result.code !== 0) throw new Error('Linux 系统凭据存储不可用或未授权');
      return;
    }
    if (process.platform === 'win32') {
      const script = "Add-Type -AssemblyName System.Security; $b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); $p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'); [Convert]::ToBase64String($p)";
      const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], value);
      if (result.code !== 0) throw new Error('Windows 系统凭据存储不可用');
      const file = join(process.env.LOCALAPPDATA ?? process.cwd(), 'FlyCut', 'ai-settings', `${ref}.dpapi`);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, result.stdout.trim(), { mode: 0o600 });
      return;
    }
    throw new Error('当前平台没有可用的系统凭据存储');
  }

  async delete(ref: string) {
    const account = this.account(ref);
    if (process.platform === 'darwin') {
      await run('/usr/bin/security', ['delete-generic-password', '-s', this.service, '-a', account]); return;
    }
    if (process.platform === 'linux') { await run('secret-tool', ['clear', 'service', this.service, 'account', account]); return; }
    if (process.platform === 'win32') {
      await rm(join(process.env.LOCALAPPDATA ?? process.cwd(), 'FlyCut', 'ai-settings', `${ref}.dpapi`), { force: true }); return;
    }
    throw new Error('当前平台没有可用的系统凭据存储');
  }
}
