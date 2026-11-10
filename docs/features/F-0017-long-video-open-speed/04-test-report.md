---
id: F-0017
stage: 04-test-report
status: review
approved_by:
approved_at:
---

# F-0017 长视频打开提速：测试与验收

验收在 commit `21c31b8` 上进行。

> 技术设计和开发阶段由 agent 连续推进、自动确认；维护者在这里一并审阅。

## 设计与实现摘要

字幕编辑列表改为本地可变行高虚拟化：只挂载可视区和上下各 6 行，行高由 `ResizeObserver` 实测；history store 继续保存字幕、删除、选择、撤销和写回的正式状态。未失焦输入用父组件 transient draft 保存在虚拟行卸载期间，滚回、切换和离开列表时提交；查找、跨边界 Tab、播放跟随和 3 秒手动滚动抑制也按 chunk ID 接入虚拟窗口。

真实性能数据统一为两段 COSCUP 素材拼接：1,173 句、15,014 字词、3,599.107 秒。Web 与 Tauri 基准共用真实拼接转写模块；E2E 的确定性数据明确只是 UI 夹具。新增 ASR 作业完成载入路径测试，以及带诊断的开发态 Tauri 基准入口。没有新增 ADR，没有修改 Host RPC、项目格式或 EDL。

与设计的主要偏差是 Tauri 基准增加了开发态 collector、真实数据校验和本机 Node 运行库诊断；这些不进入生产构建。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 共享性能数据 | Web 与 Tauri 基准共用 `tests/e2e/lib/longTranscript.ts` 中的真实 COSCUP 拼接函数 | 避免一边用合成数据、一边用真实素材却都声称同一门槛 | AC-1、AC-2、AC-3 |
| E2E 长列表数据 | 保留确定性 1,173 行作为 UI/交互夹具 | 回归可重复且不依赖大文件；报告不把它声称为真实数据集 | AC-3–AC-11 |
| Tauri Node 运行库 | 只在本机被忽略的 `src-tauri/binaries` 临时提供 `libnode` | 当前打包 Node 通过 `@rpath` 查找动态库；该资源不提交 | AC-1 |
| 桌面缺口处理 | 应用和 Host 启动后，自动驱动不能从卡片进入编辑器，因此不再改底层，桌面计时标 Not run | 避免以 Web 数字冒充桌面通过；请维护者确认是否接受该剩余条件 | AC-1 |

## 验收标准逐条结果

| AC | 验证方式 | 证据 | 结果 |
|---|---|---|---|
| AC-1 打开项目 | 真实使用：前台 Chrome 5 次；真实 Tauri 启动 | Web：`pnpm bench:f0017`，1,173 句 / 15,014 字词 / 3,599.107 秒，打开 2,673 / 349 / 311 / 301 / 343 ms，全部不超过 3 秒，可编辑后 1 秒最大 long task 均为 0 ms。Tauri：应用与 Host 启动、首页显示“已连接”和真实项目，但自动点击项目卡片后仍停在 `#/projects`，textarea 数为 0，未得到 5 次桌面样本 | Web ✅；桌面 ⏸ Not run |
| AC-2 切换视频 | Web 真实使用 5 次 | 切到长视频 419 / 376 / 393 / 407 / 389 ms；切回短视频 496 / 371 / 299 / 322 / 388 ms；所有可编辑后 long task 为 0 ms | ✅ |
| AC-3 转写完成后载入 | E2E 经真实前端作业链路注入固定长转写 | `F-0017/AC-3 AC-10 AC-11 provider job completion injects a long transcript into the bounded editor`，明暗主题 2/2；从 `workflow.start`、`jobs.get` 完成、`saveTranscript` 到首句可编辑少于 3 秒，可编辑后 long task 不超过 200 ms，只挂载少于 30 行 / 60 个 textarea | ✅ |
| AC-4 滚动 | E2E + Web 基准 | 连续 30 次滚轮和拖到底部通过，最大 long task 0 ms；滚动到底可挂载最后一行，统计保持“总计 1173 / 有效 1173”；截图 `long-bottom-{light,dark}.png` | ✅ |
| AC-5 编辑后滚走 | E2E | 未失焦修改滚出窗口后仍自动保存；重新打开显示新文本；切换视频不会把旧视频输入写进新视频 | ✅ |
| AC-6 删除与选择 | E2E | 单删、批量删除、全选 1,173 句、取消选择、恢复和统计更新均通过；操作均基于全量 chunk 集而非已挂载 DOM。本报告未另列每次操作的独立毫秒样本 | ✅ 行为；计时未单列 |
| AC-7 撤销重做 | E2E + 架构 | 离屏编辑、删除、批量、智能剪空白后的撤销重做与离屏重挂载内容通过；变量行布局单测通过 | ✅ |
| AC-8 播放高亮与跟随 | E2E + 架构 | 高亮句离屏时最小跟随；textarea 聚焦和最近 3 秒手动滚动时抑制；点击/键盘滚动与程序化滚动区分；截图 `long-playback-follow-light.png` | ✅ |
| AC-9 整份字幕写回 | E2E | 翻译和 AI 纠错写回离屏行，撤销恢复；智能剪空白确认和撤销；写入后重挂载读取最新 store；截图 `long-ai-writeback-light.png`、`long-smart-cut-light.png` | ✅ |
| AC-10 回归 | F-0017、F-0002、F-0003 E2E；生产构建 | F-0017 10/10；F-0002/F-0003 80/80；短视频、明暗主题、English 标签、生产构建和 `setTranscript` 全文日志断言均通过 | ✅ |
| AC-11 载入中 | E2E 明暗主题 | 打开门控期间“正在打开…”持续显示，释放后首句文本可编辑，DOM 有界；截图 `long-opening-{light,dark}.png` | ✅ |

