# 代码与验收标准

写代码、审代码、合并和打 tag 前都要逐条对照。下面 6 条全部满足才能合并或发版；做不到的条目必须按第 5 条写明，不能省略。

`LESSONS.md` 中同一条教训在 3 个不同日期出现后，会转正到本文件末尾的「已转正规则」。

## 验收标准

### 1. 静态检查全绿

```bash
pnpm lint
pnpm tsc -b --noEmit
pnpm check:host
cargo check --manifest-path src-tauri/Cargo.toml
```

### 2. 测试全绿

每个任务先跑适用的自动化检查。需求逐条对应 AC，小修和文档改动按影响范围选已有测试、静态检查或可复现的校验。能用脚本断言的行为不能只靠 Computer Use、截图或手动点一遍判通过。如何选层级见 [自动化验收方案](30-engineering/acceptance-testing.md)。

```bash
pnpm test
pnpm test:architecture
```

按改动范围追加子系统文档要求的测试（例如 sidecar 改动加 `pnpm test:funasr-sidecar`）。main 上已经挂掉的测试视为需要马上修的 bug，不能当作「与本次无关」跳过。

### 3. Red check（回退测试）

修 bug 或改行为必须带测试，并证明测试真的能抓住问题：把本次修复撤掉（或 `git stash` 实现部分）后，新测试必须失败，且失败信息指出是哪个行为错了。

- 不算数：编译失败、测试被跳过、断言与本次改动无关。
- 纯重构可以不加新测试，但要说明哪些现有测试覆盖了被改的路径。

### 4. 真实使用

单元测试通过不等于功能可用。优先用自动化在真实目标环境执行同等流程并保留断言证据；只有覆盖不到的步骤才补 Computer Use 或人工验证。按改动范围至少验证：

| 改动范围 | 至少要做的真实验证 |
|---|---|
| ASR Provider / 模型 / sidecar | 用真实模型文件识别一段真实视频（`tests/` 的 demo 素材），检查字幕和时间戳 |
| 视频导出 | 导出一次，用播放器打开结果，确认删除片段确实被剪掉、音画同步 |
| Tauri / 桌面路径 / 原生对话框 | 在真实 Tauri 中验证受影响的流程；涉及打包时测本次打包的应用，涉及原生对话框时实际完成选择或保存 |
| 第三方 API（OpenAI 兼容等） | 用真实配置和真实接口返回验证，不只用 mock |
| UI | 在浏览器或桌面端实际操作，明暗主题都看一眼 |

没做过真实验证的功能，不要在上面继续开发，也不要对用户说「已修好」或「能用了」。修用户报告的问题时，先在报告人用的那个界面（Web / 桌面、对应的 Provider）把问题原样复现，再说修好。

### 5. 没跑的写出来

commit 正文和 PR 评论都要带验证记录，固定格式：

```
Verification (@ <commit sha>):
- Ran: pnpm tsc -b --noEmit ✅, pnpm test:architecture ✅
- Red check: 撤销 src/utils/smartCutBlank.ts 的修复后，smart-cut-blank.test 失败于 "gap < 300ms 被误删"
- Real use: tauri:dev 导入 demo.mp4 → FunASR 识别 → 导出，结果正常
- Not run: Windows 打包（无环境）
```

没跑的检查列在 `Not run` 里并说明原因，不能不写。`Ran` 要对应 `@` 后面那个 commit，代码之后又改过就要重跑。

### 6. 合并与发版

- 合并 PR 用 `gh pr merge --match-head-commit <审过的 sha>`，审查后有新 push 就让合并失败、重新审。
- 打 tag 前，该 commit 必须有一轮**已完成且全绿**的 CI（`.github/workflows/ci.yml`）；被取消的运行不算。发版统一用 `pnpm release`，它会检查这一条和下面的版本号，不要手动 `git tag`。
- 版本号在 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 三处保持一致，改完跑一次 `cargo check` 确认 `Cargo.toml` 仍可解析。`src/index.ts` 导出的 `version` 由 `vite.config.ts` 从 `package.json` 注入，不要再写死版本号。

## 代码约定

- 新代码跟随所在文件的命名、注释密度和写法。
- 同一类 bug 一起修：修一个分支/引擎/平台时，检查其他 Provider、平台或调用点是否有同样问题，一并修掉或在 PR 中列出。
- 不推翻 [decisions.md](decisions.md) 中已拍板的决定；确实要改，先在 PR 描述里提出并等维护者确认。
- 安全相关改动（`src-tauri/capabilities/**`、`src-tauri/tauri.conf.json`、下载或执行外部二进制的脚本、Host 鉴权）不自动合并，等维护者放行。

## 已转正规则

（暂无。由 `LESSONS.md` 中 Seen 满 3 个不同日期的条目转入，每条保留原条目的证据链接。）
