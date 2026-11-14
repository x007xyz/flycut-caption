# FlyCut Caption MCP & Skills 上架准备材料

> **发布授权提示**：本目录与根目录 `server.json`、`skills/flycut-caption/SKILL.md` 仅为 F-0052 交付的**上架准备材料**。向 npm、MCP Registry、Smithery 或 Skills 市场公开发布前，必须由项目维护者单独确认并执行，不得在无授权情况下自动提交发布。

## 1. 产品简介（Listing Copy）

### 中文

**FlyCut Caption MCP Server** 让支持 MCP 的 AI Agent（Codex、Claude Desktop、Cursor 等）通过本地 stdio 协议安全接入正在运行的 FlyCut Caption Host，完成：

- 上传本地视频/音频并创建、管理剪辑项目；
- 调用本机离线或已配置的 ASR 模型生成带字级时间戳的字幕；
- 生成「仅待审」的去口癖、静音与语义剪辑建议（不改动正式字幕、EDL 或导出），并引导创作者在 FlyCut 界面审阅确认；
- 从已确认的正式项目状态导出 MP4 / WebM 视频与 SRT / VTT / JSON / ASS 字幕；
- 对删除项目、移除视频、覆盖已有本地文件等破坏性操作强制走客户端人工二次确认门禁，Agent 与提示注入无法自行放行。

### English

**FlyCut Caption MCP Server** connects MCP-compatible AI agents (Codex, Claude Desktop, Cursor) over local stdio JSON-RPC 2.0 to a running FlyCut Caption Host:

- Upload local video/audio and manage captioning projects;
- Run Host-managed ASR models (including local offline models) to generate word-level transcripts;
- Generate review-only filler, silence, and semantic cut suggestions without modifying formal subtitles, EDL, or exports until confirmed in the FlyCut UI;
- Export MP4 / WebM videos and SRT / VTT / JSON / ASS subtitles from formal project state;
- Enforce human-in-the-loop client confirmation for destructive actions (project deletion, video removal, and overwriting existing files).

## 2. 权限、数据与隐私声明

- **本地 Host 鉴权**：MCP Server 仅连接本地或用户显式配置的 FlyCut Host，使用 Host Bearer Token 鉴权；Token、AI API Key 与其他项目无关数据不会写入工具描述、`stdout`/`stderr` 日志或工具返回。
- **文件访问边界**：仅在调用方显式传入 `filePath` 或 `outPath` 时读写对应媒体/导出文件，不将任意本地路径直接提交给 Host RPC；媒体通过 Host `/uploads` / `/assets` 传输。
- **破坏性操作门禁**：MCP 工具表不提供批准接口（无 `confirmations.decide`），所有 `yes`/`approve`/`actor` 注入字段均被严格 schema 拒绝；覆盖本地已有文件前需用户于 FlyCut UI 批准并一次性消费 `confirmationId`。
- **无遥测 / 无云端强制依赖**：所有工具与资源均在本地 Host 运行，不收集或上传用户使用数据。

## 3. 上架提审前检查清单（维护者确认用）

- [ ] 确认发布目标版本（当前 `package.json` 与 `server.json` 均为 `2.0.2`）并确保 `package.json` 的 `files` 包含 `dist-mcp/flycut-mcp.mjs` 及对应发布产物（需在正式发版 PR 中一并审阅 `pnpm build:mcp` 打包结果）。
- [ ] 在获得维护者发布授权后运行 `pnpm lint && pnpm build:lib && pnpm build:cli && pnpm build:mcp`，确认 `flycut-mcp --version` 与 `flycut-mcp --help` 正常。
- [ ] 使用 MCP Registry CLI（如 `mcp-publisher validate`）校验根目录 `server.json`；经维护者批准后再执行 `npm publish` 与 `mcp-publisher publish`。
- [ ] 将 `skills/flycut-caption/SKILL.md` 同步或提交至目标 Agent Skills 仓库时，一并附带 `docs/mcp-server.md` 链接与最低 Host 版本要求。
