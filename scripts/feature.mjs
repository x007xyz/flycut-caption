// 需求流程工具：按 docs/00-process/README.md 的层级、阶段和门禁管理产品规划、Epic、需求与批次。
//
//   pnpm feature status [E-05 | F-0001 | B-01]
//   pnpm feature check
//   pnpm feature epic <slug> "<标题>"
//   pnpm feature new <slug> "<标题>" --epic E-05 [--type spike] [--depends F-0002,F-0003]
//   pnpm feature depends F-0001 F-0002 F-0003   （--clear 清空）
//   pnpm feature next F-0001
//   pnpm feature ai-review F-0001 --by <审查员> [--stage <阶段>] [--fail "<原因>"]
//   pnpm feature review <VISION | E-05 | F-0001>
//   pnpm feature approve <VISION | E-05 | F-0001 ...> --by <名字> [--stage <阶段>]
//   pnpm feature batch new <slug> "<标题>" F-0001 F-0002 ... [--docs E-05,ROADMAP]
//   pnpm feature batch add B-01 F-0003 ... [--docs E-05]
//   pnpm feature batch sync [B-01]
//   pnpm feature batch status [B-01]
//   pnpm feature approve B-01 --by <名字>        （批次的「方案确认」或「验收」节点）
//   pnpm feature release-notes <版本，例如 v2.1.0>
//   pnpm feature archive <F-0001 ...> --release <版本>
//   pnpm feature adr <slug> "<标题>" [--feature F-0001]
//   pnpm feature incident <slug> "<标题>" [--feature F-0001]
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FEATURES = 'docs/features';
const ARCHIVE = join(FEATURES, 'archive');
const BATCHES = join(FEATURES, 'batches');
const PRODUCT = 'docs/10-product';
const EPICS = join(PRODUCT, 'epics');
const TEMPLATES = 'docs/00-process/templates';
const PRODUCT_DOCS = { VISION: 'vision.md', 'CAPABILITY-MAP': 'capability-map.md', ROADMAP: 'roadmap.md' };
// Epic 获批前必须先确认的产品级文档
const EPIC_PREREQUISITES = ['VISION', 'CAPABILITY-MAP'];

// 维护者只在两个节点确认（批次的「方案确认」和「验收」），其他阶段由 AI 审查员或脚本检查确认：
// - 人工：01-spec、02-design 在「方案确认」一起确认；04-test-report 在「验收」一起确认
// - AI：02-research 经独立 AI 审查通过即确认，结论汇总进批次的下一个人工节点
// - 脚本：03-implementation 检查清单通过即确认
const STAGES = {
  feature: ['01-spec', '02-design', '03-implementation', '04-test-report'],
  spike: ['01-spec', '02-research'],
};
const STAGE_NAMES = {
  '01-spec': '需求说明', '02-research': '调研', '02-design': '技术设计',
  '03-implementation': '开发', '04-test-report': '测试与验收',
};
// 最后一个阶段确认后，需求就算「完成」，依赖它的需求才能开始开发
const DONE_STAGE = { feature: '04-test-report', spike: '02-research' };
// 需要依赖全部完成（或同批次测试报告通过 AI 审查）才能进入的阶段
const GATED_STAGE = { feature: '03-implementation', spike: '02-research' };
const DONE = new Set(['approved']);
const HUMAN_STAGES = new Set(['01-spec', '02-design', '04-test-report']);
const AI_STAGES = new Set(['02-research']);
const AUTO_STAGES = new Set(['03-implementation']);
// 提交确认前必须先由独立的 AI 审查员通过
const AI_REVIEWED = new Set([...HUMAN_STAGES, ...AI_STAGES]);
const AUTO_BY = 'auto';
const RELEASES = 'docs/40-ops/releases';
// 创建某个阶段前必须已经确认的阶段（02-design 只需要 01-spec 已提交，见 missingPrerequisites）
const PREREQUISITES = {
  '02-design': ['01-spec'],
  '03-implementation': ['01-spec', '02-design'],
  '04-test-report': ['03-implementation'],
  '02-research': ['01-spec'],
};
// 批次「方案确认」要一起看的阶段
const PLAN_STAGES = { feature: ['01-spec', '02-design'], spike: ['01-spec'] };
const EXEC_LABEL = { '02-research': '02 调研（AI 确认）', '03-implementation': '03 开发', '04-test-report': '04 验收' };
const DOC_READY = new Set(['review', 'approved']);
const WAITING_BATCH = new Set(['plan-review', 'acceptance-review']);

const [command, ...rest] = process.argv.slice(2);
const positional = rest.filter((arg, i) => !arg.startsWith('--') && !rest[i - 1]?.startsWith('--'));
const option = (name) => {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] : undefined;
};
const flag = (name) => rest.includes(`--${name}`);

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

