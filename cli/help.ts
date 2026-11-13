export const ROOT_HELP = `FlyCut Caption Host CLI

用法 / Usage:
  flycut <command> [options]

全局选项 / Global Options:
  --json                  输出机器可读 JSON 到 stdout（日志与进度仅走 stderr）
  --host <url>            指定已运行 Host 地址（或设置 FLYCUT_HOST_URL）
  --token <token>         指定 Host Bearer 凭证（或设置 FLYCUT_HOST_TOKEN）
  --token-file <path>     从文件读取 Host Bearer 凭证
  --home <dir>            Host home 目录（默认 ~/.flycut-caption/host，用于读取 connection.json）
  --operation-id <uuid>   幂等操作 ID（UUID，重试不重复执行副作用）
  -h, --help              显示帮助与示例
  -v, --version           显示版本号

子命令 / Commands:
  status                                   检查 Host 连接、身份与能力
  providers list | models | prepare        查看识别/VAD Provider 与模型状态，或准备模型
  ai list                                  查看 Host 保存的 AI 配置（仅脱敏视图，不读浏览器）
  media upload <file>                      上传本地媒体文件到 Host，返回 assetId
  projects list                            列出活动项目（空列表返回 [] 且退出码 0）
  projects create --name <n> [media]       创建项目（--file <path> | --asset-id <id> | --empty）
  projects get <projectId>                 读取项目详情、视频列表与当前转写/编辑摘要
  projects add-video <projectId> [media]   向项目添加视频（--file <path> | --asset-id <id>）
  projects delete <projectId> [--purge]    请求删除项目（仅生成客户端待确认请求，--yes 不可绕过）
  projects remove-video <pid> <vid>        请求移除视频（仅生成客户端待确认请求，--yes 不可绕过）
  transcribe <projectId> [options]         在 Host 上转写项目视频并保存（可 --no-wait）
  suggest <projectId> [options]            生成待审剪辑建议（不写入正式字幕/EDL/导出）
  suggestions list|dismiss <projectId>     查看或忽略 Host 待审剪辑建议
  export <projectId> --out <path> [opts]   导出新文件（目标已存在时需客户端确认）
  jobs list | get <id> | cancel <id>       查询或取消 Host 后台任务
  confirmations list | get <id>            查询客户端二次确认请求状态

退出码 / Exit Codes:
  0    成功（含空列表 [] 与 --no-wait 接受提交）
  1    内部或未知错误
  2    鉴权失败（AUTH_FAILED）
  3    无 Host 连接或连接超时（NO_HOST_CONNECTION）
  4    需要客户端二次确认或已被拒绝（CONFIRMATION_REQUIRED / CONFIRMATION_REJECTED）
  5    参数或 ID 格式错误（INVALID_ARGUMENT / INVALID_ID）
  6    目标不存在、已进回收站或媒体缺失（NOT_FOUND / PROJECT_TRASHED / MEDIA_MISSING）
  7    识别模型或 Host AI 配置未就绪（MODEL_REQUIRED / MODEL_NOT_READY / AI_CONFIG_NOT_READY）
  8    版本冲突（VERSION_CONFLICT）
  9    Host 任务失败或已取消（JOB_FAILED / JOB_CANCELLED）
  130  Ctrl+C 停止本地等待（将附带 Host 任务最新状态）

示例 / Examples:
  flycut status --json
  flycut projects list --json
  flycut projects create --name "口播第1期" --file ./demo.mp4 --json
  flycut transcribe <projectId> --provider sherpa-onnx --model sensevoice-small-int8-zh-en-ja-ko-yue-2024-07-17 --language zh --json
  flycut suggest <projectId> --kind fillers --json
  flycut export <projectId> --format mp4 --subtitles hard --out ./out.mp4 --json
  flycut jobs get <jobId> --json
`;

export const SUBCOMMAND_HELP: Record<string, string> = {
  status: `用法: flycut status [--json]\n检查已运行 Host 的连通性、hostId 与能力标志。`,
  providers: `用法:\n  flycut providers list [--json]\n  flycut providers models [--json]\n  flycut providers prepare --provider <id> --model <id> [--no-wait] [--json]`,
  ai: `用法: flycut ai list [--json]\n列出 Host 保存的 AI 配置元数据（仅包含 hasApiKey，不暴露密钥）。`,
  media: `用法: flycut media upload <filePath> [--operation-id <uuid>] [--json]\n将本地音视频通过 Host /uploads（或 /assets）上传，返回 assetId。`,
  projects: `用法:\n  flycut projects list [--json]\n  flycut projects create --name <name> (--file <path> | --asset-id <uuid> | --empty) [--operation-id <uuid>] [--json]\n  flycut projects get <projectId> [--video <videoId>] [--json]\n  flycut projects add-video <projectId> (--file <path> | --asset-id <uuid>) [--name <name>] [--operation-id <uuid>] [--json]\n  flycut projects delete <projectId> [--purge] [--operation-id <uuid>] [--json]\n  flycut projects remove-video <projectId> <videoId> [--operation-id <uuid>] [--json]`,
  transcribe: `用法: flycut transcribe <projectId> [--video <videoId>] [--provider <providerId>] --model <modelId> [--language auto|zh|en|...] [--option key=value] [--no-wait] [--operation-id <uuid>] [--json]`,
  suggest: `用法: flycut suggest <projectId> [--video <videoId>] [--kind fillers|silence|semantic|all] [--silence-method auto|vad|gap] [--config-id <uuid>] [--vad-provider <id> --vad-model <id>] [--no-wait] [--operation-id <uuid>] [--json]`,
  suggestions: `用法:\n  flycut suggestions list <projectId> [--video <videoId>] [--json]\n  flycut suggestions dismiss <projectId> <videoId> <suggestionId> [--json]`,
  export: `用法: flycut export <projectId> --out <filePath> [--video <videoId>] [--format mp4|webm|srt|vtt|json|ass] [--quality high|medium|low] [--subtitles none|soft|hard] [--subtitle-mode Bilingual|Main|Second] [--no-audio] [--confirmation-id <uuid>] [--no-wait] [--operation-id <uuid>] [--json]`,
  jobs: `用法:\n  flycut jobs list [--json]\n  flycut jobs get <jobId> [--json]\n  flycut jobs cancel <jobId> [--json]`,
  confirmations: `用法:\n  flycut confirmations list [--pending] [--json]\n  flycut confirmations get <confirmationId> [--json]`,
};
