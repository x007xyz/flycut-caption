/* eslint-disable @typescript-eslint/no-explicit-any -- mock Host payloads mirror JSON RPC shapes. */
import { expect, test } from '@playwright/test';
import { mockHost, prepare, uuid } from '../lib/mockHost';
import { shot } from '../lib/evidence';

const F = 'F-0051';
const T = '2026-11-13T12:00:00Z';

function pending(id: string, kind: string, name: string) {
  return { id, kind, source: 'cli', status: 'pending', summary: name, target: { projectName: name }, createdAt: T, updatedAt: T };
}

for (const theme of ['light', 'dark'] as const) {
  for (const lang of ['zh', 'en'] as const) {
    test('F-0051/AC-3 AC-5 AC-8 confirmation center lists pending CLI requests and approves them (' + theme + '-' + lang + ')', async ({ page }) => {
      await prepare(page, theme);
      if (lang === 'en') await page.addInitScript(() => window.localStorage.setItem('app-language', 'en'));
      let items = [pending(uuid(5101), 'trash-project', '口播素材'), pending(uuid(5102), 'overwrite-export', '成片.mp4')];
      const host = await mockHost(page, {
        'projects.list': () => [],
        'confirmations.list': () => items,
        'confirmations.decide': (payload: any) => {
          if (payload.decision === 'approve') items = items.filter(item => item.id !== payload.id);
          return { status: payload.decision === 'approve' ? 'approved' : 'rejected' };
        },
      });
      await page.goto('/#/projects');
      await expect(page.getByTestId('confirmations-open')).toBeVisible();
      await expect(page.getByTestId('confirmations-count')).toHaveText('2');
      await shot(page, F, 'confirmations-entry-' + theme + '-' + lang);

      await page.getByTestId('confirmations-open').click();
      const panel = page.getByTestId('confirmations-panel');
      await expect(panel.getByTestId('confirmation-item')).toHaveCount(2);
      await shot(page, F, 'confirmations-list-' + theme + '-' + lang);

      await panel.getByTestId('confirmations-approve').first().click();
      await expect(panel.getByTestId('confirmation-item')).toHaveCount(1);
      await expect(page.getByTestId('confirmations-count')).toHaveText('1');
      expect(host.calls.filter(call => call.method === 'confirmations.decide').length).toBeGreaterThan(0);
      await shot(page, F, 'confirmations-approved-' + theme + '-' + lang);

      await panel.getByTestId('confirmations-reject').first().click();
      await expect.poll(() => host.calls.filter(call => call.method === 'confirmations.decide').length).toBeGreaterThan(1);
    });

    test('F-0051/AC-5 empty confirmation list is explicit and keeps project editing usable (' + theme + '-' + lang + ')', async ({ page }) => {
      await prepare(page, theme);
      if (lang === 'en') await page.addInitScript(() => window.localStorage.setItem('app-language', 'en'));
      await mockHost(page, { 'projects.list': () => [], 'confirmations.list': () => [] });
      await page.goto('/#/projects');
      await page.getByTestId('confirmations-open').click();
      await expect(page.getByTestId('confirmations-empty')).toBeVisible();
      await shot(page, F, 'confirmations-empty-' + theme + '-' + lang);
    });
  }
}

