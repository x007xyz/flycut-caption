---
id: F-0003
stage: 04-test-report
status: review
approved_by:
approved_at:
---

# F-0003 项目管理：测试与验收

验收在 commit `6b2ef3c` 上进行（分支 `feat/f-0003-project-management`，从 `feat/f-0002-project-persistence` 切出；实现在 `52cd7be`，`6b2ef3c` 只加文档和一条 Host 测试）。

> 技术设计和开发阶段由 agent 连续推进、自动确认；维护者在这里一并审阅。

## 设计与实现摘要

- **数据格式 2**（[ADR-0003](../../20-architecture/adr/0003-multi-video-projects.md)，proposed，确认本报告时一并改为 accepted）：每个视频有自己的修订号和样式来源（跟随项目 / 单独设置），项目级保存主、副字幕样式，画幅始终按视频保存；回收站用 `deletedAt` / `purgeAfter` 标记，默认 30 天。格式 1 的项目读时迁移，第一次写入时保留 `project.v1.json`。
- **Host**（`server/plugins/projects.ts`）：新增 `createEmpty / detail / rename / trash / restore / trashList / purge / emptyTrash / addVideo / removeVideo / saveVideoEdits / saveProjectStyle / createFromSnapshot`。回收站里的项目对所有读写都不可见；彻底删除先把目录改名再删，不跟随链接、不碰原文件；到期清理在启动时和每小时运行。
- **前端**：首页新建空项目、排序、卡片和列表行菜单、重命名与删除（带撤销）；回收站页；项目详情页（多文件添加、打开、移除）；编辑器顶栏视频切换；样式面板的样式来源栏和一次性提示；「项目已被删除」对话框。桌面外壳新增 `pick_media_files`（多选）。
- **与设计的偏差（请确认）**：没有项目事务恢复记录；迁移改为读时计算；没有 `metadataRevision`；Host 不记录转写属于哪个视频；清单 1–7 一次提交。详见 [03-implementation.md](03-implementation.md)「与设计的偏差」。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| **不做事务恢复记录（请确认）** | 每个文件原子替换，先写 `edits.json` 再写 `project.json` | 实现量小；崩溃时最坏情况是修订号没加一、读到较新的内容，不会读到半个文件。代价：这时另一个窗口用旧修订号保存同一视频不会报冲突 | AC-14、AC-16 |
| **读时迁移（请确认）** | 格式 1 的样式留在原视频的 `edits.json`，项目没有 `style` 时由 Host 读出；第一次写入时备份 `project.v1.json` | 不需要搬文件，也就不需要迁移事务；移除提供样式的视频前先把样式写进 `project.json` | AC-12、AC-16 |
| **元数据操作后写生效（请确认）** | 重命名、移到回收站、恢复不比较修订号 | PRD 只要求保存类操作检测冲突 | AC-2、AC-3、AC-4 |
| **转写保护只在界面上（请确认）** | Host 不记录转写属于哪个视频；发起转写的窗口里不能切换或移除这个视频 | 另一个窗口仍可移除正在转写的视频，此时结果写回失败，不会写到别的视频 | AC-11、AC-30 |
| 一次提交实现 | 清单 1–7 合成一次提交 | 共用同一份格式 2 契约和同一个 `projectService`，拆开会有很多只能一起工作的中间状态 | — |
| 名称排序 | `Intl.Collator(界面语言)`；中文界面下汉字按拼音、排在拉丁字母之前 | ICU 中文排序规则 | AC-6 |
| 画幅的范围 | 画幅只指 `aspectPreset`；底边距属于样式，跟随项目时共享 | 与 F-0002 的样式结构一致 | AC-13 |
| 一次性提示 | 按项目记在本机 localStorage | 界面偏好，不进 Host | AC-31 |
| 彻底删除后另存 | 新增 `projects.createFromSnapshot`：保存字幕、修改和样式，媒体读作丢失，走 F-0002 媒体丢失流程重新选择 | ADR-0002 只允许登记本次选择或拖入的文件，不能让外壳重新登记原路径 | AC-32 |
| 桌面端多选 | 外壳新增 `pick_media_files`，选中的路径同样进允许列表 | AC-8 要一次选多个文件 | AC-8 |
| F-0002 端到端测试 | 假数据改成格式 2（`saveVideoEdits`、`videos`） | 契约变了，测的行为不变 | F-0002 回归 |

