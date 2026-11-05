// 需求流程工具：按 docs/00-process/README.md 的层级、阶段和门禁管理产品规划、Epic 与需求。
//
//   pnpm feature status [E-05 | F-0001]
//   pnpm feature check
//   pnpm feature epic <slug> "<标题>"
//   pnpm feature new <slug> "<标题>" --epic E-05 [--type spike] [--depends F-0002,F-0003]
//   pnpm feature depends F-0001 F-0002 F-0003   （--clear 清空）
//   pnpm feature next F-0001
//   pnpm feature review <VISION | E-05 | F-0001>
//   pnpm feature approve <VISION | E-05 | F-0001> --by <名字> [--stage <阶段>]
//   pnpm feature skip F-0001 --by <名字> --reason "<原因>"
//   pnpm feature archive F-0001
//   pnpm feature adr <slug> "<标题>" [--feature F-0001]
//   pnpm feature incident <slug> "<标题>" [--feature F-0001]
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FEATURES = 'docs/features';
const ARCHIVE = join(FEATURES, 'archive');
const PRODUCT = 'docs/10-product';
const EPICS = join(PRODUCT, 'epics');
const TEMPLATES = 'docs/00-process/templates';
const PRODUCT_DOCS = { VISION: 'vision.md', 'CAPABILITY-MAP': 'capability-map.md', ROADMAP: 'roadmap.md' };
// Epic 获批前必须先确认的产品级文档
const EPIC_PREREQUISITES = ['VISION', 'CAPABILITY-MAP'];

const STAGES = {
  feature: ['01-intake', '02-prd', '03-design', '05-implementation',
    '06-test-report', '07-release', '08-ops', '09-retro'],
  spike: ['01-intake', '02-research', '09-retro'],
};
const STAGE_NAMES = {
  '01-intake': '立项', '02-prd': '产品文档', '02-research': '调研', '03-design': '技术设计',
  '05-implementation': '开发', '06-test-report': '测试与验收',
  '07-release': '发布', '08-ops': '运维观察', '09-retro': '复盘',
};
// 依赖方达到这个阶段并确认后，才算「完成」，依赖它的需求才能开始开发
const DONE_STAGE = { feature: '06-test-report', spike: '02-research' };
// 需要依赖全部完成才能进入的阶段
const GATED_STAGE = { feature: '05-implementation', spike: '02-research' };
const DONE = new Set(['approved', 'skipped']);
// 这些阶段由 agent 连续推进：review 时检查通过就自动确认，维护者在「测试与验收」时一并审阅
const AUTO_STAGES = new Set(['03-design', '05-implementation']);
const AUTO_BY = 'auto';

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

