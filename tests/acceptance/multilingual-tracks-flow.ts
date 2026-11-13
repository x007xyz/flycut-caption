import assert from 'node:assert/strict';
import type { Browser } from 'webdriverio';
import type { ProjectOpenResult } from '../../shared/projects';

export interface AcceptanceHostApi {
  call<T>(method: string, payload?: unknown): Promise<T>;
  upload(source: string): Promise<string>;
}

const TITLE = 'F-0030 多语言轨道真实验收';

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, message: string, timeoutMs = 12_000) {
  const end = Date.now() + timeoutMs;
  let value: T | undefined;
  let lastError: unknown;
  while (Date.now() < end) {
    try {
      value = await read();
      if (done(value)) return value;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message, { cause: lastError });
}

async function addTrack(browser: Browser, languageCode: string, name: string) {
  await browser.$('[data-testid="language-track-add"]').click();
  const select = await browser.$('#language-track-language');
  await select.waitForDisplayed({ timeout: 5_000 });
  await browser.execute((element, code) => {
    const input = element as HTMLSelectElement;
    input.value = code;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, select, languageCode);
  await browser.$('#language-track-name').setValue(name);
  await browser.$('form button[type="submit"]').click();
}

/** F-0030 real-browser flow shared by the Web Host and packaged macOS Tauri runs. */
export async function multilingualTracks(browser: Browser, api: AcceptanceHostApi, source: string) {
  const assetId = await api.upload(source);
  const ids = await api.call<{ projectId: string; videoId: string }>('projects.create', {
    name: TITLE, videoName: 'fixture.mp4', durationSeconds: 3, media: { assetId, mimeType: 'video/mp4' },
  });
  await api.call('projects.saveTranscript', { ...ids, durationSeconds: 3,
    transcript: { text: '这是原字幕', language: 'zh', duration: 3, hasWordTimestamps: false,
      chunks: [{ id: 'cue-1', text: '这是原字幕', timestamp: [0.25, 2] }] } });

  await browser.refresh();
  const card = await browser.$(`button*=${TITLE}`);
  await card.waitForDisplayed({ timeout: 15_000 });
  await card.click();
  const bar = await browser.$('[data-testid="language-track-bar"]');
  await bar.waitForDisplayed({ timeout: 15_000 });
  assert.equal(await browser.$('[data-testid="language-track-empty"]').isDisplayed(), true);

  await addTrack(browser, 'en', 'English');
  const secondary = await browser.$('[data-testid="subtitle-secondary-text"]');
  await secondary.setValue('Hello from Host');
  await browser.$('[data-testid="subtitle-main-text"]').click();
  await until(async () => api.call<ProjectOpenResult>('projects.open', ids), value =>
    value.status === 'ok' && value.edits?.languageTracks?.[0]?.entries['cue-1']?.text === 'Hello from Host',
  'F-0030/AC-1 AC-7: translation did not reach the real Host');

  await browser.refresh();
  const reopened = await browser.$('[data-testid="subtitle-secondary-text"]');
  await reopened.waitForDisplayed({ timeout: 15_000 });
  assert.equal(await reopened.getValue(), 'Hello from Host');

  await addTrack(browser, 'fr', 'Français');
  const french = await browser.$('[data-testid="subtitle-secondary-text"]');
  await french.setValue('Bonjour du Host');
  await browser.$('[data-testid="subtitle-main-text"]').click();
  await until(async () => api.call<ProjectOpenResult>('projects.open', ids), value =>
    value.status === 'ok' && value.edits?.languageTracks?.length === 2
      && value.edits.languageTracks[1].entries['cue-1']?.text === 'Bonjour du Host',
  'F-0030/AC-1: second language did not persist');
  const trackSelect = await browser.$('[data-testid="language-track-select"]');
  await browser.execute(element => {
    const input = element as HTMLSelectElement;
    const option = [...input.options].find(item => item.text.startsWith('English ·'));
    if (!option) throw new Error('English language track option is missing');
    input.value = option.value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, trackSelect);
  await browser.waitUntil(async () => (await browser.$('[data-testid="subtitle-secondary-text"]').getValue()) === 'Hello from Host', {
    timeout: 5_000, timeoutMsg: 'F-0030/AC-1: switching to English kept the active French translation',
  });
  assert.equal(await browser.$('[data-testid="subtitle-secondary-text"]').getValue(), 'Hello from Host');

  const main = await browser.$('[data-testid="subtitle-main-text"]');
  await main.setValue('字幕已更新');
  await browser.$('[data-testid="subtitle-secondary-text"]').click();
  const outdated = await browser.$('[data-testid="translation-outdated"]');
  await outdated.waitForDisplayed({ timeout: 5_000 });
  await (await outdated.$('button')).click();
  await browser.execute(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true })));
  await until(async () => api.call<ProjectOpenResult>('projects.open', ids), value =>
    value.status === 'ok' && value.edits?.languageTracks?.[0]?.entries['cue-1']?.sourceText === '字幕已更新',
  'F-0030/AC-3: keeping an outdated translation did not update its source version');
  console.log('PASS F-0030/AC-1 AC-3 AC-4 AC-7: real Host tracks, switching, outdated keep and reopen');
}
