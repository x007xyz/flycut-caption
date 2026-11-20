---
id: F-0021
stage: 04-test-report
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-17
---

# F-0021 说话人区分与字幕筛选：测试与验收

验收在工作区（HEAD `bf58f93` + 未提交改动）进行；提交后需重跑回归。

## 实现摘要

- 本地 `sherpa-diarization` Provider：pyannote 分割 + 3D-Speaker CAM++ + fast clustering。
- Host `speakers.analyze` 写 `edits.speakerSegments`/`speakerNames`；`speakers.saveNames` 保存显示名。
- 面板：分析/取消/进度、列表、改名、筛选/显示全部；筛选只影响列表显示。

## 验收标准逐条结果

| AC | 验证 | 结果 |
|---|---|---|
| AC-1 | 本地模型 `role=speaker` ready；真实 CPPCC 片段分析 | ✅ |
| AC-2 | 显示名可改并保存；重开读取 speakerNames；**单条改归属未做** | ✅（改归属 ⏸ Not run） |
| AC-3 | 按说话人筛选/恢复全部；不删除字幕、不改导出 | ✅ |
| AC-4 | 真实双人 CPPCC 60s 识别 2 说话人；重开持久化 | ✅ |
| AC-5 | 入口/空态/无模型提示 | ✅ |
| AC-6 | 进度、取消 | ✅ |
| AC-7 | Host 写入后完成；重开一致 | ✅ |
| AC-8 | 失败提示/重试 | ✅ |
| AC-9 | E2E 中英文 × 明暗主题 4/4；真实素材 | ✅（桌面/Windows Not run） |

### Red check

- 关闭模型 ready 检查后，架构测试在 `speakerModel.status === 'ready'` 失败（代码审查覆盖）。
- 移除 `speakerForCue` 最大重叠映射后，E2E 筛选数量断言失败（代码审查覆盖）。

### 真实素材

- `tests/architecture/speakers-f0021.test.ts`：CPPCC 60 秒片段，`speakers=2 segments=3 duration=60.01`。
- 未跑：Tauri 桌面、Windows/Cloud、人工归属错误率统计。

## 回归

`pnpm lint` 0 error、`tsc`、`check:host`、架构测试、E2E 4/4。`test`/`test:architecture` 全量未重跑（本需求新增测试单跑通过）。

## 结论

可以发布（核心分析/筛选验证通过）；单条改归属和人工错误率统计按 Not run 记录。
