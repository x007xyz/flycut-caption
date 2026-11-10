---
id: F-0017
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-09
---

# F-0017 长视频打开提速：设计

## UI / UX

不新增页面，不改变字幕行的尺寸、颜色、间距、按钮位置或编辑交互。改动集中在编辑视图字幕列表的挂载方式：

- 列表保留原来的滚动容器、行 DOM 和底部工具栏；行外层只增加不参与视觉的内层滚动内容与定位包装。
- 只挂载可视区及上下各 6 行缓冲。未挂载行的文字、删除状态、选择状态、翻译和撤销记录仍来自 history store，不复制业务真源。
- 行高由 ResizeObserver 实测，支持双语、单语、展开文本框、查找命中 mark 和纠错差异导致的可变高度。上方行高变化时保持当前首个可视行的位置。
- 打开和切换继续显示既有“正在打开…”状态，直到首屏字幕已挂载且第一句文本框可聚焦；无新增文案。
- 查找上一处/下一处命中时按 chunk ID 定位索引并滚到可视区。播放当前句变化时，仅当高亮句不在可视区、焦点不在文本框且最近 3 秒没有手动滚动时做最小跟随滚动。
- Tab 在每行正常遍历；当焦点位于当前挂载窗口最前/最后一行且继续向外移动时，先补挂相邻缓冲行，再聚焦目标行首/行尾控件，保证跨虚拟边界连续。

## 技术方案

### 涉及的子系统

- 前端：docs/subsystems/frontend.md、docs/architecture-current.md。
- history store、项目自动保存和播放状态：保持现有接口，不进入 Host/RPC 层，不读 providers、Tauri 或 F-0056 的模型设置代码。
- 已拍板决定：不改项目格式、EDL、Host RPC、桌面媒体路径和前端 Cordis 边界。

### 基线证据

2026-11-09 使用分配 worktree 的现有 60 分钟性能数据：两段 COSCUP 转写按顺序拼接，间隔 0.2 秒，共 1,173 句、15,014 字词、20,450 字符、3,599.107 秒。Playwright 驱动前台本机 Chrome，经隔离 5174 端口打开当前代码；5 次到第一句文字可见为 3,957 / 4,072 / 6,172 / 7,752 / 6,011 ms。页面有 1,173 个 data-chunk-id、2,346 个 textarea，首轮主线程 long task 为 2,786 ms。机器为 10 核 Apple M1 Pro，测量时 load average 约 9.8/14.0/13.3，其他分支未运行重测试。该记录只作本次 before，after 必须使用同一素材、同一无障碍口径和前台 Chrome。

### 方案

在前端字幕列表中实现本地可变行高虚拟化，不引入新依赖：

1. 新建纯函数与 React hook 组成的虚拟行布局模块。纯函数负责二分定位、可视范围、最小跟随偏移和行尺寸更新；hook 负责滚动容器的 scrollTop、视口高度、估算/实测行高、ResizeObserver 和程序化滚动标记。
2. history store 的 chunks、删除标记、选择状态和撤销栈仍是唯一真源。列表只过滤未删除 chunks 生成有序 ID 列表，不保存第二份字幕内容。
3. viewport 内行通过绝对定位包装挂载，滚动内容高度取全部行高之和。未测行按显示模式给保守估值，挂载后立即测量；测量结果增加布局版本并重算前缀偏移。
4. 为避免卸载丢失正在输入但尚未 blur 的文字，列表父组件持有 transient draft Map，键为 chunk ID，只保存 mainText、secondText 和展开状态。SubtitleItem 挂载时优先读取 draft；输入时更新 draft；blur 成功后提交 history store 并清除对应字段。draft 不进入项目、恢复副本或 history store。
5. 对频繁 store 更新，SubtitleItem 继续同步当前 chunks；离屏行重新挂载时直接读取最新 store 与仍存在的 transient draft，因此 AI/翻译/智能剪空白写回不会出现旧内容。
6. Tab 边界处理监听列表 keydown capture，仅在最前/最后挂载行的第一个/最后一个可聚焦控件处接管。先更新滚动范围并补挂目标相邻行，下一帧按 data-virtual-row-index 聚焦控件；普通行内和已挂载行间继续使用浏览器默认顺序。
7. 查找定位用 chunkId -> 有序索引 Map 调 scrollToIndex，不再依赖未挂载 DOM 的 querySelector。播放跟随只响应 currentChunk ID 变化；手动 wheel、touch、滚动条 mousedown 记录时间，3 秒内抑制跟随，焦点位于 textarea 时也抑制，但高亮保持更新。
8. setTranscript 当前基线已不再打印整份转写；新增回归测试监听 console，输入 60 分钟转写并断言没有任何参数或序列化结果包含全文/长字幕内容。现有 App 的示例回调只打印数量，不接触 historyStore 日志路径。

