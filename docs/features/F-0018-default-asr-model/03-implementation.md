---
id: F-0018
stage: 03-implementation
status: draft
approved_by:
approved_at:
---

# F-0018 默认模型推荐与下载引导：开发记录

## 分支与 PR

- 分支：codex/f0018-default-asr-model
- PR：

## 进度

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-13 | 1. 清单元数据与共享模型契约 | 015516f | model-manifest.test ✅, lint ✅, tsc ✅, check:host ✅ |
| 2026-11-13 | 2. Host 下载进度、磁盘检查、SHA-256 校验与取消 | 75f7422 | default-asr-model.test ✅, check:host ✅, lint ✅ |
| 2026-11-13 | 3. 前端安全选型、下载状态管理与过期防护 | b4ad705 | model-recommendation.test ✅, tsc ✅, lint ✅ |
| 2026-11-13 | 4. 推荐引导卡片与三大入口集成 | ec5996c | lint ✅, tsc ✅, vite build ✅ |
| 2026-11-13 | 5. 端到端验收与全量回归 | 2ca1000 | lint ✅, tsc ✅, check:host ✅, cargo check ✅, pnpm test 112 passed/5 skipped ✅, test:architecture 147/147 ✅, PW_PORT=5296 F-0018 E2E 12/12 ✅ |

## 自行决定的事项

- **单一推荐而非排名**：只把 SenseVoice Small INT8 标为「推荐」，模型名旁如实标注 F-0001 的受限结论（两模型文字评测、无独立时间真值），不写「最佳模型」或全模型排名。影响 AC-1。
- **推荐元数据放清单**：`models.json` 只增 `recommendation` 字段（参照样本、CER 区间、时间戳级别、离线、体积、限制说明），Host 与前端读同一份清单，避免两处硬编码漂移。影响 AC-1、AC-4。
- **下载就绪判定**：只有 SHA-256 校验通过并完成落盘原子替换后才标记可用；取消时删除临时文件与部分分片，避免残留半包被当成可用模型。影响 AC-2、AC-3。
- **不自动切换云端**：推荐卡片在无网络/磁盘不足时只提示改选已下载模型或重试，从不建议或自动启用收费/云端 Provider。影响 AC-3。

## 与设计的偏差

- 推荐引导复用了三个既有入口（模型面板、ASR 设置、编辑器字幕区空态），未新增独立页面，符合 AC-5 的「不显示假成功、复用现有入口」。无接口或数据格式偏差。

## 遗留问题

- 真实「全新安装」环境（清空模型目录的首次启动）与 Tauri 桌面打包实机需独立环境；Web 侧已用真实本地 HTTP 下载源 + 真实 `funasr-asr` 识别验证，桌面实机在测试报告中记为 `⏸ Not run`。

