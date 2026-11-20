import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHost } from '../../server/app';
import type { JobSnapshot } from '../../shared/protocol';
import { findTerminologyIssues } from '../../shared/terminology';

async function readKey(): Promise<string | undefined> {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY;
  try {
    const auth = JSON.parse(await readFile(join(process.env.HOME ?? '', '.local/share/opencode/auth.json'), 'utf8'));
    return auth?.['opencode-go']?.key;
  } catch { return undefined; }
}

const key = await readKey();
if (!key) { console.log('SKIP F-0032 real API: set OPENCODE_API_KEY'); process.exit(0); }
const home = await mkdtemp(join(tmpdir(), 'flycut-f0032-real-'));
const token = randomUUID();
const ctx = await createHost({ home, appData: home, bind: '127.0.0.1', port: 0, token, resourceRoot: resolve('.') }, {
  profile: 'desktop', patches: [{ source: 'f0032-real', patch: { config: { 'ai-settings': { secretBackend: 'memory' } } } }] });
const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
const call = async <T>(method: string, payload: unknown = {}): Promise<T> => {
  const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }) });
  const envelope = await response.json() as { result: { ok: boolean; value: T; error?: { message: string } } };
  if (!envelope.result.ok) throw new Error(`${method}: ${envelope.result.error?.message}`);
  return envelope.result.value;
};
try {
  const host = await call<{ hostId: string }>('projects.identity');
  const saved = await call<{ configId: string }>('aiSettings.save', { hostId: host.hostId, expectedRevision: 0,
    config: { name: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4.1-flash',
      temperature: 0.2, apiKey: key, headers: { 'x-opencode-session': `ses_f0032_${Date.now()}` } } });
  const run = async (targetLang: string, items: Array<{ id: string; text: string }>, terms: Array<{ term: string; translation: string }>) => {
    const job = await call<JobSnapshot>('text.start', { mode: 'translation', configId: saved.configId, targetLang, items, terms });
    for (let i = 0; i < 400; i += 1) {
      const current = await call<JobSnapshot>('jobs.get', { id: job.id });
      if (current.status === 'complete') return current.result as Array<{ id: string; text: string }>;
      if (current.status === 'error' || current.status === 'cancelled') throw new Error(`${current.status}: ${current.error}`);
      await new Promise(done => setTimeout(done, 300));
    }
    throw new Error('translation timed out');
  };
  const batches = [
    { targetLang: 'English', terms: [{ term: 'FlyCut', translation: 'FlyCut' }, { term: '字幕', translation: 'subtitle' },
      { term: '术语表', translation: 'glossary' }],
      items: [{ id: 'a', text: 'FlyCut 的字幕工具支持术语表。' }, { id: 'b', text: '术语表能保证字幕译名一致。' }] },
    { targetLang: 'Japanese', terms: [{ term: 'FlyCut', translation: 'FlyCut' }, { term: '字幕', translation: '字幕' }],
      items: [{ id: 'c', text: 'FlyCut 的字幕功能很好用。' }] },
  ];
  for (const batch of batches) {
    const result = await run(batch.targetLang, batch.items, batch.terms);
    const total = result.reduce((sum, item) => {
      const source = batch.items.find(entry => entry.id === item.id)!;
      return sum + batch.terms.filter(term => source.text.includes(term.term)).length;
    }, 0);
    const issues = findTerminologyIssues(result.map(item => ({
      id: item.id, sourceText: batch.items.find(entry => entry.id === item.id)!.text, translatedText: item.text })), batch.terms);
    const followed = total - issues.reduce((sum, issue) => sum + issue.terms.length, 0);
    console.log(`${batch.targetLang}: ${followed}/${total} terms followed`);
    console.log(JSON.stringify(result));
  }
  console.log('F-0032 real terminology acceptance passed');
} finally {
  await ctx.fiber.dispose();
  await rm(home, { recursive: true, force: true });
}