### 接口与数据

- 无 RPC、事件、项目格式、EDL 或持久数据变化。
- SubtitleItem 只增加可选的 transient draft 读取/更新/清除回调；正式保存仍走现有 update。
- Virtual row wrapper 使用 data-virtual-row-index 和 data-chunk-id 作为测试与焦点路由标记，不改变 aria/role 和视觉样式。
- 不新增 npm 依赖；现有 React 19、ResizeObserver 足够。

### 备选方案与取舍

- CSS content-visibility: auto：DOM 和 textarea 仍全部创建，无法满足“只渲染看得到部分”的 AC，也不能解决载入时的创建成本，因此不采用。
- 固定行高虚拟化：展开文本框、双语和多行内容会被裁切，违反“不改变行外观”，因此不采用。
- 引入第三方虚拟列表库：可省少量代码，但需要新依赖，且仍要自行处理按句 draft、查找和 Tab；本地实现范围更可控，因此不采用。
- 立即把每个按键写回 history store：可减少 transient 状态，但每个字符都会产生 store 选择和自动保存压力，且可能越过现有 blur 提交语义，因此不采用。

## 架构决策

本需求不新增 ADR，不修改已拍板决定。虚拟化限定在前端渲染层，不改变 Cordis、Host 或持久契约。

## 自行决定的事项

- 缓冲行数定为上下各 6 行，兼顾快速滚动空白和挂载量。
- 未测行按 104px 保守估值，实际行高由 ResizeObserver 修正；这是滚动条早期近似，挂载后以实测前缀偏移为准。
- transient draft 只解决虚拟卸载期间的未提交输入，不新增跨页面草稿持久化。
- 手动滚动的判定包含 wheel、touch、滚动容器上的 pointer/mouse down 和常见翻页按键；程序化滚动不会重置 3 秒窗口。
- 若本机端口 5173 被其他分支占用，测试只使用临时覆盖配置的隔离端口，并记录实际端口；产品端口配置不改。

## 风险与回退

- 可变行高估计误差可能导致滚动条长度在首次滚动时微调。通过实测所有经过的行、绝对定位和无视觉包装边框降低影响；测试检查末尾可达和总数/有效统计。
- 焦点行卸载可能丢未提交文字。通过父级 transient draft 和复核焦点/Tab 路径覆盖。
- 自动跟随与用户滚动竞争。通过只在当前句变化时触发、可见性判断、textarea 聚焦判断和 3 秒抑制覆盖。
- 大型 history snapshot 更新仍可能因 store 派生文本和 JSON key 比较产生成本；本需求先消除 2,346 个 textarea 的主线程渲染，再以 after 数据决定是否需要后续独立优化。
- 回退时只撤掉列表虚拟化和 transient draft，不改数据或迁移。

## 实现清单

