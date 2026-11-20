/* eslint-disable @typescript-eslint/no-explicit-any -- mock Host payloads */
import { expect, test } from '@playwright/test';
import { prepare, mockHost, uuid, VIDEO_ID } from '../lib/mockHost';
import { shot } from '../lib/evidence';

const F = 'F-0042';
const P = uuid(420);
const T = '2026-11-17T00:00:00Z';
const segments = [{ speaker: 'A', start: 0, end: 2 }, { speaker: 'B', start: 2, end: 4 }];
const chunks = [{ id: 'c1', text: '第一句', timestamp: [0, 2] }, { id: 'c2', text: '第二句', timestamp: [2, 4] }];
const openPayload = () => ({
  status: 'ok',
  project: { formatVersion: 4, id: P, name: '多说话人配音', createdAt: T, updatedAt: T, revision: 1, styleRevision: 0,
    voiceProfiles: [{ id: uuid(4201), name: 'A 的克隆', file: 'voices/' + uuid(4202) + '.wav', durationSeconds: 3, sourceVideoId: VIDEO_ID,
      sourceStart: 0, sourceEnd: 3, authorization: { confirmed: true, statement: '授权', confirmedAt: T }, createdAt: T }],
    videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 4, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: 0, styleSource: 'project' }] },
  video: { id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 4, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: 0, styleSource: 'project' },
  transcript: { text: '第一句第二句', language: 'zh', duration: 4, chunks },
  edits: { chunks, deletedWordIds: [], languageTracks: [{ id: 'en', name: 'English', languageCode: 'en', origin: 'manual',
    entries: { c1: { text: 'First', sourceText: '第一句', updatedAt: T }, c2: { text: 'Second', sourceText: '第二句', updatedAt: T } } }],
    activeLanguageTrackId: 'en', speakerSegments: segments, speakerNames: { A: '主持', B: '嘉宾' },
    speakerVoices: { A: `profile:${uuid(4201)}`, B: 'voice:af_heart' } },
  media: { status: 'ok', name: 'sample.mp4', playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } },
  videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 4, createdAt: T, updatedAt: T, hasTranscript: true, mediaMissing: false, hasThumbnail: false, styleSource: 'project', revision: 0 }],
});

for (const theme of ['light', 'dark'] as const) {
  for (const lang of ['zh', 'en'] as const) {
    test(`F-0042/AC-1 AC-2 AC-3 per-speaker voice mapping and grouped dubbing (${theme}-${lang})`, async ({ page }) => {
      await prepare(page, theme);
      const calls: any[] = [];
      await mockHost(page, {
        'providers.models': () => [{ provider: { id: 'flycut:tts', name: 'TTS Reference', kind: 'endpoint' },
          models: [{ id: 'kokoro-demo', name: 'Kokoro Reference', role: 'tts', status: 'ready', languages: ['zh', 'en'],
            tts: { voices: [{ id: 'af_heart', name: 'Heart' }], voiceCloning: true, durationControl: true, outputFormats: ['wav'] } }] }],
        'tts.getSettings': () => ({ hostId: '00000000-0000-4000-8000-0000000000cc', revision: 0, selectedModel: null, voiceId: null, language: 'auto', speed: 1, options: {}, lastAudition: null }),
        'projects.open': () => openPayload(),
        'speakers.saveVoices': () => ({ status: 'saved', videoRevision: 2, projectRevision: 2, updatedAt: T }),
        'dubbing.alignTrack': (payload: any) => { calls.push(payload); return { id: uuid(4210 + calls.length), status: 'running' }; },
        'jobs.get': ({ id }: any) => ({ id, status: 'complete', result: { status: 'saved', artifacts: [], unresolved: [], videoRevision: 2, projectRevision: 2, updatedAt: T } }),
      });
      const url = lang === 'en' ? `/?ui=en#/projects/${P}/videos/${VIDEO_ID}` : `/#/projects/${P}/videos/${VIDEO_ID}`;
      await page.goto(url);
      await page.getByTestId('speaker-open').click();
      const speakerPanel = page.getByTestId('speaker-panel');
      await expect(speakerPanel.getByTestId('speaker-A')).toBeVisible();
      await expect(speakerPanel.getByTestId('speaker-voice-A')).toHaveValue(`profile:${uuid(4201)}`);
      await speakerPanel.getByTestId('speaker-voice-B').selectOption('voice:af_heart');
      await speakerPanel.getByTestId('speaker-save-voices').click();
      await shot(page, F, `mapping-${theme}-${lang}`);
      await page.getByTestId('speaker-open').click();
      await page.getByTestId('track-dubbing-open').click();
      await page.getByTestId('track-dubbing-start').click();
      await expect(page.getByTestId('track-dubbing-completed')).toBeVisible();
      expect(calls.length).toBe(2);
      const byVoice = calls.map(call => call.voiceProfileId ? `profile:${call.voiceProfileId}` : `voice:${call.request.voiceId}`).sort();
      expect(byVoice).toEqual([`profile:${uuid(4201)}`, 'voice:af_heart']);
      await shot(page, F, `completed-${theme}-${lang}`);
    });
  }
}