Red check：临时把 `findVirtualRange()` 改为返回全部 1,173 行后，定向 E2E 在 light 主题 5 秒内找不到首句 textarea，在 dark 主题首句可编辑耗时 5,720 ms；恢复虚拟范围后 F-0017 10/10 通过。失败明确指向全部行渲染，而非编译或无关断言。

## 界面证据

`pnpm e2e:evidence F-0017`：10 通过、0 失败，12 张截图，10 段本地录屏。

| 界面 | 状态 | AC | 截图 | 录屏 |
|---|---|---|---|---|
| 项目编辑器 | 打开中、首屏、底部、ASR 返回、选择撤销、播放跟随、AI 写回、智能剪切 | AC-1、AC-3–AC-11 | `screenshots/long-*.png` | `recordings/`（本地，不提交） |

## 回归检查

- `pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`cargo check --manifest-path src-tauri/Cargo.toml`：通过。
- `pnpm test`：95 通过，3 个未下载模型的 family smoke 跳过，0 失败。
- `pnpm test:architecture`：95/95 通过。首次运行因本工作区缺少 `tests/media/clips` 被跳过资源而失败 3 项；复用原仓库被忽略的真实音频夹具后全部通过，未修改产品代码。
- `pnpm build`：通过；只有既有的 bundle size 警告。
- F-0017 E2E：10/10；F-0002/F-0003 E2E：80/80。
- Web/Chrome 基准：前台 Chrome、5173、10 核 Apple Silicon；测量时 load average 约 25.4。真实数据 1,173 句 / 15,014 字词 / 3,599.107 秒；5 次打开 2,673 / 349 / 311 / 301 / 343 ms。
- Tauri：`pnpm bench:f0017:tauri` 校验真实数据并启动应用和 Host；尚未生成桌面计时文件。

## 发现的问题

- **Tauri AC-1 Not run**：真实 Tauri 应用和 Host 都已启动，首页显示“已连接 · This computer”、59:59 的 `Tauri 六十分钟口播`，但开发态 WebView 自动驱动执行项目卡片点击后仍为 `#/projects`，20 秒内 page body 保持首页、textarea 数为 0。此前 `flycut-node` 的 `libnode.147.dylib` 缺失已通过本机被忽略运行库解决；剩余阻塞是自动驱动无法进入编辑器。没有桌面耗时样本，不能用 Web 结果替代。
- 原语言视图切换 869 ms，但出现 464 ms long task。按需求说明该视图不在本次门槛内；建议在 E-02 后续评估。
- Web 首次打开为 2,673 ms，满足 3 秒门槛但余量较小；暖路径稳定在 301–349 ms。

## 结论

自动化、Web/Chrome、构建和编辑行为验收通过；桌面 AC-1 为 `⏸ Not run`。本报告可提交维护者评审，但在维护者接受该剩余条件或补跑真实桌面 5 次之前，不建议发布。
