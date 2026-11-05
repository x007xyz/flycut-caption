// 需求验收的截图：UPDATE_SHOTS=1（pnpm e2e:evidence）时写进需求目录的 screenshots/，平时不写。
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

function featureDir(id: string): string {
  const name = readdirSync('docs/features').find((n) => n.startsWith(`${id}-`));
  if (!name) throw new Error(`找不到需求目录 docs/features/${id}-*`);
  return join('docs/features', name);
}

/** 截一张验收截图，文件名例如 `home-empty-dark`（不带扩展名）。 */
export async function shot(page: Page, featureId: string, name: string): Promise<void> {
  if (!process.env.UPDATE_SHOTS) return;
  const dir = join(featureDir(featureId), 'screenshots');
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}
