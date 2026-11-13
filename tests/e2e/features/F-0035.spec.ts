/* eslint-disable @typescript-eslint/no-explicit-any -- mock Host payloads mirror JSON RPC shapes. */
import { expect, test, type Page } from '@playwright/test';
import { shot } from '../lib/evidence';
import { E2E_HOST_ID, MOCK_HOST, mockHost, pending, prepare, projectItem, RpcError, uuid, VIDEO_ID, type MockHandlers } from '../lib/mockHost';

const P = uuid(350);
const T = '2026-11-13T10:00:00.000Z';

function makeWavBuffer(durationSeconds = 0.5, sampleRate = 16000): Buffer {
  const numSamples = Math.max(1, Math.round(durationSeconds * sampleRate));
  const dataBytes = numSamples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

const PAID_AND_REMOTE_MODELS = [
  {
    provider: { id: 'flycut-cloud', name: 'FlyCut Cloud', kind: 'builtin' },
    models: [
      {
        id: 'cloud-tts',
        name: 'Cloud TTS',
        role: 'tts',
        languages: ['en', 'zh'],
        status: 'ready',
        offline: false,
        tts: {
          voices: [{ id: 'cloud_aria', name: 'Aria', languages: ['en'] }],
          voiceCloning: false,
          durationControl: true,
          outputFormats: ['wav'],
        },
      },
    ],
  },
  {
    provider: { id: 'flycut:tts-box', name: 'Remote TTS Box', kind: 'endpoint' },
    models: [
      {
        id: 'kokoro-v1',
        name: 'Kokoro v1.0',
        role: 'tts',
        languages: ['en', 'zh'],
        status: 'ready',
        offline: false,
        tts: {
          voices: [
            { id: 'af_heart', name: 'Heart', languages: ['en'], gender: 'female' },
            { id: 'zf_xiaobei', name: 'Xiaobei', languages: ['zh'], gender: 'female' },
          ],
          voiceCloning: false,
          durationControl: true,
          streaming: false,
          outputFormats: ['wav'],
        },
      },
    ],
  },
];

async function setupDubbingHost(
  page: Page,
  options: { models?: any[]; withTranslations?: boolean } = {},
) {
  const chunks = [
    { id: 'c1', text: '大家好，欢迎来到本期节目', timestamp: [0, 1.5] as [number, number] },
    { id: 'c2', text: '今天我们来聊配音工作流', timestamp: [1.5, 4.5] as [number, number] },
  ];
  let tracks = options.withTranslations === false ? [] : [
    {
      id: 'track-en',
      name: 'English',
      languageCode: 'en',
      origin: 'manual' as const,
      entries: {
        c1: { text: 'Hello everyone, welcome to the show today!', sourceText: chunks[0].text, updatedAt: T },
        c2: { text: 'Today we talk about dubbing workflow.', sourceText: chunks[1].text, updatedAt: T },
      },
    },
  ];
  let dubbings: any[] = [];
  let videoRevision = 4;
  let projectRevision = 9;
  let modelGroups = options.models ?? PAID_AND_REMOTE_MODELS;
  let dubMode: 'ok' | 'slow' | 'fail' | 'uncertain-applied' | 'conflict' = 'ok';
  let durationOverride: number | undefined;
  let jobSeq = 0;
  let dubSeq = 0;
  const jobs = new Map<string, any>();
  const wavBytes = makeWavBuffer(0.6, 16000);

  const currentEdits = () => ({
    chunks,
    deletedWordIds: [],
    languageTracks: tracks,
    activeLanguageTrackId: tracks[0]?.id ?? null,
    dubbings,
  });

  const handlers: MockHandlers = {
    'projects.list': () => [projectItem(P, 'Dubbing Demo')],
    'providers.models': () => modelGroups,
    'tts.getSettings': () => ({
      hostId: E2E_HOST_ID,
      revision: 0,
      selectedModel: null,
      voiceId: null,
      language: 'auto',
      speed: 1,
      options: {},
      lastAudition: null,
    }),
    'projects.open': () => ({
      status: 'ok',
      project: { id: P, name: 'Dubbing Demo', formatVersion: 4, revision: projectRevision, styleRevision: 0, videos: [], createdAt: T, updatedAt: T },
      video: {
        id: VIDEO_ID,
        name: 'talk.mp4',
        durationSeconds: 6,
        revision: videoRevision,
        styleSource: 'project',
        hasTranscript: true,
        createdAt: T,
        media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1, mimeType: 'video/mp4' },
      },
      videos: [],
      transcript: { text: chunks.map(c => c.text).join(' '), language: 'zh', duration: 6, hasWordTimestamps: false, chunks },
      edits: tracks.length || dubbings.length ? currentEdits() : { chunks, deletedWordIds: [] },
      media: { status: 'missing', name: 'talk.mp4' },
    }),
    'projects.saveVideoEdits': (input: any) => {
      if (input.baseRevision !== videoRevision && !input.force) {
        return { status: 'conflict', revision: videoRevision, updatedAt: T };
      }
      tracks = structuredClone(input.edits.languageTracks ?? []);
      dubbings = structuredClone(input.edits.dubbings ?? dubbings);
      videoRevision += 1;
      projectRevision += 1;
      return { status: 'saved', revision: videoRevision, projectRevision, updatedAt: T };
    },
    'projects.saveProjectStyle': () => ({ status: 'saved', revision: 1, projectRevision, updatedAt: T }),
    'dubbing.synthesizeCue': (payload: any) => {
      const id = uuid(3600 + (++jobSeq));
      if (dubMode === 'fail') {
        jobs.set(id, { id, operationId: payload.operationId, status: 'error', error: 'TTS 鉴权失败（HTTP 401），请检查 API Key', createdAt: T, updatedAt: T });
        return jobs.get(id);
      }
      if (dubMode === 'slow') {
        jobs.set(id, { id, operationId: payload.operationId, status: 'running', progress: { status: 'running', purpose: 'synthesize', progress: 45, data: 'Synthesizing…' }, createdAt: T, updatedAt: T });
        return jobs.get(id);
      }
      if (dubMode === 'conflict') {
        dubMode = 'ok';
        videoRevision += 1;
        projectRevision += 1;
        tracks = tracks.map(t => t.id === payload.trackId ? {
          ...t,
          entries: {
            ...t.entries,
            [payload.chunkId]: { text: 'Host updated translation', sourceText: chunks[1].text, updatedAt: T },
          },
        } : t);
        const conflictRes = { status: 'conflict', reason: 'revision-mismatch', videoRevision, projectRevision, updatedAt: T };
        jobs.set(id, { id, operationId: payload.operationId, status: 'complete', result: conflictRes, createdAt: T, updatedAt: T });
        return jobs.get(id);
      }
      const dubId = uuid(3700 + (++dubSeq));
      const cue = chunks.find(c => c.id === payload.chunkId)!;
      const cueDur = cue.timestamp[1] - cue.timestamp[0];
      const dur = durationOverride ?? (payload.chunkId === 'c1' ? 2.4 : 1.4);
      const artifact = {
        id: dubId,
        trackId: payload.trackId,
        chunkId: payload.chunkId,
        file: `dubbing/${dubId}.wav`,
        mimeType: 'audio/wav',
        format: 'wav',
        byteLength: wavBytes.byteLength,
        durationSeconds: dur,
        sampleRate: 16000,
        cueDurationSeconds: cueDur,
        text: payload.expectedText,
        model: { providerId: payload.request.providerId, modelId: payload.request.modelId },
        voiceId: payload.request.voiceId,
        language: payload.request.language,
        speed: payload.request.speed,
        operationId: payload.operationId,
        createdAt: T,
      };
      dubbings = [...dubbings.filter(d => !(d.trackId === artifact.trackId && d.chunkId === artifact.chunkId)), artifact];
      videoRevision += 1;
      projectRevision += 1;
      const savedRes = { status: 'saved', artifact, videoRevision, projectRevision, updatedAt: T };
      jobs.set(id, { id, operationId: payload.operationId, status: 'complete', result: savedRes, createdAt: T, updatedAt: T });
      if (dubMode === 'uncertain-applied') {
        dubMode = 'ok';
        throw new Error('simulated network drop after commit');
      }
      return jobs.get(id);
    },
    'jobs.list': () => [...jobs.values()],
    'jobs.get': ({ id }) => {
      const job = jobs.get(id);
      if (!job) throw new RpcError('Unknown job');
      return job;
    },
    'jobs.cancel': ({ id }) => {
      const job = jobs.get(id);
      if (job) job.status = 'cancelled';
      return job ?? { id, status: 'cancelled' };
    },
  };

  const host = await mockHost(page, handlers);
  await page.route(`${MOCK_HOST}/projects/${P}/videos/${VIDEO_ID}/dubbing/*`, route =>
    route.fulfill({ status: 200, contentType: 'audio/wav', body: wavBytes }),
  );

  return {
    host,
    setModels: (next: any[]) => { modelGroups = next; },
    setDubMode: (next: typeof dubMode) => { dubMode = next; },
    setDurationOverride: (next: number | undefined) => { durationOverride = next; },
  };
}

