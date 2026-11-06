// F-0004 崩溃恢复：界面状态与本地副本验收（PRD AC-1 到 AC-10）。
// 本地副本用浏览器真实的 IndexedDB（与产品同一个适配器）；Host 用 tests/e2e/lib/mockHost.ts 模拟，
// 这里的假项目会记住保存过的修改和修订号，所以恢复、冲突和「已经写进 Host」的判断都按真实规则走。
// 客户端崩溃 = 直接关闭页面（不跑 beforeunload、不保存），同一浏览器上下文里再开一个页面重新打开项目。
// Host 侧的稳定身份与幂等另存由 tests/architecture/projects-f0004.test.ts 覆盖；桌面端强退见测试报告的真实使用记录。
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { shot } from '../lib/evidence';
import { E2E_HOST_ID, mockHost, pending, prepare, projectItem, RpcError, uuid, VIDEO_ID, type MockHandlers } from '../lib/mockHost';

const F = 'F-0004';
const THEMES = ['light', 'dark'] as const;
type Theme = typeof THEMES[number];

const P = uuid(41);
const OTHER = uuid(42);
const NAME = '口播：崩溃恢复';
const T0 = '2026-11-06T08:00:00.000Z';
const transcript = {
  text: '大家好 今天聊聊剪辑', language: 'zh', duration: 6, hasWordTimestamps: false,
  chunks: [{ id: 's1', text: '大家好', timestamp: [0, 2] }, { id: 's2', text: '今天聊聊剪辑', timestamp: [2, 6] }],
};

/** 一个会记住保存结果的假项目：修订号、这个视频的修改、项目样式。 */
function fakeProject() {
  const state = { revision: 3, styleRevision: 0, updatedAt: T0, edits: undefined as undefined | { chunks: { id: string; text: string }[] },
    projectStyle: undefined as unknown, status: 'ok' as 'ok' | 'trashed' };
  const open = ({ projectId }: { projectId: string }) => {
    if (state.status === 'trashed') return { status: 'trashed', name: NAME };
    return {
      status: 'ok',
      project: { formatVersion: 2, id: projectId, name: NAME, createdAt: T0, updatedAt: state.updatedAt, revision: state.revision, styleRevision: state.styleRevision, videos: [] },
      video: { id: VIDEO_ID, name: `${NAME}.mp4`, durationSeconds: 6, createdAt: T0, updatedAt: state.updatedAt, hasTranscript: true, revision: state.revision,
        styleSource: 'project', media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1, mimeType: 'video/mp4' } },
      videos: [{ id: VIDEO_ID, name: `${NAME}.mp4`, durationSeconds: 6, createdAt: T0, updatedAt: state.updatedAt, hasTranscript: true, mediaMissing: false,
        hasThumbnail: false, styleSource: 'project', revision: state.revision }],
      transcript, edits: state.edits, projectStyle: state.projectStyle,
      media: { status: 'ok', name: `${NAME}.mp4`, playback: { kind: 'url', path: `/projects/${projectId}/media/${VIDEO_ID}` } },
    };
  };
  const saveVideoEdits = ({ edits, baseRevision, force }: { edits: typeof state.edits; baseRevision: number; force: boolean }) => {
    if (baseRevision !== state.revision && !force) return { status: 'conflict', revision: state.revision, updatedAt: state.updatedAt };
    state.edits = edits; state.revision += 1; state.updatedAt = new Date().toISOString();
    return { status: 'saved', revision: state.revision, projectRevision: state.revision, updatedAt: state.updatedAt };
  };
  const saveProjectStyle = ({ style, baseRevision, force }: { style: unknown; baseRevision: number; force: boolean }) => {
    if (baseRevision !== state.styleRevision && !force) return { status: 'conflict', revision: state.styleRevision, updatedAt: state.updatedAt };
    state.projectStyle = style; state.styleRevision += 1;
    return { status: 'saved', revision: state.styleRevision, projectRevision: state.revision, updatedAt: state.updatedAt };
  };
  /** 「另一个窗口」保存了别的内容 */
  const savedElsewhere = (text: string) => {
    saveVideoEdits({ edits: { chunks: [{ ...transcript.chunks[0], text }, transcript.chunks[1]], deletedWordIds: [] } as never, baseRevision: state.revision, force: false });
  };
  const handlers: MockHandlers = { 'projects.list': () => [projectItem(P, NAME)], 'projects.open': open, 'projects.saveVideoEdits': saveVideoEdits,
    'projects.saveProjectStyle': saveProjectStyle };
  return { state, open, saveVideoEdits, handlers, savedElsewhere };
}
type Fake = ReturnType<typeof fakeProject>;

