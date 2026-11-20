---
id: F-0027
stage: 04-test-report
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-16
---

# F-0027 自定义字幕样式保存与复用：测试与验收

验收在 **工作区（HEAD `bf58f93` + 未提交改动）** 上进行。本会话未获 git 提交授权，因此没有固定 commit；维护者提交后应按新 commit 重跑文末回归命令。

> 技术设计和开发阶段由 agent 连续推进、自动确认；维护者在这里一并审阅。

## 设计与实现摘要

- `project.json` 增加可选 `stylePresets` / `stylePresetsRevision`（格式 4 增量，无迁移）；Host 新增 `projects.getStylePresets` / `projects.saveStylePresets`，项目写锁内检查 `baseRevision`、`operationId` 去重。
- 样式面板新增 `CustomPresetsSection`：保存为预设、名称校验、同名覆盖确认、应用、删除二次确认、加载/空态/处理中/完成/版本过期/失败重试/字体缺失状态。
- 应用预设只合并样式字段，保留当前视频的 `aspectPreset` 与 `bottomOffsetRatio`；未知字体回退当前字体并提示；删除预设不修改已应用样式。
- 无新 ADR；沿用 ADR-0001 增量字段和 ADR-0003 画幅按视频保存。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 预设范围 | 存名称 + 主/副样式，不存画幅、底边距、显示模式 | 画幅按视频保存；应用预设不应悄悄改画幅 | AC-2、AC-3 |
| 同名规则 | 去空白、合并空格、大小写不敏感；覆盖需二次确认 | 避免无提示覆盖 | AC-1 |
| 冲突域 | 独立 `stylePresetsRevision` | 与视频样式保存解耦，避免假冲突 | AC-8 |
| 网络不确定 | 下一次保存先读取最新列表，再决定是否重发 | 不盲目重复副作用 | AC-8 |
| 字体缺失 | 回退当前字体并提示 | 保证已保存项目可打开、可渲染 | AC-4 |
| **请确认**：预设存项目文件而不是全局配置 | `project.json` 增量字段 | AC-2 要求项目内多视频复用，项目备份/迁移也应带上预设 | AC-2 |

## 验收标准逐条结果

| AC | 目标平台 / 环境 | 验证方式、用例与命令 | 证据或未跑原因 | 结果 |
|---|---|---|---|---|
| AC-1 | Web（Chrome） | E2E `preset lifecycle`：空名/超长/同名就地报错、保存表单预览、同名覆盖确认、保存成功；架构测试名称校验 | 8/8 E2E 通过；`tests/architecture/style-presets-f0027.test.ts` 4 项通过；截图 `saved-*`、`overwrite-*` | ✅ |
| AC-2 | Web + 真实 Host | Host 保存/重开读取；真实验收双视频项目：保存后第二个视频可见、重开后仍在；内置预设列表未改动 | 架构测试重启读取；`pnpm acceptance:f0027` 输出 `second video sees the preset`、`presets after UI save: Night, FromUI`、重开列表一致 | ✅ |
| AC-3 | Web + 真实 Host | 单测验证颜色/字号改变、`aspectPreset`/`bottomOffsetRatio` 保留；E2E 应用提示；真实验收检查项目样式颜色写入且画幅仍为 `landscape` | 单测通过；真实验收输出 `project style applied, aspect kept` | ✅ |
| AC-4 | Web + 真实 Host | E2E 删除二次确认、字体缺失提示；真实验收删除后读取 Host，已应用颜色仍为 `#FF0000`；内置预设无删除入口 | 8/8 E2E；真实验收输出 `delete kept the applied style snapshot`；截图 `delete-confirm-*`、`font-missing-*` | ✅ |
| AC-5 | Web（Chrome） | E2E 项目模式入口、加载/空态；非项目模式显示「打开项目后可保存自定义预设」 | 截图 `loading-*`、`empty-*`；组件在无项目时渲染提示 | ✅ |
| AC-6 | Web（Chrome） | E2E 加载「正在加载…」、保存「正在处理…」并禁用按钮；应用不能重复提交 | 截图 `loading-*`；按钮 `disabled={busy}`；E2E 覆盖 | ✅ |
| AC-7 | Web + 真实 Host | 只有 `saveStylePresets` 成功才显示「已完成」并更新列表；真实 Host 读回列表；重开保持 | E2E `saved-*`；真实验收 `presets after UI save: Night, FromUI`、重开列表一致 | ✅ |
| AC-8 | Web + 真实 Host | E2E 首次保存失败→「重试」成功；首次返回 conflict→「重新检查」读取最新列表；架构测试冲突与 operationId 去重 | 8/8 E2E；架构测试通过；截图 `error-*`、`stale-*` | ✅ |
| AC-9 | Web（Chrome）+ 真实 Host | `PW_PORT=5211 pnpm e2e:evidence F-0027` 中英文 × 明暗主题 8/8；`pnpm acceptance:f0027` 真实 Host、真实媒体、双视频；截图 32 张、录屏 8 段 | 全部通过；桌面 Tauri 未单独跑，记 `⏸ Not run`（本轮无桌面构建会话） | ✅（桌面待补测） |