// 本地日期，避免 UTC 跨日
const today = () => new Date().toLocaleDateString('sv-SE');
const pad = (n, width = 4) => String(n).padStart(width, '0');
const splitList = (value) => (value ?? '').replace(/^\[|\]$/g, '').split(/[,，、\s]+/).map((s) => s.trim()).filter((s) => s && s !== '—' && s !== '-');
const unique = (items) => [...new Set(items)];
const nid = (id) => id.replace('-', '');
const esc = (text) => String(text).replace(/"/g, '#quot;');
const cell = (text) => String(text).replace(/\|/g, '\\|');

function listDirs(dir) {
  return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
}

function listFiles(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
}

// 编号只增不减：归档的也参与计数
function nextNumber(names, pattern) {
  const used = names.map((name) => Number(name.match(pattern)?.[1])).filter(Boolean);
  return Math.max(0, ...used) + 1;
}

function readFrontmatter(file) {
  const block = readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const fields = {};
  for (const line of block.split('\n')) {
    const match = line.match(/^(\w+):\s*([^#]*?)\s*(#.*)?$/);
    if (match) fields[match[1]] = match[2];
  }
  return fields;
}

// 更新或新增 frontmatter 字段；保留原行尾的注释（例如模板里的「# 说明」）
function writeFrontmatter(file, updates) {
  let text = readFileSync(file, 'utf8');
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}: ${value}`.trimEnd();
    const pattern = new RegExp(`^(---\\n[\\s\\S]*?)^${key}:(.*)$`, 'm');
    text = pattern.test(text)
      ? text.replace(pattern, (_, head, tail) => `${head}${line}${tail.match(/\s{2,}#.*$/)?.[0] ?? ''}`)
      : text.replace(/\n---\n/, () => `\n${line}\n---\n`);
  }
  writeFileSync(file, text);
}

function render(template, values) {
  return readFileSync(join(TEMPLATES, template), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? '');
}

function slugOf(raw) {
  const slug = (raw ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) fail('需要一个英文 slug，例如 voice-dubbing');
  return slug;
}

// ---------- 产品级文档与 Epic ----------

// 找不到时返回 null
function findDoc(id) {
  if (PRODUCT_DOCS[id]) {
    const file = join(PRODUCT, PRODUCT_DOCS[id]);
    return existsSync(file) ? { id, file, kind: 'product', ...readFrontmatter(file) } : null;
  }
  if (!/^E-\d{2}$/.test(id ?? '')) return null;
  const name = listFiles(EPICS).find((f) => f.startsWith(`${id}-`));
  if (!name) return null;
  const file = join(EPICS, name);
  const title = readFileSync(file, 'utf8').match(/^# E-\d{2} (.*)$/m)?.[1] ?? '';
  return { id, file, kind: 'epic', title, ...readFrontmatter(file) };
}

// 命令行参数里的文档编号：找不到就退出
function loadDoc(id) {
  const doc = findDoc(id);
  if (!doc && (PRODUCT_DOCS[id] || /^E-\d{2}$/.test(id ?? ''))) fail(`找不到 ${id}`);
  return doc;
}

const allEpics = () => listFiles(EPICS).map((f) => f.slice(0, 4)).filter((id) => /^E-\d{2}$/.test(id)).map(loadDoc);

// ---------- 需求 ----------

function loadFeature(dir, archived = false) {
  const intake = join(dir, '01-spec.md');
  const meta = readFrontmatter(intake);
  const type = meta.type === 'spike' ? 'spike' : 'feature';
  const stages = STAGES[type].filter((stage) => existsSync(join(dir, `${stage}.md`)))
    .map((stage) => ({ stage, file: join(dir, `${stage}.md`), ...readFrontmatter(join(dir, `${stage}.md`)) }));
  const heading = readFileSync(intake, 'utf8').match(/^# F-\d{4} (.*?)：/m);
  return {
    dir, archived, type, id: dir.split('/').pop().slice(0, 6), title: heading?.[1] ?? '',
    epic: meta.epic ?? '', depends: splitList(meta.depends_on), releasedIn: meta.released_in ?? '', stages, current: stages.at(-1),
  };
}

function allFeatures() {
  return [
    ...listDirs(FEATURES).filter((d) => /^F-\d{4}-/.test(d)).map((d) => loadFeature(join(FEATURES, d))),
    ...listDirs(ARCHIVE).filter((d) => /^F-\d{4}-/.test(d)).map((d) => loadFeature(join(ARCHIVE, d), true)),
  ];
}

function findFeature(id, { allowArchived = false } = {}) {
  if (!/^F-\d{4}$/.test(id ?? '')) fail('需求编号格式是 F-0001');
  const feature = allFeatures().find((f) => f.id === id);
  if (!feature) fail(`找不到 ${id}`);
  if (feature.archived && !allowArchived) fail(`${id} 已归档`);
  return feature;
}

// 重新读取一个需求（写入之后用）
const reload = (id) => allFeatures().find((f) => f.id === id);

// ---------- 实现清单（02-design.md 的「实现清单」） ----------

// 返回未勾选的清单项；没有清单时返回 null
function openChecklist(feature) {
  const file = join(feature.dir, '02-design.md');
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const section = text.match(/^## 实现清单\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1];
  if (section === undefined) return null;
  const items = [...section.matchAll(/^\s*- \[( |x|X)\] (.+)$/gm)];
  if (!items.length) return null;
  return items.filter((m) => m[1] === ' ').map((m) => m[2].trim());
}

// ---------- 批次 ----------

function loadBatch(file) {
  const meta = readFrontmatter(file);
  return { ...meta, id: file.split('/').pop().slice(0, 4), file, features: splitList(meta.features), docs: splitList(meta.docs) };
}

function loadBatches() {
  return listFiles(BATCHES)
    .filter((f) => /^B-\d{2}-/.test(f))
    .map((f) => loadBatch(join(BATCHES, f)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// 一次命令里用到的全部需求和批次
function loadContext() {
  return { features: allFeatures(), batches: loadBatches() };
}

function findBatch(id, ctx = loadContext()) {
  if (!/^B-\d{2}$/.test(id ?? '')) fail('批次编号格式是 B-01');
  return ctx.batches.find((b) => b.id === id) ?? fail(`找不到 ${id}`);
}

const batchMembers = (batch, features) => batch.features.map((id) => features.find((f) => f.id === id)).filter(Boolean);

// 方案就绪：需求说明和技术设计都已提交（review 或 approved）
const planReady = (feature) => PLAN_STAGES[feature.type].every((name) => DOC_READY.has(feature.stages.find((s) => s.stage === name)?.status));
// 验收就绪：测试报告已提交，等维护者验收
const finalReviewPending = (feature) => feature.stages.find((s) => s.stage === '04-test-report')?.status === 'review';

// 批次状态由脚本计算：planning → plan-review → executing → acceptance-review → done
function batchStatus(batch, features) {
  const members = batchMembers(batch, features);
  if (!members.length || members.length !== batch.features.length) return 'planning';
  if (members.every(isFeatureDone)) return 'done';
  if (batch.plan_approved_by) {
    return members.every((f) => isFeatureDone(f) || finalReviewPending(f)) ? 'acceptance-review' : 'executing';
  }
  const docsReady = batch.docs.every((id) => DOC_READY.has(findDoc(id)?.status));
  return docsReady && members.every(planReady) ? 'plan-review' : 'planning';
}

const isOpenBatch = (batch, features) => batchStatus(batch, features) !== 'done';
const openBatchOf = (id, ctx) => ctx.batches.find((b) => b.features.includes(id) && isOpenBatch(b, ctx.features));
const sharesOpenBatch = (a, b, ctx) => ctx.batches.some((batch) => batch.features.includes(a.id) && batch.features.includes(b.id) && isOpenBatch(batch, ctx.features));

// 需求加入批次前的检查：存在、未归档、没在别的未完成批次里
function validateMembers(ids, ctx, batchId) {
  const seen = new Set();
  for (const id of ids) {
    if (!/^F-\d{4}$/.test(id)) fail(`需求编号格式是 F-0001：${id}`);
    if (seen.has(id)) fail(`${id} 写了两次`);
    seen.add(id);
    const feature = ctx.features.find((f) => f.id === id) ?? fail(`找不到 ${id}`);
    if (feature.archived) fail(`${id} 已归档`);
    const open = openBatchOf(id, ctx);
    if (open && open.id !== batchId) fail(`${id} 已在未完成的批次 ${open.id} 里，一个需求同一时间只能属于一个未完成的批次`);
  }
}

function validateDocs(ids) {
  for (const id of ids) if (!loadDoc(id)) fail(`找不到文档 ${id}`);
}

// ---------- 依赖判定 ----------

function isFeatureDone(feature) {
  if (feature.archived) return true;
  const done = feature.stages.find((s) => s.stage === DONE_STAGE[feature.type]);
  return Boolean(done && DONE.has(done.status));
}

// 返回依赖未满足的原因；空数组表示全部满足。
// 同一个未完成批次里，依赖的测试报告已通过 AI 审查即可开始开发，不用等维护者验收。
function unmetDependencies(feature, ctx = loadContext()) {
  const problems = [];
  for (const dep of feature.depends) {
    const target = ctx.features.find((f) => f.id === dep);
    if (!target) { problems.push(`${dep} 不存在`); continue; }
    if (isFeatureDone(target)) continue;
    const sameBatch = target.type === 'feature' && sharesOpenBatch(feature, target, ctx);
    if (sameBatch && target.stages.find((s) => s.stage === '04-test-report')?.ai_review === 'pass') continue;
    problems.push(sameBatch
      ? `${dep} 未完成（同批次需要验收报告通过 AI 审查，否则需要「测试与验收」确认）`
      : `${dep} 未完成（需要「${STAGE_NAMES[DONE_STAGE[target.type]]}」确认）`);
  }
  return problems;
}

function findCycle(nodes, edgesOf) {
  const state = new Map();
  const stack = [];
  const visit = (node) => {
    if (state.get(node) === 'done') return null;
    if (state.get(node) === 'visiting') return [...stack.slice(stack.indexOf(node)), node];
    state.set(node, 'visiting');
    stack.push(node);
    for (const next of edgesOf(node)) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(node, 'done');
    return null;
  };
  for (const node of nodes) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return null;
}

const featureEdges = (features) => (id) => (features.find((f) => f.id === id)?.depends ?? []).filter((d) => d !== id);

function validateDepends(featureId, deps) {
  const features = allFeatures();
  for (const dep of deps) {
    if (!/^F-\d{4}$/.test(dep)) fail(`依赖只能写需求编号，例如 F-0001：${dep}`);
    if (dep === featureId) fail('不能依赖自己');
    if (!features.some((f) => f.id === dep)) fail(`${dep} 不存在`);
  }
  const updated = features.map((f) => (f.id === featureId ? { ...f, depends: deps } : f));
  if (!updated.some((f) => f.id === featureId)) updated.push({ id: featureId, depends: deps });
  const cycle = findCycle(updated.map((f) => f.id), featureEdges(updated));
  if (cycle) fail(`依赖成环：${cycle.join(' → ')}`);
}

// ---------- 阶段推进 ----------

// 创建某阶段前还没确认的前置阶段；02-design 只要求 01-spec 已提交（review）
function missingPrerequisites(feature, stage) {
  return (PREREQUISITES[stage] ?? []).flatMap((name) => {
    const ok = stage === '02-design' ? ['review', 'approved'] : ['approved'];
    const status = feature.stages.find((s) => s.stage === name)?.status;
    return ok.includes(status) ? [] : [`需要「${STAGE_NAMES[name]}」先确认`];
  });
}

// 计划下一阶段：返回 { error } 或 { stage, file, exists } 或 { stage, file }（可以创建）
function planNextStage(feature, ctx = loadContext()) {
  const stages = STAGES[feature.type];
  const index = stages.indexOf(feature.current.stage);
  if (index === stages.length - 1) return { error: '已经是最后一个阶段' };
  const stage = stages[index + 1];
  const file = join(feature.dir, `${stage}.md`);
  if (existsSync(file)) return { stage, file, exists: true };
  const missing = missingPrerequisites(feature, stage);
  if (missing.length) return { error: `还不能进入「${STAGE_NAMES[stage]}」：${missing.join('；')}` };
  if (stage === GATED_STAGE[feature.type]) {
    const unmet = unmetDependencies(feature, ctx);
    if (unmet.length) return { error: `依赖未完成，不能进入「${STAGE_NAMES[stage]}」：${unmet.join('；')}` };
  }
  return { stage, file };
}

function createNextStage(feature, ctx) {
  const plan = planNextStage(feature, ctx);
  if (plan.error || plan.exists) return plan;
  writeFileSync(plan.file, render(`${plan.stage}.md`, { id: feature.id, title: feature.title }));
  return { ...plan, created: true };
}

function printCreated(result) {
  if (result.error) console.log(`  下一阶段：${result.error}`);
  else if (result.created) console.log(`  ✓ 已创建 ${result.file}（${STAGE_NAMES[result.stage]}）`);
  else console.log(`  下一阶段：${STAGE_NAMES[result.stage]} 已存在`);
}

// 阶段确认后尝试创建下一阶段
function reportNext(feature) {
  const last = feature.current.stage === STAGES[feature.type].at(-1);
  if (!DONE.has(feature.current.status) || last) {
    console.log(`  下一步：${nextAction(feature)}`);
    return;
  }
  printCreated(createNextStage(feature));
}

// 批次里还能不能开始：草稿阶段可以写；已确认的前一阶段可以创建下一阶段
function actionable(feature, ctx) {
  if (feature.archived || isFeatureDone(feature)) return false;
  if (feature.current.status === 'draft') return true;
  if (!DONE.has(feature.current.status)) return false;
  const plan = planNextStage(feature, ctx);
  return !plan.error && !plan.exists;
}

function approveStage(stage, by) {
  writeFrontmatter(stage.file, { status: 'approved', approved_by: by, approved_at: today() });
}

// ---------- 状态文字与下一步 ----------

function stateText(stage) {
  if (!stage) return '未开始';
  if (stage.status === 'draft') return stage.ai_review === 'fail' ? '待修改' : '进行中';
  if (stage.status === 'review') return stage.stage === '04-test-report' ? '待维护者验收' : '待维护者确认';
  return '已确认';
}

function aiText(stage) {
  if (!stage?.ai_review) return '—';
  return `${stage.ai_review}（${stage.ai_reviewed_by || '未知'}）`;
}

function draftAction(feature) {
  const { current } = feature;
  if (AUTO_STAGES.has(current.stage)) return `编写 ${current.stage}.md，完成后 pnpm feature review ${feature.id}（检查通过后自动确认，接着进入下一阶段）`;
  const ask = `pnpm feature ai-review ${feature.id} --by <审查员>`;
  if (current.ai_review === 'fail') return `${current.stage}.md 的 AI 审查未通过：${current.ai_review_note || '未写原因'}。修改后重新 ${ask}，再 pnpm feature review ${feature.id}`;
  if (current.ai_review === 'pass') return `pnpm feature review ${feature.id}`;
  return `编写 ${current.stage}.md，写完先 ${ask}，再 pnpm feature review ${feature.id}`;
}

function nextAction(feature, ctx = loadContext()) {
  const { current, type } = feature;
  if (feature.archived) return feature.releasedIn ? `已归档（发布版本：${feature.releasedIn}）` : '已归档';
  if (current.status === 'draft') return draftAction(feature);
  if (current.status === 'review') {
    const batch = openBatchOf(feature.id, ctx);
    const node = current.stage === '04-test-report' ? '验收' : '方案确认';
    return batch ? `等待维护者在批次 ${batch.id} 的「${node}」节点确认` : `等待维护者确认「${STAGE_NAMES[current.stage]}」`;
  }
  const stages = STAGES[type];
  if (current.stage === stages.at(-1)) {
    return type === 'spike'
      ? `调研已完成，可以归档：pnpm feature archive ${feature.id} --release none`
      : '已验收，等待发版：用 fc-release 写版本发布文档，发版后 pnpm feature archive <编号...> --release <版本>';
  }
  const upcoming = stages[stages.indexOf(current.stage) + 1];
  if (upcoming === GATED_STAGE[type]) {
    const unmet = unmetDependencies(feature, ctx);
    if (unmet.length) return `被依赖阻塞：${unmet.join('；')}`;
  }
  return `pnpm feature next ${feature.id}，进入「${STAGE_NAMES[upcoming]}」`;
}

// ---------- 执行图与进度的数据 ----------

const execStageOf = (feature) => {
  if (feature.type === 'spike') return '02-research';
  return feature.stages.some((s) => s.stage === '04-test-report') ? '04-test-report' : '03-implementation';
};

function planView(feature) {
  const names = PLAN_STAGES[feature.type];
  const states = names.map((name) => feature.stages.find((s) => s.stage === name));
  const text = names.map((name, i) => `${STAGE_NAMES[name]} ${stateText(states[i])}`).join(' · ');
  let cls;
  if (states.every((s) => s?.status === 'approved')) cls = 'done';
  else if (!names.includes(feature.current.stage)) cls = 'todo';
  else cls = { review: 'review', draft: 'doing' }[feature.current.status] ?? 'todo';
  return { cls, text };
}

function execView(feature, ctx) {
  if (isFeatureDone(feature)) return { cls: 'done', text: '已完成' };
  const stage = feature.stages.find((s) => s.stage === execStageOf(feature));
  if (!stage) {
    const blocked = unmetDependencies(feature, ctx).length > 0;
    return { cls: blocked ? 'blocked' : 'todo', text: blocked ? '被依赖阻塞' : '未开始' };
  }
  return { cls: stage.status === 'review' ? 'review' : 'doing', text: stateText(stage) };
}

// 拓扑层级：只看批次内的依赖，没有批内依赖的是波次 1
function computeWaves(members) {
  const ids = new Set(members.map((f) => f.id));
  const byId = new Map(members.map((f) => [f.id, f]));
  const memo = new Map();
  const levelOf = (id, path = []) => {
    if (memo.has(id)) return memo.get(id);
    if (path.includes(id)) return 1;
    const deps = byId.get(id).depends.filter((d) => ids.has(d) && d !== id);
    const level = 1 + Math.max(0, ...deps.map((d) => levelOf(d, [...path, id])));
    memo.set(id, level);
    return level;
  };
  return new Map(members.map((f) => [f.id, levelOf(f.id)]));
}

// ---------- 输出 ----------

function printFeature(feature, detailed, ctx = loadContext()) {
  const { current } = feature;
  const tag = feature.type === 'spike' ? '［调研］' : '';
  console.log(`${feature.id} ${tag}${feature.title}  [${feature.epic || '无 Epic'} · ${current.stage} ${STAGE_NAMES[current.stage]}: ${current.status}]`);
  if (detailed) {
    if (feature.depends.length) console.log(`  依赖：${feature.depends.join('、')}`);
    for (const s of feature.stages) {
      const who = s.approved_by ? `  ${s.approved_by} ${s.approved_at}` : '';
      const ai = s.ai_review ? `  AI 审查：${aiText(s)}${s.ai_review === 'fail' ? `，${s.ai_review_note || '未写原因'}` : ''}` : '';
      console.log(`  ${s.stage.padEnd(18)} ${(s.status ?? '').padEnd(8)}${who}${ai}`);
    }
    const open = openChecklist(feature);
    if (open) console.log(`  实现清单：${open.length ? `还有 ${open.length} 项未完成` : '全部完成'}`);
  }
  console.log(`  下一步：${nextAction(feature, ctx)}`);
}

function requireBy() {
  const by = option('by');
  if (!by) fail('需要 --by <确认人>，只能在维护者明确确认后使用');
  return by;
}

function requireDocsApproved(ids, what) {
  const pending = ids.map(loadDoc).filter((d) => d.status !== 'approved');
  if (pending.length) fail(`${what}前需要先确认：${pending.map((d) => `${d.id}（${d.status}）`).join('、')}`);
}

// 需求进入方案确认前还差什么
function planBlockers(feature) {
  return PLAN_STAGES[feature.type].flatMap((name) => {
    const stage = feature.stages.find((s) => s.stage === name);
    if (!stage || stage.status === 'draft') return [`${feature.id} 的${STAGE_NAMES[name]}还没完成提交确认`];
    return [];
  });
}

function waitingItems(batch, members, ctx, status) {
  if (status === 'plan-review') {
    const docs = batch.docs.filter((id) => findDoc(id)?.status === 'review');
    const stages = members.flatMap((f) => f.stages
      .filter((s) => PLAN_STAGES[f.type].includes(s.stage) && s.status === 'review')
      .map((s) => `${f.id} ${STAGE_NAMES[s.stage]}`));
    return `方案确认：${[...docs, ...stages].join('、')}`;
  }
  if (status === 'acceptance-review') {
    const items = members.filter(finalReviewPending).map((f) => `${f.id} 测试与验收`);
    return `验收：${items.join('、')}`;
  }
  return '';
}

function printBatch(batch, ctx) {
  const status = batchStatus(batch, ctx.features);
  const members = batchMembers(batch, ctx.features);
  console.log(`${batch.id} ${batch.title}  [${status}]`);
  const waves = computeWaves(members);
  const maxWave = Math.max(0, ...waves.values());
  for (let w = 1; w <= maxWave; w++) {
    console.log(`  波次 ${w}：${members.filter((f) => waves.get(f.id) === w).map((f) => f.id).join('、')}`);
  }
  for (const f of members) {
    console.log(`  ${f.id} ${f.title}  ${f.current.stage} ${f.current.status}  AI：${aiText(f.current)}`);
    console.log(`    下一步：${nextAction(f, ctx)}`);
  }
  console.log(`现在可以并行开始：${members.filter((f) => actionable(f, ctx)).map((f) => f.id).join('、') || '无'}`);
  const waiting = waitingItems(batch, members, ctx, status);
  if (waiting) console.log(`等待维护者：${waiting}`);
}

// 批次还不能确认时，说明缺什么
function notReadyReason(batch, members, ctx, status) {
  if (status === 'done') return `${batch.id} 已经完成`;
  if (status === 'executing') {
    const running = members.filter((f) => !isFeatureDone(f) && !finalReviewPending(f));
    return `${batch.id} 方案已确认，还在执行中；等需求进入验收后再确认。还没到的：${running.map((f) => `${f.id} 当前 ${f.current.stage} ${f.current.status}`).join('、')}`;
  }
  const missing = batch.features.filter((id) => !members.some((f) => f.id === id)).map((id) => `${id} 不存在`);
  const docs = batch.docs
    .filter((id) => !DOC_READY.has(findDoc(id)?.status))
    .map((id) => `${id} 还是 ${findDoc(id)?.status ?? '不存在'}，先用 pnpm feature review ${id} 提交确认`);
  const reasons = [...missing, ...docs, ...members.flatMap(planBlockers)];
  return `${batch.id} 还不能确认（当前 ${status}）：${reasons.join('；') || '无'}`;
}

// ---------- 执行图与进度（批次文件里由脚本生成的部分） ----------

const CLASS_DEFS = [
  'classDef todo fill:#f1f5f9,stroke:#94a3b8,color:#334155',
  'classDef doing fill:#dbeafe,stroke:#2563eb,color:#1e3a8a',
  'classDef review fill:#fef3c7,stroke:#d97706,color:#78350f',
  'classDef done fill:#dcfce7,stroke:#16a34a,color:#14532d',
  'classDef blocked fill:#fee2e2,stroke:#dc2626,color:#7f1d1d',
  'classDef gate fill:#f3e8ff,stroke:#7c3aed,stroke-width:4px,color:#4c1d95',
];

function graphBlock(members, ctx) {
  if (!members.length) return '（还没有需求，用 pnpm feature batch add 加入）';
  const waves = computeWaves(members);
  const ids = new Set(members.map((f) => f.id));
  const dependedOn = new Set(members.flatMap((f) => f.depends.filter((d) => ids.has(d))));
  const classes = new Map(['todo', 'doing', 'review', 'done', 'blocked'].map((c) => [c, []]));
  const lines = ['flowchart LR', ...CLASS_DEFS.map((d) => `  ${d}`)];

  lines.push('  G1{{"🧑 节点一：方案确认"}}');
  lines.push('  subgraph plan["方案：需求说明 + 设计（全部并行）"]');
  for (const f of members) {
    const view = planView(f);
    const prefix = f.type === 'spike' ? '调研问题' : '需求+设计';
    lines.push(`    ${nid(f.id)}_plan["${esc(`${f.id} ${f.title}<br/>${prefix}：${view.text}`)}"]`);
    classes.get(view.cls).push(`${nid(f.id)}_plan`);
  }
  lines.push('  end', '  plan --> G1');

  const maxWave = Math.max(0, ...waves.values());
  for (let w = 1; w <= maxWave; w++) {
    lines.push(`  subgraph W${w}["波次 ${w}（可并行）"]`);
    for (const f of members.filter((m) => waves.get(m.id) === w)) {
      const view = execView(f, ctx);
      lines.push(`    ${nid(f.id)}["${esc(`${f.id} ${f.title}<br/>${EXEC_LABEL[execStageOf(f)]}：${view.text}`)}"]`);
      classes.get(view.cls).push(nid(f.id));
    }
    lines.push('  end');
  }

  lines.push('  G2{{"🧑 节点二：验收"}}');
  const external = new Map();
  for (const f of members) for (const d of f.depends) if (!ids.has(d)) external.set(d, ctx.features.find((x) => x.id === d));
  for (const [dep, target] of external) {
    lines.push(`  ext_${nid(dep)}["${dep}（批外）"]`);
    classes.get(target && isFeatureDone(target) ? 'done' : 'blocked').push(`ext_${nid(dep)}`);
  }

  for (const f of members) {
    if (waves.get(f.id) === 1) lines.push(`  G1 --> ${nid(f.id)}`);
    for (const d of f.depends) lines.push(ids.has(d) ? `  ${nid(d)} --> ${nid(f.id)}` : `  ext_${nid(d)} -.-> ${nid(f.id)}`);
    if (!dependedOn.has(f.id)) lines.push(`  ${nid(f.id)} --> G2`);
  }
  lines.push('  class G1,G2 gate');
  for (const [cls, list] of classes) if (list.length) lines.push(`  class ${list.join(',')} ${cls}`);

  return [
    '```mermaid',
    ...lines,
    '```',
    '图例：灰色 未开始 · 蓝色 进行中 · 琥珀 等待确认（AI 或维护者） · 绿色 已完成 · 红色 被依赖阻塞 · 紫色 维护者确认节点',
  ].join('\n');
}

function progressBlock(members, ctx) {
  const done = members.filter(isFeatureDone).length;
  const waves = computeWaves(members);
  const rows = members.map((f) => {
    const { current } = f;
    const deps = f.depends.length ? f.depends.join('、') : '—';
    return `| ${f.id} ${cell(f.title)} | ${f.type === 'spike' ? '调研' : '功能'} | ${waves.get(f.id)} | ${deps} | ${current.stage} ${STAGE_NAMES[current.stage]} | ${current.status} | ${cell(aiText(current))} | ${cell(nextAction(f, ctx))} |`;
  });
  return [
    `完成 ${done} / ${members.length} 个需求`,
    '',
    '| 需求 | 类型 | 波次 | 依赖 | 当前阶段 | 状态 | AI 审查 | 下一步 |',
    '|---|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

// 替换两个标记之间的内容，标记之外的（维护者写的）保持不动
function replaceBlock(text, name, body) {
  const start = `<!-- batch:${name}:start -->`;
  const end = `<!-- batch:${name}:end -->`;
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from < 0 || to < from) fail(`批次文件缺少 ${start} / ${end} 标记，无法同步`);
  return `${text.slice(0, from + start.length)}\n${body}\n${text.slice(to)}`;
}

// 在「同步日志」表格最后一行后追加一行
function appendLog(text, row) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## 同步日志'));
  if (start < 0) return `${text}\n${row}\n`;
  let last = start;
  for (let i = start + 1; i < lines.length && !lines[i].startsWith('## '); i++) {
    if (lines[i].startsWith('|')) last = i;
  }
  lines.splice(last + 1, 0, row);
  return lines.join('\n');
}

function syncOne(batch, ctx) {
  const status = batchStatus(batch, ctx.features);
  const members = batchMembers(batch, ctx.features);
  let text = readFileSync(batch.file, 'utf8');
  if (status !== batch.status) text = appendLog(text, `| ${today()} | 状态 ${batch.status || '—'} → ${status} |`);
  text = replaceBlock(text, 'graph', graphBlock(members, ctx));
  text = replaceBlock(text, 'progress', progressBlock(members, ctx));
  writeFileSync(batch.file, text);
  if (status !== batch.status) writeFrontmatter(batch.file, { status });
  return status;
}

// 需求或文档状态变化后，同步包含它们的未完成批次（执行图和进度随工作推进更新）
function syncRelated(ids) {
  const ctx = loadContext();
  const related = ctx.batches.filter((b) => isOpenBatch(b, ctx.features) && [...b.features, ...b.docs].some((id) => ids.includes(id)));
  for (const batch of related) {
    const before = batch.status;
    const status = syncOne(batch, ctx);
    if (status !== before) console.log(`  批次 ${batch.id} 状态：${before || '—'} → ${status}`);
  }
}

function syncBatches(ids) {
  const ctx = loadContext();
  const targets = ids
    ? ids.map((id) => findBatch(id, ctx))
    : ctx.batches.filter((b) => b.status !== 'done' || isOpenBatch(b, ctx.features));
  if (!targets.length) {
    console.log('没有进行中的批次');
    return;
  }
  for (const batch of targets) {
    const status = syncOne(batch, ctx);
    console.log(`✓ ${batch.id} ${batch.title}：${status}`);
  }
}

// ---------- 批次的确认节点 ----------

function approvePlan(batch, members, by) {
  const docs = batch.docs.map((id) => findDoc(id)).filter((d) => d?.status === 'review');
  const approving = new Set(docs.map((d) => d.id));
  for (const doc of docs.filter((d) => d.kind === 'epic')) {
    const missing = EPIC_PREREQUISITES.filter((p) => findDoc(p)?.status !== 'approved' && !approving.has(p));
    if (missing.length) fail(`确认 ${doc.id} 前需要先确认：${missing.join('、')}`);
  }
  for (const doc of docs) {
    writeFrontmatter(doc.file, { status: 'approved', approved_by: by, approved_at: today() });
    console.log(`✓ ${doc.id} 已由 ${by} 确认`);
  }
  for (const f of members) {
    for (const s of f.stages) {
      if (PLAN_STAGES[f.type].includes(s.stage) && s.status === 'review') {
        approveStage(s, by);
        console.log(`✓ ${f.id} ${s.stage} 已由 ${by} 确认`);
      }
    }
  }
  writeFrontmatter(batch.file, { plan_approved_by: by, plan_approved_at: today() });
  console.log(`✓ ${batch.id} 方案已由 ${by} 确认，开始执行`);
  for (const f of members) {
    console.log(`${f.id} ${f.title}`);
    reportNext(reload(f.id));
  }
}

function approveAcceptance(batch, members, by) {
  for (const f of members) {
    const stage = f.stages.find((s) => s.stage === '04-test-report');
    if (stage?.status === 'review') {
      approveStage(stage, by);
      console.log(`✓ ${f.id} 测试与验收 已由 ${by} 确认`);
    }
  }
  writeFrontmatter(batch.file, { accepted_by: by, accepted_at: today() });
  console.log(`✓ ${batch.id} 验收已由 ${by} 确认`);
}

function approveBatch(id, by) {
  const ctx = loadContext();
  const batch = findBatch(id, ctx);
  const members = batchMembers(batch, ctx.features);
  const status = batchStatus(batch, ctx.features);
  if (status === 'plan-review') approvePlan(batch, members, by);
  else if (status === 'acceptance-review') approveAcceptance(batch, members, by);
  else fail(notReadyReason(batch, members, ctx, status));
  syncBatches([batch.id]);
}

// 确认一个需求：不带 --stage 时确认所有等待确认的阶段（例如 01-spec 和 02-design）
function approveFeature(id, by) {
  const feature = findFeature(id);
  const stageName = option('stage');
  const targets = stageName
    ? [feature.stages.find((s) => s.stage === stageName) ?? fail(`${id} 没有阶段 ${stageName}`)]
    : feature.stages.filter((s) => s.status === 'review');
  if (!targets.length) fail(`${id} 没有等待确认的阶段，先用 pnpm feature review ${id} 提交确认`);
  for (const target of targets) {
    if (target.status !== 'review') fail(`${id} ${target.stage} 当前是 ${target.status}，先用 pnpm feature review ${id} 提交确认`);
    approveStage(target, by);
    console.log(`✓ ${id} ${target.stage} 已由 ${by} 确认`);
  }
  reportNext(reload(id));
  syncRelated([id]);
}

// ---------- 批次命令 ----------

function batchNew([slugRaw, title, ...featureIds]) {
  const slug = slugOf(slugRaw);
  if (!title) fail('需要标题：pnpm feature batch new <slug> "<标题>" F-0001 F-0002');
  const ctx = loadContext();
  validateMembers(featureIds, ctx, null);
  const docs = splitList(option('docs'));
  validateDocs(docs);
  const id = `B-${pad(nextNumber([...listFiles(BATCHES), 'B-01-removed'], /^B-(\d{2})-/), 2)}`;
  const file = join(BATCHES, `${id}-${slug}.md`);
  if (existsSync(file)) fail(`${file} 已存在`);
  mkdirSync(BATCHES, { recursive: true });
  writeFileSync(file, render('batch.md', { id, title }));
  writeFrontmatter(file, { features: `[${featureIds.join(', ')}]`, docs: `[${docs.join(', ')}]` });
  console.log(`✓ 已创建 ${file}`);
  syncBatches([id]);
}

function batchAdd([id, ...featureIds]) {
  const ctx = loadContext();
  const batch = findBatch(id, ctx);
  validateMembers(featureIds, ctx, batch.id);
  const docs = splitList(option('docs'));
  validateDocs(docs);
  writeFrontmatter(batch.file, {
    features: `[${unique([...batch.features, ...featureIds]).join(', ')}]`,
    docs: `[${unique([...batch.docs, ...docs]).join(', ')}]`,
  });
  console.log(`✓ ${batch.id} 已加入 ${featureIds.join('、') || '（没有新需求）'}`);
  syncBatches([batch.id]);
}

function batchStatusCmd(id) {
  const ctx = loadContext();
  const targets = id ? [findBatch(id, ctx)] : ctx.batches.filter((b) => isOpenBatch(b, ctx.features));
  if (!targets.length) {
    console.log('没有进行中的批次');
    return;
  }
  for (const batch of targets) printBatch(batch, ctx);
}

// ---------- 命令 ----------

switch (command) {
  case 'status': {
    const id = positional[0];
    if (id?.startsWith('F-')) { printFeature(findFeature(id, { allowArchived: true }), true); break; }
    if (id?.startsWith('B-')) { const ctx = loadContext(); printBatch(findBatch(id, ctx), ctx); break; }
    if (id) {
      const doc = loadDoc(id) ?? fail(`不认识的编号 ${id}`);
      console.log(`${doc.id} ${doc.title ?? ''}  [${doc.status}]${doc.approved_by ? `  ${doc.approved_by} ${doc.approved_at}` : ''}`);
      const ctx = loadContext();
      allFeatures().filter((f) => f.epic === doc.id).forEach((f) => printFeature(f, false, ctx));
      break;
    }
    const ctx = loadContext();
    console.log('产品规划');
    for (const docId of Object.keys(PRODUCT_DOCS)) {
      const doc = loadDoc(docId);
      console.log(`  ${docId.padEnd(15)} ${doc.status}`);
    }
    console.log('Epic');
    for (const epic of allEpics()) console.log(`  ${epic.id} ${epic.status.padEnd(8)} ${(epic.priority ?? '').padEnd(4)} ${epic.title}`);
    const active = ctx.features.filter((f) => !f.archived);
    console.log(active.length ? '需求' : '需求：还没有。pnpm feature new <slug> "<标题>" --epic E-NN 新建。');
    active.forEach((f) => printFeature(f, false, ctx));
    const unreleased = active.filter((f) => f.type === 'feature' && isFeatureDone(f));
    if (unreleased.length) console.log(`待发布（已验收）：${unreleased.map((f) => f.id).join('、')}`);
    if (ctx.batches.length) {
      console.log('批次');
      for (const batch of ctx.batches) {
        const status = batchStatus(batch, ctx.features);
        console.log(`  ${batch.id} ${status.padEnd(18)} ${batch.title}${WAITING_BATCH.has(status) ? '  ← 等待维护者' : ''}`);
      }
    }
    break;
  }

  case 'check': {
    const problems = [];
    const ctx = loadContext();
    const { features, batches } = ctx;
    const epicIds = allEpics().map((e) => e.id);
    for (const f of features.filter((x) => !x.archived)) {
      if (!f.epic) problems.push(`${f.id} 没有所属 Epic`);
      else if (!epicIds.includes(f.epic)) problems.push(`${f.id} 的 Epic ${f.epic} 不存在`);
      for (const dep of f.depends) {
        if (!/^F-\d{4}$/.test(dep)) problems.push(`${f.id} 的依赖 ${dep} 格式不对，只能写需求编号`);
        else if (!features.some((x) => x.id === dep)) problems.push(`${f.id} 依赖的 ${dep} 不存在`);
      }
    }
    const cycle = findCycle(features.map((f) => f.id), featureEdges(features));
    if (cycle) problems.push(`需求依赖成环：${cycle.join(' → ')}`);
    for (const batch of batches) {
      for (const id of batch.features) if (!features.some((f) => f.id === id)) problems.push(`${batch.id} 里的 ${id} 不存在`);
      for (const id of batch.docs) if (!findDoc(id)) problems.push(`${batch.id} 里的文档 ${id} 不存在`);
    }
    const openCount = new Map();
    for (const batch of batches.filter((b) => isOpenBatch(b, features))) {
      for (const id of batch.features) openCount.set(id, (openCount.get(id) ?? 0) + 1);
    }
    for (const [id, count] of openCount) {
      if (count > 1) problems.push(`${id} 同时在 ${count} 个未完成的批次里，只能属于一个`);
    }
    if (problems.length) {
      problems.forEach((p) => console.log(`✗ ${p}`));
      process.exit(1);
    }
    console.log(`✓ ${features.length} 个需求、${batches.length} 个批次，依赖关系正常`);
    break;
  }

  case 'epic': {
    const slug = slugOf(positional[0]);
    const title = positional[1] ?? fail('需要标题：pnpm feature epic <slug> "<标题>"');
    const id = `E-${pad(nextNumber(listFiles(EPICS), /^E-(\d{2})-/), 2)}`;
    mkdirSync(EPICS, { recursive: true });
    const file = join(EPICS, `${id}-${slug}.md`);
    writeFileSync(file, render('epic.md', { id, title }));
    console.log(`✓ 已创建 ${file}`);
    break;
  }

  case 'new': {
    const slug = slugOf(positional[0]);
    const title = positional[1] ?? fail('需要标题：pnpm feature new <slug> "<标题>" --epic E-NN');
    const epicId = option('epic') ?? fail('需要 --epic E-NN：每个需求都属于一个 Epic');
    const epic = loadDoc(epicId) ?? fail(`不认识的 Epic ${epicId}`);
    if (epic.status !== 'approved') fail(`${epicId} 还是 ${epic.status}，Epic 确认后才能立项`);
    const type = option('type') ?? 'feature';
    if (!STAGES[type]) fail('--type 只能是 feature 或 spike');
    // docs/features 于 2026-11-19 整体移除（原文在 git 历史 ed177c8），编号从 F-0059 继续，不复用旧编号
    const id = `F-${pad(nextNumber([...listDirs(FEATURES), ...listDirs(ARCHIVE), 'F-0058-removed'], /^F-(\d{4})-/))}`;
    const deps = splitList(option('depends'));
    validateDepends(id, deps);
    const dir = join(FEATURES, `${id}-${slug}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, '01-spec.md');
    writeFileSync(file, render('01-spec.md', { id, title }));
    writeFrontmatter(file, { epic: epicId, type, depends_on: `[${deps.join(', ')}]` });
    console.log(`✓ 已创建 ${file}（${type === 'spike' ? '调研' : '功能'}，属于 ${epicId}）`);
    console.log(`  记得在 ${epic.file} 的候选需求表里回填 ${id}`);
    break;
  }

  case 'depends': {
    const feature = findFeature(positional[0]);
    const deps = flag('clear') ? [] : positional.slice(1);
    validateDepends(feature.id, deps);
    writeFrontmatter(join(feature.dir, '01-spec.md'), { depends_on: `[${deps.join(', ')}]` });
    console.log(`✓ ${feature.id} 依赖：${deps.length ? deps.join('、') : '无'}`);
    break;
  }

  case 'next': {
    const feature = findFeature(positional[0]);
    if (!DONE.has(feature.current.status)) fail(`${feature.current.stage} 还是 ${feature.current.status}，确认后才能进入下一阶段`);
    const result = createNextStage(feature);
    if (result.error) fail(result.error);
    console.log(result.created ? `✓ 已创建 ${result.file}（${STAGE_NAMES[result.stage]}）` : `✓ ${STAGE_NAMES[result.stage]} 已存在：${result.file}`);
    syncRelated([feature.id]);
    break;
  }

  case 'ai-review': {
    const feature = findFeature(positional[0]);
    const by = option('by') ?? fail('需要 --by <审查员>：写明是哪个独立的 AI 审查员（不能是本次的作者）');
    const stageName = option('stage');
    const target = stageName
      ? feature.stages.find((s) => s.stage === stageName) ?? fail(`${feature.id} 没有阶段 ${stageName}`)
      : feature.current;
    if (!AI_REVIEWED.has(target.stage)) fail(`${target.stage} 不需要 AI 审查`);
    if (!['draft', 'review'].includes(target.status)) fail(`${target.stage} 当前是 ${target.status}，只有 draft 或 review 可以做 AI 审查`);
    const failed = rest.includes('--fail');
    const reason = option('fail');
    if (failed && !reason) fail('--fail 需要写原因，例如 --fail "验收标准 AC-2 不可验证"');
    writeFrontmatter(target.file, {
      ai_review: failed ? 'fail' : 'pass',
      ai_reviewed_by: by,
      ai_reviewed_at: today(),
      ai_review_note: failed ? reason : '',
    });
    if (failed) {
      console.log(`✗ ${feature.id} ${target.stage} AI 审查未通过（${by}）：${reason}`);
      console.log('  修改后重新 ai-review，再 review');
    } else {
      console.log(`✓ ${feature.id} ${target.stage} AI 审查通过（${by}）`);
      console.log(`  下一步：pnpm feature review ${feature.id}`);
    }
    syncRelated([feature.id]);
    break;
  }

  case 'review': {
    const id = positional[0];
    if (id?.startsWith('B-')) fail(`批次不用 review，确认请用 pnpm feature approve ${id} --by <名字>`);
    const doc = id?.startsWith('F-') ? null : loadDoc(id);
    if (doc) {
      if (doc.status !== 'draft') fail(`${id} 当前是 ${doc.status}，只有 draft 可以提交确认`);
      writeFrontmatter(doc.file, { status: 'review' });
      console.log(`✓ ${id} 已提交确认。请维护者审阅 ${doc.file}`);
      syncRelated([id]);
      break;
    }
    const feature = findFeature(id);
    const { current } = feature;
    if (current.status !== 'draft') fail(`${current.stage} 当前是 ${current.status}，只有 draft 可以提交确认`);
    if (current.stage === '02-design' && openChecklist(feature) === null) {
      fail('02-design.md 需要「## 实现清单」一节，用 - [ ] 列出要完成的步骤');
    }
    if (current.stage === '03-implementation') {
      const open = openChecklist(feature);
      if (open?.length) fail(`实现清单还有 ${open.length} 项未勾选：${open.map((item) => item.replace(/\*\*/g, '').slice(0, 24)).join('；')}`);
    }
    if (AI_REVIEWED.has(current.stage) && current.ai_review !== 'pass') {
      fail(`先由独立的 AI 审查员（不是作者）审查：pnpm feature ai-review ${feature.id} --by <审查员>`);
    }
    if (AUTO_STAGES.has(current.stage)) {
      writeFrontmatter(current.file, { status: 'approved', approved_by: AUTO_BY, approved_at: today() });
      console.log(`✓ ${feature.id} ${current.stage} 检查通过，已自动确认（维护者在「测试与验收」时一并审阅）`);
      reportNext(reload(feature.id));
      syncRelated([feature.id]);
      break;
    }
    if (current.stage === '02-research') {
      const by = `ai:${current.ai_reviewed_by || 'unknown'}`;
      writeFrontmatter(current.file, { status: 'approved', approved_by: by, approved_at: today() });
      console.log(`✓ ${feature.id} 调研报告已由 ${by} 确认`);
      const batch = openBatchOf(feature.id, loadContext());
      console.log(`  调研结论要在${batch ? `批次 ${batch.id} 的` : ''}下一个维护者节点（方案确认或验收）里汇总`);
      console.log(`  下一步：${nextAction(reload(feature.id))}`);
      syncRelated([feature.id]);
      break;
    }
    writeFrontmatter(current.file, { status: 'review' });
    console.log(`✓ ${feature.id} ${current.stage} 已提交确认。请维护者审阅 ${current.file}`);
    // 需求说明提交时就写好技术设计：方案确认时两者一起看
    if (current.stage === '01-spec' && feature.type === 'feature') printCreated(createNextStage(reload(feature.id)));
    console.log(`  下一步：${nextAction(reload(feature.id))}`);
    syncRelated([feature.id]);
    break;
  }

  case 'approve': {
    const by = requireBy();
    if (!positional.length) fail('需要编号：pnpm feature approve <VISION | E-05 | F-0001 | B-01 ...> --by <名字>');
    // 可以一次确认多个，例如维护者说「F-0006 到 F-0009 的需求说明都确认」
    for (const id of positional) {
      if (id.startsWith('B-')) {
        approveBatch(id, by);
        continue;
      }
      const doc = id.startsWith('F-') ? null : loadDoc(id);
      if (doc) {
        if (doc.status !== 'review') fail(`${id} 当前是 ${doc.status}，先用 pnpm feature review ${id} 提交确认`);
        if (doc.kind === 'epic') requireDocsApproved(EPIC_PREREQUISITES, '确认 Epic ');
        writeFrontmatter(doc.file, { status: 'approved', approved_by: by, approved_at: today() });
        console.log(`✓ ${id} 已由 ${by} 确认`);
        syncRelated([id]);
        continue;
      }
      approveFeature(id, by);
    }
    break;
  }

  case 'batch': {
    const [sub, ...args] = positional;
    switch (sub) {
      case 'new': batchNew(args); break;
      case 'add': batchAdd(args); break;
      case 'sync': syncBatches(args[0] ? [args[0]] : undefined); break;
      case 'status': batchStatusCmd(args[0]); break;
      default: fail('用法：pnpm feature batch new | add | sync | status ...');
    }
    break;
  }

  case 'release-notes': {
    const version = positional[0] ?? fail('需要版本号：pnpm feature release-notes v2.1.0');
    if (!/^v\d+\.\d+\.\d+/.test(version)) fail('版本号格式是 v2.1.0');
    const file = join(RELEASES, `${version}.md`);
    if (existsSync(file)) fail(`${file} 已存在`);
    const done = allFeatures().filter((f) => !f.archived && f.type === 'feature' && isFeatureDone(f));
    const list = done.length ? done.map((f) => `| [${f.id}](../../features/archive/${f.dir.split('/').pop()}/04-test-report.md) | ${f.title} | ${f.epic} |`).join('\n') : '| | | |';
    // 链接指向归档后的位置：发版后这些需求会用 pnpm feature archive 归档
    mkdirSync(RELEASES, { recursive: true });
    writeFileSync(file, render('release.md', { version, date: today(), features: list }));
    console.log(`✓ 已创建 ${file}，包含 ${done.length} 个已验收的需求：${done.map((f) => f.id).join('、') || '无'}`);
    break;
  }

  case 'archive': {
    const release = option('release') ?? fail('需要 --release <版本>（随哪个版本发布；调研写 none）');
    if (!positional.length) fail('需要编号：pnpm feature archive <F-0001 ...> --release <版本>');
    const features = positional.map((id) => findFeature(id));
    for (const feature of features) {
      if (!isFeatureDone(feature)) fail(`${feature.id} 的「${STAGE_NAMES[DONE_STAGE[feature.type]]}」还没确认，不能归档`);
    }
    mkdirSync(ARCHIVE, { recursive: true });
    for (const feature of features) {
      writeFrontmatter(join(feature.dir, '01-spec.md'), { released_in: release });
      const target = join(ARCHIVE, feature.dir.split('/').pop());
      renameSync(feature.dir, target);
      console.log(`✓ ${feature.id} 已归档到 ${target}`);
    }
    break;
  }

  case 'adr':
  case 'incident': {
    const slug = slugOf(positional[0]);
    const title = positional[1] ?? fail(`需要标题：pnpm feature ${command} <slug> "<标题>"`);
    const dir = command === 'adr' ? 'docs/20-architecture/adr' : 'docs/40-ops/incidents';
    const prefix = command === 'adr' ? 'ADR' : 'INC';
    const number = pad(nextNumber(existsSync(dir) ? readdirSync(dir) : [], /^(\d{4})-/));
    const file = join(dir, `${number}-${slug}.md`);
    const text = readFileSync(join(TEMPLATES, `${command}.md`), 'utf8')
      .replaceAll(`${prefix}-NNNN`, `${prefix}-${number}`)
      .replace(/<(决策|事故)标题>/, title)
      .replace(/^date:.*$/m, `date: ${today()}`)
      .replace(/^feature:.*$/m, `feature: ${option('feature') ?? ''}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, text);
    console.log(`✓ 已创建 ${file}`);
    break;
  }

  default:
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//   ')).map((l) => l.slice(5)).join('\n'));
    if (command) process.exit(1);
}