## 验收标准逐条结果

命令：Host `pnpm test:architecture`（`tests/architecture/projects-f0003.test.ts`，11 条）；界面 `pnpm e2e:evidence F-0003`（`tests/e2e/features/F-0003.spec.ts`，44 条：明暗主题各一遍，另有英文界面）。真实使用在 Web 端完成：`pnpm dev` 的 Host 和前端，用单独的 Host 目录和端口（8777 / 5180），内置浏览器操作，SenseVoice Small INT8 真实识别。

| AC | 验证方式 | 证据 | 结果 |
|---|---|---|---|
| AC-1 新建空项目 | Host 测试；e2e；真实使用 | `F-0003/AC-1: an empty project exists…`；`AC-18 AC-1 新建空项目…`；浏览器新建后进入空详情页 | ✅ |
| AC-2 重命名 | Host 测试；e2e；真实使用 | `AC-2: rename trims, validates…`（1–200 字、去空格、只改名称和修改时间）；`AC-21 AC-2 …`；详情页改名后首页、顶栏同步 | ✅ |
| AC-3 移到回收站 | Host 测试；e2e；真实使用；Red check | `AC-3 AC-4 AC-15: Trash hides a project…`；`AC-22 AC-3 …`；第二个标签页删除后首页数量减少。Red check：去掉列表的回收站过滤后该测试失败 | ✅ |
| AC-4 恢复 | Host 测试；e2e | 恢复后转写、修改、视频和媒体与删除前一致，媒体可播放；`AC-25 AC-4 …`、撤销 | ✅ |
| AC-5 彻底删除 | Host 测试；真实使用 | `AC-5 AC-24: permanent delete…`（stored 媒体删除；linked 原文件、项目目录里指向外部的文件和目录符号链接都不受影响；只删回收站里的项目）；`AC-5: expired projects…`（保留期调到 0.4 秒，运行中和启动时到期删除，恢复先执行的保留，中断的删除下次启动删完）；浏览器回收站彻底删除 | ✅ |
| AC-6 排序 | e2e | `AC-20 AC-6 排序…`（三种排序、与搜索组合、重开后保持） | ✅ |
| AC-7 打开项目 | e2e；真实使用 | `AC-7 只有一个视频直接进编辑器…`；浏览器点多视频项目进入详情页 | ✅ |
| AC-8 添加视频 | Host 测试；e2e；真实使用 | `AC-8 AC-11: videos are added one by one…`（失败不留半个视频）；`AC-27 AC-8 …`（每个文件一次请求、不传路径）；浏览器一次添加两个文件，状态「未转写」 | ✅ Web；⏸ 桌面端原生多选和拖入未跑（见下） |
| AC-9 打开视频 | e2e；真实使用 | `AC-29 AC-9 …`；浏览器打开未转写视频后自动转写，结果写进这个视频（Host 文件核对） | ✅ |
| AC-10 切换视频 | e2e；真实使用 | `AC-30 AC-10 …`（先保存当前视频、再载入目标、撤销清空）；浏览器两段之间切换，改过的字幕和各自样式都保留 | ✅ |
| AC-11 移除视频 | Host 测试；e2e | stored 副本删除、linked 原文件保留、最后一个视频移除后项目留空；`AC-28 AC-11 …` | ✅ |
| AC-12 共享样式 | Host 测试；e2e；真实使用 | `AC-12 AC-13: videos follow…`、格式 1 升级测试；`AC-31 …`；浏览器改第 1 段样式后 `project.json` 的 `style` 更新，第 2 段打开即是同一样式 | ✅ |
| AC-13 单独设置 | Host 测试；e2e；真实使用 | 单独设置的样式只在这个视频的 `edits.json`，恢复跟随后丢弃；画幅按视频保存；浏览器把第 2 段设为蓝色后第 1 段和项目样式不变 | ✅ |
| AC-14 多窗口不同视频 | Host 测试；Red check | `AC-14: two windows…`（同时保存不同视频都成功；同视频、同项目样式冲突）。Red check：改回按项目修订号比较后该测试失败 | ✅ Host；⏸ 两个真实窗口同时改不同视频没有在界面上做（Host 并发测试覆盖了判定逻辑） |
| AC-15 项目在别处被删除 | Host 测试；e2e；真实使用 | 回收站里的项目不接受任何写入；`AC-32 AC-15 …`；浏览器两个标签页：一个删除，另一个保存时暂停并弹窗，恢复并保存后数据写入 | ✅ |
| AC-16 格式升级 | Host 测试 | `AC-16 AC-12: a format-1 project opens with nothing lost…`（字幕、删除标记、译文、样式、画幅、媒体都在；读取不写文件；第一次写入后为格式 2 并保留 `project.v1.json`）；格式过新的拒绝写入沿用 F-0002 测试 | ✅ |
| AC-17 Web 端 | 真实使用 | 以上真实使用全部在 Web 端（`pnpm dev`，本机 Host）完成 | ✅ Web；⏸ 「桌面端创建的项目在 Web 端打开」未做（桌面端没跑） |
| AC-18 新建区 | e2e | `AC-18 AC-1 …`：创建中三个按钮不可点 | ✅ |
| AC-19 卡片菜单 | e2e；真实使用 | `AC-19 …`：键盘聚焦显示「更多操作」，列表行同样菜单，「3 个视频」、时长之和、「0 个视频」和「—」 | ✅ |
| AC-20 排序控件 | e2e | 默认「最近修改」，搜索无结果时仍可用 | ✅ |
| AC-21 重命名对话框 | e2e | 填好并全选、空名和未改动不可保存、保存中、失败不关闭、Esc 取消 | ✅ |
| AC-22 删除确认 | e2e | 文案、「移到回收站」、提示里的撤销 | ✅ |
| AC-23 回收站页面 | e2e | 加载中、读取失败重试、空（没有「清空回收站」）、有项目（「28 天后彻底删除」「今天彻底删除」）、首页搜索不到回收站项目 | ✅ |
| AC-24 彻底删除确认 | e2e | 单个和清空两种文案、执行中按钮不可点、失败不关闭；清空只提交看到的项目 | ✅ |
| AC-25 恢复反馈 | e2e | 该行转圈、成功消失并提示、失败提示且保留 | ✅ |
| AC-26 详情页 | e2e | 加载中、失败可重试且能返回、空（点击打开多选文件框）、有视频（已转写 / 未转写 / 媒体丢失、菜单「移除」、重命名按钮） | ✅（「转写中 {progress}%」只在发起转写的窗口出现，由真实使用看到，e2e 没单独构造） |
| AC-27 添加视频 | e2e | 拖入遮罩、正在添加、添加中「添加视频」不可点、单个失败不影响其他并可移除 | ✅ |
| AC-28 移除确认 | e2e | 文案、执行中、失败不关闭、成功后列表更新 | ✅ |
| AC-29 正在打开 | e2e | 该行「正在打开…」，其他行变灰不可点 | ✅ |
| AC-30 顶栏切换 | e2e；真实使用 | 视频列表与状态、切换中「正在打开…」、点项目名进详情页、单视频不显示下拉；转写中其他视频不可选并显示「正在转写，完成后再切换」（真实转写中在内置浏览器里看到，e2e 没有构造转写中状态） | ✅ |
| AC-31 样式来源 | e2e | 两种状态、恢复跟随要确认（取消不变）、一次性提示关闭后不再出现 | ✅ |
| AC-32 项目已被删除 | e2e；Host 测试；真实使用 | 回收站中：三个按钮，恢复并保存；已彻底删除：只有另存和放弃，另存后媒体读作丢失；放弃回到首页；`AC-32: save as new after a permanent delete…` | ✅ |

