import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createHost } from '../../server/app';
import { analyzeFillers, type FillerSentence, type FillerWord } from '../../shared/editing/fillerRules';
import { createEdl, changeCuts, fromUs } from '../../shared/editing/edl';
import { populateSuggestionTexts } from '../../shared/editing/suggestions';
import type { PendingProjectSuggestion, ProjectSuggestResult } from '../../shared/projectOps';
import type { JobSnapshot } from '../../shared/protocol';

const DEMO_MP4 = resolve('tests/media/clips/silence/zh-podcast-3min.mp4');
const FALLBACK_MP4 = resolve('src/assets/demo.mp4');

async function bootHost() {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0043-host-'));
  const token = 'f0043-test-token';
  const ctx = await createHost({ home, token, port: 0, resourceRoot: resolve('.') }, {
    profile: 'desktop',
    patches: [{ source: 'f0043-test', patch: { config: { 'ai-settings': { secretBackend: 'memory' } } } }],
  });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async <T = any>(method: string, payload: unknown = {}): Promise<T> => {
    const response = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
    });
    const envelope = await response.json() as any;
    if (!envelope.result.ok) {
      const err = new Error(envelope.result.error.message) as Error & { code?: string };
      err.code = envelope.result.error.code;
      throw err;
    }
    return envelope.result.value;
  };
  const waitJob = async (id: string) => {
    for (let i = 0; i < 300; i++) {
      const job = await call<JobSnapshot>('jobs.get', { id });
      if (['complete', 'error', 'cancelled'].includes(job.status)) return job;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error(`Job ${id} timed out`);
  };
  const upload = async (bytes: Buffer) => {
    const response = await fetch(`${base}/assets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: new Uint8Array(bytes),
    });
    assert.equal(response.status, 201);
    return ((await response.json()) as { assetId: string }).assetId;
  };
  return { home, ctx, base, call, waitJob, upload };
}

test('F-0043/AC-1 AC-2 AC-3 AC-4 registers VAD and rule-filler Agent tools matching UI output, blocks silent apply, guards stale/cancel, and completes confirm->export->undo on real talking-head media', async () => {
  const samplePath = existsSync(DEMO_MP4) ? DEMO_MP4 : FALLBACK_MP4;
  assert.equal(existsSync(samplePath), true, 'Expected demo media fixture');
  const mediaBytes = await readFile(samplePath);

  const host = await bootHost();
  try {
    const toolsList = await host.call<Array<{ name: string; description: string }>>('agent.tools');
    const silenceTool = host.ctx.agentTools.list().find((t) => t.name === 'suggest_silence_cuts');
    const fillerTool = host.ctx.agentTools.list().find((t) => t.name === 'suggest_filler_cuts');
    assert.ok(toolsList.some((t) => t.name === 'suggest_silence_cuts'));
    assert.ok(toolsList.some((t) => t.name === 'suggest_filler_cuts'));
    assert.ok(silenceTool && fillerTool);

    // AC-2: strict schema forbids any silent apply parameter
    assert.throws(() => silenceTool.schema.parse({ projectId: randomUUID(), apply: true }));
    assert.throws(() => fillerTool.schema.parse({ projectId: randomUUID(), autoApply: true }));

    const assetId = await host.upload(mediaBytes);
    const mediaProbe = await host.ctx.export.probeFile(samplePath);
    const realDuration = mediaProbe.duration ?? 10;
    const created = await host.call<{ projectId: string; videoId: string }>('projects.create', {
      name: 'Agent 工具真实口播测试',
      videoName: 'talk.mp4',
      durationSeconds: realDuration,
      media: { assetId, mimeType: 'video/mp4' },
    });

    // 1. Transcript WITHOUT reliable word timestamps -> filler tool rejects cleanly, VAD tool warns sentenceLevelOnly
    await host.call('projects.saveTranscript', {
      projectId: created.projectId,
      videoId: created.videoId,
      transcript: {
        text: '嗯 今天我们讲一下口播剪辑',
        chunks: [{ id: 's1', text: '嗯 今天我们讲一下口播剪辑', timestamp: [0, 8] }],
        hasWordTimestamps: false,
        language: 'zh',
        duration: realDuration,
      },
    });
    await assert.rejects(
      () => fillerTool.invoke(fillerTool.schema.parse({ projectId: created.projectId, videoId: created.videoId }), {
        jobId: 'j1', input: { prompt: 'fillers' }, signal: new AbortController().signal, report: () => undefined,
      }),
      /字词级去口癖条件/,
    );
    const silenceNoWords = JSON.parse(await silenceTool.invoke(silenceTool.schema.parse({
      projectId: created.projectId, videoId: created.videoId, silenceMethod: 'vad',
    }), {
      jobId: 'j2', input: { prompt: 'silence' }, signal: new AbortController().signal, report: () => undefined,
    })) as ProjectSuggestResult;
    assert.equal(silenceNoWords.sentenceLevelOnly, true);
    assert.ok((silenceNoWords.warnings?.length ?? 0) > 0);
    assert.ok(silenceNoWords.batch.items.length > 0, 'Expected real FSMN-VAD silence candidates on talking-head media');

    // Cancelled tool run writes nothing
    const cancelledController = new AbortController();
    cancelledController.abort(new Error('Job cancelled'));
    await assert.rejects(
      () => silenceTool.invoke(silenceTool.schema.parse({
        projectId: created.projectId, videoId: created.videoId, silenceMethod: 'vad',
      }), { jobId: 'j-cancel', input: { prompt: 'cancel' }, signal: cancelledController.signal, report: () => undefined }),
    );

    // 2. Now save transcript WITH reliable word timestamps including filler words
    const chunks: FillerSentence[] = [
      { id: 's1', text: '嗯 今天我们讲一下那个那个剪辑', timestamp: [0, 6], wordIds: ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'] },
    ];
    const words: FillerWord[] = [
      { id: 'w1', text: '嗯', timestamp: [0.1, 0.45], sentenceId: 's1' },
      { id: 'w2', text: '今天', timestamp: [0.6, 1.1], sentenceId: 's1' },
      { id: 'w3', text: '我们', timestamp: [1.15, 1.6], sentenceId: 's1' },
      { id: 'w4', text: '讲一下', timestamp: [1.65, 2.2], sentenceId: 's1' },
      { id: 'w5', text: '那个', timestamp: [2.25, 2.6], sentenceId: 's1' },
      { id: 'w6', text: '那个', timestamp: [2.65, 3.0], sentenceId: 's1' },
      { id: 'w7', text: '剪辑', timestamp: [3.1, 3.8], sentenceId: 's1' },
    ];
    await host.call('projects.saveTranscript', {
      projectId: created.projectId,
      videoId: created.videoId,
      transcript: {
        text: '嗯 今天我们讲一下那个那个剪辑',
        chunks,
        wordChunks: words,
        hasWordTimestamps: true,
        language: 'zh',
        duration: realDuration,
      },
    });

    // Compare direct UI analyzer output against suggest_filler_cuts Agent tool & projects.suggestEdits RPC
    const uiAnalyzed = analyzeFillers({
      chunks,
      wordChunks: words,
      hasWordTimestamps: true,
      sourceDuration: realDuration,
      existingDeleted: [],
    });
    const uiExpectedItems = populateSuggestionTexts(
      uiAnalyzed.candidates.map((c) => ({
        id: c.id, start: c.start, end: c.end, reason: c.reason, category: c.category, label: c.label,
        confidence: c.confidence, selected: c.defaultSelected, source: 'rule' as const, sources: ['rule' as const],
      })),
      chunks,
      words,
    );
    assert.ok(uiExpectedItems.length >= 2);

    const fillerOpId = randomUUID();
    const toolRes = JSON.parse(await fillerTool.invoke(fillerTool.schema.parse({
      projectId: created.projectId, videoId: created.videoId, expectedRevision: 0, operationId: fillerOpId,
    }), {
      jobId: 'j3', input: { prompt: 'fillers' }, signal: new AbortController().signal, report: () => undefined,
    })) as ProjectSuggestResult;
    assert.equal(toolRes.status, 'pending');
    assert.deepEqual(toolRes.batch.items, uiExpectedItems);
    assert.ok(toolRes.batch.items.every((item) => typeof item.text === 'string' && item.text.length > 0));

    // Duplicate / idempotent call does not accumulate duplicate pending suggestions
    const retryToolRes = JSON.parse(await fillerTool.invoke(fillerTool.schema.parse({
      projectId: created.projectId, videoId: created.videoId, expectedRevision: 0, operationId: fillerOpId,
    }), {
      jobId: 'j4', input: { prompt: 'fillers' }, signal: new AbortController().signal, report: () => undefined,
    })) as ProjectSuggestResult;
    assert.equal(retryToolRes.suggestionId, toolRes.suggestionId);

    const pendingList = await host.call<PendingProjectSuggestion[]>('projects.suggestions.list', {
      projectId: created.projectId, videoId: created.videoId,
    });
    const fillerPending = pendingList.filter((p) => p.batch.kind === 'filler');
    assert.equal(fillerPending.length, 1);

    // AC-2: formal EDL and formal export remain untouched before user confirmation
    const openedBefore = await host.call<any>('projects.open', { projectId: created.projectId, videoId: created.videoId });
    assert.equal(openedBefore.edits, undefined);

    // Stale expectedRevision fails with VERSION_CONFLICT
    await assert.rejects(
      () => fillerTool.invoke(fillerTool.schema.parse({
        projectId: created.projectId, videoId: created.videoId, expectedRevision: 99,
      }), { jobId: 'j-stale', input: { prompt: 'stale' }, signal: new AbortController().signal, report: () => undefined }),
      (err: unknown) => (err as { code?: string })?.code === 'VERSION_CONFLICT',
    );

    // AC-4: Confirm pending suggestion -> saveVideoEdits -> dismiss suggestion -> real MP4 export -> undo restore
    const initialEdl = createEdl(realDuration, []);
    const cutRanges = toolRes.batch.items.filter((i) => i.selected).map((i) => ({ start: i.start, end: i.end }));
    const appliedEdl = changeCuts(initialEdl, cutRanges, true);
    const savedEdits = await host.call<any>('projects.saveVideoEdits', {
      projectId: created.projectId,
      videoId: created.videoId,
      styleSource: 'project',
      baseRevision: 0,
      edits: {
        chunks,
        deletedWordIds: ['w1', 'w5'],
        editing: {
          edl: appliedEdl,
          history: [{ id: 'cut-1', at: new Date().toISOString(), kind: 'filler', edl: appliedEdl, deletedIds: [], deletedWordIds: ['w1', 'w5'] }],
        },
      },
    });
    assert.equal(savedEdits.status, 'saved');
    await host.call('projects.suggestions.dismiss', {
      projectId: created.projectId, videoId: created.videoId, suggestionId: toolRes.suggestionId,
    });

    const exportJob = await host.call<JobSnapshot>('projects.export', {
      projectId: created.projectId, videoId: created.videoId, format: 'mp4', subtitleProcessing: 'none',
    });
    const exportDone = await host.waitJob(exportJob.id);
    assert.equal(exportDone.status, 'complete', exportDone.error);
    const exportedAsset = (exportDone.result as { assetId: string }).assetId;
    const probe = await host.ctx.export.probeFile(host.ctx.assets.path(exportedAsset));
    const expectedCutSecs = cutRanges.reduce((acc, r) => acc + (r.end - r.start), 0);
    assert.ok(probe.duration && probe.duration < realDuration - expectedCutSecs + 0.5, `Expected shortened export from ${realDuration}, got ${probe.duration}`);

    // Undo back to initial EDL
    const undone = await host.call<any>('projects.saveVideoEdits', {
      projectId: created.projectId,
      videoId: created.videoId,
      styleSource: 'project',
      baseRevision: savedEdits.revision,
      edits: {
        chunks,
        deletedWordIds: [],
        editing: { edl: initialEdl, history: [] },
      },
    });
    assert.equal(undone.status, 'saved');
    const reopened = await host.call<any>('projects.open', { projectId: created.projectId, videoId: created.videoId });
    assert.equal(reopened.edits.editing.edl.deleted.length, 0);
    assert.ok(Math.abs(fromUs(reopened.edits.editing.edl.sourceDurationUs) - realDuration) < 0.01);
  } finally {
    await host.ctx.fiber.dispose();
    await rm(host.home, { recursive: true, force: true });
  }
});
