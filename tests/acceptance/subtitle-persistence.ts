import assert from 'node:assert/strict';
import type { Browser } from 'webdriverio';
import { changed, initial, title, type host } from './fixture';

export async function subtitlePersistence(browser: Browser, api: ReturnType<typeof host>, source: string) {
  const ids = await api.seed(source);
  await browser.refresh();
  const editor = () => browser.$('[data-testid="subtitle-main-text"]');
  const open = async () => {
    const card = await browser.$(`button*=${title}`);
    await card.waitForDisplayed({ timeout: 15_000 });
    await card.click();
    await editor().waitForDisplayed({ timeout: 15_000 });
  };
  await open();
  assert.equal(await editor().getValue(), initial);
  await editor().setValue(changed);
  // The embedded driver does not perform native focus traversal on Tab.
  // An ordinary button click gives the input the same blur on both platforms.
  await browser.$('//button[normalize-space(.)="全选" or normalize-space(.)="Select All"]').click();
  await browser.waitUntil(() => api.saved(ids), {
    timeout: 10_000, timeoutMsg: 'F-0058/AC-1: Host did not persist the changed subtitle',
  });
  // Click the real toolbar action; the fallback label is for an English OS locale.
  const back = await browser.$('//button[normalize-space(.)="我的项目" or normalize-space(.)="My Projects"]');
  await back.click();
  await open();
  assert.equal(await editor().getValue(), changed, 'F-0058/AC-1: reopening lost the persisted text');
  console.log('PASS F-0058/AC-1: subtitle persisted on Host and survived reopening');
}
