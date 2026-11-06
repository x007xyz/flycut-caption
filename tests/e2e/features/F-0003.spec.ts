// F-0003 项目管理：界面状态验收（PRD AC-18 到 AC-32，以及 AC-1、AC-6、AC-7、AC-10 的界面部分）。
// Host 用 tests/e2e/lib/mockHost.ts 模拟；Host 本身的存储、回收站、并发保存和格式升级由 tests/architecture/projects-f0003.test.ts 覆盖，
// 两个窗口与真实 Host 的流程（AC-14、AC-15）记录在测试报告的真实使用部分。
import { expect, test, type Page } from '@playwright/test';
import { shot } from '../lib/evidence';
import { mockHost, pending, prepare, projectItem, RpcError, uuid, VIDEO_ID, type MockHandlers } from '../lib/mockHost';

const F = 'F-0003';
const THEMES = ['light', 'dark'] as const;
type Theme = typeof THEMES[number];

const P = uuid(1); const EMPTY = uuid(2); const OLD = uuid(3);
const V1 = VIDEO_ID; const V2 = uuid(12); const V3 = uuid(13);
const NAME = '第 12 期 · 剪辑工作流';
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const DAY = 86_400_000;

const transcript = {
  text: '大家好 今天聊聊剪辑', language: 'zh', duration: 6, hasWordTimestamps: false,
  chunks: [{ id: 's1', text: '大家好', timestamp: [0, 2] }, { id: 's2', text: '今天聊聊剪辑', timestamp: [2, 6] }],
};

const videoSummary = (id: string, name: string, patch: Record<string, unknown> = {}) => ({ id, name, durationSeconds: 125, createdAt: iso(-DAY), updatedAt: iso(),
  hasTranscript: true, mediaMissing: false, hasThumbnail: false, styleSource: 'project', revision: 2, ...patch });
const threeVideos = () => [videoSummary(V1, '开场.mp4'), videoSummary(V2, '正文.mp4', { hasTranscript: false }), videoSummary(V3, '补录.mov', { mediaMissing: true })];
const detail = (videos = threeVideos(), name = NAME) => ({ status: 'ok', project: { id: P, name, createdAt: iso(-DAY), updatedAt: iso(), revision: 5, styleRevision: 1 }, videos });

const homeItems = () => [
  projectItem(P, NAME, { videoCount: 3, durationSeconds: 375, createdAt: iso(-3 * DAY), updatedAt: iso(-60_000) }),
  projectItem(EMPTY, '未命名项目', { videoCount: 0, durationSeconds: 0, videoId: undefined, createdAt: iso(-DAY), updatedAt: iso(-2 * 3600_000) }),
  projectItem(OLD, 'Alpha 口播', { createdAt: iso(-10 * DAY), updatedAt: iso(-5 * DAY) }),
];

/** `projects.open` 的正常返回：多视频项目里的一个视频。 */
function openResult(videoId: string, patch: Record<string, unknown> = {}) {
  const videos = threeVideos();
  const video = videos.find(item => item.id === videoId)!;
  return { status: 'ok', project: { formatVersion: 2, id: P, name: NAME, createdAt: iso(), updatedAt: iso(), revision: 5, styleRevision: 1, videos: [] },
    video: { ...video, media: { kind: 'stored', file: `media/${videoId}.mp4`, size: 1, mimeType: 'video/mp4' } },
    transcript: { ...transcript, chunks: transcript.chunks.map(chunk => ({ ...chunk, text: `${chunk.text}（${video.name}）` })) },
    media: { status: 'ok', name: video.name, playback: { kind: 'url', path: `/projects/${P}/media/${videoId}` } },
    projectStyle: { primary: { color: '#FF4F9A' }, secondary: { color: '#FFFFFF' } }, videos, ...patch };
}

const trashRow = (id: string, name: string, patch: Record<string, unknown> = {}) => ({ ...projectItem(id, name), deletedAt: iso(-2 * DAY), purgeAfter: iso(28 * DAY - 3600_000), ...patch });

async function open(page: Page, theme: Theme, hash: string, handlers: MockHandlers = {}, extra: Record<string, string> = {}) {
  await prepare(page, theme, extra);
  const host = await mockHost(page, { 'projects.list': homeItems, 'projects.detail': () => detail(), 'projects.trashList': () => [], ...handlers });
  await page.goto(`/${hash}`);
  return host;
}
const calls = (host: { calls: { method: string; payload: Record<string, unknown> }[] }, method: string) => host.calls.filter(call => call.method === method);
const dialog = (page: Page) => page.getByRole('dialog');

