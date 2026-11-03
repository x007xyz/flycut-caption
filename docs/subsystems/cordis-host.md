# Cordis / Host

适用范围：`core/**`、`server/**`、`shared/**`、`src/runtime/**`、`src-tauri/src/host.rs`。当前边界和未迁移部分以 [architecture-current.md](../architecture-current.md) 为准。

## 规则

- 前后端是独立 Cordis Context。源码位于 `core/cordis`、`core/cosmokit`，来源与修改规则见 `core/UPSTREAM.md`；不要用自行实现的兼容类替换它们。
- Host 默认插件组合在 `server/app.ts`；LangGraph 同时提供 Workflow 与 Agent Loop。ASR Provider 在后端注册，前端通过 HTTP RPC / WebSocket 调用。
- **RPC 由插件自己注册**：在插件里 `ctx.effect(() => ctx.rpc.register(method, zodSchema, handler))`，并在 `shared/protocol.ts` 的 `RpcMethods` 中声明类型。不要在 `gateway.ts` 中加 `case`；Gateway 只负责传输、鉴权和分发。
- **事件跨进程需显式暴露**：Host 插件用 `ctx.emit` 发 Cordis 事件，需要推到前端的在 `RemoteEvents` 中声明并 `ctx.rpc.expose(name)`；前端用 `connection.on(name, ...)` 订阅。
- **扩展走注册表**：ASR Provider（`ctx.providers.register` / `describe`）、编辑分析（`ctx.editorPlugins.register`，自动成为 Workflow 步骤）、Agent 工具（`ctx.agentTools.register`）、工具策略（`agent/before-tool` 事件）。Provider ID 是开放字符串。
- 前端插件组合在 `src/runtime/client.ts`，React 通过 PluginSlot 渲染注册组件（`tools`、`options` 可多贡献）。ASR/AI 服务是 `ctx.asr` / `ctx.ai`，组件通过 `useClientRuntime()` 获取，不要再写模块级单例或全局连接。共享协议在 `shared/protocol.ts`，前后端共用的纯逻辑放 `shared/`。
- 视频导出通过后端 `server/plugins/export.ts` 的 Cordis 插件执行；前端只负责导出参数、任务进度和保存结果，Host 返回结果资产。Web 端 WebAV/FFmpeg 保留为明确的本地回退引擎；桌面只用 Host 导出，并通过 `save_host_asset` 复制到用户选定路径。
- Host 插件组合按 Profile 分层解析（`server/profile.ts`）：新内置插件要在 `BUILTINS` 登记 `provides`，否则依赖检查会把注入它的插件判为不满足。外部插件通过 `profile.patch.yml`（或 `.json`）的 `plugins` 加载。`js-yaml` 是 Host 包（`server/package.json`）的依赖，根包只放在 devDependencies。
- **Host 可能部署在远程**：`server` Profile 下 Gateway 不注册 `host.shutdown`，`models` 不接受服务器本地路径。新插件如果会读取客户端指定的 Host 本地路径或执行文件，要提供同样的配置开关，在 `server/profile.ts` 的 `PROFILE_CONFIG.server` 中关闭，并用 `ctx.rpc.capability` 告知前端。部署参数见 [architecture-current.md](../architecture-current.md) 的「部署形态」。
- 业务 store 是每个 Context 一份：组件用 `useXStore(selector)`，回调里用 `useRuntimeStoreApi(key).getState()`；不要再写 `useXStore.getState()` 或在 runtime 外使用这些 store。

## 命令

- `pnpm dev` 同时启动前端与 Host；`pnpm host:dev` 只启动 Host。
- `pnpm build:core` 构建 vendored 源码；`pnpm package:host` 为桌面部署后端及本机 Node。

## 验证

修改运行时或通信后至少运行：

```bash
pnpm test:architecture
pnpm check:host
pnpm tsc -b --noEmit
```

同时动到 Tauri/sidecar 的，还要满足 [funasr-tauri.md](funasr-tauri.md) 的验证要求。
