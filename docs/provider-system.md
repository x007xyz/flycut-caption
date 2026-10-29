# Provider 包与 Pipeline 规范

## 目标

Provider 是可安装、可发现、可配置的能力包。一个 Provider 可以提供多个能力，例如 ASR、VAD 和字词对齐；Pipeline 负责把不同 Provider 的能力按顺序组合。

```text
ProviderPackage → Capability → Model → Config
Pipeline        → ordered Capability steps
```

当前前端类型位于 `src/types/provider.ts`，内置目录位于 `src/services/providerRegistry.ts`，用户当前流程保存于 `pipeline-settings` Zustand 持久化存储。

## Provider Manifest

外部 Provider 使用版本化 JSON 描述，不直接暴露任意 shell 命令：

```json
{
  "schemaVersion": 1,
  "id": "audio-separator",
  "name": "Audio Separator",
  "runtime": "python",
  "capabilities": [
    {
      "id": "separate-vocals",
      "kind": "separate-vocals",
      "input": ["audio", "video"],
      "output": ["vocals", "instrumental"],
      "configFields": {
        "device": { "type": "select", "default": "auto" }
      }
    }
  ]
}
```

Provider manifest 只声明能力、模型和参数 schema。运行时入口由应用的受控 runner 注册，避免导入配置就执行任意程序。

## Pipeline

Pipeline 只引用 Provider、能力和模型：

```json
{
  "schemaVersion": 1,
  "id": "music-video-caption",
  "name": "音乐视频字幕",
  "steps": [
    {
      "id": "preprocess",
      "providerId": "audio-separator",
      "capabilityId": "separate-vocals",
      "enabled": true,
      "config": { "device": "auto" }
    },
    {
      "id": "recognizer",
      "providerId": "qwen-asr",
      "capabilityId": "transcribe",
      "modelId": "qwen3-asr-0.6b",
      "enabled": true,
      "config": {}
    }
  ]
}
```

当前识别通过独立 Cordis Host 的 LangGraph Workflow 执行，ASR Provider 在后端注册。已支持识别及剪空白分析；人声分离仍标记 planned，若启用未实现步骤会明确报错。完整运行架构见 architecture-current.md。