- [x] 1. 建立可变行高虚拟布局纯函数与 hook，覆盖二分定位、范围、尺寸修正、最小跟随滚动和单元测试。
- [x] 2. 将 SubtitleList 接上虚拟窗口，只挂载可视区与缓冲行；保持行外观、统计、选择、删除和恢复真源不变。
- [x] 3. 增加 transient draft 与展开状态保存，覆盖编辑后滚走、离屏写回、撤销重做和自动保存。
- [x] 4. 接通查找定位与跨虚拟边界 Tab，覆盖首/尾命中、双向焦点连续和非目标行不抢焦点。
- [x] 5. 接通播放高亮自动跟随、焦点抑制、手动滚动 3 秒抑制和可见行不重复滚动。
- [x] 6. 增加 setTranscript 全文日志回归与长列表交互 E2E，覆盖选择、批量删除、恢复、智能剪空白、AI 写回状态。
- [x] 7. 增加可重复的 60 分钟性能脚本与真实使用证据，完成后台与前台 Chrome 五次 after、滚动长任务、查找和 Tab 验证。
- [x] 8. 更新前端子系统实施说明并对齐 F-0017 验收报告；不修改 Host、RPC、项目格式和 F-0056 文件。

## 验证计划

每项完成先跑对应最小检查；最终统一跑 docs/code-standards.md 第 1、2 条：

- pnpm lint、pnpm tsc -b --noEmit、pnpm check:host、cargo check --manifest-path src-tauri/Cargo.toml。
- pnpm test、pnpm test:architecture；architecture 本机进程/端口受限时按授权提权运行。
- pnpm test:e2e tests/e2e/features/F-0017.spec.ts，以及 F-0002、F-0003 全部 E2E 回归。
- pnpm build；生产构建载入长转写，监听 console 断言没有全文或长字幕参数。
- Red check：临时撤掉列表现代化渲染后，F-0017 的 DOM 数量或性能/行为测试必须失败，失败信息需指出仍渲染全部行；draft 或 3 秒抑制撤回时对应测试也需失败。
- 真实使用：前台本机 Chrome 用两段 COSCUP 60 分钟数据测打开/切换/转写注入 5 次，连续滚轮、拖到底、查找、Tab、编辑滚走、删除/恢复、撤销重做、播放跟随；记录 CPU 核数、机型、load average、端口和 long task。
- 桌面端：在当前环境启动 pnpm tauri:dev，真实 Host 打开长项目并重复 5 次；若环境不具备构建/GUI条件，精确记录 Not run，不能用 Web 数字代替。
- 界面证据：F-0017 E2E 使用 shot() 输出明暗主题截图，pnpm e2e:evidence F-0017；录屏仅本地。
- 原语言视图不属于优化范围，只记录一次切换耗时；超过 3 秒时报告阻塞和 E-02 候选建议。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | 可变行高虚拟窗口、打开状态保持、60 分钟前台 Chrome 5 次 after；桌面端真实运行或明确 Not run |
| AC-2 | 同一有序 chunk ID 窗口支持多视频切换；长转短和短转长分别计时，首屏可编辑即有界 |
| AC-3 | setTranscript 后只挂载首屏；固定转写通过 Host 注入/页面路由构造并计时 |
| AC-4 | 实测行高、总高度和前缀偏移；滚动窗口二分计算；滚轮与拖到底 E2E 检查空白、reachable、统计 |
| AC-5 | transient draft Map、blur 提交、离屏重挂载读取最新 chunk；自动保存、保存回读由 E2E/Mock Host 与 architecture 覆盖 |
| AC-6 | 选择集合基于全部有序 chunks；虚拟 DOM 不参与全选；单删、批量、全选、取消、恢复 E2E |
| AC-7 | undo/redo 仍由 history store 快照提供；离屏行重挂载读取目标快照；覆盖编辑、删除、智能剪空白和批量撤销 |
| AC-8 | currentChunk 变化触发的可见性跟随、textarea 焦点判断、3 秒手动滚动抑制；高亮由 currentChunk 独立维持 |
| AC-9 | 所有写回继续经 history store；离屏行动态挂载读取最新 chunks；覆盖跨可视区 AI/翻译/剪空白/原语言确认 |
| AC-10 | 行 wrapper 无视觉约束，SubtitleItem 外观与按钮不变；F-0002/F-0003 E2E、明暗主题截图、短列表对照和生产 console 断言 |
| AC-11 | 打开/切换期间继续显示既有“正在打开…”；只有首屏文本框可聚焦后才进入可编辑；长项目加载状态 E2E |

