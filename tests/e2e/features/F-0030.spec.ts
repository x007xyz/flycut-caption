import { test, expect, type Page } from '@playwright/test';
import { mockHost, prepare, uuid, VIDEO_ID, RpcError, type MockHandlers } from '../lib/mockHost';
import { shot } from '../lib/evidence';

const P = uuid(300);
const T = '2026-11-12T12:00:00.000Z';
const transcript = {
  text: '你好 世界', language: 'zh', duration: 6, hasWordTimestamps: false,
  chunks: [
    { id: 's1', text: '你好', timestamp: [0, 2] as [number, number] },
    { id: 's2', text: '世界', timestamp: [3, 5] as [number, number] },
  ],
};
type Edit = Record<string, unknown> & { chunks: Array<Record<string, unknown>> };
type Track = { id: string; name: string; languageCode: string | null; origin: 'manual' | 'legacy-second-text'; entries: Record<string, { text: string; sourceText: string; updatedAt: string }> };
type SaveInput = { edits: Edit; baseRevision: number; force?: boolean };

function track(id: string, name: string, languageCode: string | null, text = ''): Track {
  return { id, name, languageCode, origin: 'manual', entries: text ? { s1: { text, sourceText: '你好', updatedAt: T } } : {} };
}

function editsWith(tracks: Track[], activeLanguageTrackId = tracks[0]?.id ?? null): Edit {
  const active = tracks.find(item => item.id === activeLanguageTrackId);
  return { chunks: transcript.chunks.map(chunk => ({ ...chunk, secondText: active?.entries[chunk.id]?.text })), deletedWordIds: [],
    languageTracks: tracks, activeLanguageTrackId };
}

function legacyEdits(): Edit {
  return { chunks: [{ ...transcript.chunks[0], secondText: 'Bonjour' }, { ...transcript.chunks[1] }], deletedWordIds: [] };
}

function fixture(initialEdits?: Edit, data: typeof transcript = transcript) {
  let edits = initialEdits ? structuredClone(initialEdits) : undefined;
  let videoRevision = 4; let projectRevision = 8;
  const open = () => ({ status: 'ok',
    project: { id: P, name: 'Multilingual', formatVersion: 4, revision: projectRevision, styleRevision: 0, videos: [], createdAt: T, updatedAt: T },
    video: { id: VIDEO_ID, name: 'voice.mp4', durationSeconds: data.duration, revision: videoRevision, styleSource: 'project',
      hasTranscript: true, createdAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1, mimeType: 'video/mp4' } },
    videos: [], transcript: data, edits, media: { status: 'missing', name: 'voice.mp4' } });
  const save = (input: SaveInput) => {
    if (input.baseRevision !== videoRevision && !input.force) return { status: 'conflict', revision: videoRevision, updatedAt: T };
    edits = structuredClone(input.edits); videoRevision += 1; projectRevision += 1;
    return { status: 'saved', revision: videoRevision, projectRevision, updatedAt: T };
  };
  const handlers: MockHandlers = {
    'projects.open': open,
    'projects.saveVideoEdits': save,
    'projects.saveProjectStyle': () => ({ status: 'saved', revision: 1, projectRevision, updatedAt: T }),
  };
  return { handlers, open, save, edits: () => edits, revisions: () => ({ videoRevision, projectRevision }) };
}

async function setEnglish(page: Page, english: boolean) {
  if (!english) return;
  const trigger = page.getByRole('button', { name: /选择语言|Select Language/ });
  await expect(trigger).toBeVisible();
  if ((await trigger.textContent())?.includes('English')) return;
  await trigger.click();
  await page.getByRole('menuitem', { name: /English/ }).click();
}

async function openEditor(page: Page, theme: 'light' | 'dark', english: boolean, fake: ReturnType<typeof fixture>, overrides: MockHandlers = {}) {
  await prepare(page, theme);
  const host = await mockHost(page, { ...fake.handlers, ...overrides });
  await page.goto(`/?ui=${english ? 'en' : 'zh'}#/projects/${P}/videos/${VIDEO_ID}`);
  await expect(page.getByTestId('language-track-bar')).toBeVisible();
  await setEnglish(page, english);
  return host;
}

async function addTrack(page: Page, language: string, name: string, english: boolean) {
  await page.getByTestId('language-track-add').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(english ? 'Add a language track' : '添加语言轨道')).toBeVisible();
  await dialog.getByLabel(english ? 'Language' : '语言').selectOption(language);
  await dialog.getByLabel(english ? 'Track name' : '轨道名称').fill(name);
  await dialog.getByRole('button', { name: english ? 'Save' : '保存' }).click();
}

async function waitCompleted(page: Page) {
  const saveNow = page.getByTitle(/立即保存|Save now/);
  if (await saveNow.isVisible().catch(() => false)) await saveNow.click();
  await expect(page.getByTestId('language-track-completed')).toBeVisible({ timeout: 10_000 });
}

