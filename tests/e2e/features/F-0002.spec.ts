// F-0002 项目数据保存到 Host：界面状态验收（PRD AC-11 到 AC-27）。
// Host 用 tests/e2e/lib/mockHost.ts 模拟；Host 本身的读写、迁移、媒体由 tests/architecture/projects.test.ts 覆盖。
import { expect, test, type Page } from '@playwright/test';
import { shot } from '../lib/evidence';
import { mockHost, pending, prepare, projectItem, RpcError, UPLOADED_ASSET, uuid, VIDEO_ID, type MockHandlers } from '../lib/mockHost';

const F = 'F-0002';
const THEMES = ['light', 'dark'] as const;

const transcript = {
  text: '大家好 今天聊聊剪辑', language: 'zh', duration: 6, hasWordTimestamps: false,
  chunks: [{ id: 's1', text: '大家好', timestamp: [0, 2] }, { id: 's2', text: '今天聊聊剪辑', timestamp: [2, 6] }],
};

/** `projects.open` 的正常返回：已转写、媒体在。 */
export function openResult(projectId: string, name: string, patch: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    status: 'ok',
    project: { formatVersion: 1, id: projectId, name, createdAt: now, updatedAt: now, revision: 3, videos: [] },
    video: { id: VIDEO_ID, name: `${name}.mp4`, durationSeconds: 6, createdAt: now, hasTranscript: true,
      media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1, mimeType: 'video/mp4' } },
    transcript,
    media: { status: 'ok', name: `${name}.mp4`, playback: { kind: 'url', path: `/projects/${projectId}/media/${VIDEO_ID}` } },
    ...patch,
  };
}

async function openHome(page: Page, theme: 'light' | 'dark', handlers: MockHandlers = {}, extra: Record<string, string> = {}) {
  await prepare(page, theme, extra);
  const host = await mockHost(page, handlers);
  await page.goto('/#/projects');
  return host;
}

const ONE = uuid(1); const TWO = uuid(2); const THREE = uuid(3);
const threeProjects = () => [
  projectItem(ONE, '口播：剪辑工作流分享', { durationSeconds: 1325 }),
  projectItem(TWO, '直播回放 11-02', { mediaMissing: true, updatedAt: new Date(Date.now() - 3 * 3600_000).toISOString() }),
  projectItem(THREE, '产品发布会彩排', { updatedAt: new Date(Date.now() - 2 * 86400_000).toISOString() }),
];