**成功指标（性能）**：在单独的 Host 上建 10 个视频的项目（其中一个是拼接的 59:59 视频、1173 句、15014 字），用 Playwright 驱动本机 Chrome 计时：

- 详情页从点击到列表显示：58、73、102、122、466 ms ✅（指标 1 秒）
- 切换到 60 分钟视频到可编辑：3521、4392、4982 ms ❌（指标 3 秒）。`projects.open` 97 ms 返回，其余约 3.3 秒是前端载入和渲染全部 1173 条字幕。和 F-0002 记录的「60 分钟数据打开 6.9 秒」是同一根因（字幕列表没有虚拟化），不是本需求引入的。

## 界面证据

`pnpm e2e:evidence F-0003`：44 通过，0 失败；截图 84 张（[screenshots/](screenshots/)，进 git），录屏 44 段（recordings/，只在本地，摘要 `recordings/summary.json`）。每个状态都有浅色和深色两张。

| 界面 | 状态 | AC | 截图 |
|---|---|---|---|
| 首页 | 创建空项目中、卡片菜单、列表行菜单、排序 | AC-18–20 | [home-creating-empty](screenshots/home-creating-empty-light.png) / [dark](screenshots/home-creating-empty-dark.png)、[home-card-menu](screenshots/home-card-menu-light.png) / [dark](screenshots/home-card-menu-dark.png)、[home-list-menu](screenshots/home-list-menu-light.png) / [dark](screenshots/home-list-menu-dark.png)、[home-sort](screenshots/home-sort-light.png) / [dark](screenshots/home-sort-dark.png) |
| 重命名 | 保存中、失败 | AC-21 | [rename-saving](screenshots/rename-saving-light.png) / [dark](screenshots/rename-saving-dark.png)、[rename-failed](screenshots/rename-failed-light.png) / [dark](screenshots/rename-failed-dark.png) |
| 删除 | 确认、移到回收站提示（撤销） | AC-22 | [delete-confirm](screenshots/delete-confirm-light.png) / [dark](screenshots/delete-confirm-dark.png)、[delete-toast](screenshots/delete-toast-light.png) / [dark](screenshots/delete-toast-dark.png) |
| 回收站 | 加载中、失败、空、有项目、恢复中 | AC-23、AC-25 | [trash-loading](screenshots/trash-loading-light.png) / [dark](screenshots/trash-loading-dark.png)、[trash-error](screenshots/trash-error-light.png) / [dark](screenshots/trash-error-dark.png)、[trash-empty](screenshots/trash-empty-light.png) / [dark](screenshots/trash-empty-dark.png)、[trash-rows](screenshots/trash-rows-light.png) / [dark](screenshots/trash-rows-dark.png)、[trash-restoring](screenshots/trash-restoring-light.png) / [dark](screenshots/trash-restoring-dark.png) |
| 彻底删除 | 确认、执行中、失败、清空确认 | AC-24 | [purge-confirm](screenshots/purge-confirm-light.png) / [dark](screenshots/purge-confirm-dark.png)、[purge-busy](screenshots/purge-busy-light.png) / [dark](screenshots/purge-busy-dark.png)、[purge-failed](screenshots/purge-failed-light.png) / [dark](screenshots/purge-failed-dark.png)、[empty-trash-confirm](screenshots/empty-trash-confirm-light.png) / [dark](screenshots/empty-trash-confirm-dark.png) |
| 项目详情 | 加载中、失败、空、有视频、拖入、添加中、添加失败、打开中 | AC-26、AC-27、AC-29 | [detail-loading](screenshots/detail-loading-light.png) / [dark](screenshots/detail-loading-dark.png)、[detail-error](screenshots/detail-error-light.png) / [dark](screenshots/detail-error-dark.png)、[detail-empty](screenshots/detail-empty-light.png) / [dark](screenshots/detail-empty-dark.png)、[detail-videos](screenshots/detail-videos-light.png) / [dark](screenshots/detail-videos-dark.png)、[detail-dragging](screenshots/detail-dragging-light.png) / [dark](screenshots/detail-dragging-dark.png)、[detail-adding](screenshots/detail-adding-light.png) / [dark](screenshots/detail-adding-dark.png)、[detail-add-failed](screenshots/detail-add-failed-light.png) / [dark](screenshots/detail-add-failed-dark.png)、[detail-opening](screenshots/detail-opening-light.png) / [dark](screenshots/detail-opening-dark.png) |
| 移除视频 | 确认、失败 | AC-28 | [remove-confirm](screenshots/remove-confirm-light.png) / [dark](screenshots/remove-confirm-dark.png)、[remove-failed](screenshots/remove-failed-light.png) / [dark](screenshots/remove-failed-dark.png) |
| 编辑器顶栏 | 视频列表、切换中、单视频 | AC-30 | [editor-switcher](screenshots/editor-switcher-light.png) / [dark](screenshots/editor-switcher-dark.png)、[editor-switching](screenshots/editor-switching-light.png) / [dark](screenshots/editor-switching-dark.png)、[editor-single](screenshots/editor-single-light.png) / [dark](screenshots/editor-single-dark.png) |
| 样式来源 | 跟随、提示、单独设置、恢复确认 | AC-31 | [style-following](screenshots/style-following-light.png) / [dark](screenshots/style-following-dark.png)、[style-shared-hint](screenshots/style-shared-hint-light.png) / [dark](screenshots/style-shared-hint-dark.png)、[style-custom](screenshots/style-custom-light.png) / [dark](screenshots/style-custom-dark.png)、[style-follow-confirm](screenshots/style-follow-confirm-light.png) / [dark](screenshots/style-follow-confirm-dark.png) |
| 项目已被删除 | 在回收站、已彻底删除 | AC-32 | [deleted-trashed](screenshots/deleted-trashed-light.png) / [dark](screenshots/deleted-trashed-dark.png)、[deleted-permanently](screenshots/deleted-permanently-light.png) / [dark](screenshots/deleted-permanently-dark.png) |
| 英文界面 | 首页、详情、回收站、顶栏、删除确认、项目已被删除 | AC-18–32 | [en-home](screenshots/en-home-light.png) / [dark](screenshots/en-home-dark.png)、[en-detail](screenshots/en-detail-light.png) / [dark](screenshots/en-detail-dark.png)、[en-trash](screenshots/en-trash-light.png) / [dark](screenshots/en-trash-dark.png)、[en-editor-switcher](screenshots/en-editor-switcher-light.png) / [dark](screenshots/en-editor-switcher-dark.png)、[en-delete-confirm](screenshots/en-delete-confirm-light.png) / [dark](screenshots/en-delete-confirm-dark.png)、[en-deleted](screenshots/en-deleted-light.png) / [dark](screenshots/en-deleted-dark.png) |

