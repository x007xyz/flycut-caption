// F-0015：断点续传的界面状态、刷新后重新选择与项目落库。Host 传输由真实 HTTP 架构测试覆盖；
// 这里按项目现有规则用 mockHost 构造界面状态，并使用 tests/e2e/lib/evidence.ts 留存证据。
import { expect, test, type Page, type Route } from '@playwright/test';
import { shot } from '../lib/evidence';
import { mockHost, pending, prepare, projectItem, uuid, type MockHandlers } from '../lib/mockHost';

const F = 'F-0015';
const THEMES = ['light', 'dark'] as const;
type Theme = typeof THEMES[number];
const PROJECT = uuid(91);
const VIDEO = uuid(92);
const EDITOR_PROJECT = uuid(93);
const TRANSCRIPT = { text: 'hello', language: 'en', duration: 1, hasWordTimestamps: false,
  chunks: [{ id: 's1', text: 'hello', timestamp: [0, 1] }] };

const hostInfo = (resumableUpload = true) => ({ protocolVersion: 2, generation: 'e2e', methods: [], events: [], providers: [],
  capabilities: { projects: true, browserSession: true, cookieMedia: true, resumableUpload } });

const createResult = () => {
  const now = new Date().toISOString();
  return { projectId: PROJECT, videoId: VIDEO, revision: 1,
    project: { id: PROJECT, name: '可恢复上传', revision: 1, styleRevision: 0, createdAt: now, updatedAt: now,
      videos: [{ id: VIDEO, name: '可恢复上传.mp4', durationSeconds: 0, createdAt: now, updatedAt: now }] } };
};

async function openHome(page: Page, theme: Theme, handlers: MockHandlers = {}) {
  await prepare(page, theme);
  const host = await mockHost(page, { 'projects.create': createResult, ...handlers });
  await page.goto('/#/projects');
  await expect(page.getByText('我的项目')).toBeVisible();
  return host;
}

const row = (page: Page) => page.getByTestId('media-upload-row').last();
const choose = (page: Page, name: string, bytes: Uint8Array, mimeType = 'video/mp4') =>
  page.getByTestId('project-file-input').setInputFiles({ name, mimeType, buffer: Buffer.from(bytes) });

