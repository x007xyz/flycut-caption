/* eslint-disable @typescript-eslint/no-explicit-any -- E2E mock Host payloads */
import { expect, test } from '@playwright/test';
import { MOCK_HOST, mockHost, prepare, uuid } from '../lib/mockHost';
import { shot } from '../lib/evidence';

const F = 'F-0023';
const T = '2026-11-13T12:00:00Z';

function projectRow(id: string, name: string, opts: { mediaMissing?: boolean; videoCount?: number } = {}) {
  return {
    id,
    name,
    durationSeconds: opts.videoCount === 0 ? 0 : 120,
    createdAt: T,
    updatedAt: T,
    revision: 3,
    videoCount: opts.videoCount ?? 2,
    videoId: opts.videoCount === 0 ? undefined : uuid(2301),
    hasThumbnail: false,
    mediaMissing: Boolean(opts.mediaMissing),
  };
}

for (const theme of ['light', 'dark'] as const) {
  for (const lang of ['zh', 'en'] as const) {
    test(`F-0023/AC-1 AC-5 AC-6 AC-7 AC-8 backup export preview, missing media, stale, error and completed (${theme}-${lang})`, async ({ page }) => {
      await prepare(page, theme);
      const entryUrl = lang === 'en' ? '/?ui=en#/projects' : '/#/projects';

      const pid1 = uuid(2310);
      const pid2 = uuid(2311);
      let previewMode: 'normal' | 'missing' = 'normal';
      let releasePreview!: () => void;
      let holdPreview = true;
      let exportAttempt = 0;
      const jobResults = new Map<string, any>();

      await mockHost(page, {
        'projects.list': () => [
          projectRow(pid1, '口播系列一期'),
          projectRow(pid2, '缺失媒体项目', { mediaMissing: true, videoCount: 1 }),
        ],
        'projects.backupPreview': async ({ projectId }: any) => {
          if (holdPreview) {
            await new Promise<void>((resolve) => { releasePreview = resolve; });
          }
          if (projectId === pid2 || previewMode === 'missing') {
            return {
              projectId,
              projectName: '缺失媒体项目',
              revision: 3,
              videoCount: 1,
              subtitleCount: 12,
              editCount: 2,
              styleSummary: { hasProjectStyle: true, customVideoStyleCount: 0 },
              artifactCount: 1,
              estimatedMediaBytes: 0,
              estimatedTotalBytes: 2048,
              missingMedia: [{ videoId: uuid(2302), videoName: 'lost.mp4', fileName: 'lost.mp4' }],
              empty: false,
              excludesSecretsNotice: true,
            };
          }
          return {
            projectId,
            projectName: '口播系列一期',
            revision: 3,
            videoCount: 2,
            subtitleCount: 48,
            editCount: 6,
            styleSummary: { hasProjectStyle: true, customVideoStyleCount: 1 },
            artifactCount: 4,
            estimatedMediaBytes: 12_582_912,
            estimatedTotalBytes: 12_600_000,
            missingMedia: [],
            empty: false,
            excludesSecretsNotice: true,
          };
        },
        'projects.backupExport': ({ operationId }: any) => {
          exportAttempt += 1;
          const jobId = uuid(2330 + exportAttempt);
          if (exportAttempt === 1) {
            jobResults.set(jobId, { id: jobId, status: 'error', error: '内容已更新，请重新检查', operationId, createdAt: T, updatedAt: T });
          } else if (exportAttempt === 2) {
            jobResults.set(jobId, { id: jobId, status: 'error', error: '磁盘临时目录写入失败', operationId, createdAt: T, updatedAt: T });
          } else {
            jobResults.set(jobId, {
              id: jobId,
              status: 'complete',
              operationId,
              createdAt: T,
              updatedAt: T,
              result: {
                assetId: uuid(2390),
                filename: '口播系列一期.flycut.zip',
                size: 12_590_000,
                sha256: 'a'.repeat(64),
                revision: 3,
                manifest: { backupVersion: 1, projectFormatVersion: 4, appVersion: '2.0.2', exportedAt: T, projectName: '口播系列一期', videoCount: 2, subtitleCount: 48, editCount: 6, styleSummary: { hasProjectStyle: true, customVideoStyleCount: 1 }, artifactCount: 4, mediaBytes: 12_582_912, missingMedia: [], entries: [] },
              },
            });
          }
          return { id: jobId, status: 'running', progress: { status: 'running', progress: 35, data: 'packing' }, operationId, createdAt: T, updatedAt: T };
        },
        'jobs.get': ({ id }: any) => jobResults.get(id) ?? { id, status: 'complete', createdAt: T, updatedAt: T },
        'assets.delete': () => ({ deleted: uuid(2390) }),
      });

      await page.route(`${MOCK_HOST}/assets/**`, async (route) => {
        const req = route.request();
        const headers = {
          'Access-Control-Allow-Origin': req.headers().origin ?? '*',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': '*',
        };
        if (req.method() === 'OPTIONS') {
          await route.fulfill({ status: 204, headers });
          return;
        }
        await route.fulfill({
          status: 200,
          headers: { ...headers, 'Content-Type': 'application/octet-stream' },
          body: Buffer.from('PK\x03\x04flycut-backup-bytes'),
        });
      });

      await page.goto(entryUrl);
      const moreButtons = page.getByRole('button', { name: lang === 'zh' ? '更多操作' : 'More actions' });
      await expect(moreButtons.first()).toBeVisible();
      await moreButtons.first().click({ force: true });
      await page.getByRole('menuitem', { name: lang === 'zh' ? '备份项目' : 'Back up project' }).click();

      const dialog = page.getByTestId('backup-export-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(lang === 'zh' ? '正在加载…' : 'Loading…')).toBeVisible();
      await shot(page, F, `export-loading-${theme}-${lang}`);

      holdPreview = false;
      releasePreview();
      await expect(dialog.getByText('48')).toBeVisible();
      await shot(page, F, `export-ready-${theme}-${lang}`);

      // 1st attempt -> stale revision
      await dialog.getByRole('button', { name: lang === 'zh' ? '导出备份' : 'Export backup' }).click();
      await expect(dialog.getByText(lang === 'zh' ? '内容已更新，请重新检查' : 'Content changed. Review again.')).toBeVisible();
      await shot(page, F, `export-stale-${theme}-${lang}`);

      await dialog.getByRole('button', { name: lang === 'zh' ? '重新检查' : 'Review again' }).click();
      await expect(dialog.getByRole('button', { name: lang === 'zh' ? '导出备份' : 'Export backup' })).toBeEnabled();

      // 2nd attempt -> error + retry -> 3rd attempt -> completed
      await dialog.getByRole('button', { name: lang === 'zh' ? '导出备份' : 'Export backup' }).click();
      await expect(dialog.getByText('磁盘临时目录写入失败')).toBeVisible();
      await dialog.getByRole('button', { name: lang === 'zh' ? '重试' : 'Retry' }).click();
      await expect(dialog.getByText(lang === 'zh' ? '已完成' : 'Completed')).toBeVisible();
      await shot(page, F, `export-completed-${theme}-${lang}`);
      await dialog.getByRole('button', { name: lang === 'zh' ? '关闭' : 'Close', exact: true }).first().click();

      // Missing-media project warning
      previewMode = 'missing';
      await moreButtons.nth(1).click({ force: true });
      await page.getByRole('menuitem', { name: lang === 'zh' ? '备份项目' : 'Back up project' }).click();
      await expect(dialog.getByText(/lost\.mp4/)).toBeVisible();
      await expect(dialog.getByRole('button', { name: lang === 'zh' ? '导出备份' : 'Export backup' })).toBeDisabled();
      await shot(page, F, `export-missing-media-${theme}-${lang}`);
    });

    test(`F-0023/AC-2 AC-3 AC-5 AC-6 AC-7 backup import empty, rejected, ready rename, and completed (${theme}-${lang})`, async ({ page }) => {
      await prepare(page, theme);
      const entryUrl = lang === 'en' ? '/?ui=en#/projects' : '/#/projects';

      const importedId = uuid(2388);
      let projectsList = [projectRow(uuid(2310), '口播系列一期')];
      let inspectMode: 'reject' | 'ok' = 'reject';
      const jobs = new Map<string, any>();

      await mockHost(page, {
        'projects.list': () => projectsList,
        'projects.backupInspect': ({ stagingId, operationId }: any) => {
          const id = uuid(2350 + jobs.size);
          if (inspectMode === 'reject') {
            jobs.set(id, { id, status: 'error', error: '无法导入此备份：备份版本（v9）高于当前应用支持的版本（v1）', operationId, createdAt: T, updatedAt: T });
          } else {
            jobs.set(id, {
              id,
              status: 'complete',
              operationId,
              createdAt: T,
              updatedAt: T,
              result: {
                stagingId,
                stagingDigest: 'b'.repeat(64),
                archiveBytes: 8_388_608,
                backupVersion: 1,
                projectFormatVersion: 4,
                appVersion: '2.0.2',
                exportedAt: T,
                projectName: '口播系列一期',
                videoCount: 2,
                subtitleCount: 48,
                editCount: 6,
                styleSummary: { hasProjectStyle: true, customVideoStyleCount: 1 },
                artifactCount: 4,
                mediaBytes: 8_300_000,
                missingMedia: [],
                requiredBytes: 75_497_472,
                availableBytes: 10_737_418_240,
              },
            });
          }
          return { id, status: 'running', progress: { status: 'running', progress: 50, data: 'verifying' }, operationId, createdAt: T, updatedAt: T };
        },
        'projects.backupImport': ({ name, operationId }: any) => {
          const id = uuid(2360 + jobs.size);
          const finalName = name || '口播系列一期';
          projectsList = [projectRow(importedId, finalName), ...projectsList];
          jobs.set(id, {
            id,
            status: 'complete',
            operationId,
            createdAt: T,
            updatedAt: T,
            result: { projectId: importedId, name: finalName, videoCount: 2, mediaMissingCount: 0, firstVideoId: uuid(2301) },
          });
          return { id, status: 'running', progress: { status: 'running', progress: 60, data: 'importing' }, operationId, createdAt: T, updatedAt: T };
        },
        'projects.backupDiscardStaging': () => ({ ok: true }),
        'jobs.get': ({ id }: any) => jobs.get(id) ?? { id, status: 'complete', createdAt: T, updatedAt: T },
      });

      await page.route(`${MOCK_HOST}/projects/backups/upload`, async (route) => {
        const req = route.request();
        const headers = {
          'Access-Control-Allow-Origin': req.headers().origin ?? '*',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': '*',
        };
        if (req.method() === 'OPTIONS') {
          await route.fulfill({ status: 204, headers });
          return;
        }
        await route.fulfill({
          status: 201,
          headers: { ...headers, 'Content-Type': 'application/json' },
          json: { stagingId: uuid(2340), size: 1024, sha256: 'b'.repeat(64), createdAt: T },
        });
      });

      await page.goto(entryUrl);
      await page.getByRole('button', { name: lang === 'zh' ? '导入备份' : 'Import backup' }).click();
      const dialog = page.getByTestId('backup-import-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(lang === 'zh' ? '暂无内容' : 'Nothing here yet')).toBeVisible();
      await shot(page, F, `import-empty-${theme}-${lang}`);

      // Reject corrupt / future backup
      const fileInput = page.getByTestId('backup-import-file-input');
      await fileInput.setInputFiles({ name: 'future.flycut.zip', mimeType: 'application/zip', buffer: Buffer.from('bad') });
      await expect(dialog.getByText(lang === 'zh' ? '无法导入此备份' : 'Cannot import this backup', { exact: true })).toBeVisible();
      await shot(page, F, `import-rejected-${theme}-${lang}`);

      // Select valid backup -> ready -> rename -> import completed
      inspectMode = 'ok';
      await fileInput.setInputFiles({ name: 'valid.flycut.zip', mimeType: 'application/zip', buffer: Buffer.from('PK\x03\x04') });
      await expect(dialog.getByLabel(lang === 'zh' ? '新项目名称' : 'New project name')).toHaveValue('口播系列一期');
      await shot(page, F, `import-ready-${theme}-${lang}`);

      await dialog.getByLabel(lang === 'zh' ? '新项目名称' : 'New project name').fill('口播系列一期（迁移）');
      await dialog.getByRole('button', { name: lang === 'zh' ? '确认导入' : 'Import project' }).click();
      await expect(dialog.getByText(lang === 'zh' ? '已完成' : 'Completed')).toBeVisible();
      await expect(dialog.getByText('口播系列一期（迁移）')).toBeVisible();
      await shot(page, F, `import-completed-${theme}-${lang}`);
    });
  }
}