for (const theme of ['light', 'dark'] as const) for (const english of [false, true]) {
  const lang = english ? 'en' : 'zh';
  test.describe(`F-0030 ${theme}-${lang}`, () => {
    test('F-0030/AC-1 AC-4 AC-7 create, name, switch and edit tracks; delete needs confirmation; reopen keeps data', async ({ page }) => {
      const fake = fixture();
      const host = await openEditor(page, theme, english, fake);
      await expect(page.getByTestId('language-track-empty')).toHaveText(english ? 'Nothing here yet' : '暂无内容');
      await shot(page, 'F-0030', `tracks-empty-${theme}-${lang}`);
      await addTrack(page, 'en', 'English', english);
      await expect(page.getByTestId('language-track-empty-translations')).toHaveText(english ? 'No translation for this language' : '此语言尚无译文');
      await shot(page, 'F-0030', `track-no-translation-${theme}-${lang}`);
      const secondary = page.getByTestId('subtitle-secondary-text').first();
      await secondary.fill('Hello'); await secondary.blur();
      await waitCompleted(page);
      await addTrack(page, 'fr', 'Français', english);
      await page.getByTestId('subtitle-secondary-text').first().fill('Bonjour'); await page.getByTestId('subtitle-secondary-text').first().blur();
      await waitCompleted(page);
      await page.getByTestId('language-track-select').selectOption({ label: 'English · English' });
      await expect(page.getByTestId('subtitle-secondary-text').first()).toHaveValue('Hello');
      await shot(page, 'F-0030', `tracks-populated-${theme}-${lang}`);
      await page.getByTestId('language-track-select').selectOption({ label: 'Français · Français' });
      await page.getByTestId('language-track-bar').getByRole('button', { name: english ? 'Delete' : '删除' }).click();
      await expect(page.getByRole('dialog')).toContainText('Français');
      await shot(page, 'F-0030', `track-delete-confirm-${theme}-${lang}`);
      await page.getByRole('dialog').getByRole('button', { name: english ? 'Delete track' : '删除轨道' }).click();
      await waitCompleted(page);
      const saved = fake.edits()!;
      expect((saved.languageTracks as Track[]).map(item => item.languageCode)).toEqual(['en']);
      expect((saved.chunks as Array<{secondText?: string}>)[0].secondText).toBe('Hello');
      await page.reload(); await setEnglish(page, english);
      await expect(page.getByTestId('language-track-select')).toBeVisible();
      await expect(page.getByTestId('subtitle-secondary-text').first()).toHaveValue('Hello');
      expect(host.calls.filter(call => call.method === 'projects.saveVideoEdits').length).toBeGreaterThanOrEqual(3);
    });

    test('F-0030/AC-2 AC-5 legacy secondText stays readable, remains unspecified, and can be assigned after save', async ({ page }) => {
      const fake = fixture(legacyEdits());
      await openEditor(page, theme, english, fake);
      await expect(page.getByTestId('subtitle-secondary-text').first()).toHaveValue('Bonjour');
      await expect(page.getByTestId('language-track-unspecified')).toBeVisible();
      await expect(page.getByTestId('language-track-select')).toContainText(english ? 'Legacy translation' : '旧副字幕');
      await shot(page, 'F-0030', `legacy-unspecified-${theme}-${lang}`);
      await page.getByTestId('language-track-bar').getByRole('button', { name: english ? 'Set language' : '设置语言' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel(english ? 'Language' : '语言').selectOption('fr');
      await dialog.getByRole('button', { name: english ? 'Save' : '保存' }).click();
      await expect(page.getByTestId('language-track-unspecified')).toHaveCount(0);
      await waitCompleted(page);
      const saved = fake.edits()!;
      expect((saved.languageTracks as Track[])[0].languageCode).toBe('fr');
      expect((saved.chunks as Array<{secondText?: string}>)[0].secondText).toBe('Bonjour');
      await shot(page, 'F-0030', `legacy-language-set-${theme}-${lang}`);
      await page.reload(); await setEnglish(page, english);
      await expect(page.getByTestId('subtitle-secondary-text').first()).toHaveValue('Bonjour');
    });

    test('F-0030/AC-3 source edits mark translations outdated; keep accepts the new source; retranslate edits in place', async ({ page }) => {
      const fake = fixture(editsWith([track('track-en', 'English', 'en', 'Hello')]));
      await openEditor(page, theme, english, fake);
      const main = page.getByTestId('subtitle-main-text').first();
      await main.fill('你好呀'); await main.blur();
      await expect(page.getByTestId('translation-outdated')).toBeVisible();
      await expect(page.getByTestId('subtitle-secondary-text').first()).toHaveValue('Hello');
      await shot(page, 'F-0030', `translation-outdated-${theme}-${lang}`);
      await page.getByTestId('translation-outdated').getByRole('button', { name: english ? 'Keep translation' : '保留译文' }).click();
      await expect(page.getByTestId('translation-outdated')).toHaveCount(0);
      await waitCompleted(page);
      expect(((fake.edits()!.languageTracks as Track[])[0].entries.s1.sourceText)).toBe('你好呀');
      await main.fill('你好呀！'); await main.blur();
      await expect(page.getByTestId('translation-outdated')).toBeVisible();
      await page.getByTestId('translation-outdated').getByRole('button', { name: english ? 'Retranslate' : '重新翻译' }).click({ force: true });
      const secondary = page.getByTestId('subtitle-secondary-text').first();
      await expect(secondary).toBeFocused();
      await secondary.fill('Hello again'); await secondary.blur();
      await expect(page.getByTestId('translation-outdated')).toHaveCount(0);
      await waitCompleted(page);
      const saved = fake.edits()!;
      expect((saved.chunks as Array<{timestamp: [number, number]}>)[0].timestamp).toEqual([0, 2]);
      expect(((saved.languageTracks as Track[])[0].entries.s1.text)).toBe('Hello again');
    });

    test('F-0030/AC-5 no subtitles shows the required empty state', async ({ page }) => {
      const empty = fixture(undefined, { ...transcript, text: '', chunks: [] });
      await prepare(page, theme);
      await mockHost(page, empty.handlers);
      await page.goto(`/?ui=${english ? 'en' : 'zh'}#/projects/${P}/videos/${VIDEO_ID}`);
      await setEnglish(page, english);
      await expect(page.getByTestId('platform-empty-subtitles').getByText(english ? 'Nothing here yet' : '暂无内容')).toBeVisible();
      await shot(page, 'F-0030', `no-content-${theme}-${lang}`);
    });

    test('F-0030/AC-6 AC-7 loading, processing and completed states are explicit', async ({ page }) => {
      const fake = fixture();
      let releaseOpen!: () => void;
      const gate = new Promise<void>(resolve => { releaseOpen = resolve; });
      await prepare(page, theme);
      const host = await mockHost(page, { ...fake.handlers, 'projects.open': async () => { await gate; return fake.open(); } });
      await page.goto(`/?ui=${english ? 'en' : 'zh'}#/projects/${P}/videos/${VIDEO_ID}`);
      await expect(page.getByRole('status').filter({ hasText: /正在加载|Loading/ }).first()).toBeVisible();
      await shot(page, 'F-0030', `loading-${theme}-${lang}`);
      releaseOpen();
      await expect(page.getByTestId('language-track-bar')).toBeVisible();
      await setEnglish(page, english);

      let releaseSave!: () => void;
      const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
      host.set('projects.saveVideoEdits', async input => {
        await saveGate;
        return fake.save(input);
      });
      await addTrack(page, 'en', 'English', english);
      await page.getByTestId('subtitle-secondary-text').first().fill('Hello');
      await page.getByTestId('subtitle-secondary-text').first().blur();
      await expect(page.getByTestId('language-track-processing')).toBeVisible();
      await shot(page, 'F-0030', `processing-${theme}-${lang}`);
      await page.getByTitle(/立即保存|Save now/).click();
      await expect.poll(() => host.calls.some(call => call.method === 'projects.saveVideoEdits')).toBe(true);
      releaseSave();
      await expect(page.getByTestId('language-track-completed')).toBeVisible();
      await shot(page, 'F-0030', `completed-${theme}-${lang}`);
      expect(host.calls.some(call => call.method === 'projects.saveVideoEdits')).toBe(true);
    });

    test('F-0030/AC-8 failed save keeps input and retries; conflict asks for review without overwriting', async ({ page }) => {
      const fake = fixture(editsWith([track('track-en', 'English', 'en', 'Hello')]));
      const host = await openEditor(page, theme, english, fake);
      const secondary = page.getByTestId('subtitle-secondary-text').first();
      host.set('projects.saveVideoEdits', () => { throw new RpcError('disk full'); });
      await secondary.fill('Pending retry'); await secondary.blur();
      await expect(page.getByTestId('language-track-failed')).toContainText('disk full');
      await expect(secondary).toHaveValue('Pending retry');
      await shot(page, 'F-0030', `save-failed-${theme}-${lang}`);
      host.set('projects.saveVideoEdits', fake.save);
      await page.getByTestId('language-track-failed').getByRole('button', { name: english ? 'Retry' : '重试' }).click();
      await waitCompleted(page);
      expect(((fake.edits()!.languageTracks as Track[])[0].entries.s1.text)).toBe('Pending retry');

      host.set('projects.saveVideoEdits', () => ({ status: 'conflict', revision: 99, updatedAt: T }));
      await secondary.fill('Conflict edit'); await secondary.blur();
      const saveNow = page.getByTitle(/立即保存|Save now/);
      if (await saveNow.isVisible().catch(() => false)) await saveNow.click();
      await expect(page.getByTestId('language-track-conflict')).toContainText(english ? 'Content changed. Review again.' : '内容已更新，请重新检查');
      await expect(secondary).toHaveValue('Conflict edit');
      await shot(page, 'F-0030', `conflict-${theme}-${lang}`);
      await page.getByTestId('language-track-conflict').getByRole('button', { name: english ? 'Review changes' : '检查更新' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await shot(page, 'F-0030', `conflict-dialog-${theme}-${lang}`);
      await page.getByRole('dialog').getByRole('button', { name: english ? 'Cancel' : '取消' }).click();
      expect(((fake.edits()!.languageTracks as Track[])[0].entries.s1.text)).toBe('Pending retry');
    });
  });
}