for (const theme of THEMES) {
  test.describe(theme, () => {
    test(`F-0015/AC-1 AC-2 协议不支持与限制拒绝显示具体状态 (${theme})`, async ({ page }) => {
      await prepare(page, theme);
      await mockHost(page, { 'host.info': () => hostInfo(false) });
      await page.goto('/#/projects');
      await choose(page, 'unsupported.mp4', new Uint8Array([1, 2, 3]));
      await expect(row(page)).toHaveAttribute('data-upload-phase', 'unsupported');
      await expect(row(page)).toContainText('此Host不支持断点续传');
      await shot(page, F, `unsupported-${theme}`);
      await row(page).getByRole('button', { name: '关闭' }).click();
      await expect(page.getByTestId('media-upload-row')).toHaveCount(0);

      await page.reload();
      await page.unroute('**/rpc').catch(() => undefined);
      await mockHost(page, { 'uploads.capabilities': () => ({ protocolVersion: 1, chunkSize: 1024, maxBytes: 1, maxChunks: 1,
        sessionTtlHours: 24, allowedMimeTypes: ['video/mp4'] }) });
      await page.goto('/#/projects');
      await choose(page, 'too-large.mp4', new Uint8Array([1, 2]));
      await expect(row(page)).toHaveAttribute('data-upload-phase', 'rejected');
      await expect(row(page)).toContainText('文件超过 Host 的大小限制');
      await shot(page, F, `rejected-${theme}`);
    });

    test(`F-0015/AC-4 AC-5 上传中暂停、继续并只显示确认字节 (${theme})`, async ({ page }) => {
      let release!: () => void; let hold = true; let requests = 0;
      const gate = new Promise<void>(resolve => { release = resolve; });
      await openHome(page, theme);
      await page.route('**/uploads/*/chunks/*', async (route: Route) => {
        requests += 1;
        if (hold) await gate;
        await route.fallback().catch(() => undefined);
      });
      await choose(page, 'pause.mp4', new Uint8Array(3 * 1024 * 1024));
      await expect.poll(() => requests).toBe(1);
      await expect(row(page)).toHaveAttribute('data-upload-phase', 'uploading');
      await expect(row(page)).toContainText('0%');
      await shot(page, F, `uploading-${theme}`);
      await row(page).getByRole('button', { name: '暂停' }).click();
      await expect(row(page)).toHaveAttribute('data-upload-phase', 'paused');
      await expect(row(page)).toContainText('已暂停');
      await shot(page, F, `paused-${theme}`);
      // 当前片被中止后不会再计入已确认字节；继续时先 GET 会话，再传缺失分片。
      release(); hold = false;
      await row(page).getByRole('button', { name: '继续' }).click();
      await expect(page).toHaveURL(new RegExp(`#/projects/${PROJECT}/videos/${VIDEO}`));
    });

    test(`F-0015/AC-6 刷新后选择原文件，错文件拒绝且正确文件续传 (${theme})`, async ({ page }) => {
      let release!: () => void; let hold = true;
      const gate = new Promise<void>(resolve => { release = resolve; });
      await openHome(page, theme);
      await page.route('**/uploads/*/chunks/*', async (route: Route) => {
        if (hold) await gate;
        await route.fallback().catch(() => undefined);
      });
      const original = new Uint8Array(1024 * 1024 + 17).map((_, index) => index % 251);
      await choose(page, 'resume.mp4', original);
      await expect.poll(() => page.evaluate(() => {
        const key = Object.keys(localStorage).find(name => name.startsWith('flycut.upload.sessions.'));
        return key ? JSON.parse(localStorage.getItem(key) ?? '[]').length : 0;
      })).toBe(1);
      await page.reload();
      hold = false;
      release();
      await expect(row(page)).toHaveAttribute('data-upload-phase', 'needs-file');
      await expect(row(page)).toContainText('选择原文件以继续');
      await expect(row(page)).toContainText('resume.mp4');
      await shot(page, F, `needs-file-${theme}`);

      const wrong = new Uint8Array(original); wrong[wrong.length - 1] ^= 0xff;
      await page.getByTestId('upload-resume-input').setInputFiles({ name: 'resume.mp4', mimeType: 'video/mp4', buffer: Buffer.from(wrong) });
      await expect(row(page)).toHaveAttribute('data-upload-phase', 'mismatch');
      await expect(row(page)).toContainText('文件不匹配');
      await shot(page, F, `mismatch-${theme}`);

      await page.getByTestId('upload-resume-input').setInputFiles({ name: 'resume.mp4', mimeType: 'video/mp4', buffer: Buffer.from(original) });
      await expect(page).toHaveURL(new RegExp(`#/projects/${PROJECT}/videos/${VIDEO}`));
    });

    test(`F-0015/AC-9 上传完成但项目回执不确定时显示核验中并禁用重复启动 (${theme})`, async ({ page }) => {
      let release!: () => void;
      const response = new Promise<void>(resolve => { release = resolve; });
      await openHome(page, theme, { 'projects.create': async () => { await response; return createResult(); } });
      await choose(page, 'verify.mp4', new Uint8Array(2048));
      await expect(row(page)).toHaveAttribute('data-upload-phase', 'verifying');
      await expect(row(page)).toContainText('正在核验结果…');
      await expect(row(page).getByRole('button', { name: /立即重试|暂停|取消上传/ })).toHaveCount(0);
      await shot(page, F, `verifying-${theme}`);
      release();
      await expect(page).toHaveURL(new RegExp(`#/projects/${PROJECT}/videos/${VIDEO}`));
    });

    test(`F-0015/AC-7 取消需要二次确认并在 Host 响应后移除队列 (${theme})`, async ({ page }) => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      await openHome(page, theme);
      await page.route('**/uploads/*/chunks/*', async (route: Route) => { await gate; await route.fallback().catch(() => undefined); });
      await choose(page, 'cancel.mp4', new Uint8Array(2048));
      await expect(row(page)).toHaveAttribute('data-upload-phase', 'uploading');
      await row(page).getByRole('button', { name: '取消上传' }).click();
      await expect(row(page)).toContainText('确认取消');
      await row(page).getByRole('button', { name: '保留' }).click();
      await expect(row(page)).toHaveAttribute('data-upload-phase', 'uploading');
      await row(page).getByRole('button', { name: '取消上传' }).click();
      await row(page).getByRole('button', { name: '确认取消' }).click();
      await expect(page.getByTestId('media-upload-row')).toHaveCount(0);
      release();
    });

    test(`F-0015/AC-8 Host 空间不足显示具体失败和重试操作 (${theme})`, async ({ page }) => {
      await openHome(page, theme);
      await page.route('**/uploads/*/chunks/*', route => route.fulfill({ status: 507,
        json: { error: { code: 'insufficient-storage', message: 'Not enough Host disk space' } } }));
      await choose(page, 'no-space.mp4', new Uint8Array(2048));
      await expect(row(page)).toHaveAttribute('data-upload-phase', 'failed');
      await expect(row(page)).toContainText('Host 存储空间不足');
      await expect(row(page).getByRole('button', { name: '立即重试' })).toBeVisible();
      await expect(row(page).getByRole('button', { name: '取消上传' })).toBeVisible();
      await shot(page, F, `failed-${theme}`);
    });

    test(`F-0015/AC-2/AC-5 检查限制、校验文件和网络中断状态 (${theme})`, async ({ page }) => {
      await openHome(page, theme, { 'uploads.capabilities': pending });
      await choose(page, 'checking.mp4', new Uint8Array(2048));
      await expect(row(page)).toHaveAttribute('data-upload-phase', 'checking');
      await expect(row(page)).toContainText('正在读取上传限制…');
      await shot(page, F, `checking-${theme}`);
    });

    test(`F-0015/AC-2/AC-3 文件摘要完成后等待 Host 创建会话 (${theme})`, async ({ page }) => {
      await openHome(page, theme);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      await page.route('**/uploads', async route => {
        if (route.request().method() === 'POST') await gate;
        await route.fallback().catch(() => undefined);
      });
      await choose(page, 'hashing.mp4', new Uint8Array(4096));
      await expect(row(page)).toHaveAttribute('data-upload-phase', 'hashing');
      await expect(row(page)).toContainText('正在校验文件…');
      await shot(page, F, `hashing-${theme}`);
      release();
    });

    test(`F-0015/AC-5 网络失败进入 interrupted 且保留重试入口 (${theme})`, async ({ page }) => {
      await openHome(page, theme);
      await page.route('**/uploads/*/chunks/*', route => route.abort('connectionreset'));
      await choose(page, 'interrupted.mp4', new Uint8Array(2 * 1024 * 1024));
      await expect(row(page)).toHaveAttribute('data-upload-phase', 'interrupted');
      await expect(row(page)).toContainText('上传已中断，等待重连');
      await expect(row(page).getByRole('button', { name: '立即重试' })).toBeVisible();
      await shot(page, F, `interrupted-${theme}`);
    });

    test(`F-0015/AC-7 会话过期显示重新开始而不是继续写入 (${theme})`, async ({ page }) => {
      let release!: () => void; let hold = true;
      const gate = new Promise<void>(resolve => { release = resolve; });
      await openHome(page, theme);
      await page.route('**/uploads/*/chunks/*', async route => { if (hold) await gate; await route.fallback().catch(() => undefined); });
      await choose(page, 'expired.mp4', new Uint8Array(2048));
      await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('flycut.upload.sessions.')))).toBe(true);
      await page.route('**/uploads/*', route => route.request().method() === 'GET'
        ? route.fulfill({ status: 410, json: { error: { code: 'expired', message: 'Upload session expired' } } })
        : route.fallback());
      hold = false; release();
      await page.reload();
      await expect(row(page)).toHaveAttribute('data-upload-phase', 'expired');
      await expect(row(page)).toContainText('上传会话已过期，请重新开始');
      await expect(row(page).getByRole('button', { name: '选择原文件' })).toBeVisible();
      await shot(page, F, `expired-${theme}`);
    });
  });
}