function writeFrontmatter(file, updates) {
  let text = readFileSync(file, 'utf8');
  for (const [key, value] of Object.entries(updates)) {
    const pattern = new RegExp(`^(---\\n[\\s\\S]*?)^${key}:.*$`, 'm');
    text = pattern.test(text) ? text.replace(pattern, `$1${key}: ${value}`) : text.replace(/\n---\n/, `\n${key}: ${value}\n---\n`);
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

function loadDoc(id) {
  if (PRODUCT_DOCS[id]) {
    const file = join(PRODUCT, PRODUCT_DOCS[id]);
    if (!existsSync(file)) fail(`找不到 ${file}`);
    return { id, file, kind: 'product', ...readFrontmatter(file) };
  }
  if (/^E-\d{2}$/.test(id)) {
    const name = listFiles(EPICS).find((f) => f.startsWith(`${id}-`));
    if (!name) fail(`找不到 ${id}`);
    const file = join(EPICS, name);
    const title = readFileSync(file, 'utf8').match(/^# E-\d{2} (.*)$/m)?.[1] ?? '';
    return { id, file, kind: 'epic', title, ...readFrontmatter(file) };
  }
  return null;
}

const allEpics = () => listFiles(EPICS).map((f) => f.slice(0, 4)).filter((id) => /^E-\d{2}$/.test(id)).map(loadDoc);

// ---------- 需求 ----------

function loadFeature(dir, archived = false) {
  const intake = join(dir, '01-intake.md');
  const meta = readFrontmatter(intake);
  const type = meta.type === 'spike' ? 'spike' : 'feature';
  const stages = STAGES[type].filter((stage) => existsSync(join(dir, `${stage}.md`)))
    .map((stage) => ({ stage, file: join(dir, `${stage}.md`), ...readFrontmatter(join(dir, `${stage}.md`)) }));
  const heading = readFileSync(intake, 'utf8').match(/^# F-\d{4} (.*?)：/m);
  return {
    dir, archived, type, id: dir.split('/').pop().slice(0, 6), title: heading?.[1] ?? '',
    epic: meta.epic ?? '', depends: splitList(meta.depends_on), stages, current: stages.at(-1),
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

// ---------- 实现清单（03-design.md 的「实现清单」） ----------

// 返回未勾选的清单项；没有清单时返回 null
function openChecklist(feature) {
  const file = join(feature.dir, '03-design.md');
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const section = text.match(/^## 实现清单\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1];
  if (section === undefined) return null;
  const items = [...section.matchAll(/^\s*- \[( |x|X)\] (.+)$/gm)];
  if (!items.length) return null;
  return items.filter((m) => m[1] === ' ').map((m) => m[2].trim());
}

// ---------- 依赖判定 ----------

function isFeatureDone(feature) {
  if (feature.archived) return true;
  const done = feature.stages.find((s) => s.stage === DONE_STAGE[feature.type]);
  return Boolean(done && DONE.has(done.status));
}

// 返回依赖未满足的原因；空数组表示全部满足
function unmetDependencies(deps, features = allFeatures()) {
  const problems = [];
  for (const dep of deps) {
    const target = features.find((f) => f.id === dep);
    if (!target) problems.push(`${dep} 不存在`);
    else if (!isFeatureDone(target)) problems.push(`${dep} 未完成（需要「${STAGE_NAMES[DONE_STAGE[target.type]]}」确认）`);
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

// ---------- 输出 ----------

function nextAction(feature) {
  const { current, type } = feature;
  if (feature.archived) return '已归档';
  if (current.status === 'draft') {
    const auto = AUTO_STAGES.has(current.stage) ? '（自动确认，接着进入下一阶段）' : '';
    return `编写 ${current.stage}.md，完成后 pnpm feature review ${feature.id}${auto}`;
  }
  if (current.status === 'review') return `等待维护者确认「${STAGE_NAMES[current.stage]}」`;
  const stages = STAGES[type];
  if (current.stage === stages.at(-1)) return `pnpm feature archive ${feature.id}`;
  const upcoming = stages[stages.indexOf(current.stage) + 1];
  if (upcoming === GATED_STAGE[type]) {
    const unmet = unmetDependencies(feature.depends);
    if (unmet.length) return `被依赖阻塞：${unmet.join('；')}`;
  }
  return `pnpm feature next ${feature.id}，进入「${STAGE_NAMES[upcoming]}」`;
}

function printFeature(feature, detailed) {
  const { current } = feature;
  const tag = feature.type === 'spike' ? '［调研］' : '';
  console.log(`${feature.id} ${tag}${feature.title}  [${feature.epic || '无 Epic'} · ${current.stage} ${STAGE_NAMES[current.stage]}: ${current.status}]`);
  if (detailed) {
    if (feature.depends.length) console.log(`  依赖：${feature.depends.join('、')}`);
    for (const s of feature.stages) {
      const who = s.approved_by ? `  ${s.approved_by} ${s.approved_at}` : '';
      console.log(`  ${s.stage.padEnd(18)} ${(s.status ?? '').padEnd(8)}${who}`);
    }
    const open = openChecklist(feature);
    if (open) console.log(`  实现清单：${open.length ? `还有 ${open.length} 项未完成` : '全部完成'}`);
  }
  console.log(`  下一步：${nextAction(feature)}`);
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

// ---------- 命令 ----------

switch (command) {
  case 'status': {
    const id = positional[0];
    if (id?.startsWith('F-')) { printFeature(findFeature(id, { allowArchived: true }), true); break; }
    if (id) {
      const doc = loadDoc(id) ?? fail(`不认识的编号 ${id}`);
      console.log(`${doc.id} ${doc.title ?? ''}  [${doc.status}]${doc.approved_by ? `  ${doc.approved_by} ${doc.approved_at}` : ''}`);
      allFeatures().filter((f) => f.epic === doc.id).forEach((f) => printFeature(f, false));
      break;
    }
    console.log('产品规划');
    for (const docId of Object.keys(PRODUCT_DOCS)) {
      const doc = loadDoc(docId);
      console.log(`  ${docId.padEnd(15)} ${doc.status}`);
    }
    console.log('Epic');
    for (const epic of allEpics()) console.log(`  ${epic.id} ${epic.status.padEnd(8)} ${(epic.priority ?? '').padEnd(4)} ${epic.title}`);
    const active = allFeatures().filter((f) => !f.archived);
    console.log(active.length ? '需求' : '需求：还没有。pnpm feature new <slug> "<标题>" --epic E-NN 新建。');
    active.forEach((f) => printFeature(f, false));
    break;
  }

  case 'check': {
    const problems = [];
    const features = allFeatures();
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
    if (problems.length) {
      problems.forEach((p) => console.log(`✗ ${p}`));
      process.exit(1);
    }
    console.log(`✓ ${features.length} 个需求，依赖关系正常`);
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
    const id = `F-${pad(nextNumber([...listDirs(FEATURES), ...listDirs(ARCHIVE)], /^F-(\d{4})-/))}`;
    const deps = splitList(option('depends'));
    validateDepends(id, deps);
    const dir = join(FEATURES, `${id}-${slug}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, '01-intake.md');
    writeFileSync(file, render('01-intake.md', { id, title }));
    writeFrontmatter(file, { epic: epicId, type, depends_on: `[${deps.join(', ')}]` });
    console.log(`✓ 已创建 ${file}（${type === 'spike' ? '调研' : '功能'}，属于 ${epicId}）`);
    console.log(`  记得在 ${epic.file} 的候选需求表里回填 ${id}`);
    break;
  }

  case 'depends': {
    const feature = findFeature(positional[0]);
    const deps = flag('clear') ? [] : positional.slice(1);
    validateDepends(feature.id, deps);
    writeFrontmatter(join(feature.dir, '01-intake.md'), { depends_on: `[${deps.join(', ')}]` });
    console.log(`✓ ${feature.id} 依赖：${deps.length ? deps.join('、') : '无'}`);
    break;
  }

  case 'next': {
    const feature = findFeature(positional[0]);
    const { current, type } = feature;
    if (!DONE.has(current.status)) fail(`${current.stage} 还是 ${current.status}，维护者确认后才能进入下一阶段`);
    const stages = STAGES[type];
    const index = stages.indexOf(current.stage);
    if (index === stages.length - 1) fail(`已经是最后一个阶段，复盘确认后用 pnpm feature archive ${feature.id}`);
    const pending = feature.stages.filter((s) => !DONE.has(s.status));
    if (pending.length) fail(`前面还有未确认的阶段：${pending.map((s) => s.stage).join('、')}`);
    const stage = stages[index + 1];
    if (stage === GATED_STAGE[type]) {
      const unmet = unmetDependencies(feature.depends);
      if (unmet.length) fail(`依赖未完成，不能进入「${STAGE_NAMES[stage]}」：${unmet.join('；')}`);
    }
    writeFileSync(join(feature.dir, `${stage}.md`), render(`${stage}.md`, { id: feature.id, title: feature.title }));
    console.log(`✓ 已创建 ${feature.dir}/${stage}.md（${STAGE_NAMES[stage]}）`);
    break;
  }

  case 'review': {
    const id = positional[0];
    const doc = id?.startsWith('F-') ? null : loadDoc(id);
    if (doc) {
      if (doc.status !== 'draft') fail(`${id} 当前是 ${doc.status}，只有 draft 可以提交确认`);
      writeFrontmatter(doc.file, { status: 'review' });
      console.log(`✓ ${id} 已提交确认。请维护者审阅 ${doc.file}`);
      break;
    }
    const feature = findFeature(id);
    const { current } = feature;
    if (current.status !== 'draft') fail(`${current.stage} 当前是 ${current.status}，只有 draft 可以提交确认`);
    if (current.stage === '03-design' && openChecklist(feature) === null) {
      fail('03-design.md 需要「## 实现清单」一节，用 - [ ] 列出要完成的步骤');
    }
    if (current.stage === '05-implementation') {
      const open = openChecklist(feature);
      if (open?.length) fail(`实现清单还有 ${open.length} 项未勾选：${open.map((item) => item.replace(/\*\*/g, '').slice(0, 24)).join('；')}`);
    }
    if (AUTO_STAGES.has(current.stage)) {
      writeFrontmatter(current.file, { status: 'approved', approved_by: AUTO_BY, approved_at: today() });
      console.log(`✓ ${feature.id} ${current.stage} 检查通过，已自动确认（维护者在「测试与验收」时一并审阅）。接着运行 pnpm feature next ${feature.id}`);
      break;
    }
    writeFrontmatter(current.file, { status: 'review' });
    console.log(`✓ ${feature.id} ${current.stage} 已提交确认。请维护者审阅 ${current.file}`);
    break;
  }

  case 'approve': {
    const by = requireBy();
    const id = positional[0];
    const doc = id?.startsWith('F-') ? null : loadDoc(id);
    if (doc) {
      if (doc.status !== 'review') fail(`${id} 当前是 ${doc.status}，先用 pnpm feature review ${id} 提交确认`);
      if (doc.kind === 'epic') requireDocsApproved(EPIC_PREREQUISITES, '确认 Epic ');
      writeFrontmatter(doc.file, { status: 'approved', approved_by: by, approved_at: today() });
      console.log(`✓ ${id} 已由 ${by} 确认`);
      break;
    }
    const feature = findFeature(id);
    const featureId = feature.id;
    // --stage 用于确认被退回重审的前面阶段（例如设计阶段改了 PRD，PRD 回到 review）
    const stageName = option('stage');
    const target = stageName ? feature.stages.find((s) => s.stage === stageName) : feature.current;
    if (!target) fail(`${featureId} 没有阶段 ${stageName}`);
    if (target.status !== 'review') fail(`${target.stage} 当前是 ${target.status}，先用 pnpm feature review ${featureId} 提交确认`);
    writeFrontmatter(target.file, { status: 'approved', approved_by: by, approved_at: today() });
    console.log(`✓ ${featureId} ${target.stage} 已由 ${by} 确认`);
    break;
  }

  case 'skip': {
    const by = requireBy();
    const reason = option('reason') ?? fail('需要 --reason "<原因>"');
    const { current, id } = findFeature(positional[0]);
    if (['01-intake', '02-prd', '02-research', '03-design', '06-test-report'].includes(current.stage)) fail(`${STAGE_NAMES[current.stage]}不能跳过`);
    if (DONE.has(current.status)) fail(`${current.stage} 已经是 ${current.status}`);
    writeFrontmatter(current.file, { status: 'skipped', approved_by: by, approved_at: today() });
    writeFileSync(current.file, readFileSync(current.file, 'utf8').replace(/\n---\n/, `\n---\n\n> 已跳过（${today()}，${by}）：${reason}\n`));
    console.log(`✓ ${id} ${current.stage} 已跳过`);
    break;
  }

  case 'archive': {
    const feature = findFeature(positional[0]);
    if (feature.current.stage !== '09-retro' || feature.current.status !== 'approved') fail('复盘（09-retro）确认后才能归档');
    mkdirSync(ARCHIVE, { recursive: true });
    const target = join(ARCHIVE, feature.dir.split('/').pop());
    renameSync(feature.dir, target);
    console.log(`✓ 已归档到 ${target}`);
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