async function setEnglish(page: Page, english: boolean) {
  if (!english) return;
  const trigger = page.getByRole('button', { name: /选择语言|Select Language/ });
  await expect(trigger).toBeVisible();
  if ((await trigger.textContent())?.includes('English')) return;
  await trigger.click();
  await page.getByRole('menuitem', { name: /English/ }).click();
}

async function openEditor(page: Page, theme: 'light' | 'dark', lang: 'zh' | 'en') {
  await prepare(page, theme);
  await page.goto(`/?ui=${lang}#/projects/${P}/videos/${VIDEO_ID}`);
  await setEnglish(page, lang === 'en');
}

for (const theme of ['light', 'dark'] as const) for (const lang of ['zh', 'en'] as const) {
  test.describe(`F-0035 ${theme}-${lang}`, () => {
    test('F-0035/AC-5 AC-6 empty models, empty translation, configure redirect, and loading indicator', async ({ page }) => {
      const state = await setupDubbingHost(page, { models: [], withTranslations: false });
      await openEditor(page, theme, lang);

      await page.getByTestId('cue-dubbing-open').click();
      const panel = page.getByTestId('cue-dubbing-panel');
      await expect(panel.getByTestId('cue-dubbing-empty-models')).toContainText(lang === 'zh' ? '暂无内容' : 'Nothing here yet');
      // Existing subtitle editing remains usable
      await expect(page.getByTestId('subtitle-main-text').first()).toBeEditable();
      await shot(page, 'F-0035', `dub-empty-models-${theme}-${lang}`);

      // Configure models button opens SettingsDialog
      await panel.getByTestId('cue-dubbing-configure-models').click();
      await expect(page.getByTestId('settings-tab-models')).toBeVisible();
      await page.keyboard.press('Escape');

      // Close, switch models in, verify missing confirmed translation empty state
      await panel.getByTestId('cue-dubbing-close').click();
      state.setModels(PAID_AND_REMOTE_MODELS);
      await page.evaluate(() => window.dispatchEvent(new Event('flycut-provider-models-changed')));
      await page.getByTestId('cue-dubbing-open').click();
      await expect(panel.getByTestId('cue-dubbing-empty-translation')).toContainText(lang === 'zh' ? '暂无内容' : 'Nothing here yet');
      await shot(page, 'F-0035', `dub-empty-translation-${theme}-${lang}`);

      // Loading state while tts.getSettings is pending
      await panel.getByTestId('cue-dubbing-close').click();
      state.host.set('tts.getSettings', () => pending());
      await page.getByTestId('cue-dubbing-open').click();
      await expect(panel.getByTestId('cue-dub-loading')).toContainText(lang === 'zh' ? '正在加载…' : 'Loading…');
      await shot(page, 'F-0035', `dub-loading-${theme}-${lang}`);
    });

    test('F-0035/AC-1 AC-2 AC-3 AC-6 AC-7 AC-8 full dubbing lifecycle', async ({ page }) => {
      const state = await setupDubbingHost(page);
      await openEditor(page, theme, lang);

      // Open Cue 1 via row action button
      const rows = page.locator('[data-chunk-id]');
      await rows.nth(0).getByTestId('cue-dub-button').click();
      const panel = page.getByTestId('cue-dubbing-panel');

      // AC-1: paid cloud and non-offline remote models are NOT auto-selected
      await expect(panel.getByTestId('cue-dub-model-select')).toHaveValue('');
      await expect(panel.getByTestId('cue-dub-no-auto-paid-hint')).toBeVisible();
      await expect(panel.getByTestId('cue-dub-submit')).toBeDisabled();

      // Select model manually -> pre-send disclosure preview is displayed
      await panel.getByTestId('cue-dub-model-select').selectOption('flycut:tts-box/kokoro-v1');
      await expect(panel.getByTestId('cue-dubbing-preview')).toContainText('Hello everyone, welcome to the show today!');
      await expect(panel.getByTestId('cue-dubbing-preview')).toContainText('Remote TTS Box / Kokoro v1.0');
      await expect(panel.getByTestId('cue-dubbing-preview')).toContainText(lang === 'zh' ? '无（仅使用自带音色）' : 'None (built-in voice only)');
      await expect(panel.getByTestId('cue-dub-submit')).toBeEnabled();
      await shot(page, 'F-0035', `dub-preview-${theme}-${lang}`);

      // AC-2 AC-7: generate Cue 1 (2.40s > 1.50s cue) -> Completed + tooLong without truncating/shifting
      await panel.getByTestId('cue-dub-submit').click();
      await expect(panel.getByTestId('cue-dub-completed')).toContainText(lang === 'zh' ? '已完成' : 'Completed');
      await expect(panel.getByTestId('cue-dub-duration')).toContainText('2.40s / 1.50s');
      await expect(panel.getByTestId('cue-dub-too-long')).toContainText(lang === 'zh' ? '配音过长' : 'Dubbing is too long');
      await expect(panel.getByTestId('cue-dub-audio')).toHaveAttribute('src', /^blob:/);
      await expect(rows.nth(0).getByTestId('cue-dub-row-status')).toContainText(lang === 'zh' ? '配音过长' : 'Dubbing is too long');

      // Play & stop toggle
      await panel.getByTestId('cue-dub-play').click();
      await expect(panel.getByTestId('cue-dub-stop')).toBeVisible();
      await panel.getByTestId('cue-dub-stop').click();
      await expect(panel.getByTestId('cue-dub-play')).toBeVisible();
      await shot(page, 'F-0035', `dub-completed-toolong-${theme}-${lang}`);

      // AC-3: change voice -> outdated; change back -> fresh; edit translation -> outdated -> redo updates
      await panel.getByTestId('cue-dub-voice-select').selectOption('zf_xiaobei');
      await expect(panel.getByTestId('cue-dub-outdated')).toContainText(lang === 'zh' ? '配音已过期' : 'Dubbing is outdated');
      await expect(rows.nth(0).getByTestId('cue-dub-row-outdated')).toBeVisible();
      await panel.getByTestId('cue-dub-voice-select').selectOption('af_heart');
      await expect(panel.getByTestId('cue-dub-outdated')).toHaveCount(0);

      const secondTextarea = rows.nth(0).getByTestId('subtitle-secondary-text');
      await secondTextarea.fill('Hello everyone, short cue!');
      await secondTextarea.blur();
      await expect(panel.getByTestId('cue-dub-outdated')).toContainText(lang === 'zh' ? '配音已过期' : 'Dubbing is outdated');
      await shot(page, 'F-0035', `dub-outdated-${theme}-${lang}`);

      state.setDurationOverride(1.1);
      await panel.getByTestId('cue-dub-redo').click();
      await expect(panel.getByTestId('cue-dub-completed')).toContainText(lang === 'zh' ? '已完成' : 'Completed');
      await expect(panel.getByTestId('cue-dub-outdated')).toHaveCount(0);
      await expect(panel.getByTestId('cue-dub-too-long')).toHaveCount(0);
      state.setDurationOverride(undefined);

      // AC-6: slow processing shows Processing + Cancel; switching cues isolates in-flight response
      await rows.nth(1).getByTestId('cue-dub-button').click();
      state.setDubMode('slow');
      await panel.getByTestId('cue-dub-submit').click();
      await expect(panel.getByTestId('cue-dub-processing')).toContainText(lang === 'zh' ? '正在处理…' : 'Processing…');
      await expect(panel.getByTestId('cue-dub-submit')).toBeDisabled();
      await shot(page, 'F-0035', `dub-processing-${theme}-${lang}`);
      await panel.getByTestId('cue-dub-cancel').click();
      await expect(panel.getByTestId('cue-dub-processing')).toHaveCount(0);
      expect(state.host.calls.some(c => c.method === 'jobs.cancel')).toBe(true);

      // Switching cue while slow request is running cancels/ignores late response
      await panel.getByTestId('cue-dub-submit').click();
      await expect(panel.getByTestId('cue-dub-processing')).toBeVisible();
      await rows.nth(0).getByTestId('cue-dub-button').click();
      await expect(panel.getByTestId('cue-dub-processing')).toHaveCount(0);
      await expect(panel.getByTestId('cue-dubbing-preview')).toContainText('Hello everyone, short cue!');

      // AC-8: error retains input, supports Back, and uncertain network drop queries Host before resending
      await rows.nth(1).getByTestId('cue-dub-button').click();
      state.setDubMode('fail');
      await panel.getByTestId('cue-dub-submit').click();
      await expect(panel.getByTestId('cue-dub-error')).toContainText('HTTP 401');
      await shot(page, 'F-0035', `dub-error-${theme}-${lang}`);
      await panel.getByTestId('cue-dub-back').click();
      await expect(panel.getByTestId('cue-dub-error')).toHaveCount(0);

      state.setDubMode('uncertain-applied');
      await panel.getByTestId('cue-dub-submit').click();
      await expect(panel.getByTestId('cue-dub-error')).toBeVisible();
      const synthBeforeRetry = state.host.calls.filter(c => c.method === 'dubbing.synthesizeCue').length;
      const jobsListBeforeRetry = state.host.calls.filter(c => c.method === 'jobs.list').length;
      await panel.getByTestId('cue-dub-retry').click();
      await expect(panel.getByTestId('cue-dub-completed')).toContainText(lang === 'zh' ? '已完成' : 'Completed');
      expect(state.host.calls.filter(c => c.method === 'jobs.list').length).toBeGreaterThan(jobsListBeforeRetry);
      expect(state.host.calls.filter(c => c.method === 'dubbing.synthesizeCue').length).toBe(synthBeforeRetry);

      // AC-8: conflict blocks submit until Review latest pulls updated translation
      state.setDubMode('conflict');
      await panel.getByTestId('cue-dub-redo').click();
      await expect(panel.getByTestId('cue-dub-conflict')).toContainText(
        lang === 'zh' ? '内容已更新，请重新检查' : 'Content changed. Review again.',
      );
      await expect(panel.getByTestId('cue-dub-redo')).toBeDisabled();
      await shot(page, 'F-0035', `dub-conflict-${theme}-${lang}`);
      await panel.getByTestId('cue-dub-review-latest').click();
      await expect(panel.getByTestId('cue-dub-conflict')).toHaveCount(0);
      await expect(panel.getByTestId('cue-dubbing-preview')).toContainText('Host updated translation');

      // AC-7: reload restores persisted project dubbing artifacts
      await page.reload();
      await rows.nth(0).getByTestId('cue-dub-button').click();
      await expect(panel.getByTestId('cue-dub-duration')).toContainText('1.10s / 1.50s');
      await expect(panel.getByTestId('cue-dub-audio')).toHaveAttribute('src', /^blob:/);
    });
  });
}
