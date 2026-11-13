import { expect, test, type Page } from '@playwright/test';
import { shot } from '../lib/evidence';
import { E2E_HOST_ID, mockHost, prepare, projectItem, RpcError, uuid, VIDEO_ID, type MockHandlers } from '../lib/mockHost';

const P = uuid(310);
const P2 = uuid(311);
const AI_ID = uuid(931);
const T = '2026-11-13T10:00:00.000Z';

function makeChunks(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `c${i + 1}`,
    text: i % 2 === 0 ? `第${i + 1}条前半句` : `第${i + 1}条后半句。`,
    timestamp: [i * 2, i * 2 + 1.8] as [number, number],
  }));
}

type Track = {
  id: string;
  name: string;
  languageCode: string | null;
  origin: 'manual' | 'legacy-second-text';
  entries: Record<string, { text: string; sourceText: string; updatedAt: string }>;
};

function createFixture(options: {
  chunks?: Array<{ id: string; text: string; timestamp: [number, number]; secondText?: string }>;
  tracks?: Track[];
  hasModel?: boolean;
} = {}) {
  const chunks = options.chunks ?? makeChunks(4);
  const tracks = options.tracks ?? [];
  const activeId = tracks[0]?.id ?? null;
  let videoRevision = 4;
  let projectRevision = 9;
  let edits: Record<string, unknown> | undefined = tracks.length
    ? { chunks, deletedWordIds: [], languageTracks: tracks, activeLanguageTrackId: activeId }
    : undefined;

  const transcript = {
    text: chunks.map((c) => c.text).join(' '),
    language: 'zh',
    duration: Math.max(4, chunks.length * 2),
    hasWordTimestamps: false,
    chunks,
  };

  let jobSeq = 0;
  const jobs = new Map<string, { status: string; result?: unknown; error?: string; payload: Record<string, unknown> }>();

  const handlers: MockHandlers = {
    'projects.list': () => [projectItem(P, 'Batch Translate'), projectItem(P2, 'Other Project', { videoId: uuid(312) })],
    'aiSettings.list': () => ({
      hostId: E2E_HOST_ID,
      revision: 1,
      selectedId: options.hasModel === false ? null : AI_ID,
      configs: options.hasModel === false
        ? []
        : [{ id: AI_ID, name: 'Mock LLM', baseUrl: 'http://ai.test/v1', model: 'mock-gpt', hasApiKey: true }],
    }),
    'projects.open': (payload) => {
      const pid = String(payload?.projectId ?? P);
      return {
        status: 'ok',
        project: { id: pid, name: pid === P ? 'Batch Translate' : 'Other Project', formatVersion: 4, revision: projectRevision, styleRevision: 0, videos: [], createdAt: T, updatedAt: T },
        video: {
          id: pid === P ? VIDEO_ID : uuid(312),
          name: 'talk.mp4',
          durationSeconds: transcript.duration,
          revision: videoRevision,
          styleSource: 'project',
          hasTranscript: true,
          createdAt: T,
          media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1, mimeType: 'video/mp4' },
        },
        videos: [],
        transcript,
        edits: pid === P ? edits : undefined,
        media: { status: 'missing', name: 'talk.mp4' },
      };
    },
    'projects.saveVideoEdits': (input: { edits: Record<string, unknown>; baseRevision: number; force?: boolean }) => {
      if (input.baseRevision !== videoRevision && !input.force) {
        return { status: 'conflict', revision: videoRevision, updatedAt: T };
      }
      edits = structuredClone(input.edits);
      videoRevision += 1;
      projectRevision += 1;
      return { status: 'saved', revision: videoRevision, projectRevision, updatedAt: T };
    },
    'projects.saveProjectStyle': () => ({ status: 'saved', revision: 1, projectRevision, updatedAt: T }),
    'text.start': (payload) => {
      const id = uuid(900 + jobSeq++);
      const items = (payload.items as Array<{ id: string; text: string }>) ?? [];
      jobs.set(id, {
        status: 'complete',
        result: items.map((item) => ({ id: item.id, text: `EN:${item.text}` })),
        payload,
      });
      return { id, status: 'queued', createdAt: T, updatedAt: T };
    },
    'jobs.get': (payload) => {
      const job = jobs.get(String(payload.id));
      if (!job) return { id: payload.id, status: 'error', error: 'missing', createdAt: T, updatedAt: T };
      return { id: payload.id, status: job.status, result: job.result, error: job.error, createdAt: T, updatedAt: T };
    },
    'jobs.cancel': (payload) => {
      const job = jobs.get(String(payload.id));
      if (job) job.status = 'cancelled';
      return { id: payload.id, status: 'cancelled', createdAt: T, updatedAt: T };
    },
  };

  return { handlers, jobs, edits: () => edits };
}

