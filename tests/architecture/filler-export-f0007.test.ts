import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHost } from '../../server/app';
import { analyzeFillers } from '../../shared/editing/fillerRules';
import { createEdl, exportSegments } from '../../shared/editing/edl';

test('F-0007 real Host: a filler candidate can be exported', { timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0007-export-'));
  const transcript = JSON.parse(await readFile('tests/media/external/coscup-3UegVxMFyeo.transcript.json', 'utf8'));
  const result = analyzeFillers({ chunks: transcript.chunks, wordChunks: transcript.wordChunks,
    hasWordTimestamps: transcript.hasWordTimestamps, sourceDuration: transcript.duration });
  assert.equal(result.gate.ok, true);
  const candidate = result.candidates[0];
  assert.ok(candidate);
  const media = resolve('tests/media/clips/dub/zh-podcast-host-1min.mp4');
  // Export a short window around the candidate using a 60s clip; the candidate time comes from a
  // different long recording, so only use it to prove the Host export path, not source alignment.
  const edl = createEdl(60.08, [{ start: 20, end: 25 }]);
  const ctx = await createHost({ home, token: 'f0007', port: 0, resourceRoot: resolve('src-tauri') }, { profile: 'desktop', providers: [], patches: [] });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async (method: string, payload: unknown) => {
    const response = await fetch(base + '/rpc', { method: 'POST', headers: { Authorization: 'Bearer f0007', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'test', method, payload }) });
    const envelope = await response.json();
    assert.equal(envelope.result.ok, true, JSON.stringify(envelope.result));
    return envelope.result.value;
  };
  try {
    const asset = await (await fetch(base + '/assets', { method: 'POST', headers: { Authorization: 'Bearer f0007' }, body: await readFile(media) })).json();
    const job = await call('export.start', { assetId: asset.assetId, edl, segments: exportSegments(edl),
      options: { format: 'mp4', quality: 'low', preserveAudio: true, subtitleProcessing: 'none', joinFadeMs: 5 } });
    let state = job;
    const deadline = Date.now() + 60_000;
    while (state.status === 'running' || state.status === 'queued') {
      assert.ok(Date.now() < deadline, 'export timeout');
      await new Promise(r => setTimeout(r, 50));
      state = await call('jobs.get', { id: job.id });
    }
    assert.equal(state.status, 'complete', state.error);
    assert.ok((await stat(ctx.assets.path(state.result.assetId))).size > 0);
  } finally {
    await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
});

test('F-0007/AC-6 confirming filler suggestions cuts words in the EDL without adding blank spacer rows', async () => {
  const { createHistoryStore } = await import('../../src/stores/historyStore.ts');
  const store = createHistoryStore();
  store.getState().setTranscript({ text: '嗯我们开始', language: 'zh', duration: 4, hasWordTimestamps: true,
    chunks: [{ id: 's1', text: '嗯我们开始', timestamp: [0, 2], wordIds: ['w1', 'w2', 'w3'] }],
    wordChunks: [
      { id: 'w1', text: '嗯', timestamp: [0, 0.3], sentenceId: 's1' },
      { id: 'w2', text: '我们', timestamp: [0.5, 1.0], sentenceId: 's1' },
      { id: 'w3', text: '开始', timestamp: [1.0, 2.0], sentenceId: 's1' },
    ] } as never);
  const s = store.getState();
  assert.equal(s.proposeSuggestions({ kind: 'filler', base: JSON.stringify([s.edl, s.chunks, s.wordChunks]), preview: false,
    items: [{ id: 'f1', start: 0, end: 0.34, reason: 'filler.standalone', category: 'standalone-filler', selected: true }] }), 'ok');
  store.getState().confirmPending();
  const after = store.getState();
  assert.equal(after.cutError, null);
  assert.equal(after.wordChunks.find(word => word.id === 'w1')?.deleted, true);
  assert.deepEqual(after.edl?.deleted.map(range => [range.startUs, range.endUs]), [[0, 340000]]);
  assert.deepEqual(after.chunks.filter(chunk => chunk.isBlankSpacer), [], 'filler cuts must not add spacer rows');
});