for (const theme of THEMES) {
  test.describe(`${theme} 首页`, () => {
    test(`F-0003/AC-18 AC-1 新建空项目：创建中三个按钮不可点，建好后进入空的详情页 (${theme})`, async ({ page }) => {
      let finish!: () => void;
      const created = new Promise<void>(resolve => { finish = resolve; });
      const host = await open(page, theme, '#/projects', {
        'projects.createEmpty': async () => { await created; return { projectId: EMPTY, revision: 1 }; },
        'projects.detail': () => ({ status: 'ok', project: { id: EMPTY, name: '未命名项目', createdAt: iso(), updatedAt: iso(), revision: 1, styleRevision: 0 }, videos: [] }),
      });
      await page.getByRole('button', { name: '新建空项目' }).click();
      for (const name of ['新建空项目', '选择文件', '用示例视频试试']) await expect(page.getByRole('button', { name })).toBeDisabled();
      await shot(page, F, `home-creating-empty-${theme}`);
      finish();
      await expect(page).toHaveURL(new RegExp(`#/projects/${EMPTY}$`));
      await expect(page.getByRole('heading', { name: '未命名项目' })).toBeVisible();
      await expect(page.getByText('这个项目还没有视频')).toBeVisible();
      await expect(page.getByText('拖入视频或音频，或点击「添加视频」。')).toBeVisible();
      expect(calls(host, 'projects.createEmpty')[0].payload).toEqual({ name: '未命名项目' });
    });

    test(`F-0003/AC-19 卡片和列表行的菜单，视频数角标、聚合时长和空项目占位 (${theme})`, async ({ page }) => {
      await open(page, theme, '#/projects');
      const multi = page.getByRole('button', { name: new RegExp(NAME) });
      await expect(multi).toContainText('3 个视频');
      await expect(multi).toContainText('6:15');
      const empty = page.getByRole('button', { name: /未命名项目/ });
      await expect(empty).toContainText('0 个视频');
      await expect(empty).toContainText('—');
      // 键盘聚焦卡片时显示「更多操作」
      await multi.focus();
      const more = page.getByRole('button', { name: '更多操作' }).first();
      await expect(more).toHaveCSS('opacity', '1');
      await more.click();
      for (const item of ['打开', '重命名', '删除']) await expect(page.getByRole('menuitem', { name: item })).toBeVisible();
      await shot(page, F, `home-card-menu-${theme}`);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '列表' }).click();
      const row = page.getByRole('row', { name: /未命名项目/ });
      await expect(row).toContainText('—');
      await row.hover();
      await row.getByRole('button', { name: '更多操作' }).click();
      for (const item of ['打开', '重命名', '删除']) await expect(page.getByRole('menuitem', { name: item })).toBeVisible();
      await shot(page, F, `home-list-menu-${theme}`);
    });

    test(`F-0003/AC-20 AC-6 排序：默认最近修改，可按创建时间和名称，与搜索同时生效，重开后保持 (${theme})`, async ({ page }) => {
      await open(page, theme, '#/projects');
      const names = () => page.locator('p[title]').allTextContents();
      const sort = page.getByRole('combobox');
      await expect(sort).toHaveText('最近修改');
      await expect.poll(names).toEqual([NAME, '未命名项目', 'Alpha 口播']);
      await sort.click();
      for (const option of ['最近修改', '创建时间', '名称']) await expect(page.getByRole('option', { name: option })).toBeVisible();
      await shot(page, F, `home-sort-${theme}`);
      await page.getByRole('option', { name: '创建时间' }).click();
      await expect.poll(names).toEqual(['未命名项目', NAME, 'Alpha 口播']);
      await sort.click(); await page.getByRole('option', { name: '名称' }).click();
      // 名称按界面语言（中文）的排序规则：汉字按拼音，排在拉丁字母之前
      const byName = [NAME, '未命名项目', 'Alpha 口播'].sort(new Intl.Collator('zh', { numeric: true, sensitivity: 'base' }).compare);
      await expect.poll(names).toEqual(byName);
      await page.getByPlaceholder('搜索项目').fill('口播');
      await expect.poll(names).toEqual(['Alpha 口播']);
      await page.getByPlaceholder('搜索项目').fill('不存在');
      await expect(page.getByText('没有找到「不存在」相关的项目')).toBeVisible();
      await expect(sort).toBeEnabled();
      await page.reload();
      await expect(page.getByRole('combobox')).toHaveText('名称');
    });

    test(`F-0003/AC-21 AC-2 重命名：填好并全选，空名和未改动不可保存，保存中、失败、取消 (${theme})`, async ({ page }) => {
      let fail = true; let release!: () => void; let list = homeItems();
      const host = await open(page, theme, '#/projects', {
        'projects.list': () => list,
        'projects.rename': async ({ projectId, name }: { projectId: string; name: string }) => {
          await new Promise<void>(resolve => { release = resolve; }); if (fail) throw new RpcError('disk full');
          list = list.map(item => item.id === projectId ? { ...item, name } : item);
          return { status: 'saved', revision: 6, updatedAt: iso() };
        },
      });
      await page.getByRole('button', { name: new RegExp(NAME) }).hover();
      await page.getByRole('button', { name: '更多操作' }).first().click();
      await page.getByRole('menuitem', { name: '重命名' }).click();
      const input = dialog(page).getByLabel('项目名称');
      await expect(dialog(page).getByRole('heading', { name: '重命名项目' })).toBeVisible();
      await expect(input).toHaveValue(NAME);
      expect(await input.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual([0, NAME.length]);
      const save = dialog(page).getByRole('button', { name: '保存' });
      await expect(save).toBeDisabled();
      await input.fill('   ');
      await expect(save).toBeDisabled();
      await input.fill('  第 13 期  ');
      await save.click();
      await expect(input).toBeDisabled();
      await expect(save).toBeDisabled();
      await shot(page, F, `rename-saving-${theme}`);
      release();
      await expect(dialog(page).getByText('重命名失败，请重试')).toBeVisible();
      await shot(page, F, `rename-failed-${theme}`);
      fail = false;
      await save.click(); release();
      await expect(dialog(page)).toHaveCount(0);
      await expect(page.getByRole('button', { name: /第 13 期/ })).toBeVisible();
      expect(calls(host, 'projects.rename').at(-1)!.payload).toEqual({ projectId: P, name: '第 13 期' });
      // Esc 取消，不改名
      await page.getByRole('button', { name: /第 13 期/ }).hover();
      await page.getByRole('button', { name: '更多操作' }).first().click();
      await page.getByRole('menuitem', { name: '重命名' }).click();
      await dialog(page).getByLabel('项目名称').fill('不要这个');
      await page.keyboard.press('Escape');
      await expect(dialog(page)).toHaveCount(0);
      expect(calls(host, 'projects.rename')).toHaveLength(2);
    });

    test(`F-0003/AC-22 AC-3 删除确认移到回收站，提示里撤销等同恢复 (${theme})`, async ({ page }) => {
      let list = homeItems();
      const host = await open(page, theme, '#/projects', {
        'projects.list': () => list,
        'projects.trash': () => { list = list.filter(item => item.id !== P); return { deletedAt: iso(), purgeAfter: iso(30 * DAY) }; },
        'projects.restore': () => { list = homeItems(); return { revision: 7 }; },
      });
      await page.getByRole('button', { name: new RegExp(NAME) }).hover();
      await page.getByRole('button', { name: '更多操作' }).first().click();
      await page.getByRole('menuitem', { name: '删除' }).click();
      await expect(dialog(page).getByRole('heading', { name: `删除项目「${NAME}」？` })).toBeVisible();
      await expect(dialog(page).getByText('项目会移到回收站，30 天内可以恢复，之后自动彻底删除。原始视频文件不受影响。')).toBeVisible();
      await expect(dialog(page).getByRole('button', { name: '取消' })).toBeVisible();
      await shot(page, F, `delete-confirm-${theme}`);
      await dialog(page).getByRole('button', { name: '移到回收站' }).click();
      await expect(page.getByText('已移到回收站')).toBeVisible();
      await expect(page.getByText('2 个项目')).toBeVisible();
      await shot(page, F, `delete-toast-${theme}`);
      await page.getByRole('button', { name: '撤销' }).click();
      await expect(page.getByText(`已恢复「${NAME}」`)).toBeVisible();
      await expect(page.getByText('3 个项目')).toBeVisible();
      expect(calls(host, 'projects.restore')[0].payload).toEqual({ projectId: P });
    });

    test(`F-0003/AC-7 只有一个视频直接进编辑器，多个或没有视频进详情页 (${theme})`, async ({ page }) => {
      const host = await open(page, theme, '#/projects', {
        'projects.open': ({ projectId }: { projectId: string }) => ({ ...openResult(V1), project: { ...openResult(V1).project, id: projectId, name: 'Alpha 口播' },
          videos: [videoSummary(V1, '开场.mp4')] }),
      });
      await page.getByRole('button', { name: new RegExp(NAME) }).click();
      await expect(page).toHaveURL(new RegExp(`#/projects/${P}$`));
      await expect(page.getByRole('heading', { name: NAME })).toBeVisible();
      await page.getByRole('button', { name: '我的项目' }).click();
      await page.getByRole('button', { name: /Alpha 口播/ }).click();
      await expect(page).toHaveURL(new RegExp(`#/projects/${OLD}/videos/${V1}`));
      expect(calls(host, 'projects.open')[0].payload).toMatchObject({ projectId: OLD });
    });
  });

  test.describe(`${theme} 回收站`, () => {
    test(`F-0003/AC-23 回收站：加载中、读取失败可重试、空、有项目 (${theme})`, async ({ page }) => {
      let mode: 'pending' | 'error' | 'empty' | 'rows' = 'pending';
      const host = await open(page, theme, '#/projects', { 'projects.trashList': () => {
        if (mode === 'pending') return pending();
        if (mode === 'error') throw new Error('down');
        return mode === 'empty' ? [] : [trashRow(P, NAME, { videoCount: 3 }), trashRow(OLD, '快过期的项目', { purgeAfter: iso(3 * 3600_000), deletedAt: iso(-30 * DAY + 3 * 3600_000) })];
      } });
      await page.getByRole('button', { name: '回收站' }).click();
      await expect(page).toHaveURL(/#\/trash$/);
      await expect(page.getByRole('heading', { name: '回收站' })).toBeVisible();
      await expect(page.getByText('回收站里的项目会在 30 天后自动彻底删除。')).toBeVisible();
      await expect(page.getByLabel('正在读取项目…')).toBeVisible();
      await shot(page, F, `trash-loading-${theme}`);

      mode = 'error';
      await page.reload();
      await expect(page.getByText('读取项目失败')).toBeVisible();
      await shot(page, F, `trash-error-${theme}`);
      mode = 'empty';
      await page.getByRole('button', { name: '重试' }).click();
      await expect(page.getByText('回收站是空的')).toBeVisible();
      await expect(page.getByRole('button', { name: '清空回收站' })).toHaveCount(0);
      await shot(page, F, `trash-empty-${theme}`);

      mode = 'rows';
      await page.reload();
      const first = page.getByRole('listitem').filter({ hasText: NAME });
      await expect(first).toContainText('3 个视频');
      await expect(first).toContainText('删除于 前天');
      await expect(first).toContainText('28 天后彻底删除');
      await expect(page.getByRole('listitem').filter({ hasText: '快过期的项目' })).toContainText('今天彻底删除');
      await expect(first.getByRole('button', { name: '恢复' })).toBeVisible();
      await expect(first.getByRole('button', { name: '彻底删除' })).toBeVisible();
      await expect(page.getByRole('button', { name: '清空回收站' })).toBeVisible();
      await shot(page, F, `trash-rows-${theme}`);
      // 回收站里的项目不出现在首页和搜索结果里
      await page.getByRole('button', { name: '项目', exact: true }).click();
      await page.getByPlaceholder('搜索项目').fill('快过期');
      await expect(page.getByText('没有找到「快过期」相关的项目')).toBeVisible();
      expect(calls(host, 'projects.trashList').length).toBeGreaterThan(2);
    });

    test(`F-0003/AC-25 AC-4 恢复：转圈，成功后消失并提示，失败保留该行 (${theme})`, async ({ page }) => {
      let release!: () => void; let fail = true;
      await open(page, theme, '#/trash', {
        'projects.trashList': () => [trashRow(P, NAME), trashRow(OLD, 'Alpha 口播')],
        'projects.restore': async () => { await new Promise<void>(resolve => { release = resolve; }); if (fail) throw new RpcError('busy'); return { revision: 7 }; },
      });
      const row = page.getByRole('listitem').filter({ hasText: NAME });
      await row.getByRole('button', { name: '恢复' }).click();
      await expect(row).toHaveAttribute('aria-busy', 'true');
      await expect(row.getByRole('button', { name: '恢复' })).toBeDisabled();
      await shot(page, F, `trash-restoring-${theme}`);
      release();
      await expect(page.getByText('恢复失败，请重试')).toBeVisible();
      await expect(row).toBeVisible();
      fail = false;
      await row.getByRole('button', { name: '恢复' }).click(); release();
      await expect(page.getByText(`已恢复「${NAME}」`)).toBeVisible();
      await expect(page.getByRole('listitem').filter({ hasText: NAME })).toHaveCount(0);
    });

    test(`F-0003/AC-24 AC-5 彻底删除和清空回收站：确认文案、执行中、失败不关闭 (${theme})`, async ({ page }) => {
      let release!: () => void; let fail = true; let rows = [trashRow(P, NAME, { videoCount: 3 }), trashRow(OLD, 'Alpha 口播')];
      const host = await open(page, theme, '#/trash', {
        'projects.trashList': () => rows,
        'projects.purge': async ({ projectId }: { projectId: string }) => {
          await new Promise<void>(resolve => { release = resolve; }); if (fail) throw new RpcError('locked');
          rows = rows.filter(row => row.id !== projectId); return { ok: true };
        },
        'projects.emptyTrash': ({ projectIds }: { projectIds: string[] }) => { rows = rows.filter(row => !projectIds.includes(row.id)); return { purged: projectIds, failed: [] }; },
      });
      await page.getByRole('listitem').filter({ hasText: NAME }).getByRole('button', { name: '彻底删除' }).click();
      await expect(dialog(page).getByRole('heading', { name: `彻底删除「${NAME}」？` })).toBeVisible();
      await expect(dialog(page).getByText('项目里的 3 个视频、字幕和剪辑结果会被永久删除，无法恢复。原始视频文件不受影响。')).toBeVisible();
      await shot(page, F, `purge-confirm-${theme}`);
      await dialog(page).getByRole('button', { name: '彻底删除' }).click();
      await expect(dialog(page).getByRole('button', { name: '彻底删除' })).toBeDisabled();
      await expect(dialog(page).getByRole('button', { name: '取消' })).toBeDisabled();
      await shot(page, F, `purge-busy-${theme}`);
      release();
      await expect(dialog(page).getByText('删除失败，请重试')).toBeVisible();
      await shot(page, F, `purge-failed-${theme}`);
      fail = false;
      await dialog(page).getByRole('button', { name: '彻底删除' }).click(); release();
      await expect(dialog(page)).toHaveCount(0);
      await expect(page.getByRole('listitem').filter({ hasText: NAME })).toHaveCount(0);

      await page.getByRole('button', { name: '清空回收站' }).click();
      await expect(dialog(page).getByRole('heading', { name: '清空回收站？' })).toBeVisible();
      await expect(dialog(page).getByText('回收站里的 1 个项目会被永久删除，无法恢复。原始视频文件不受影响。')).toBeVisible();
      await shot(page, F, `empty-trash-confirm-${theme}`);
      await dialog(page).getByRole('button', { name: '清空回收站' }).click();
      await expect(page.getByText('回收站是空的')).toBeVisible();
      expect(calls(host, 'projects.emptyTrash')[0].payload).toEqual({ projectIds: [OLD] });
    });
  });

  test.describe(`${theme} 项目详情`, () => {
    test(`F-0003/AC-26 详情页：加载中、读取失败可重试且能返回、有视频的各种状态 (${theme})`, async ({ page }) => {
      let mode: 'pending' | 'error' | 'ok' = 'pending';
      await open(page, theme, `#/projects/${P}`, { 'projects.detail': () => mode === 'pending' ? pending() : mode === 'error' ? (() => { throw new Error('down'); })() : detail() });
      await expect(page.getByLabel('正在读取项目…')).toBeVisible();
      await expect(page.getByRole('button', { name: '我的项目' })).toBeEnabled();
      await shot(page, F, `detail-loading-${theme}`);
      mode = 'error';
      await page.reload();
      await expect(page.getByText('读取项目失败')).toBeVisible();
      await shot(page, F, `detail-error-${theme}`);
      mode = 'ok';
      await page.getByRole('button', { name: '重试' }).click();
      await expect(page.getByRole('heading', { name: NAME })).toBeVisible();
      await expect(page.getByText('3 个视频')).toBeVisible();
      await expect(page.getByRole('button', { name: '添加视频' })).toBeEnabled();
      await expect(page.getByRole('button', { name: '重命名' })).toBeVisible();
      await expect(page.getByRole('listitem').filter({ hasText: '开场.mp4' })).toContainText('已转写');
      await expect(page.getByRole('listitem').filter({ hasText: '正文.mp4' })).toContainText('未转写');
      await expect(page.getByRole('listitem').filter({ hasText: '补录.mov' })).toContainText('媒体丢失');
      await expect(page.getByRole('button', { name: '打开编辑' })).toHaveCount(3);
      await shot(page, F, `detail-videos-${theme}`);
      await page.getByRole('listitem').filter({ hasText: '正文.mp4' }).hover();
      await page.getByRole('listitem').filter({ hasText: '正文.mp4' }).getByRole('button', { name: '更多操作' }).click();
      await expect(page.getByRole('menuitem', { name: '移除' })).toBeVisible();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '重命名' }).click();
      await expect(dialog(page).getByLabel('项目名称')).toHaveValue(NAME);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '我的项目' }).click();
      await expect(page).toHaveURL(/#\/projects$/);
    });

    test(`F-0003/AC-27 AC-8 添加视频：拖入遮罩、逐个添加、添加中不可再添加、失败的行可移除 (${theme})`, async ({ page }) => {
      let videos = [videoSummary(V1, '开场.mp4')];
      const releases: Array<() => void> = [];
      const host = await open(page, theme, `#/projects/${P}`, {
        'projects.detail': () => detail(videos),
        'projects.addVideo': async ({ videoName }: { videoName: string }) => {
          await new Promise<void>(resolve => releases.push(resolve));
          if (videoName === '坏文件.mp4') throw new RpcError('cannot read');
          videos = [...videos, videoSummary(uuid(20 + videos.length), videoName, { hasTranscript: false, revision: 0 })];
          return { videoId: uuid(20 + videos.length), revision: 6 };
        },
      });
      await expect(page.getByText('1 个视频')).toBeVisible();
      const data = await page.evaluateHandle(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'a.mp4', { type: 'video/mp4' })); return dt; });
      const target = page.getByRole('heading', { name: NAME });
      await target.dispatchEvent('dragenter', { dataTransfer: data });
      await expect(page.getByText('松开即可添加到这个项目')).toBeVisible();
      await shot(page, F, `detail-dragging-${theme}`);
      await target.dispatchEvent('dragleave', { dataTransfer: data });
      await expect(page.getByText('松开即可添加到这个项目')).toHaveCount(0);

      await page.getByTestId('project-add-input').setInputFiles([
        { name: '正文.mp4', mimeType: 'video/mp4', buffer: Buffer.from('a') },
        { name: '坏文件.mp4', mimeType: 'video/mp4', buffer: Buffer.from('b') },
      ]);
      const adding = page.getByRole('listitem').filter({ hasText: '正文.mp4' });
      await expect(adding).toContainText('正在添加…');
      await expect(page.getByRole('listitem').filter({ hasText: '坏文件.mp4' })).toContainText('正在添加…');
      await expect(page.getByRole('button', { name: '添加视频' })).toBeDisabled();
      await shot(page, F, `detail-adding-${theme}`);
      await expect.poll(() => releases.length).toBe(1);
      releases[0]();
      await expect(page.getByRole('listitem').filter({ hasText: '正文.mp4' })).toContainText('未转写');
      await expect.poll(() => releases.length).toBe(2);
      releases[1]();
      const failed = page.getByRole('listitem').filter({ hasText: '坏文件.mp4' });
      await expect(failed).toContainText('添加失败');
      await expect(page.getByRole('button', { name: '添加视频' })).toBeEnabled();
      await expect(page.getByText('2 个视频')).toBeVisible();
      await shot(page, F, `detail-add-failed-${theme}`);
      await failed.getByRole('button', { name: '移除' }).click();
      await expect(failed).toHaveCount(0);
      // AC-8：每个文件单独一次请求，不传本地路径
      expect(calls(host, 'projects.addVideo').map(call => call.payload.videoName)).toEqual(['正文.mp4', '坏文件.mp4']);
      expect(JSON.stringify(calls(host, 'projects.addVideo'))).not.toContain('path');
    });

    test(`F-0003/AC-26 空项目：拖入区占据列表位置，点击添加 (${theme})`, async ({ page }) => {
      await open(page, theme, `#/projects/${EMPTY}`, { 'projects.detail': () => ({ ...detail([], '未命名项目'), project: { ...detail().project, id: EMPTY, name: '未命名项目' } }) });
      await expect(page.getByText('这个项目还没有视频')).toBeVisible();
      await expect(page.getByText('0 个视频')).toBeVisible();
      await shot(page, F, `detail-empty-${theme}`);
      const chooser = page.waitForEvent('filechooser');
      await page.getByText('这个项目还没有视频').click();
      expect((await chooser).isMultiple()).toBe(true);
    });

    test(`F-0003/AC-28 AC-11 移除视频：确认文案、执行中、失败不关闭、成功后列表更新 (${theme})`, async ({ page }) => {
      let release!: () => void; let fail = true; let videos = threeVideos();
      const host = await open(page, theme, `#/projects/${P}`, {
        'projects.detail': () => detail(videos),
        'projects.removeVideo': async ({ videoId }: { videoId: string }) => {
          await new Promise<void>(resolve => { release = resolve; }); if (fail) throw new RpcError('busy');
          videos = videos.filter(video => video.id !== videoId); return { revision: 6 };
        },
      });
      const row = page.getByRole('listitem').filter({ hasText: '正文.mp4' });
      await row.hover();
      await row.getByRole('button', { name: '更多操作' }).click();
      await page.getByRole('menuitem', { name: '移除' }).click();
      await expect(dialog(page).getByRole('heading', { name: '从项目中移除「正文.mp4」？' })).toBeVisible();
      await expect(dialog(page).getByText('这个视频的字幕和剪辑结果会被删除，无法恢复。原始视频文件不受影响。')).toBeVisible();
      await shot(page, F, `remove-confirm-${theme}`);
      await dialog(page).getByRole('button', { name: '移除' }).click();
      await expect(dialog(page).getByRole('button', { name: '移除' })).toBeDisabled();
      release();
      await expect(dialog(page).getByText('移除失败，请重试')).toBeVisible();
      await shot(page, F, `remove-failed-${theme}`);
      fail = false;
      await dialog(page).getByRole('button', { name: '移除' }).click(); release();
      await expect(dialog(page)).toHaveCount(0);
      await expect(page.getByText('2 个视频')).toBeVisible();
      await expect(page.getByRole('listitem').filter({ hasText: '正文.mp4' })).toHaveCount(0);
      expect(calls(host, 'projects.removeVideo').at(-1)!.payload).toEqual({ projectId: P, videoId: V2 });
    });

    test(`F-0003/AC-29 AC-9 打开视频：该行转圈，其他行变灰不可点，进入编辑器载入保存的字幕 (${theme})`, async ({ page }) => {
      let release!: () => void;
      const host = await open(page, theme, `#/projects/${P}`, {
        'projects.open': async ({ videoId }: { videoId: string }) => { await new Promise<void>(resolve => { release = resolve; }); return openResult(videoId); },
      });
      const row = page.getByRole('listitem').filter({ hasText: '开场.mp4' });
      await row.getByRole('button', { name: '打开编辑' }).click();
      await expect(row.getByRole('button', { name: '正在打开…' })).toBeDisabled();
      for (const name of ['正文.mp4', '补录.mov']) {
        const other = page.getByRole('listitem').filter({ hasText: name });
        await expect(other).toHaveAttribute('aria-disabled', 'true');
        await expect(other.getByRole('button', { name: '打开编辑' })).toBeDisabled();
      }
      await shot(page, F, `detail-opening-${theme}`);
      release();
      await expect(page).toHaveURL(new RegExp(`#/projects/${P}/videos/${V1}`));
      await expect(page.getByPlaceholder('请输入主字幕').first()).toHaveValue('大家好（开场.mp4）');
      expect(calls(host, 'projects.open')).toHaveLength(1);
    });
  });

  test.describe(`${theme} 编辑器`, () => {
    const SAVED = (revision: number) => ({ status: 'saved', revision, projectRevision: revision + 5, updatedAt: iso() });

    async function openEditor(page: Page, handlers: MockHandlers = {}, extra: Record<string, string> = {}) {
      const host = await open(page, theme, `#/projects/${P}/videos/${V1}`, {
        'projects.open': ({ videoId }: { videoId: string }) => openResult(videoId ?? V1),
        'projects.saveVideoEdits': () => SAVED(3), 'projects.saveProjectStyle': () => SAVED(2), ...handlers,
      }, extra);
      await expect(page.getByPlaceholder('请输入主字幕').first()).toHaveValue('大家好（开场.mp4）');
      return host;
    }

    test(`F-0003/AC-30 AC-10 顶栏切换视频：列出全部视频和状态，先保存再切换，切换中显示正在打开，撤销清空 (${theme})`, async ({ page }) => {
      let release: (() => void) | undefined;
      const host = await openEditor(page, {
        'projects.open': async ({ videoId }: { videoId: string }) => {
          if (videoId === V2) await new Promise<void>(resolve => { release = resolve; });
          return openResult(videoId);
        },
      });
      await expect(page.getByRole('button', { name: NAME })).toBeVisible();
      const box = page.getByPlaceholder('请输入主字幕').first();
      await box.click(); await box.fill('改了开场'); await box.blur();
      await page.getByRole('button', { name: '切换视频' }).click();
      const items = page.getByRole('menuitem');
      await expect(items).toHaveCount(3);
      await expect(items.nth(0)).toContainText('开场.mp4');
      await expect(items.nth(0)).toContainText('已转写');
      await expect(items.nth(1)).toContainText('未转写');
      await expect(items.nth(2)).toContainText('媒体丢失');
      await shot(page, F, `editor-switcher-${theme}`);
      await items.nth(1).click();
      await expect(page.getByRole('status').filter({ hasText: '正在打开…' })).toBeVisible();
      await shot(page, F, `editor-switching-${theme}`);
      // 先保存当前视频，再载入目标视频
      await expect.poll(() => calls(host, 'projects.saveVideoEdits').length).toBe(1);
      expect(calls(host, 'projects.saveVideoEdits')[0].payload).toMatchObject({ videoId: V1, baseRevision: 2 });
      await expect.poll(() => !!release).toBe(true);
      release!();
      await expect(page).toHaveURL(new RegExp(`#/projects/${P}/videos/${V2}`));
      await expect(page.getByPlaceholder('请输入主字幕').first()).toHaveValue('大家好（正文.mp4）');
      await expect(page.getByRole('button', { name: '撤销' })).toBeDisabled();
      // 点击项目名进入项目详情页
      await page.getByRole('button', { name: NAME }).click();
      await expect(page).toHaveURL(new RegExp(`#/projects/${P}$`));
    });

    test(`F-0003/AC-30 单视频项目只显示项目名，点击进入详情页 (${theme})`, async ({ page }) => {
      await openEditor(page, { 'projects.open': () => openResult(V1, { videos: [videoSummary(V1, '开场.mp4')] }) });
      await expect(page.getByRole('button', { name: '切换视频' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: NAME })).toBeVisible();
      await shot(page, F, `editor-single-${theme}`);
    });

    test(`F-0003/AC-31 AC-12 AC-13 样式来源：跟随项目、单独设置、恢复跟随要确认，一次性提示 (${theme})`, async ({ page }) => {
      const host = await openEditor(page);
      const bar = page.getByTestId('style-source');
      await expect(bar).toContainText('跟随项目样式');
      await shot(page, F, `style-following-${theme}`);
      // 跟随项目时改样式：写进项目样式，并提示一次
      const presets = page.locator('.subtitle-preset-btn');
      await presets.nth(5).click();
      const hint = page.getByText('样式修改会应用到这个项目里所有跟随项目样式的视频');
      await expect(hint).toBeVisible();
      await expect.poll(() => calls(host, 'projects.saveProjectStyle').length).toBe(1);
      expect(calls(host, 'projects.saveProjectStyle')[0].payload).toMatchObject({ projectId: P, baseRevision: 1 });
      await shot(page, F, `style-shared-hint-${theme}`);
      await page.getByRole('button', { name: '知道了' }).click();
      await expect(hint).toHaveCount(0);

      await bar.getByRole('button', { name: '为这个视频单独设置' }).click();
      await expect(bar).toContainText('这个视频使用单独的样式');
      await expect.poll(() => calls(host, 'projects.saveVideoEdits').length).toBe(1);
      expect(calls(host, 'projects.saveVideoEdits')[0].payload).toMatchObject({ videoId: V1, styleSource: 'custom' });
      await shot(page, F, `style-custom-${theme}`);
      await bar.getByRole('button', { name: '恢复跟随项目' }).click();
      await expect(dialog(page).getByRole('heading', { name: '恢复跟随项目' })).toBeVisible();
      await expect(dialog(page).getByText('恢复后，这个视频的单独样式会被丢弃。')).toBeVisible();
      await shot(page, F, `style-follow-confirm-${theme}`);
      await dialog(page).getByRole('button', { name: '取消' }).click();
      await expect(bar).toContainText('这个视频使用单独的样式');
      await bar.getByRole('button', { name: '恢复跟随项目' }).click();
      await dialog(page).getByRole('button', { name: '恢复跟随' }).click();
      await expect(bar).toContainText('跟随项目样式');
      await expect.poll(() => calls(host, 'projects.saveVideoEdits').length).toBe(2);
      expect(calls(host, 'projects.saveVideoEdits')[1].payload).toMatchObject({ styleSource: 'project' });
      expect((calls(host, 'projects.saveVideoEdits')[1].payload.edits as Record<string, unknown>).stylePair).toBeUndefined();
      // 关闭过的提示，同一项目不再显示
      await presets.nth(6).click();
      await expect.poll(() => calls(host, 'projects.saveProjectStyle').length).toBe(2);
      await expect(hint).toHaveCount(0);
    });

    test(`F-0003/AC-32 AC-15 项目在别处移到回收站：保存暂停，恢复项目并保存 (${theme})`, async ({ page }) => {
      let trashed = true;
      const host = await openEditor(page, {
        'projects.saveVideoEdits': () => trashed ? { status: 'trashed' } : SAVED(3),
        'projects.restore': () => { trashed = false; return { revision: 8 }; },
      });
      const box = page.getByPlaceholder('请输入主字幕').first();
      await box.click(); await box.fill('别处删除后还在改'); await box.blur();
      await expect(dialog(page).getByRole('heading', { name: '项目已被删除' })).toBeVisible();
      await expect(dialog(page).getByText(`「${NAME}」已在另一个窗口或设备上被删除，当前的修改没有保存。`)).toBeVisible();
      for (const name of ['恢复项目并保存', '另存为新项目', '放弃修改']) await expect(dialog(page).getByRole('button', { name })).toBeVisible();
      // 对话框打开时外面的内容对读屏隐藏，用 CSS 选择器找顶栏的保存状态
      await expect(page.locator('[role=status]').filter({ hasText: '保存已暂停' })).toBeVisible();
      await shot(page, F, `deleted-trashed-${theme}`);
      await dialog(page).getByRole('button', { name: '恢复项目并保存' }).click();
      await expect(dialog(page)).toHaveCount(0);
      await expect.poll(() => calls(host, 'projects.saveVideoEdits').length).toBe(2);
      expect((calls(host, 'projects.saveVideoEdits')[1].payload.edits as { chunks: { text: string }[] }).chunks[0].text).toBe('别处删除后还在改');
      await expect(page.getByRole('status').filter({ hasText: '已保存' })).toBeVisible();
    });

    test(`F-0003/AC-32 项目已彻底删除：只能另存为新项目或放弃修改 (${theme})`, async ({ page }) => {
      const COPY = uuid(30);
      const host = await openEditor(page, {
        'projects.saveVideoEdits': ({ projectId }: { projectId: string }) => projectId === P ? { status: 'deleted' } : SAVED(1),
        'projects.createFromSnapshot': () => ({ projectId: COPY, videoId: V1 }),
        'projects.open': ({ projectId, videoId }: { projectId: string; videoId: string }) => projectId === COPY
          ? openResult(V1, { project: { ...openResult(V1).project, id: COPY, name: `${NAME}（副本）` }, media: { status: 'missing', name: '开场.mp4' } })
          : openResult(videoId ?? V1),
      });
      const box = page.getByPlaceholder('请输入主字幕').first();
      await box.click(); await box.fill('要保住的修改'); await box.blur();
      await expect(dialog(page).getByRole('heading', { name: '项目已被删除' })).toBeVisible();
      await expect(dialog(page).getByRole('button', { name: '恢复项目并保存' })).toHaveCount(0);
      await expect(dialog(page).getByRole('button', { name: '另存为新项目' })).toBeVisible();
      await expect(dialog(page).getByRole('button', { name: '放弃修改' })).toBeVisible();
      await shot(page, F, `deleted-permanently-${theme}`);
      await dialog(page).getByRole('button', { name: '另存为新项目' }).click();
      await expect(page).toHaveURL(new RegExp(`#/projects/${COPY}/videos/`));
      const created = calls(host, 'projects.createFromSnapshot')[0].payload as { name: string; edits: { chunks: { text: string }[] } };
      expect(created.name).toBe(`${NAME}（副本）`);
      expect(created.edits.chunks[0].text).toBe('要保住的修改');
      // 媒体已随原项目删除：进入 F-0002 的媒体丢失流程
      await expect(page.getByText('找不到这个项目的视频文件')).toBeVisible();
    });

    test(`F-0003/AC-32 放弃修改回到首页 (${theme})`, async ({ page }) => {
      await openEditor(page, { 'projects.saveVideoEdits': () => ({ status: 'deleted' }) });
      const box = page.getByPlaceholder('请输入主字幕').first();
      await box.click(); await box.fill('不要了'); await box.blur();
      await dialog(page).getByRole('button', { name: '放弃修改' }).click();
      await expect(page).toHaveURL(/#\/projects$/);
      await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible();
    });
  });
}

