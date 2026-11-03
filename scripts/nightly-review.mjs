// 夜审：复盘最近的 commit，交给 agent 更新 LESSONS.md，并把满 3 个不同日期的教训转正到 docs/code-standards.md。
// 流程与提示词见 docs/agent/nightly-review-prompt.md。
//
// 用法：
//   pnpm review:nightly                       复盘过去 24 小时，调用 agent 更新错题本（不提交）
//   pnpm review:nightly --since "3 days ago"  自定义复盘窗口
//   pnpm review:nightly --report-only         只打印启发式报告，不调用 agent
//   pnpm review:nightly --commit              agent 改完后只提交 LESSONS.md 与 docs/code-standards.md
//
// 环境变量 REVIEW_AGENT 指定 agent 命令（默认 claude）。
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const sinceExpr = option('--since', '24 hours ago');
const agent = process.env.REVIEW_AGENT || 'claude';
const LESSON_FILES = ['LESSONS.md', 'docs/code-standards.md'];
// 返工判定：fix 提交改到的文件，在它之前这么多小时内被别的提交改过
const REWORK_WINDOW_HOURS = 72;

function git(...gitArgs) {
  return execFileSync('git', gitArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function readCommits(sinceArg) {
  const SEP = '\u001e';
  const FIELD = '\u001f';
  const raw = git('log', '--no-merges', `--since=${sinceArg}`, '--name-only',
    `--format=${SEP}%H${FIELD}%cI${FIELD}%s${FIELD}%b${FIELD}`);
  return raw.split(SEP).filter(Boolean).map((entry) => {
    const [sha, date, subject, body, files] = entry.split(FIELD);
    return {
      sha, date: new Date(date), subject, body: body.trim(),
      files: files.split('\n').map((f) => f.trim()).filter(Boolean),
    };
  });
}

const isDocsOnly = (files) => files.length > 0 && files.every((f) => f.endsWith('.md') || f.startsWith('docs/'));
const isFix = (subject) => /^(fix|revert|hotfix)(\(.+\))?!?:/i.test(subject) || /^Revert "/.test(subject);
const shortSha = (sha) => sha.slice(0, 8);
const day = (date) => date.toISOString().slice(0, 10);

const commits = readCommits(sinceExpr);
// 窗口之前再多取一段历史，用来判断窗口内的 fix 是在返工谁
const oldest = commits.at(-1)?.date ?? new Date();
const history = readCommits(new Date(oldest - REWORK_WINDOW_HOURS * 3600 * 1000).toISOString());

const findings = [];
for (const commit of commits) {
  const notes = [];

  if (isFix(commit.subject)) {
    const earlier = history.filter((c) => c.sha !== commit.sha
      && c.date < commit.date
      && commit.date - c.date <= REWORK_WINDOW_HOURS * 3600 * 1000
      && c.files.some((f) => commit.files.includes(f)));
    if (earlier.length) {
      notes.push(`疑似返工：${REWORK_WINDOW_HOURS} 小时内改过相同文件的提交 ${earlier.map((c) => `${shortSha(c.sha)}「${c.subject}」`).join('、')}`);
    }
  }

  if (!isDocsOnly(commit.files)) {
    if (!/^Verification\b/m.test(commit.body)) {
      notes.push('缺少 Verification 段（code-standards 第 5 条）');
    } else {
      if (isFix(commit.subject) && !/Red check/i.test(commit.body)) notes.push('fix 提交没有 Red check（code-standards 第 3 条）');
      const notRun = commit.body.match(/^- *Not run:(.*)$/m);
      if (notRun) notes.push(`有未运行项：${notRun[1].trim()}`);
    }
  }

  if (notes.length) findings.push({ commit, notes });
}

const report = [
  `# 夜审报告（${sinceExpr}，共 ${commits.length} 个提交，${findings.length} 个需要关注）`,
  '',
  ...findings.flatMap(({ commit, notes }) => [
    `## ${shortSha(commit.sha)} ${day(commit.date)} ${commit.subject}`,
    `文件：${commit.files.slice(0, 12).join(', ')}${commit.files.length > 12 ? ` 等 ${commit.files.length} 个` : ''}`,
    ...notes.map((n) => `- ${n}`),
    '',
  ]),
  findings.length ? '' : '启发式规则没有发现问题；仍需人工或 agent 判断是否有不该合并的提交。',
].join('\n');

console.log(report);

if (flag('--report-only') || commits.length === 0) process.exit(0);

const dirty = git('status', '--porcelain', '--', ...LESSON_FILES);
if (dirty) {
  console.error(`\n${LESSON_FILES.join(' / ')} 有未提交的改动，先处理后再运行夜审。`);
  process.exit(1);
}

const prompt = [
  readFileSync('docs/agent/nightly-review-prompt.md', 'utf8'),
  '',
  `复盘窗口：${sinceExpr}，今天是 ${day(new Date())}。`,
  '',
  report,
].join('\n');

const result = spawnSync(agent, [
  '-p', prompt,
  '--permission-mode', 'acceptEdits',
  // 只读 git 命令 + 编辑两份错题本文件
  '--allowedTools', 'Read,Grep,Glob,Edit(LESSONS.md),Edit(docs/code-standards.md),Bash(git log:*),Bash(git show:*),Bash(git diff:*)',
], { stdio: 'inherit' });

if (result.error) {
  console.error(`\n无法启动 agent 命令「${agent}」：${result.error.message}。用 REVIEW_AGENT 指定可执行文件。`);
  process.exit(1);
}
if (result.status) process.exit(result.status);

const changed = git('status', '--porcelain', '--', ...LESSON_FILES);
if (!changed) {
  console.log('\n错题本没有变化。');
  process.exit(0);
}

if (flag('--commit')) {
  git('add', '--', ...LESSON_FILES);
  git('commit', '-m', `chore(lessons): nightly review ${day(new Date())}`, '--', ...LESSON_FILES);
  console.log(`\n已提交：${git('log', '-1', '--format=%h %s')}`);
} else {
  console.log(`\n错题本已更新（未提交）：\n${changed}`);
}