## 回归检查

在 `52cd7be` 的工作区上：

- `pnpm lint` ✅、`pnpm tsc -b --noEmit` ✅、`pnpm check:host` ✅、`cargo check --manifest-path src-tauri/Cargo.toml` ✅
- `pnpm test` ✅（66 条：63 过，3 条需要本机模型的集成测试跳过）、`pnpm test:architecture` ✅（40 条，含 F-0002 全部 Host 测试）、`pnpm build` ✅
- F-0002 回归：`tests/e2e/features/F-0002.spec.ts` 36 条全过（假数据改为格式 2）

**Not run**：

- ⏸ **桌面端（Tauri）**：没有运行 `pnpm tauri:dev`。它用本机真实的应用数据目录，第一次保存就会把维护者现有项目升级为格式 2（会保留 `project.v1.json`）。原生多选（`pick_media_files`，只做了 `cargo check`）、桌面拖入添加、桌面端从选择文件到出结果的完整流程、桌面端创建的项目在 Web 端打开，都没有验证。**请维护者同意后再测**。
- ⏸ **逐段导出**：本需求没有改导出代码（导出仍是当前视频），没有实际导出各段并用播放器检查。
- ⏸ **两个真实窗口同时改不同视频**：判定逻辑由 Host 并发测试覆盖；界面上只做了「一个窗口删除、另一个窗口保存」。
- ⏸ **HTTP Provider 转写**：只用了内置 sherpa-onnx（SenseVoice）；转写路径本需求没改。

## 发现的问题

1. **切换到 60 分钟视频没达成功指标**（3.5–5.0 秒，指标 3 秒）。根因是字幕列表没有虚拟化，F-0002 已记录，建议单独立项做字幕列表虚拟化。
2. **已修**：同一项目里多个视频的封面原来按「项目 + 修订号」缓存，会显示成同一张；改为按视频缓存。添加视频后 3 秒再读一次详情，拿到 Host 后台截好的封面和真实时长。
3. 内置浏览器面板隐藏时，后台标签页的定时器被节流，计时和多步操作都不可靠；性能数据改用 Playwright 前台 Chrome 测。一次「地址是短片、内容是长视频」的现象就是切换做到一半被节流造成的，前台复测正常。

## 结论

**需要维护者确认后发布**：32 条验收标准在 Web 端全部通过，其中 AC-8、AC-14、AC-17 的桌面端部分 ⏸ 未测。需要你决定的是：

1. 上面标「请确认」的四条设计偏差（ADR-0003 一并改为 accepted）；
2. 是否同意在桌面端用真实数据目录补测（或者告诉我用一个临时数据目录跑 Tauri 的办法）；
3. 「60 分钟视频切换 3 秒」不达标，是否接受，以字幕列表虚拟化单独立项跟进。
