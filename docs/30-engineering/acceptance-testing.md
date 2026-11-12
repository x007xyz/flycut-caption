# 自动化验收方案

每个任务先用命令验证结果。需求在设计阶段逐条为 AC 写下目标平台、自动化用例和预期断言；小修、重构或文档改动可以直接复用适用的测试、lint、类型检查或结构检查。只在现有检查无法验证新行为时新增测试。调研用可复跑的实验命令、输入和输出作为证据。

| 要验证什么 | 优先方式 | 当前入口 |
|---|---|---|
| 纯逻辑、数据迁移、Host RPC、错误处理 | 单元或集成测试，用固定输入断言输出或实际状态 | `pnpm test`、`pnpm test:architecture` |
| Web 界面、交互与界面状态 | Playwright，用角色、名称等稳定定位，等待可观察结果；需要时连接真实 Host | `pnpm test:e2e tests/e2e/features/<F-编号>.spec.ts`；用 `pnpm e2e:evidence <F-编号>` 生成截图和录屏 |
| Web 与桌面共用的业务流程 | 复用素材、操作和断言，在 Chrome 与真实 Tauri WKWebView 分别运行 | Web 现用 Playwright；WebdriverIO 双端试点见 [F-0058](../features/F-0058-cross-platform-acceptance/01-spec.md)，桌面入口待实现 |
| 桌面启动、内置 Host、字体和 FFmpeg 等打包资源 | 用脚本启动本次打包的应用，验证 Host 就绪并真实导出；检查输出文件和字幕画面 | 打包冒烟入口随 [F-0058](../features/F-0058-cross-platform-acceptance/01-spec.md) 实现 |
| 原生系统交互、剪映等外部应用 | 先检查是否有可靠的脚本或原生测试接口；没有时只补必要的实机步骤 | 在报告写明应用版本、操作、观察结果与自动化缺口 |

**执行与证据**

1. 先跑最快且能证明行为正确的检查，再跑受影响平台上的集成或端到端流程。修改行为或修 bug 按 [验收标准](../code-standards.md) 做 Red check；真实模型、真实 API、真实媒体等可由脚本驱动，mock 结果不能代替它们。
2. 端到端测试使用固定素材和独立测试数据。桌面测试按明确的构建路径启动，使用独立应用标识和数据目录，等待明确的就绪信号。失败保留目标平台、日志和断言，定位原因后再跑；对同一确定失败不反复点击或重启。
3. 在本次验收提交上记录每条 AC 的运行命令、结果和证据。Web、桌面、mock、真实环境分别如实记录。尚未执行的步骤记 `Not run` 并注明原因；只能用 Computer Use 或人工补验的，写清自动化覆盖不了什么以及实机结果。截图和录屏是补充证据。

维护者仍在原有确认点审阅需求与验收报告。自动测试通过是验收证据，不自动批准、合并或发布。

## Web 与 macOS 共用用例

F-0058 的试点用一份真实 Host 用例分别驱动 Chrome 和 macOS WKWebView；两端都会修改同一固定字幕，读取 Host 正式保存快照，再重新打开项目核对。

```bash
pnpm acceptance:web

# 仅测试构建注册 WebDriver；常规安装包不会注册测试命令或测试权限。
pnpm package:host
CARGO_TARGET_DIR="$PWD/src-tauri/target-acceptance" \
  pnpm exec tauri build --debug --bundles app \
  --features acceptance-webdriver --config src-tauri/tauri.acceptance.conf.json
pnpm acceptance:tauri "$PWD/src-tauri/target-acceptance/debug/bundle/macos/FlyCut Acceptance.app"
```

打包冒烟使用没有测试驱动的普通 macOS 候选包。它会启动隔离数据目录中的随包 Host，生成固定短片并导出中文字幕，断言视频轨、音频轨、时长和字幕像素：

```bash
pnpm package:host
pnpm exec tauri build --debug --bundles app
pnpm acceptance:bundle "$PWD/src-tauri/target/debug/bundle/macos/FlyCut Caption.app"
```

三个目标在 macOS CI 的 `macOS acceptance` 工作流分别运行；任一失败时上传各自的 `test-results/f0058-*.log`。现有 Playwright 用例仍使用 `pnpm test:e2e` 和 `pnpm e2e:evidence <F-编号>`。
