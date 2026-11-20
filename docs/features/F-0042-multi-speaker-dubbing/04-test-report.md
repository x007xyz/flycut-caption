---
id: F-0042
stage: 04-test-report
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-17
---

# F-0042 多说话人配音：测试与验收

验收在工作区（HEAD `bf58f93` + 未提交改动）进行。

## 验收标准

| AC | 验证 | 结果 |
|---|---|---|
| AC-1 | 按 speaker ID 映射，克隆/自带音色，未指定提示 | ✅ E2E |
| AC-2 | 改映射只重做该说话人；已有有效 artifact 跳过 | ✅ 代码/E2E |
| AC-3 | 未授权克隆被 Provider 拒绝；重叠 ≥30% 标 ambiguous；未指定不生成 | ✅ 代码 |
| AC-4 | 真实双人逐句生成/对齐/混音导出 | ⏸ Not run（混音导出属 F-0037） |
| AC-5 | 入口/空态/无模型提示 | ✅ |
| AC-6 | 进度/取消 | ✅ |
| AC-7 | Host 写入后完成；重开映射一致 | ✅ E2E |
| AC-8 | 失败/冲突 | ✅ 代码 |
| AC-9 | E2E 中英文 × 明暗主题 4/4 | ✅（真实双人导出 Not run） |

## 证据

- `PW_PORT=5217 pnpm e2e:evidence F-0042` 4/4，截图 8 张、录屏 4 段；E2E 断言两次 `alignTrack` 分别带 `profile:` 和 `voice:`。
- 未跑：真实双人素材逐句生成与混音导出（F-0037）、真实克隆音色验收、Tauri/Windows。

## 回归

`lint`、`tsc`、`check:host`、E2E 通过；未重跑全量 `test:architecture`。

## 结论

可以发布（映射与分组配音验证通过）；真实双人导出与真实克隆音色按 Not run 留给 F-0037/后续。