async function setEnglish(page: Page, english: boolean) {
  if (!english) return;
  const trigger = page.getByRole('button', { name: /选择语言|Select Language/ });
  await expect(trigger).toBeVisible();
  if ((await trigger.textContent())?.includes('English')) return;
  await trigger.click();
  await page.getByRole('menuitem', { name: /English/ }).click();
}

async function openEditor(page: Page, theme: 'light' | 'dark', english: boolean, fake: ReturnType<typeof createFixture>, projectId = P) {
  await prepare(page, theme);
  const host = await mockHost(page, fake.handlers);
  await page.goto(`/?ui=${english ? 'en' : 'zh'}#/projects/${projectId}/videos/${VIDEO_ID}`);
  await setEnglish(page, english);
  return host;
}

for (const theme of ['light', 'dark'] as const) for (const english of [false, true]) {
  const lang = english ? 'en' : 'zh';

  test.describe(`F-0031 ${theme}-${lang}`, () => {
    test('F-0031/AC-5 empty subtitles shows Nothing here yet', async ({ page }) => {
      const empty = createFixture({ chunks: [], hasModel: false });
      await openEditor(page, theme, english, empty);
      await expect(page.getByText(english ? 'Nothing here yet' : '暂无内容')).toBeVisible();
      await shot(page, 'F-0031', `empty-${theme}-${lang}`);
    });

    test('F-0031/AC-5 missing AI model and empty scope show guidance and keep editor usable', async ({ page }) => {
      const noModel = createFixture({ chunks: makeChunks(2), hasModel: false });
      const host = await openEditor(page, theme, english, noModel);
      await page.getByTestId('translation-open').click();
      await expect(page.getByTestId('translation-no-model')).toContainText(
        english ? 'Configure an AI model first' : '请先配置AI模型',
      );
      await expect(page.getByTestId('translation-settings')).toBeVisible();
      await shot(page, 'F-0031', `missing-model-${theme}-${lang}`);

      // Existing subtitle editing remains usable while panel is open
      const main = page.getByTestId('subtitle-main-text').first();
      await main.fill('手动编辑可用');
      await main.blur();
      await expect(main).toHaveValue('手动编辑可用');

      // When model exists but selected scope has zero items, show Nothing here yet and disable Start
      host.set('aiSettings.list', () => ({
        hostId: E2E_HOST_ID,
        revision: 2,
        selectedId: AI_ID,
        configs: [{ id: AI_ID, name: 'Mock LLM', baseUrl: 'http://ai.test/v1', model: 'mock-gpt', hasApiKey: true }],
      }));
      await page.reload();
      await setEnglish(page, english);
      await page.getByTestId('translation-open').click();
      await page.getByTestId('translation-scope').selectOption('outdated');
      await expect(page.getByTestId('translation-empty-scope')).toContainText(
        english ? 'Nothing here yet' : '暂无内容',
      );
      await expect(page.getByTestId('translation-start')).toBeDisabled();
    });

    test('F-0031/AC-1 AC-6 semantic batch progress, cancel ignores late response, and navigation isolates projects', async ({ page }) => {
      // 28 cues => 2 batches (24 + 4 along semantic-sentence boundaries)
      const fake = createFixture({ chunks: makeChunks(28) });
      const host = await openEditor(page, theme, english, fake);
      let releaseBatch2!: () => void;
      const batch2Gate = new Promise<void>((resolve) => { releaseBatch2 = resolve; });
      let startCalls = 0;

      host.set('text.start', (payload) => {
        const idx = startCalls++;
        const id = uuid(920 + idx);
        const items = payload.items as Array<{ id: string; text: string }>;
        fake.jobs.set(id, {
          status: idx === 0 ? 'complete' : 'running',
          result: items.map((item) => ({ id: item.id, text: `EN:${item.text}` })),
          payload,
        });
        return { id, status: 'queued', createdAt: T, updatedAt: T };
      });
      host.set('jobs.get', async (payload) => {
        const job = fake.jobs.get(String(payload.id))!;
        if (job.status === 'running') {
          return { id: payload.id, status: 'running', createdAt: T, updatedAt: T };
        }
        return { id: payload.id, status: job.status, result: job.result, createdAt: T, updatedAt: T };
      });

      await page.getByTestId('translation-open').click();
      await page.getByTestId('translation-source-lang').selectOption('zh');
      await page.getByTestId('translation-target-lang').selectOption('en');
      await page.getByTestId('translation-start').click();

      await expect(page.getByTestId('translation-progress')).toContainText(english ? 'Processing…' : '正在处理…');
      await expect(page.getByTestId('translation-progress')).toContainText('1/2');
      await shot(page, 'F-0031', `processing-${theme}-${lang}`);

      // Verify semanticGroups & contextAfter were sent on batch 1
      const firstReq = host.calls.find((c) => c.method === 'text.start')!.payload as Record<string, unknown>;
      expect((firstReq.semanticGroups as Array<unknown>).length).toBeGreaterThan(0);
      expect((firstReq.contextAfter as Array<unknown>).length).toBeGreaterThan(0);

      // Cancel mid-run: completed batch 1 stays editable; late response for batch 2 is ignored
      await page.getByTestId('translation-cancel').click();
      await expect(page.getByTestId('translation-partial')).toBeVisible();
      await expect(page.getByTestId('translation-draft-input-c1')).toBeVisible();
      await expect(page.getByTestId('translation-draft-input-c28')).toHaveCount(0);

      // Simulate late response completing on Host after cancel
      const secondJob = fake.jobs.get(uuid(921))!;
      secondJob.status = 'complete';
      releaseBatch2();
      await batch2Gate;
      await page.waitForTimeout(150);
      await expect(page.getByTestId('translation-draft-input-c28')).toHaveCount(0);
      await shot(page, 'F-0031', `cancelled-partial-${theme}-${lang}`);
    });

    test('F-0031/AC-2 AC-3 invalid batch fails without fallback, single-batch retry keeps manual edits', async ({ page }) => {
      const fake = createFixture({ chunks: makeChunks(28) });
      const host = await openEditor(page, theme, english, fake);
      let callIndex = 0;

      host.set('text.start', (payload) => {
        const idx = callIndex++;
        const id = uuid(940 + idx);
        const items = payload.items as Array<{ id: string; text: string }>;
        // Call 1 (batch-2 initial) omits last item => strict validation fails entire batch-2
        const result = idx === 1
          ? items.slice(0, -1).map((item) => ({ id: item.id, text: `EN:${item.text}` }))
          : items.map((item) => ({ id: item.id, text: `EN:${item.text}` }));
        fake.jobs.set(id, { status: 'complete', result, payload });
        return { id, status: 'queued', createdAt: T, updatedAt: T };
      });

      await page.getByTestId('translation-open').click();
      await page.getByTestId('translation-start').click();

      // Batch 2 failed validation; Batch 1 kept editable; no source fallback for c28
      await expect(page.getByTestId('translation-batch-batch-2')).toContainText(
        english ? 'Invalid translation result' : '翻译结果无效',
      );
      await expect(page.getByTestId('translation-draft-input-c1')).toHaveValue('EN:第1条前半句');
      await expect(page.getByTestId('translation-draft-input-c28')).toHaveCount(0);
      await expect(page.getByTestId('translation-apply')).toBeDisabled();
      await shot(page, 'F-0031', `batch-invalid-${theme}-${lang}`);

      // Manually edit c1 before retrying batch-2
      await page.getByTestId('translation-draft-input-c1').fill('Manual intro translation');
      await expect(page.getByTestId('translation-edited-c1')).toBeVisible();

      // Retry ONLY batch-2
      await page.getByTestId('translation-batch-retry-batch-2').click();
      await expect(page.getByTestId('translation-draft-input-c28')).toHaveValue('EN:第28条后半句。');
      await expect(page.getByTestId('translation-draft-input-c1')).toHaveValue('Manual intro translation');

      // Verify batch-1 was NOT re-sent on retry (total 3 text.start calls: b1, b2-bad, b2-retry)
      const textStartCalls = host.calls.filter((c) => c.method === 'text.start');
      expect(textStartCalls).toHaveLength(3);
      expect((textStartCalls[2].payload.items as Array<{ id: string }>).map((i) => i.id)).not.toContain('c1');
    });

    test('F-0031/AC-4 selective outdated retranslation and translation-too-long warning with manual fix', async ({ page }) => {
      const tracks: Track[] = [{
        id: 'track-en',
        name: 'English',
        languageCode: 'en',
        origin: 'manual',
        entries: {
          c1: { text: 'Old 1', sourceText: '旧1', updatedAt: T },
          c2: { text: 'Old 2', sourceText: '旧2', updatedAt: T },
          c3: { text: 'Up to date 3', sourceText: '第3条前半句', updatedAt: T },
        },
      }];
      const chunks = [
        { id: 'c1', text: '新1前半', timestamp: [0, 2] as [number, number] },
        { id: 'c2', text: '新2后半。', timestamp: [2, 4] as [number, number] },
        { id: 'c3', text: '第3条前半句', timestamp: [4, 6] as [number, number] },
      ];
      const fake = createFixture({ chunks, tracks });
      const host = await openEditor(page, theme, english, fake);

      host.set('text.start', (payload) => {
        const id = uuid(960);
        const items = payload.items as Array<{ id: string; text: string }>;
        // Return an intentionally over-length translation (> 42 chars) to trigger AC-4 warning
        fake.jobs.set(id, {
          status: 'complete',
          result: items.map((item) => ({
            id: item.id,
            text: 'This translated subtitle line intentionally exceeds forty two characters limit.',
          })),
          payload,
        });
        return { id, status: 'queued', createdAt: T, updatedAt: T };
      });

      await page.getByTestId('translation-open').click();
      await page.getByTestId('translation-scope').selectOption('outdated');
      await expect(page.getByTestId('translation-outdated-list')).toBeVisible();
      // Uncheck c2 so ONLY c1 is retranslated
      await page.getByTestId('translation-outdated-item-c2').uncheck();
      await shot(page, 'F-0031', `outdated-select-${theme}-${lang}`);

      await page.getByTestId('translation-start').click();
      const req = host.calls.find((c) => c.method === 'text.start')!.payload as Record<string, unknown>;
      expect((req.items as Array<{ id: string }>).map((i) => i.id)).toEqual(['c1']);
      // Surrounding cue c2 is passed as read-only contextAfter
      expect((req.contextAfter as Array<{ id: string }>).map((i) => i.id)).toContain('c2');

      // Too long badge appears; user shortens translation and badge clears
      await expect(page.getByTestId('translation-too-long')).toContainText(
        english ? 'Translation too long' : '译文过长',
      );
      await shot(page, 'F-0031', `too-long-${theme}-${lang}`);

      await page.getByTestId('translation-draft-input-c1').fill('Short updated line.');
      await expect(page.getByTestId('translation-too-long')).toHaveCount(0);

      await page.getByTestId('translation-apply').click();
      await expect(page.getByTestId('translation-completed')).toContainText(english ? 'Completed' : '已完成');

      const savedTracks = fake.edits()!.languageTracks as Track[];
      expect(savedTracks[0].entries.c1.text).toBe('Short updated line.');
      expect(savedTracks[0].entries.c2.text).toBe('Old 2'); // untouched
      expect(savedTracks[0].entries.c3.text).toBe('Up to date 3'); // untouched
    });

    test('F-0031/AC-3 AC-7 AC-8 stale source guard, save failure retry/back preserving edits, and persistence on reload', async ({ page }) => {
      const fake = createFixture({ chunks: makeChunks(2) });
      const host = await openEditor(page, theme, english, fake);

      await page.getByTestId('translation-open').click();
      await page.getByTestId('translation-start').click();
      await expect(page.getByTestId('translation-draft-input-c1')).toBeVisible();

      // Edit draft manually
      await page.getByTestId('translation-draft-input-c1').fill('Reviewed EN 1');

      // Mutate source subtitle while panel is open => stale guard blocks submit
      const main = page.getByTestId('subtitle-main-text').first();
      await main.fill('修改后的第一句');
      await main.blur();
      await expect(page.getByTestId('translation-stale')).toContainText(
        english ? 'Content changed. Review again.' : '内容已更新，请重新检查',
      );
      await expect(page.getByTestId('translation-apply')).toBeDisabled();
      await shot(page, 'F-0031', `stale-guard-${theme}-${lang}`);

      await page.getByTestId('translation-review-again').click();
      await expect(page.getByTestId('translation-stale')).toHaveCount(0);
      await expect(page.getByTestId('translation-apply')).toBeEnabled();

      // Simulate Host write failure on apply => rolls back formal state, keeps draft, shows Retry & Back
      const realSave = fake.handlers['projects.saveVideoEdits'];
      host.set('projects.saveVideoEdits', () => { throw new RpcError('disk full'); });
      await page.getByTestId('translation-apply').click();
      await expect(page.getByTestId('translation-apply-error')).toContainText('disk full');
      await expect(page.getByTestId('translation-retry-apply')).toContainText(english ? 'Retry' : '重试');
      await expect(page.getByTestId('translation-back')).toContainText(english ? 'Back' : '返回');
      await expect(page.getByTestId('translation-draft-input-c1')).toHaveValue('Reviewed EN 1');
      await shot(page, 'F-0031', `apply-failed-${theme}-${lang}`);

      // Retry succeeds => Completed shown only after Host confirms
      host.set('projects.saveVideoEdits', realSave);
      await page.getByTestId('translation-retry-apply').click();
      await expect(page.getByTestId('translation-completed')).toContainText(english ? 'Completed' : '已完成');
      await shot(page, 'F-0031', `completed-${theme}-${lang}`);

      // Reload reads persisted track from Host
      await page.reload();
      await setEnglish(page, english);
      await expect(page.getByTestId('subtitle-secondary-text').first()).toHaveValue('Reviewed EN 1');
    });
  });
}

