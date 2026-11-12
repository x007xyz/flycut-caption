---
id: F-0058
stage: 03-implementation
status: approved
approved_by: auto
approved_at: 2026-11-12
---

# F-0058 Web 与桌面共用自动化验收：开发记录

## 分支与 PR

- 分支：`codex/f0058-cross-platform-acceptance`（实现时在 `codex/f0028-shared-subtitle-graphics` 工作区完成）
- PR：

## 进度

<!-- 每完成实现清单的一项，在 02-design.md 勾选，并在这里追加一行：日期、清单项、提交 sha、跑过的检查。
换会话接着做时，先读 02-design.md 和这里。 -->

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-12 | 1：固定项目、Chrome 和共用保存用例 | 11c5a49 | `pnpm acceptance:web`；真实 Host 快照与重开文本一致 |
| 2026-11-12 | 2：隔离 Tauri 测试构建和 WKWebView | 11c5a49 | `pnpm acceptance:tauri`；同一用例通过，默认构建没有 WebDriver |
| 2026-11-12 | 3：无驱动启动、字幕导出和反向故障 | 11c5a49 | `pnpm acceptance:bundle`；正常导出及缺 Node、缺字体均通过 |
| 2026-11-12 | 4：CI、命令文档与回归 | 11c5a49 | 静态检查、单元测试、92 项架构测试和打包字体资源测试通过 |

## 自行决定的事项

- Web 和桌面共用 `tests/acceptance/subtitle-persistence.ts`；两端只替换浏览器会话和项目夹具，保存断言复用真实 Host RPC。
- 桌面驱动只由 macOS debug 构建的 `acceptance-webdriver` feature 注册，并使用独立 bundle id `com.flycut.caption.acceptance`。
- 打包测试先检查本次启动的应用 PID 是否持有驱动器端口，避免连接到旧安装版。
- 无驱动冒烟使用黑底、固定 3 秒短片和已知中文字幕；音视频轨、时长、cue 内亮像素和 cue 外黑场均由脚本断言。
- 打包测试发现了 Host 未声明 `@chenglou/pretext` 的真实缺失，补到 Host 依赖后重打包通过。

## 与设计的偏差

- 嵌入驱动不会在按 Tab 时执行原生焦点切换，因此共用用例用真实「全选」按钮点击触发字幕输入失焦；这仍经过产品交互并让两端执行同一操作。
- 普通包与带驱动包使用不同 Cargo 输出目录，防止后一次构建覆盖前者而让无驱动冒烟误测测试包。
- macOS Tauri 测试构建通过 `--config src-tauri/tauri.acceptance.conf.json` 使用独立应用标识和窗口标题。

## 遗留问题

- 当前沙盒在启动 ChromeDriver 前会拦截回环监听；本机已经完成 Web、WKWebView 和无驱动包三项真实运行。全量 `pnpm test:architecture` 在这个普通沙盒内无法启动，需要在 CI 或获准的本机终端复跑。