// ---------- 英文界面（各页面的关键状态） ----------

test.describe('English', () => {
  /** 界面语言只能在编辑器顶栏切换；切换后在应用内导航，语言保持。 */
  async function english(page: Page, theme: Theme, handlers: MockHandlers = {}) {
    await prepare(page, theme);
    const host = await mockHost(page, { 'projects.list': homeItems, 'projects.detail': () => detail(),
      'projects.trashList': () => [trashRow(P, NAME, { videoCount: 3 })], 'projects.open': ({ videoId }: { videoId: string }) => openResult(videoId ?? V1), ...handlers });
    await page.goto(`/#/projects/${P}/videos/${V1}`);
    await expect(page.getByPlaceholder('请输入主字幕').first()).toBeVisible();
    await page.getByRole('button', { name: '选择语言' }).click();
    await page.getByRole('menuitem', { name: /English/ }).click();
    await expect(page.getByRole('button', { name: 'Switch video' })).toBeVisible();
    return host;
  }

  for (const theme of THEMES) {
    test(`F-0003/AC-18 AC-19 AC-20 AC-23 AC-26 AC-30 AC-31 English labels (${theme})`, async ({ page }) => {
      await english(page, theme);
      await expect(page.getByTestId('style-source')).toContainText('Following project style');
      await page.getByRole('button', { name: 'Switch video' }).click();
      await expect(page.getByRole('menuitem').nth(1)).toContainText('Not transcribed');
      await shot(page, F, `en-editor-switcher-${theme}`);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: NAME }).click();
      await expect(page.getByRole('button', { name: 'Add video' })).toBeVisible();
      await expect(page.getByText('3 videos')).toBeVisible();
      await expect(page.getByRole('listitem').filter({ hasText: '补录.mov' })).toContainText('Media missing');
      await shot(page, F, `en-detail-${theme}`);
      await page.getByRole('button', { name: 'My projects' }).click();
      await expect(page.getByRole('button', { name: 'New empty project' })).toBeVisible();
      await expect(page.getByRole('combobox')).toHaveText('Last modified');
      await shot(page, F, `en-home-${theme}`);
      await page.getByRole('button', { name: 'Trash' }).click();
      await expect(page.getByText('Projects in Trash are deleted permanently after 30 days.')).toBeVisible();
      await expect(page.getByRole('listitem').filter({ hasText: NAME })).toContainText(/Deleted permanently in \d+ days/);
      await expect(page.getByRole('button', { name: 'Empty Trash' })).toBeVisible();
      await shot(page, F, `en-trash-${theme}`);
      await page.getByRole('button', { name: 'Delete permanently' }).click();
      await expect(dialog(page).getByText('Its 3 videos, subtitles and edits will be deleted permanently and cannot be restored. Your original video files are not affected.')).toBeVisible();
    });

    test(`F-0003/AC-22 AC-32 English dialogs (${theme})`, async ({ page }) => {
      await english(page, theme, { 'projects.saveVideoEdits': () => ({ status: 'trashed' }), 'projects.saveProjectStyle': () => ({ status: 'trashed' }) });
      const box = page.getByPlaceholder(/subtitle/i).first();
      await box.click(); await box.fill('changed'); await box.blur();
      await expect(dialog(page).getByRole('heading', { name: 'Project was deleted' })).toBeVisible();
      for (const name of ['Restore and save', 'Save as new project', 'Discard changes']) await expect(dialog(page).getByRole('button', { name })).toBeVisible();
      await shot(page, F, `en-deleted-${theme}`);
      await dialog(page).getByRole('button', { name: 'Discard changes' }).click();
      await page.getByRole('button', { name: new RegExp(NAME) }).hover();
      await page.getByRole('button', { name: 'More actions' }).first().click();
      await page.getByRole('menuitem', { name: 'Delete' }).click();
      await expect(dialog(page).getByText('The project moves to Trash. You can restore it within 30 days; after that it is deleted permanently. Your original video files are not affected.')).toBeVisible();
      await expect(dialog(page).getByRole('button', { name: 'Move to Trash' })).toBeVisible();
      await shot(page, F, `en-delete-confirm-${theme}`);
    });
  }
});