for (const theme of THEMES) {
  test.describe(`${theme}`, () => {
    test(`F-0002/AC-11 加载中显示骨架屏，新建区可用 (${theme})`, async ({ page }) => {
      await openHome(page, theme, { 'projects.list': pending });
      await expect(page.getByLabel('正在读取项目…')).toBeVisible();
      await expect(page.getByText(/\d+ 个项目/)).toHaveCount(0);
      await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled();
      await expect(page.getByRole('button', { name: '用示例视频试试' })).toBeEnabled();
      await shot(page, F, `home-loading-${theme}`);
    });

    test(`F-0002/AC-12 读取失败可重试，重试时回到加载中 (${theme})`, async ({ page }) => {
      let fail = true;
      const host = await openHome(page, theme, { 'projects.list': () => { if (fail) throw new Error('down'); return pending(); } });
      await expect(page.getByText('读取项目失败')).toBeVisible();
      await expect(page.getByText('没能连接到 FlyCut Host，请稍后重试')).toBeVisible();
      await shot(page, F, `home-error-${theme}`);
      fail = false;
      const before = host.calls.filter(call => call.method === 'projects.list').length;
      await page.getByRole('button', { name: '重试' }).click();
      await expect(page.getByLabel('正在读取项目…')).toBeVisible();
      expect(host.calls.filter(call => call.method === 'projects.list').length).toBeGreaterThan(before);
    });

    test(`F-0002/AC-13 没有项目时显示空状态 (${theme})`, async ({ page }) => {
      await openHome(page, theme);
      await expect(page.getByText('还没有项目')).toBeVisible();
      await expect(page.getByText('拖入一个视频或音频，就会自动创建项目，转写和修改都会自动保存。')).toBeVisible();
      await shot(page, F, `home-empty-${theme}`);
    });

    test(`F-0002/AC-14 网格和列表视图，状态标记，视图选择重开后保持 (${theme})`, async ({ page }) => {
      await openHome(page, theme, { 'projects.list': threeProjects });
      await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible();
      await expect(page.getByText('3 个项目')).toBeVisible();
      const first = page.getByRole('button', { name: /口播：剪辑工作流分享/ });
      await expect(first).toContainText('22:05');
      await expect(first).toContainText('刚刚');
      await expect(page.getByRole('button', { name: /直播回放 11-02/ })).toContainText('媒体丢失');
      await shot(page, F, `home-grid-${theme}`);

      await page.getByRole('button', { name: '列表' }).click();
      for (const column of ['名称', '视频', '时长', '修改时间', '状态']) await expect(page.getByRole('columnheader', { name: column })).toBeVisible();
      await shot(page, F, `home-list-${theme}`);
      await page.reload();
      await expect(page.getByRole('columnheader', { name: '状态' })).toBeVisible();
    });

    test(`F-0002/AC-15 搜索实时过滤，无结果有提示，清空恢复 (${theme})`, async ({ page }) => {
      await openHome(page, theme, { 'projects.list': threeProjects });
      const search = page.getByPlaceholder('搜索项目');
      await search.fill('直播');
      await expect(page.getByRole('button', { name: /直播回放 11-02/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /产品发布会彩排/ })).toHaveCount(0);
      await search.fill('不存在');
      await expect(page.getByText('没有找到「不存在」相关的项目')).toBeVisible();
      await shot(page, F, `home-no-results-${theme}`);
      await search.fill('');
      await expect(page.getByRole('button', { name: /产品发布会彩排/ })).toBeVisible();
    });

    test(`F-0002/AC-16 拖入文件显示遮罩，拖出后消失且不建项目 (${theme})`, async ({ page }) => {
      const host = await openHome(page, theme, { 'projects.list': threeProjects });
      await expect(page.getByText('3 个项目')).toBeVisible();
      const data = await page.evaluateHandle(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'a.mp4', { type: 'video/mp4' })); return dt; });
      const target = page.getByRole('heading', { name: '我的项目' });
      await target.dispatchEvent('dragenter', { dataTransfer: data });
      await expect(page.getByText('松开即可创建项目')).toBeVisible();
      await shot(page, F, `home-dragging-${theme}`);
      await target.dispatchEvent('dragleave', { dataTransfer: data });
      await expect(page.getByText('松开即可创建项目')).toHaveCount(0);
      expect(host.calls.some(call => call.method === 'projects.create')).toBe(false);
    });

    test(`F-0002/AC-17 选择文件后转圈、按钮不可点，创建成功提示并进入编辑器 (${theme})`, async ({ page }) => {
      let finish!: () => void;
      const created = new Promise<void>(resolve => { finish = resolve; });
      const host = await openHome(page, theme, {
        'projects.create': async () => { await created; return { projectId: uuid(9), videoId: VIDEO_ID, revision: 1 }; },
        'projects.open': () => openResult(uuid(9), '我的口播'),
      });
      await page.getByTestId('project-file-input').setInputFiles({ name: '我的口播.mp4', mimeType: 'video/mp4', buffer: Buffer.from('fake') });
      await expect(page.getByRole('button', { name: '选择文件' })).toBeDisabled();
      await shot(page, F, `home-creating-${theme}`);
      finish();
      await expect(page.getByText('已创建项目「我的口播」')).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`#/projects/${uuid(9)}/videos/${VIDEO_ID}`));
      const create = host.calls.find(call => call.method === 'projects.create');
      // AC-1：名称不含扩展名，媒体以 assetId 传入，不传本地路径
      expect(create?.payload).toMatchObject({ name: '我的口播', videoName: '我的口播.mp4', media: { assetId: UPLOADED_ASSET } });
      expect(JSON.stringify(create?.payload)).not.toContain('path');
    });

    test(`F-0002/AC-18 打开项目时卡片转圈，其他卡片不可点 (${theme})`, async ({ page }) => {
      await openHome(page, theme, { 'projects.list': threeProjects, 'projects.open': pending });
      await page.getByRole('button', { name: /口播：剪辑工作流分享/ }).click();
      await expect(page.getByText('正在打开…')).toBeVisible();
      await expect(page.getByRole('button', { name: /产品发布会彩排/ })).toBeDisabled();
      await shot(page, F, `home-opening-${theme}`);
    });

    test(`F-0002/AC-5 AC-19 打开项目直接进入编辑，不重新转写；面包屑返回首页 (${theme})`, async ({ page }) => {
      const host = await openHome(page, theme, { 'projects.list': threeProjects, 'projects.open': ({ projectId }: { projectId: string }) => openResult(projectId, '口播：剪辑工作流分享') });
      await page.getByRole('button', { name: /口播：剪辑工作流分享/ }).click();
      await expect(page.getByText('今天聊聊剪辑').first()).toBeVisible();
      await expect(page.getByRole('button', { name: /我的项目/ })).toBeVisible();
      await expect(page.getByText('口播：剪辑工作流分享')).toBeVisible();
      expect(host.calls.some(call => call.method === 'asr.start' || call.method === 'providers.prepare')).toBe(false);
      await shot(page, F, `editor-opened-${theme}`);
      await page.getByRole('button', { name: /我的项目/ }).click();
      await expect(page).toHaveURL(/#\/projects$/);
      await expect(page.getByText('3 个项目')).toBeVisible();
    });
  });
}

test('F-0002/AC-12 RPC 报错与网络失败一样显示读取失败', async ({ page }) => {
  await openHome(page, 'light', { 'projects.list': () => { throw new RpcError('disk full'); } });
  await expect(page.getByText('读取项目失败')).toBeVisible();
});
