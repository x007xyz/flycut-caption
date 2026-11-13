import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createHost } from '../../server/app';
import { createEdl } from '../../shared/editing/edl';
import { findTrackForLanguage, languageTrackCounts, projectLanguageTrack, withTranslation } from '../../shared/languageTracks';
import { splitTranslationBatches } from '../../shared/text/translation';

const TOKEN = 'f0031-test-token';

async function startMockOpenAIServer(
  handler: (body: { messages: Array<{ role: string; content: string }> }) => { status?: number; content: string },
) {
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      const reply = handler(body);
      res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: reply.content } }] }));
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

async function setupHost(home?: string) {
  const dir = home ?? (await mkdtemp(join(tmpdir(), 'flycut-f0031-')));
  const ctx = await createHost(
    { home: dir, token: TOKEN, port: 0, resourceRoot: resolve('.'), shellToken: 'shell' },
    { profile: 'desktop', providers: [], aiSettings: { secretBackend: 'memory', privateNetwork: true } },
  );
  const address = ctx.httpServer.address() as { port: number };
  const call = async <T = any>(method: string, payload: unknown = {}): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${address.port}/rpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
    });
    const envelope = await response.json();
    if (!envelope.result.ok) throw new Error(envelope.result.error.message);
    return envelope.result.value;
  };
  const waitJob = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const job = await call('jobs.get', { id });
      if (job.status === 'complete') return job.result;
      if (job.status === 'error' || job.status === 'cancelled') throw new Error(job.error || job.status);
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('Job timeout');
  };
  const upload = async (body: string) =>
    (
      await (
        await fetch(`http://127.0.0.1:${address.port}/assets`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${TOKEN}` },
          body,
        })
      ).json()
    ).assetId as string;

  return { dir, ctx, call, waitJob, upload };
}

test('F-0031/AC-1 AC-4 AC-7 60-minute Chinese transcript translates in batches via Host, maps 100% of IDs, and persists across reopen and second client', async () => {
  const cues = Array.from({ length: 1200 }, (_, i) => {
    const start = i * 3;
    const isEnd = i % 3 === 2;
    return {
      id: `cue-${i + 1}`,
      text: isEnd ? `第${i + 1}段话结束。` : `第${i + 1}段话内容`,
      timestamp: [start, start + 2.8] as [number, number],
    };
  });

  const openai = await startMockOpenAIServer((body) => {
    const parsed = JSON.parse(body.messages[1].content);
    const items = Array.isArray(parsed) ? parsed : parsed.items;
    return {
      content: JSON.stringify(items.map((item: { id: string; text: string }) => ({ id: item.id, text: `EN:${item.text}` }))),
    };
  });

  const host = await setupHost();
  try {
    const identity = await host.call('projects.identity');
    const savedAi = await host.call('aiSettings.save', {
      hostId: identity.hostId,
      expectedRevision: 0,
      config: { name: 'Local Mock LLM', baseUrl: openai.url, model: 'mock-gpt', apiKey: 'sk-test-123' },
    });
    assert.equal(savedAi.status, 'saved');

    const created = await host.call('projects.create', {
      name: '60分钟口播',
      videoName: 'talk60.mp4',
      durationSeconds: 3600,
      media: { assetId: await host.upload('video'), mimeType: 'video/mp4' },
    });
    await host.call('projects.saveTranscript', {
      projectId: created.projectId,
      videoId: created.videoId,
      transcript: { text: cues.map((c) => c.text).join(' '), language: 'zh', duration: 3600, chunks: cues },
    });

    const batches = splitTranslationBatches(cues);
    assert.ok(batches.length > 40, `expected >40 batches for 1200 cues, got ${batches.length}`);
    assert.ok(batches.every((batch) => batch.semanticGroups.every((g) => g.itemIds.length === 3)));

    const translatedUpdates: Array<{ id: string; text: string }> = [];
    for (const batch of batches) {
      const job = await host.call('text.start', {
        mode: 'translation',
        configId: savedAi.configId,
        sourceLang: 'zh',
        targetLang: 'en',
        items: batch.items,
        semanticGroups: batch.semanticGroups,
        contextBefore: batch.contextBefore,
        contextAfter: batch.contextAfter,
      });
      const result = (await host.waitJob(job.id)) as Array<{ id: string; text: string }>;
      translatedUpdates.push(...result);
    }

    assert.equal(translatedUpdates.length, 1200);
    assert.equal(openai.requests.length, batches.length);

    let track = { id: 'track-en', name: 'English', languageCode: 'en', origin: 'manual' as const, entries: {} };
    for (const update of translatedUpdates) {
      const source = cues.find((c) => c.id === update.id)!;
      track = withTranslation(track, source, update.text);
    }
    const projected = projectLanguageTrack(cues, [track], track.id);
    const saveRes = await host.call('projects.saveVideoEdits', {
      projectId: created.projectId,
      videoId: created.videoId,
      baseRevision: 0,
      styleSource: 'project',
      edits: {
        chunks: projected,
        deletedWordIds: [],
        editing: { edl: createEdl(3600), history: [] },
        languageTracks: [track],
        activeLanguageTrackId: track.id,
      },
    });
    assert.equal(saveRes.status, 'saved');

    // Reopen and simulate a second client reading the same Host
    const reopened = await host.call('projects.open', { projectId: created.projectId, videoId: created.videoId });
    assert.equal(reopened.status, 'ok');
    const reopenedTrack = findTrackForLanguage(reopened.edits.languageTracks, 'en');
    assert.ok(reopenedTrack);
    assert.equal(Object.keys(reopenedTrack.entries).length, 1200);
    assert.equal(reopenedTrack.entries['cue-1200'].text, 'EN:第1200段话结束。');
    assert.equal(reopened.edits.chunks[1199].secondText, 'EN:第1200段话结束。');
    assert.deepEqual(languageTrackCounts(reopenedTrack, reopened.edits.chunks), { translated: 1200, outdated: 0 });
  } finally {
    await openai.close();
    await host.ctx.fiber.dispose();
    await rm(host.dir, { recursive: true, force: true });
  }
});

test('F-0031/AC-2 text.start rejects missing or empty translations from upstream LLM without source fallback', async () => {
  const openai = await startMockOpenAIServer(() => ({
    content: JSON.stringify([{ id: 'c1', text: 'Hello' }]), // missing c2
  }));
  const host = await setupHost();
  try {
    const identity = await host.call('projects.identity');
    const savedAi = await host.call('aiSettings.save', {
      hostId: identity.hostId,
      expectedRevision: 0,
      config: { name: 'Bad LLM', baseUrl: openai.url, model: 'mock-gpt', apiKey: 'sk-test-123' },
    });
    const job = await host.call('text.start', {
      mode: 'translation',
      configId: savedAi.configId,
      targetLang: 'en',
      items: [{ id: 'c1', text: '你好' }, { id: 'c2', text: '世界' }],
    });
    await assert.rejects(host.waitJob(job.id), /翻译结果无效（Invalid translation result）：缺少 1 条（id: c2）/);
  } finally {
    await openai.close();
    await host.ctx.fiber.dispose();
    await rm(host.dir, { recursive: true, force: true });
  }
});

test('F-0031/AC-4 AC-7 AC-8 selective outdated translation updates only chosen IDs and persistence verifies uncertain writes', async () => {
  const { createHistoryStore } = await import('../../src/stores/historyStore.ts');
  const { applyLanguageTranslationsWithPersistence } = await import('../../src/services/translationPersistence.ts');

  const store = createHistoryStore();
  store.getState().setTranscript(
    {
      text: '你好 世界 再见',
      language: 'zh',
      duration: 6,
      chunks: [
        { id: 's1', text: '你好呀', timestamp: [0, 2] },
        { id: 's2', text: '新世界', timestamp: [2, 4] },
        { id: 's3', text: '再见', timestamp: [4, 6] },
      ],
    },
    [{
      id: 'track-en',
      name: 'English',
      languageCode: 'en',
      origin: 'manual',
      entries: {
        s1: { text: 'Hello', sourceText: '你好', updatedAt: '2026-11-12T00:00:00Z' },
        s2: { text: 'World', sourceText: '世界', updatedAt: '2026-11-12T00:00:00Z' },
        s3: { text: 'Goodbye', sourceText: '再见', updatedAt: '2026-11-12T00:00:00Z' },
      },
    }],
    'track-en',
  );

  let verifiedCalled = 0;
  let flushOk = false;
  let verifyOk = true;
  const projectState = {
    current: { projectId: 'p1', videoId: 'v1' },
    save: { status: 'failed' as string, error: 'timeout' as string | undefined },
  };
  const fakeCtx = {
    stores: {
      history: store,
      project: { getState: () => projectState },
    },
    projects: {
      flush: async () => flushOk,
      verifyCurrentEditsSaved: async () => {
        verifiedCalled += 1;
        return verifyOk;
      },
    },
  } as any;

  // 1. Uncertain flush where verifyCurrentEditsSaved confirms Host actually saved -> succeeds without duplicate write
  const verifiedResult = await applyLanguageTranslationsWithPersistence(fakeCtx, {
    trackId: 'track-en',
    languageCode: 'en',
    name: 'English',
    updates: [{ id: 's1', text: 'Hi there!', expectedSource: '你好呀' }],
  });
  assert.equal(verifiedResult.ok, true);
  assert.equal(verifiedCalled, 1);
  assert.equal(store.getState().languageTracks[0].entries.s1.text, 'Hi there!');
  assert.equal(store.getState().languageTracks[0].entries.s2.text, 'World'); // untouched outdated cue preserved
  assert.equal(store.getState().languageTracks[0].entries.s2.sourceText, '世界');

  // 2. Real save failure -> rolls back formal store to prior state
  verifyOk = false;
  const failedResult = await applyLanguageTranslationsWithPersistence(fakeCtx, {
    trackId: 'track-en',
    languageCode: 'en',
    name: 'English',
    updates: [{ id: 's2', text: 'New World', expectedSource: '新世界' }],
  });
  assert.equal(failedResult.ok, false);
  assert.equal(failedResult.error, 'apply-failed');
  assert.equal(store.getState().languageTracks[0].entries.s2.text, 'World'); // rolled back
});

