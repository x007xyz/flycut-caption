/* eslint-disable @typescript-eslint/no-explicit-any -- mock Host payloads mirror JSON RPC shapes. */
import { expect, test, type Page } from '@playwright/test';
import { E2E_HOST_ID, MOCK_HOST, mockHost, pending, prepare, RpcError, uuid } from '../lib/mockHost';
import { shot } from '../lib/evidence';

const TTS_ASSET_1 = uuid(5301);
const TTS_ASSET_2 = uuid(5302);

function makeWavBuffer(durationSeconds = 0.25, sampleRate = 16000): Buffer {
  const numSamples = Math.round(durationSeconds * sampleRate);
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

const SAMPLE_MODELS = [
  {
    provider: { id: 'flycut:tts-box', name: 'Local TTS Box', kind: 'endpoint' },
    models: [
      {
        id: 'kokoro-v1',
        name: 'Kokoro v1.0',
        role: 'tts',
        languages: ['zh', 'en'],
        status: 'ready',
        tts: {
          voices: [
            { id: 'zf_xiaobei', name: 'Xiaobei', languages: ['zh'], gender: 'female' },
            { id: 'af_heart', name: 'Heart', languages: ['en'], gender: 'female' },
          ],
          voiceCloning: false,
          durationControl: true,
          streaming: false,
          outputFormats: ['wav'],
        },
        options: {
          pitch: { type: 'number', label: 'Pitch', default: 0, min: -6, max: 6, step: 1 },
        },
      },
      {
        id: 'cosyvoice-300m',
        name: 'CosyVoice 300M',
        role: 'tts',
        languages: ['zh', 'en'],
        status: 'ready',
        tts: {
          voices: [{ id: 'base_zh', name: 'Base ZH', languages: ['zh'] }],
          voiceCloning: true,
          cloningTerms: 'Reference audio is discarded immediately after synthesis.',
          maxReferenceSeconds: 15,
          durationControl: true,
          streaming: true,
          outputFormats: ['wav'],
        },
      },
    ],
  },
];

async function setupTtsHost(page: Page, initialGroups: any[] = SAMPLE_MODELS) {
  let groups = initialGroups;
  let settings: any = {
    hostId: E2E_HOST_ID,
    revision: 0,
    selectedModel: null,
    voiceId: null,
    language: 'auto',
    speed: 1,
    options: {},
    lastAudition: null,
  };
  const jobs = new Map<string, any>();
  let synthMode: 'ok' | 'fail' | 'slow' | 'clone-ok' = 'ok';
  let saveMode: 'ok' | 'uncertain-applied' | 'conflict' = 'ok';
  let jobCounter = 0;
  const wavBytes = makeWavBuffer(1.2, 16000);

  const host = await mockHost(page, {
    'providers.models': () => groups,
    'tts.getSettings': () => settings,
    'tts.saveSettings': payload => {
      if (saveMode === 'conflict') {
        saveMode = 'ok';
        settings = {
          ...settings,
          revision: settings.revision + 1,
          voiceId: 'af_heart',
        };
        return { status: 'conflict', snapshot: settings };
      }
      if (saveMode === 'uncertain-applied') {
        saveMode = 'ok';
        settings = {
          ...settings,
          revision: settings.revision + 1,
          selectedModel: payload.settings.selectedModel,
          voiceId: payload.settings.voiceId,
          language: payload.settings.language,
          speed: payload.settings.speed,
          options: payload.settings.options ?? {},
          lastOperationId: payload.operationId,
        };
        // Simulate lost response on client side (non-RpcError triggers route abort / network failure)
        throw new Error('simulated network drop after commit');
      }
      if (payload.expectedRevision !== settings.revision) {
        return { status: 'conflict', snapshot: settings };
      }
      settings = {
        ...settings,
        revision: settings.revision + 1,
        selectedModel: payload.settings.selectedModel,
        voiceId: payload.settings.voiceId,
        language: payload.settings.language,
        speed: payload.settings.speed,
        options: payload.settings.options ?? {},
        lastOperationId: payload.operationId,
      };
      return { status: 'saved', snapshot: settings };
    },
    'tts.synthesize': payload => {
      const id = uuid(5400 + (++jobCounter));
      const assetId = payload.request.cloneReferenceAssetId ? TTS_ASSET_2 : TTS_ASSET_1;
      if (synthMode === 'fail') {
        jobs.set(id, { id, status: 'error', error: 'TTS 鉴权失败（HTTP 401），请检查 API Key', createdAt: '', updatedAt: '' });
      } else if (synthMode === 'slow') {
        jobs.set(id, { id, status: 'running', progress: { status: 'running', purpose: 'synthesize', progress: 35, data: 'Synthesizing...' }, createdAt: '', updatedAt: '' });
      } else {
        const summary = {
          assetId,
          text: payload.request.text,
          model: { providerId: payload.request.providerId, modelId: payload.request.modelId },
          voiceId: payload.request.voiceId,
          language: payload.request.language,
          mimeType: 'audio/wav',
          format: 'wav',
          byteLength: wavBytes.byteLength,
          durationSeconds: 1.2,
          sampleRate: 16000,
          verifiedAt: '2026-11-13T10:00:00.000Z',
        };
        settings = { ...settings, lastAudition: summary };
        jobs.set(id, {
          id,
          status: 'complete',
          result: { ...summary, cloned: Boolean(payload.request.cloneReferenceAssetId) },
          createdAt: '',
          updatedAt: '',
        });
      }
      return jobs.get(id);
    },
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
  });

  await page.route(MOCK_HOST + '/assets/' + TTS_ASSET_1, route =>
    route.fulfill({ status: 200, contentType: 'audio/wav', body: wavBytes }),
  );
  await page.route(MOCK_HOST + '/assets/' + TTS_ASSET_2, route =>
    route.fulfill({ status: 200, contentType: 'audio/wav', body: wavBytes }),
  );

  return {
    host,
    setGroups: (next: any[]) => { groups = next; },
    setSynthMode: (next: typeof synthMode) => { synthMode = next; },
    setSaveMode: (next: typeof saveMode) => { saveMode = next; },
  };
}

async function openTtsSettings(page: Page, theme: 'light' | 'dark', lang: 'zh' | 'en') {
  await prepare(page, theme);
  await page.goto('/?ui=' + lang + '#/projects');
  await page.getByRole('button', { name: lang === 'zh' ? '设置' : 'Settings' }).click();
  await page.getByTestId('settings-tab-tts').click();
}

for (const theme of ['light', 'dark'] as const) for (const lang of ['zh', 'en'] as const) {
  test.describe(theme + '-' + lang, () => {
    test('F-0053/AC-5 AC-6 empty state, configure redirect, and loading indicator', async ({ page }) => {
      const state = await setupTtsHost(page, []);
      await openTtsSettings(page, theme, lang);
      const panel = page.getByTestId('tts-settings-panel');
      await expect(panel.getByTestId('tts-empty')).toContainText(lang === 'zh' ? '暂无内容' : 'Nothing here yet');
      await shot(page, 'F-0053', 'tts-empty-' + theme + '-' + lang);

      await panel.getByTestId('tts-go-models').click();
      await expect(page.getByRole('heading', { name: lang === 'zh' ? '添加服务' : 'Add endpoint' })).toBeVisible();

      state.host.set('tts.getSettings', () => pending());
      await page.getByTestId('settings-tab-tts').click();
      await expect(panel.getByTestId('tts-loading')).toContainText(lang === 'zh' ? '正在加载…' : 'Loading…');
      await shot(page, 'F-0053', 'tts-loading-' + theme + '-' + lang);
    });

    test('F-0053/AC-3 AC-4 AC-6 AC-7 AC-8 selection, limits, audition, cancel, cloning auth, persistence, uncertain retry, and conflict', async ({ page }) => {
      const state = await setupTtsHost(page);
      await openTtsSettings(page, theme, lang);
      const panel = page.getByTestId('tts-settings-panel');

      // AC-3: fixed-voice model shows cloning unsupported and lists built-in voices
      await expect(panel.getByTestId('tts-cloning-status')).toContainText(
        lang === 'zh' ? '不支持声音克隆' : 'Voice cloning is not supported',
      );
      await expect(panel.getByTestId('tts-voice-select')).toContainText('Xiaobei');
      await shot(page, 'F-0053', 'tts-fixed-model-' + theme + '-' + lang);

      // AC-3 + AC-7: run single-sentence audition -> Completed + real audio element
      await panel.getByTestId('tts-audition-text').fill('Audition check');
      await panel.getByTestId('tts-audition').click();
      await expect(panel.getByTestId('tts-completed')).toContainText(lang === 'zh' ? '已完成' : 'Completed');
      await expect(panel.getByTestId('tts-completed')).toContainText('WAV');
      await expect(panel.getByTestId('tts-completed')).not.toContainText('{format}');
      await expect(panel.getByTestId('tts-audition-audio')).toHaveAttribute('src', /^blob:/);
      await shot(page, 'F-0053', 'tts-audition-completed-' + theme + '-' + lang);

      // AC-6: slow audition shows Processing and Cancel button
      state.setSynthMode('slow');
      await panel.getByTestId('tts-audition').click();
      await expect(panel.getByTestId('tts-processing')).toContainText(lang === 'zh' ? '正在处理…' : 'Processing…');
      await expect(panel.getByTestId('tts-audition')).toBeDisabled();
      await shot(page, 'F-0053', 'tts-processing-' + theme + '-' + lang);
      await panel.getByTestId('tts-cancel').click();
      await expect(panel.getByTestId('tts-processing')).toHaveCount(0);
      expect(state.host.calls.some(c => c.method === 'jobs.cancel')).toBe(true);

      // AC-8: synthesis error retains input, offers Retry and Back
      state.setSynthMode('fail');
      await panel.getByTestId('tts-audition').click();
      await expect(panel.getByTestId('tts-error')).toContainText('HTTP 401');
      await expect(panel.getByTestId('tts-audition-text')).toHaveValue('Audition check');
      await shot(page, 'F-0053', 'tts-error-' + theme + '-' + lang);
      await panel.getByTestId('tts-back').click();
      await expect(panel.getByTestId('tts-error')).toHaveCount(0);
      await expect(panel.getByTestId('tts-audition-text')).toHaveValue('Audition check');

      // AC-4: cloning-capable model requires reference WAV + explicit speaker authorization
      state.setSynthMode('ok');
      await panel.getByTestId('tts-model-select').click();
      await page.getByRole('option', { name: 'CosyVoice 300M' }).click();
      await expect(panel.getByTestId('tts-clone-section')).toBeVisible();
      await panel.getByTestId('tts-clone-toggle').click();
      await expect(panel.getByTestId('tts-audition')).toBeDisabled();
      await panel.getByTestId('tts-clone-file').setInputFiles({
        name: 'speaker-ref.wav',
        mimeType: 'audio/wav',
        buffer: makeWavBuffer(0.2, 16000),
      });
      await expect(panel.getByTestId('tts-audition')).toBeDisabled();
      await panel.getByTestId('tts-clone-auth').check();
      await expect(panel.getByTestId('tts-audition')).toBeEnabled();
      await shot(page, 'F-0053', 'tts-clone-authorized-' + theme + '-' + lang);
      const synthCallsBeforeClone = state.host.calls.filter(c => c.method === 'tts.synthesize').length;
      await panel.getByTestId('tts-audition').click();
      await expect(panel.getByTestId('tts-completed')).toContainText(lang === 'zh' ? '已完成' : 'Completed');
      // The earlier audition already renders a completed state, so wait for the clone request itself.
      await expect.poll(() => state.host.calls.filter(c => c.method === 'tts.synthesize').length)
        .toBeGreaterThan(synthCallsBeforeClone);
      const cloneCall = state.host.calls.filter(c => c.method === 'tts.synthesize').at(-1);
      expect((cloneCall?.payload as any).request.cloneAuthorization.confirmed).toBe(true);

      // AC-8: uncertain save queries Host first on Retry without duplicate write
      state.setSaveMode('uncertain-applied');
      await panel.getByTestId('tts-save').click();
      await expect(panel.getByTestId('tts-error')).toBeVisible();
      const savesBeforeRetry = state.host.calls.filter(c => c.method === 'tts.saveSettings').length;
      const getsBeforeRetry = state.host.calls.filter(c => c.method === 'tts.getSettings').length;
      await panel.getByTestId('tts-retry').click();
      await expect(panel.getByTestId('tts-completed')).toContainText(lang === 'zh' ? '已完成' : 'Completed');
      expect(state.host.calls.filter(c => c.method === 'tts.getSettings').length).toBeGreaterThan(getsBeforeRetry);
      expect(state.host.calls.filter(c => c.method === 'tts.saveSettings').length).toBe(savesBeforeRetry);

      // AC-8: version conflict blocks save until reviewed
      state.setSaveMode('conflict');
      await panel.getByTestId('tts-save').click();
      await expect(panel.getByTestId('tts-conflict')).toContainText(
        lang === 'zh' ? '内容已更新，请重新检查' : 'Content changed. Review again.',
      );
      await expect(panel.getByTestId('tts-conflict')).not.toContainText('{revision}');
      await expect(panel.getByTestId('tts-save')).toBeDisabled();
      await shot(page, 'F-0053', 'tts-conflict-' + theme + '-' + lang);
      await panel.getByTestId('tts-conflict-ack').click();
      await panel.getByTestId('tts-save').click();
      await expect(panel.getByTestId('tts-completed')).toContainText(lang === 'zh' ? '已完成' : 'Completed');

      // AC-7: reopen settings reads persisted Host settings consistently
      await page.reload();
      await page.getByRole('button', { name: lang === 'zh' ? '设置' : 'Settings' }).click();
      await page.getByTestId('settings-tab-tts').click();
      await expect(panel.getByTestId('tts-model-select')).toContainText('CosyVoice 300M');
      await expect(panel.getByTestId('tts-completed')).toBeVisible();
    });
  });
}