### Red check

- 撤掉 `validatePresetName` 的同名校验后，`F-0027/AC-1 preset names…` 在重复名断言失败（实际 `ok: true`，期望 `duplicate`）；恢复后通过。
- 撤掉 `applyCustomStylePreset` 的画幅保留后，`F-0027/AC-3 applying a preset…` 在 `aspectPreset` 断言失败（`square_1_1` vs `portrait_9_16`）；恢复后通过。

### 真实验证与未测项

- Ran：`pnpm acceptance:f0027`（真实 Host + 真实生成媒体 + 同项目两个视频 + Chrome）。输出：`project style applied, aspect kept`、`second video sees the preset`、`presets after UI save: Night, FromUI`、`delete kept the applied style snapshot`、`F-0027 real acceptance passed`。
- Not run：Tauri 桌面窗口、Windows/Linux/Cloud。原因：本会话没有桌面构建/签名环境和对应平台；Web 与桌面复用同一 Host 与前端逻辑，仍需桌面补测。
- Not run：真实 ASR/模型。本需求只处理样式，不依赖模型；真实媒体和真实 Host 已覆盖本次行为。

## 界面证据

`pnpm e2e:evidence F-0027`：8/8 通过，截图 32 张（`docs/features/F-0027-custom-subtitle-presets/screenshots/`），录屏 8 段（`recordings/`，只在本地）。

| 界面 | 状态 | AC | 截图 | 录屏 |
|---|---|---|---|---|
| 样式面板 / 自定义预设 | 加载、空态 | AC-5、AC-6 | `loading-*.png`、`empty-*.png` | `F-0027_AC-1_…webm` |
| 样式面板 / 自定义预设 | 保存完成、同名覆盖 | AC-1、AC-7 | `saved-*.png`、`overwrite-*.png` | 同上 |
| 样式面板 / 自定义预设 | 删除确认、失败、版本过期 | AC-4、AC-8 | `delete-confirm-*.png`、`error-*.png`、`stale-*.png` | `F-0027_AC-4_AC-8_…webm` |
| 样式面板 / 自定义预设 | 字体缺失回退 | AC-4 | `font-missing-*.png` | 同上 |
| 真实双视频项目 | 预设加载、UI 保存 | AC-2、AC-9 | `real-preset-loaded-zh.png`、`real-preset-saved-zh.png` | 无（验收脚本截图） |

## 回归检查

| 命令 | 结果 |
|---|---|
| `pnpm lint` | ✅ 0 error，1 条既有 warning（`PlatformPresetsSection.tsx`，与本次改动无关） |
| `pnpm tsc -b --noEmit` | ✅ |
| `pnpm check:host` | ✅ |
| `pnpm test` | ✅ 140 项：135 pass，5 skip，0 fail |
| `pnpm test:architecture` | ✅ 195 项：194 pass，1 skip，0 fail（第一次全量运行出现 F-0018 `releaseSlow is not a function` 偶发失败，单独重跑和第二次全量均通过，记录为既有测试 flake） |
| `cargo check --manifest-path src-tauri/Cargo.toml` | ✅ |
| `PW_PORT=5211 pnpm e2e:evidence F-0027` | ✅ 8/8 |
| `pnpm acceptance:f0027` | ✅ 真实 Host + 双视频通过 |

## 发现的问题

- `pnpm test:architecture` 第一次全量运行出现既有 F-0018 测试偶发失败（`releaseSlow is not a function`），与本需求无关；单独重跑与第二次全量通过。建议后续把该测试的释放函数等待改成显式 promise，避免计时假设。
- 本会话未提交 commit，报告不能绑定固定 sha；提交后需按新 commit 重跑回归命令。

## 结论

可以发布（工作区验证通过）。建议维护者先提交本次改动，再按新 commit 重跑回归命令并确认本报告；桌面端与 Windows/Linux/Cloud 仍按 AC-9 记为待补测。