for (const theme of THEMES) {
  test(`F-0015/AC-1 AC-6 English upload states (${theme})`, async ({ page }) => {
    await prepare(page, theme);
    const now = new Date().toISOString();
    await mockHost(page, { 'host.info': () => hostInfo(false),
      'projects.list': () => [projectItem(EDITOR_PROJECT, 'English project', { videoId: VIDEO })],
      'projects.open': () => ({ status: 'ok', project: { formatVersion: 2, id: EDITOR_PROJECT, name: 'English project', createdAt: now, updatedAt: now,
        revision: 1, styleRevision: 0, videos: [] }, video: { id: VIDEO, name: 'English project.mp4', durationSeconds: 1, createdAt: now,
        updatedAt: now, hasTranscript: true, revision: 1, styleSource: 'project', media: { kind: 'stored', file: `media/${VIDEO}.mp4`, size: 1,
          mimeType: 'video/mp4' } }, videos: [{ id: VIDEO, name: 'English project.mp4', durationSeconds: 1, createdAt: now, updatedAt: now,
        hasTranscript: true, mediaMissing: false, hasThumbnail: false, styleSource: 'project', revision: 1 }], transcript: TRANSCRIPT,
        media: { status: 'ok', name: 'English project.mp4', playback: { kind: 'url', path: `/projects/${EDITOR_PROJECT}/media/${VIDEO}` } } }) });
    await page.goto(`/#/projects/${EDITOR_PROJECT}/videos/${VIDEO}`);
    await expect(page.getByPlaceholder(/请输入主字幕|Enter main subtitle/).first()).toHaveValue('hello');
    await page.getByRole('button', { name: '选择语言' }).click();
    await page.getByRole('menuitem', { name: /English/ }).click();
    await page.getByRole('button', { name: 'My projects' }).click();
    await expect(page.getByRole('heading', { name: 'My projects' })).toBeVisible();
    await choose(page, 'unsupported.mp4', new Uint8Array([1, 2, 3]));
    await expect(row(page)).toContainText('This Host does not support resumable uploads');
    await expect(row(page).getByRole('button', { name: 'Close' })).toBeVisible();
    await shot(page, F, `unsupported-en-${theme}`);
  });
}