const editor = (page: Page, videoProject = P) => page.goto(`/#/projects/${videoProject}/videos/${VIDEO_ID}`);
const PLACEHOLDER = /请输入主字幕|Enter main subtitle/;
const firstBox = (page: Page) => page.getByPlaceholder(PLACEHOLDER).first();
/** 编辑区被对话框挡住：点不到 */
const blocked = async (page: Page) => { await expect(firstBox(page).click({ trial: true, timeout: 500 })).rejects.toThrow(); };

async function editAt(page: Page, index: number, text: string) {
  const box = page.getByPlaceholder(PLACEHOLDER).nth(index);
  await box.click(); await box.fill(text); await box.blur();
}

// ---------- 浏览器里的 IndexedDB（与 src/recovery/storage.ts 同一个库） ----------

interface StoredCopy { key: string; sessionId: string; sequence: number; baseVideoRevision: number; recordedAt: string; content: { chunks: { text: string }[] } }

/** 读出所有副本；数据库不存在时按产品的结构建好（否则产品打开时不会再升级）。 */
const copies = (page: Page) => page.evaluate(() => new Promise<unknown[]>((resolve, reject) => {
  const req = indexedDB.open('flycut-recovery', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('copies', { keyPath: 'key' }).createIndex('scope', 'scope');
  req.onerror = () => reject(req.error);
  req.onsuccess = () => {
    const db = req.result; const get = db.transaction('copies').objectStore('copies').getAll();
    get.onsuccess = () => { db.close(); resolve(get.result); };
    get.onerror = () => { db.close(); reject(get.error); };
  };
})) as Promise<StoredCopy[]>;

const putCopies = (page: Page, records: unknown[]) => page.evaluate(records => new Promise<void>((resolve, reject) => {
  const req = indexedDB.open('flycut-recovery', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('copies', { keyPath: 'key' }).createIndex('scope', 'scope');
  req.onerror = () => reject(req.error);
  req.onsuccess = () => {
    const db = req.result; const tx = db.transaction('copies', 'readwrite');
    for (const record of records) tx.objectStore('copies').put(record);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  };
}), records);

const STYLE = { primary: { aspectPreset: 'landscape' }, secondary: {} };
/** 一份预置的副本（与产品写入的格式相同）。样式只放画幅：其余字段与 Host 默认样式比较时不会被当成改动——见 `seededStyle`。 */
function copyRecord(patch: { sessionId?: string; text?: string; recordedAt?: string; base?: number; hostId?: string; projectId?: string; videoId?: string; style?: unknown } = {}) {
  const hostId = patch.hostId ?? E2E_HOST_ID; const projectId = patch.projectId ?? P; const videoId = patch.videoId ?? VIDEO_ID;
  const sessionId = patch.sessionId ?? uuid(900);
  return { schemaVersion: 1, key: `${hostId}|${projectId}|${videoId}|${sessionId}`, scope: `${hostId}|${projectId}|${videoId}`, hostId, projectId, videoId, sessionId,
    sequence: 7, recordedAt: patch.recordedAt ?? '2026-11-06T09:30:00.000Z', baseVideoRevision: patch.base ?? 3, baseStyleRevision: 0, projectName: NAME,
    content: { chunks: [{ ...transcript.chunks[0], text: patch.text ?? '大家好，恢复的修改' }, transcript.chunks[1]], deletedWordIds: [], styleSource: 'project',
      stylePair: patch.style ?? STYLE } };
}

/** 编辑器里实际使用的样式（预置副本时用它，避免样式被当成另一处修改）。 */
async function seededStyle(context: BrowserContext, theme: Theme, fake: Fake) {
  const page = await context.newPage();
  await prepare(page, theme);
  await mockHost(page, { ...fake.handlers, 'projects.saveVideoEdits': pending });
  await editor(page);
  await expect(firstBox(page)).toHaveValue('大家好');
  await editAt(page, 0, '取样式');
  await expect.poll(async () => (await copies(page)).length).toBe(1);
  const [copy] = await copies(page) as unknown as Array<{ content: { stylePair: unknown } }>;
  await page.close();
  // 页面关闭后会话锁释放，这份取样用的副本删掉，不影响测试
  const cleaner = await context.newPage();
  await cleaner.goto('/#/projects');
  await cleaner.evaluate(() => new Promise<void>(resolve => { const req = indexedDB.open('flycut-recovery', 1);
    req.onsuccess = () => { const db = req.result; const tx = db.transaction('copies', 'readwrite'); tx.objectStore('copies').clear(); tx.oncomplete = () => { db.close(); resolve(); }; }; }));
  await cleaner.close();
  return copy.content.stylePair;
}

/** 在一个页面里编辑然后「崩溃」：Host 一直没收到保存，页面直接关闭。返回崩溃前已记录的副本。 */
async function crashAfterEdit(context: BrowserContext, theme: Theme, fake: Fake, text: string | string[], handlers: MockHandlers = {}) {
  const page = await context.newPage();
  await prepare(page, theme);
  await mockHost(page, { ...fake.handlers, 'projects.saveVideoEdits': pending, ...handlers });
  await editor(page);
  await expect(firstBox(page)).toHaveValue(fake.state.edits?.chunks[0].text ?? '大家好');
  for (const version of [text].flat()) {
    await editAt(page, 0, version);
    await expect.poll(async () => (await copies(page)).map(copy => copy.content.chunks[0].text)).toContain(version);
  }
  await page.close();
}

/** 崩溃之后重新打开项目的页面。 */
async function reopen(context: BrowserContext, theme: Theme, fake: Fake, handlers: MockHandlers = {}) {
  const page = await context.newPage();
  await prepare(page, theme);
  const host = await mockHost(page, { ...fake.handlers, ...handlers });
  await editor(page);
  return { page, host };
}

const dialog = (page: Page) => page.getByRole('dialog');
const calls = (host: { calls: { method: string; payload: Record<string, unknown> }[] }, method: string) => host.calls.filter(call => call.method === method);

for (const theme of THEMES) {
  test.describe(`${theme}`, () => {
    test(`F-0004/AC-1 AC-3 AC-5 客户端崩溃后重新打开，发现并恢复最近一次记录的修改 (${theme})`, async ({ context }) => {
      const fake = fakeProject();
      // 记录的是最后一次成功记录的完整状态：改了两版后崩溃，恢复的是第二版
      await crashAfterEdit(context, theme, fake, ['大家好，第一版', '大家好，第二版']);
      // 更早另一个窗口崩溃留下的副本
      const { page, host } = await reopen(context, theme, fake);
      await putCopies(page, [copyRecord({ text: '更早的会话', sessionId: uuid(903), recordedAt: '2020-01-01T00:00:00.000Z' })]);
      await page.reload();
      await expect(dialog(page).getByRole('heading', { name: '发现未保存的修改' })).toBeVisible();
      await expect(dialog(page)).toContainText(/发现此设备上 .+ 记录的修改。恢复前会检查项目的最新版本。/);
      await expect(dialog(page)).toContainText(/项目最后保存于/);
      // 两次崩溃是两个会话：按记录时间倒序列出，默认选最新的
      const radios = dialog(page).getByRole('radio');
      await expect(radios).toHaveCount(2);
      await expect(radios.first()).toBeChecked();
      for (const name of ['恢复修改', '放弃恢复', '稍后']) await expect(dialog(page).getByRole('button', { name })).toBeEnabled();
      // 用户选择前不写项目
      expect(calls(host, 'projects.saveVideoEdits')).toHaveLength(0);
      await shot(page, F, `choose-${theme}`);
      await dialog(page).getByRole('button', { name: '恢复修改' }).click();
      await expect(page.getByText('修改已恢复并保存')).toBeVisible();
      await expect(dialog(page)).toHaveCount(0);
      await expect(firstBox(page)).toHaveValue('大家好，第二版');
      const save = calls(host, 'projects.saveVideoEdits');
      expect(save).toHaveLength(1);
      expect(save[0].payload).toMatchObject({ baseRevision: 3, force: false });
      await expect(page.getByRole('status').filter({ hasText: /已保存/ })).toBeVisible();
      await shot(page, F, `recovered-${theme}`);
      // 只清除这次恢复的副本，另一个会话的副本还在
      await expect.poll(async () => (await copies(page)).map(copy => copy.content.chunks[0].text)).toEqual(['更早的会话']);
      await page.close();
      // 恢复后再强退重开：从 Host 读到同样的结果；剩下那份比 Host 旧，仍可选择，不会自动套用
      const again = await reopen(context, theme, fake);
      await expect(firstBox(again.page)).toHaveValue('大家好，第二版');
      await expect(dialog(again.page).getByRole('heading', { name: '发现未保存的修改' })).toBeVisible();
      await expect(dialog(again.page).getByRole('radio')).toHaveCount(0);
    });

    test(`F-0004/AC-1 停止编辑 1 秒内记录；保存成功后不再提示；旧保存成功不清除更新的修改 (${theme})`, async ({ context, page }) => {
      const fake = fakeProject();
      let release!: () => void; let count = 0;
      await prepare(page, theme);
      await mockHost(page, { ...fake.handlers, 'projects.saveVideoEdits': async (input: Parameters<Fake['saveVideoEdits']>[0]) => {
        count += 1;
        if (count > 1) return pending();
        await new Promise<void>(resolve => { release = resolve; });
        return fake.saveVideoEdits(input);
      } });
      await editor(page);
      await expect(firstBox(page)).toHaveValue('大家好');
      const started = Date.now();
      await editAt(page, 0, '第一处修改');
      await expect.poll(async () => (await copies(page)).length, { intervals: [50] }).toBe(1);
      expect(Date.now() - started).toBeLessThan(1000);
      // 自动保存发出后（Host 还没回复）又改了第二条
      await expect.poll(() => count, { timeout: 4000 }).toBe(1);
      await editAt(page, 1, '第二处修改');
      await expect.poll(async () => (await copies(page))[0]?.content.chunks[1].text).toBe('第二处修改');
      release();
      // 第一次保存成功：副本保留第二处修改，基准修订号推进到这次保存的结果
      await expect.poll(async () => (await copies(page))[0]?.baseVideoRevision).toBe(4);
      expect((await copies(page))[0].content.chunks.map(chunk => chunk.text)).toEqual(['第一处修改', '第二处修改']);
      await page.close();
      const { page: reopened, host } = await reopen(context, theme, fake);
      await expect(dialog(reopened).getByRole('heading', { name: '发现未保存的修改' })).toBeVisible();
      await dialog(reopened).getByRole('button', { name: '恢复修改' }).click();
      await expect(reopened.getByText('修改已恢复并保存')).toBeVisible();
      // 基于本窗口已保存的版本，不是冲突
      expect(calls(host, 'projects.saveVideoEdits')[0].payload).toMatchObject({ baseRevision: 4, force: false });
      await expect(reopened.getByPlaceholder('请输入主字幕').nth(1)).toHaveValue('第二处修改');
      // 正常保存成功后副本删除，再打开不提示
      await expect.poll(async () => (await copies(reopened)).length).toBe(0);
      await editAt(reopened, 0, '保存后的修改');
      await expect(reopened.getByRole('status').filter({ hasText: /已保存/ })).toBeVisible({ timeout: 5000 });
      await expect.poll(async () => (await copies(reopened)).length).toBe(0);
      await reopened.close();
      const last = await reopen(context, theme, fake);
      await expect(firstBox(last.page)).toHaveValue('保存后的修改');
      await last.page.waitForTimeout(500);
      await expect(dialog(last.page)).toHaveCount(0);
    });

    test(`F-0004/AC-1 AC-3 只列出这个 Host、项目、视频的副本，不列出还开着的窗口 (${theme})`, async ({ context, page }) => {
      const fake = fakeProject();
      await prepare(page, theme);
      await mockHost(page, { ...fake.handlers, 'projects.saveVideoEdits': pending });
      await editor(page);
      await expect(firstBox(page)).toHaveValue('大家好');
      await putCopies(page, [copyRecord({ hostId: uuid(77), text: '别的 Host' }), copyRecord({ projectId: OTHER, text: '别的项目' }),
        copyRecord({ videoId: uuid(78), text: '别的视频', sessionId: uuid(901) })]);
      // 这个窗口正在编辑：它的副本属于还开着的会话
      await editAt(page, 0, '另一个窗口正在编辑');
      await expect.poll(async () => (await copies(page)).length).toBe(4);
      const other = await reopen(context, theme, fake);
      await expect(firstBox(other.page)).toHaveValue('大家好');
      await other.page.waitForTimeout(600);
      await expect(dialog(other.page)).toHaveCount(0);
      // 那个窗口崩溃后，它的副本才算待恢复
      await page.close();
      await other.page.close();
      const later = await reopen(context, theme, fake);
      await expect(dialog(later.page).getByRole('heading', { name: '发现未保存的修改' })).toBeVisible();
      await expect(dialog(later.page).getByRole('radio')).toHaveCount(0);
      // 其他 Host、项目、视频的副本原样保留
      expect((await copies(later.page)).map(copy => copy.content.chunks[0].text).sort()).toEqual(['另一个窗口正在编辑', '别的 Host', '别的视频', '别的项目'].sort());
    });

    test(`F-0004/AC-2 检查中挡住编辑区，可以返回首页；检查失败不当作没有副本 (${theme})`, async ({ page }) => {
      const fake = fakeProject();
      await prepare(page, theme);
      // Host 身份一直没有回复（真实环境里 30 秒后请求超时失败）
      let timeOut!: () => void;
      const host = await mockHost(page, { ...fake.handlers, 'projects.identity': () => new Promise((_, reject) => { timeOut = () => reject(new RpcError('timeout')); }) });
      await editor(page);
      const checking = dialog(page).getByRole('status').filter({ hasText: '正在检查恢复内容…' });
      await expect(checking).toBeVisible();
      await expect(dialog(page).getByRole('button', { name: '返回首页' })).toBeEnabled();
      await blocked(page);
      await shot(page, F, `checking-${theme}`);
      await dialog(page).getByRole('button', { name: '返回首页' }).click();
      await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible();
      // Host 身份读取失败：进入 AC-6，不直接进入编辑
      host.set('projects.identity', () => { throw new RpcError('down'); });
      timeOut();
      await editor(page);
      await expect(dialog(page).getByRole('heading', { name: '无法完成恢复' })).toBeVisible();
      host.set('projects.identity', () => ({ hostId: E2E_HOST_ID, recovery: 1 }));
      await dialog(page).getByRole('button', { name: '重试' }).click();
      await expect(dialog(page)).toHaveCount(0);
      await expect(firstBox(page)).toBeEditable();
    });

    test(`F-0004/AC-4 AC-6 恢复中不能重复提交；响应丢失先查询确认 (${theme})`, async ({ context }) => {
      const fake = fakeProject();
      await crashAfterEdit(context, theme, fake, '响应丢失的恢复');
      let release!: () => void;
      const { page, host } = await reopen(context, theme, fake, { 'projects.saveVideoEdits': async (input: Parameters<Fake['saveVideoEdits']>[0]) => {
        await new Promise<void>(resolve => { release = resolve; });
        // Host 写入成功，但响应在路上丢了
        fake.saveVideoEdits(input);
        throw new Error('connection lost');
      } });
      await dialog(page).getByRole('button', { name: '恢复修改' }).click();
      const applying = dialog(page).getByRole('button', { name: '正在恢复…' });
      await expect(applying).toBeDisabled();
      for (const name of ['放弃恢复', '稍后']) await expect(dialog(page).getByRole('button', { name })).toBeDisabled();
      await blocked(page);
      await shot(page, F, `applying-${theme}`);
      release();
      // 查询发现已经写进 Host：按成功处理，不再写第二次
      await expect(page.getByText('修改已恢复并保存')).toBeVisible();
      expect(calls(host, 'projects.saveVideoEdits')).toHaveLength(1);
      await expect(firstBox(page)).toHaveValue('响应丢失的恢复');
    });

    test(`F-0004/AC-6 无法确认结果、目标不存在时保留副本，可重试或返回首页 (${theme})`, async ({ context }) => {
      const fake = fakeProject();
      await crashAfterEdit(context, theme, fake, '还没写进去的修改');
      const { page, host } = await reopen(context, theme, fake);
      await expect(dialog(page).getByRole('heading', { name: '发现未保存的修改' })).toBeVisible();
      // 写入失败、查询也连不上 Host：结果无法确认
      host.set('projects.saveVideoEdits', () => { throw new Error('network'); });
      let opens = 0;
      host.set('projects.open', input => { opens += 1; if (opens > 1) throw new Error('network'); return fake.open(input); });
      await dialog(page).getByRole('button', { name: '恢复修改' }).click();
      await expect(dialog(page).getByRole('heading', { name: '无法完成恢复' })).toBeVisible();
      await expect(dialog(page)).toContainText('恢复未完成，现有项目没有被此操作覆盖。请重试或稍后处理。');
      await expect(dialog(page)).toContainText('暂时无法确认保存结果，重新连接后检查。');
      await expect(dialog(page).getByRole('button', { name: '重试' })).toBeEnabled();
      await expect(dialog(page).getByRole('button', { name: '返回首页' })).toBeEnabled();
      await shot(page, F, `failed-uncertain-${theme}`);
      expect(await copies(page)).toHaveLength(1);
      // 重试时项目已在别处被移到回收站：说明原位置不可用，副本仍保留
      fake.state.status = 'trashed';
      host.set('projects.open', fake.open);
      await dialog(page).getByRole('button', { name: '重试' }).click();
      await expect(dialog(page)).toContainText('原项目或视频已不存在，无法恢复到原位置。');
      await shot(page, F, `failed-missing-${theme}`);
      expect(await copies(page)).toHaveLength(1);
      expect(fake.state.edits).toBeUndefined();
      await dialog(page).getByRole('button', { name: '返回首页' }).click();
      await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible();
      expect(await copies(page)).toHaveLength(1);
    });

    test(`F-0004/AC-6 无法读取的副本不删除，显示无法完成恢复 (${theme})`, async ({ page }) => {
      const fake = fakeProject();
      await prepare(page, theme);
      await mockHost(page, fake.handlers);
      await page.goto('/#/projects');
      await putCopies(page, [{ key: `${E2E_HOST_ID}|${P}|${VIDEO_ID}|broken`, scope: `${E2E_HOST_ID}|${P}|${VIDEO_ID}`, schemaVersion: 99, garbage: true }]);
      await editor(page);
      await expect(dialog(page).getByRole('heading', { name: '无法完成恢复' })).toBeVisible();
      await dialog(page).getByRole('button', { name: '返回首页' }).click();
      expect(await copies(page)).toHaveLength(1);
    });

    test(`F-0004/AC-7 版本冲突：取消回到选择，覆盖必须显式选择 (${theme})`, async ({ context }) => {
      const fake = fakeProject();
      await crashAfterEdit(context, theme, fake, '崩溃前的修改');
      fake.savedElsewhere('另一个窗口后来保存的');
      const { page, host } = await reopen(context, theme, fake);
      await expect(firstBox(page)).toHaveValue('另一个窗口后来保存的');
      await dialog(page).getByRole('button', { name: '恢复修改' }).click();
      await expect(dialog(page).getByRole('heading', { name: '项目已在别处修改' })).toBeVisible();
      await expect(dialog(page)).toContainText('项目已有更新的修改，请选择恢复方式。');
      for (const name of ['用我的版本覆盖', '另存为新项目', '取消']) await expect(dialog(page).getByRole('button', { name })).toBeEnabled();
      await shot(page, F, `conflict-${theme}`);
      expect(calls(host, 'projects.saveVideoEdits')).toHaveLength(0);
      await dialog(page).getByRole('button', { name: '取消' }).click();
      await expect(dialog(page).getByRole('heading', { name: '发现未保存的修改' })).toBeVisible();
      expect(await copies(page)).toHaveLength(1);
      await dialog(page).getByRole('button', { name: '恢复修改' }).click();
      await dialog(page).getByRole('button', { name: '用我的版本覆盖' }).click();
      await expect(page.getByText('修改已恢复并保存')).toBeVisible();
      expect(calls(host, 'projects.saveVideoEdits').at(-1)!.payload).toMatchObject({ force: true });
      await expect(firstBox(page)).toHaveValue('崩溃前的修改');
      await expect.poll(async () => (await copies(page)).length).toBe(0);
    });

    test(`F-0004/AC-7 冲突时另存为新项目：重试不会建出第二个副本，只处理选中的副本 (${theme})`, async ({ context }) => {
      const fake = fakeProject();
      const style = await seededStyle(context, theme, fake);
      fake.savedElsewhere('另一个窗口后来保存的');
      const NEW = uuid(43);
      const duplicates: Array<{ copyId: string }> = [];
      let failOnce = true;
      const { page } = await reopen(context, theme, fake, {
        'projects.duplicate': ({ copyId }: { copyId: string }) => {
          duplicates.push({ copyId });
          if (failOnce) { failOnce = false; throw new Error('response lost'); }
          return { projectId: NEW, videoId: VIDEO_ID, revision: 1 };
        },
        'projects.open': (input: { projectId: string }) => input.projectId === NEW
          ? { ...fake.open(input) as object, project: { ...(fake.open(input) as { project: object }).project, id: NEW, name: `${NAME}（副本）` } } : fake.open(input),
      });
      await putCopies(page, [copyRecord({ text: '要另存的会话', style, recordedAt: '2026-11-06T09:40:00.000Z' }),
        copyRecord({ text: '另一个会话', sessionId: uuid(902), style, recordedAt: '2026-11-06T09:10:00.000Z' })]);
      await page.reload();
      await expect(dialog(page).getByRole('radio')).toHaveCount(2);
      await dialog(page).getByRole('button', { name: '恢复修改' }).click();
      await dialog(page).getByRole('button', { name: '另存为新项目' }).click();
      await expect(dialog(page).getByRole('heading', { name: '无法完成恢复' })).toBeVisible();
      await dialog(page).getByRole('button', { name: '重试' }).click();
      await dialog(page).getByRole('button', { name: '另存为新项目' }).click();
      await expect(page.getByText('修改已恢复并保存')).toBeVisible();
      expect(duplicates).toHaveLength(2);
      expect(duplicates[1].copyId).toBe(duplicates[0].copyId);
      await expect(page).toHaveURL(new RegExp(`#/projects/${NEW}/videos/`));
      // 原项目保持另一个窗口的版本，另一个会话的副本还在
      expect(fake.state.edits?.chunks[0].text).toBe('另一个窗口后来保存的');
      expect((await copies(page)).map(copy => copy.content.chunks[0].text)).toEqual(['另一个会话']);
    });

    test(`F-0004/AC-8 AC-9 放弃需要确认，失败可重试，只移除选中的副本 (${theme})`, async ({ context }) => {
      const fake = fakeProject();
      await crashAfterEdit(context, theme, fake, '要放弃的修改');
      const { page, host } = await reopen(context, theme, fake);
      await dialog(page).getByRole('button', { name: '放弃恢复' }).click();
      await expect(dialog(page).getByRole('heading', { name: '放弃这些未保存的修改？' })).toBeVisible();
      await expect(dialog(page)).toContainText('只会移除此恢复副本，已保存的项目不受影响。');
      await shot(page, F, `discard-confirm-${theme}`);
      await dialog(page).getByRole('button', { name: '取消' }).click();
      await expect(dialog(page).getByRole('heading', { name: '发现未保存的修改' })).toBeVisible();
      expect(await copies(page)).toHaveLength(1);
      // 移除失败：保留确认框，可重试
      await page.evaluate(() => {
        const original = IDBObjectStore.prototype.delete;
        (window as unknown as { restoreDelete: () => void }).restoreDelete = () => { IDBObjectStore.prototype.delete = original; };
        IDBObjectStore.prototype.delete = function () { throw new DOMException('blocked', 'UnknownError'); };
      });
      await dialog(page).getByRole('button', { name: '放弃恢复' }).click();
      await dialog(page).getByRole('button', { name: '放弃恢复' }).click();
      await expect(dialog(page)).toContainText('无法移除恢复副本，请重试。');
      await expect(dialog(page).getByRole('button', { name: '重试' })).toBeEnabled();
      await shot(page, F, `discard-failed-${theme}`);
      // 处理中：按钮不可点
      await page.evaluate(() => {
        (window as unknown as { restoreDelete: () => void }).restoreDelete();
        const original = IDBObjectStore.prototype.get;
        (window as unknown as { restoreGet: () => void }).restoreGet = () => { IDBObjectStore.prototype.get = original; };
        IDBObjectStore.prototype.get = function () { return {} as IDBRequest; };
      });
      await dialog(page).getByRole('button', { name: '重试' }).click();
      await expect(dialog(page).getByRole('status').filter({ hasText: '正在移除恢复副本…' })).toBeVisible();
      await expect(dialog(page).getByRole('button', { name: '取消' })).toBeDisabled();
      await shot(page, F, `discarding-${theme}`);
      await page.close();
      // 重新打开：副本还在（刚才没删成），这次正常放弃
      const again = await reopen(context, theme, fake);
      await dialog(again.page).getByRole('button', { name: '放弃恢复' }).click();
      await dialog(again.page).getByRole('button', { name: '放弃恢复' }).click();
      await expect(again.page.getByText('已放弃恢复')).toBeVisible();
      await expect(dialog(again.page)).toHaveCount(0);
      await expect(firstBox(again.page)).toHaveValue('大家好');
      expect(await copies(again.page)).toHaveLength(0);
      expect(calls(host, 'projects.saveVideoEdits')).toHaveLength(0);
      expect(calls(again.host, 'projects.saveVideoEdits')).toHaveLength(0);
    });

    test(`F-0004/AC-3 稍后返回首页，副本保留，不启动自动保存 (${theme})`, async ({ context }) => {
      const fake = fakeProject();
      await crashAfterEdit(context, theme, fake, '稍后再处理');
      const { page, host } = await reopen(context, theme, fake);
      await dialog(page).getByRole('button', { name: '稍后' }).click();
      await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible();
      expect(await copies(page)).toHaveLength(1);
      expect(calls(host, 'projects.saveVideoEdits')).toHaveLength(0);
      // 再打开一次仍然提示；Host 身份不再重新读取（打开长视频时页面会忙很久，检查不能再等一次 Host 请求）
      const identityCalls = calls(host, 'projects.identity').length;
      await editor(page);
      await expect(dialog(page).getByRole('heading', { name: '发现未保存的修改' })).toBeVisible();
      expect(calls(host, 'projects.identity')).toHaveLength(identityCalls);
    });

    test(`F-0004/AC-10 记录失败时持续提示，不影响 Host 自动保存；重试成功后提示消失 (${theme})`, async ({ page }) => {
      const fake = fakeProject();
      await prepare(page, theme);
      const host = await mockHost(page, { ...fake.handlers, 'projects.saveVideoEdits': () => { throw new RpcError('Host 暂时不可用'); } });
      await editor(page);
      await expect(firstBox(page)).toHaveValue('大家好');
      await page.evaluate(() => {
        const original = IDBObjectStore.prototype.put;
        (window as unknown as { restorePut: () => void }).restorePut = () => { IDBObjectStore.prototype.put = original; };
        IDBObjectStore.prototype.put = function () { throw new DOMException('quota', 'QuotaExceededError'); };
      });
      await editAt(page, 0, '存储满了');
      const banner = page.getByRole('alert').filter({ hasText: '崩溃恢复暂不可用' });
      await expect(banner).toBeVisible();
      await expect(banner).toContainText('临时恢复记录失败，异常退出可能丢失尚未保存的修改。请保存到 Host。');
      // 正式自动保存照常尝试
      await expect.poll(() => calls(host, 'projects.saveVideoEdits').length, { timeout: 4000 }).toBeGreaterThan(0);
      await shot(page, F, `unavailable-${theme}`);
      const before = calls(host, 'projects.saveVideoEdits').length;
      await banner.getByRole('button', { name: '立即保存' }).click();
      await expect.poll(() => calls(host, 'projects.saveVideoEdits').length).toBeGreaterThan(before);
      await expect(banner).toBeVisible();
      await page.evaluate(() => (window as unknown as { restorePut: () => void }).restorePut());
      await banner.getByRole('button', { name: '重试' }).click();
      await expect(banner).toHaveCount(0);
      expect((await copies(page))[0].content.chunks[0].text).toBe('存储满了');
    });

    test(`F-0004/AC-3 AC-6 AC-8 AC-10 English (${theme})`, async ({ context }) => {
      const fake = fakeProject();
      await crashAfterEdit(context, theme, fake, 'Recovered edit');
      const page = await context.newPage();
      await prepare(page, theme);
      const other = fakeProject();
      const host = await mockHost(page, { ...fake.handlers, 'projects.open': (input: { projectId: string }) => input.projectId === OTHER ? other.open(input) : fake.open(input) });
      await editor(page, OTHER);
      await expect(firstBox(page)).toBeVisible();
      await page.getByRole('button', { name: '选择语言' }).click();
      await page.getByRole('menuitem', { name: /English/ }).click();
      await editor(page);
      await expect(dialog(page).getByRole('heading', { name: 'Unsaved changes found' })).toBeVisible();
      await expect(dialog(page)).toContainText(/Changes recorded on this device at .+ are available\. The latest project version will be checked before recovery\./);
      for (const name of ['Recover changes', 'Discard recovery', 'Later']) await expect(dialog(page).getByRole('button', { name })).toBeVisible();
      await shot(page, F, `en-choose-${theme}`);
      await dialog(page).getByRole('button', { name: 'Discard recovery' }).click();
      await expect(dialog(page).getByRole('heading', { name: 'Discard these unsaved changes?' })).toBeVisible();
      await expect(dialog(page)).toContainText("Only this recovery copy will be removed. Your saved project won't change.");
      await shot(page, F, `en-discard-${theme}`);
      await dialog(page).getByRole('button', { name: 'Cancel' }).click();
      host.set('projects.saveVideoEdits', () => { throw new RpcError('down'); });
      await dialog(page).getByRole('button', { name: 'Recover changes' }).click();
      await expect(dialog(page).getByRole('heading', { name: "Couldn't complete recovery" })).toBeVisible();
      await expect(dialog(page)).toContainText("Recovery isn't complete. This operation has not overwritten the existing project. Try again or return later.");
      for (const name of ['Retry', 'Back to projects']) await expect(dialog(page).getByRole('button', { name })).toBeVisible();
      await shot(page, F, `en-failed-${theme}`);
      await dialog(page).getByRole('button', { name: 'Back to projects' }).click();
      // AC-10 English
      await editor(page, OTHER);
      await expect(firstBox(page)).toBeVisible();
      await page.evaluate(() => { IDBObjectStore.prototype.put = function () { throw new DOMException('quota', 'QuotaExceededError'); }; });
      await editAt(page, 0, 'Storage full');
      const banner = page.getByRole('alert').filter({ hasText: 'Crash recovery unavailable' });
      await expect(banner).toContainText("Recovery data couldn't be recorded. A crash may lose changes not yet saved. Save to the Host.");
      for (const name of ['Retry', 'Save now']) await expect(banner.getByRole('button', { name })).toBeVisible();
      await shot(page, F, `en-unavailable-${theme}`);
    });
  });
}
