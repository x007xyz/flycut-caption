---
id: F-0021
stage: 03-implementation
status: draft
approved_by:
approved_at:
---

# F-0021 说话人区分与字幕筛选：开发记录

## 进度

| 日期 | 清单项 | 检查 |
|---|---|---|
| 2026-11-17 | 1. 共享 schema/映射/项目字段 | `tsc` ✅ |
| 2026-11-17 | 2. Provider + Host analyze/saveNames | 真实模型架构测试 ✅（2 speakers/3 segments） |
| 2026-11-17 | 3. 面板与筛选 | E2E 4/4 |
| 2026-11-17 | 4. 单条改归属 | 未完成 |
| 2026-11-17 | 5. E2E/真实素材 | 截图 8 张、录屏 4 段；CPPCC 2 说话人 |

## 自行决定的事项

- 本地分离用 Python + sherpa-onnx 模型，路径可配置；不随安装包分发 Python，后续换 sidecar/Provider。
- 筛选只在客户端显示层生效，绝不修改字幕或导出。
- 分析结果按最大重叠映射到字幕条，不改 chunk.speaker 字段。

## 遗留问题

- 单条字幕改归属未做；目前只能改名和筛选。
- 未提交 commit。
