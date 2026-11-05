# FlyCut Caption 本地化技术文档

## 📋 文档目录

- [技术架构](./architecture.md) - 整体技术架构设计
- [本地化迁移指南](./migration-guide.md) - 从 Web 版本迁移到桌面版本
- [性能对比分析](./performance-comparison.md) - Web vs 本地化性能对比
- [开发环境配置](./development-setup.md) - Tauri 开发环境搭建
- [API 设计](./api-design.md) - Rust 后端 API 设计
- [部署指南](./deployment.md) - 应用打包和分发
- [接入 FunASR（Python）](./funasr-provider.md) - 运行独立的 FunASR Provider 并在 FlyCut 里添加
- [FunASR 客户端本地接入方案](./funasr-integration.md) - Web 和 Tauri 无服务端接入 FunASR 的实现路线
- [字幕系统改进方案](./subtitle-system-improvement-plan.md) - 字体、排版、分辨率适配、导出格式分阶段实施方案

## 🎯 项目概述

FlyCut Caption 是一个智能视频字幕裁剪工具，正在从 Web 应用迁移到桌面应用，以获得更好的性能和用户体验。

### 核心功能
- **ASR 语音识别**: 基于 Whisper 模型生成字级时间戳字幕
- **智能字幕编辑**: 可视化选择和删除字幕片段
- **视频预览**: 跳过删除片段的预览播放
- **高效导出**: 快速生成裁剪后的视频文件

### 技术栈演进

| 组件 | Web 版本 | 桌面版本 | 备注 |
|------|----------|----------|------|
| **前端** | React + Vite | React + Vite | 保持不变 |
| **后端** | 浏览器 API | Tauri + Rust | 新增本地后端 |
| **ASR** | WebAssembly Whisper | whisper.cpp | 本地化处理 |
| **视频处理** | Web API | FFmpeg | 本地化处理 |
| **部署** | Web 部署 | 桌面应用 | 跨平台支持 |

## 🚀 快速开始

### 当前 Web 版本运行
```bash
pnpm install
pnpm dev
```

### 未来桌面版本运行
```bash
# 安装依赖
pnpm install
cargo install tauri-cli

# 开发模式
pnpm tauri dev

# 构建应用
pnpm tauri build
```

## 📊 预期收益

- **性能提升**: ASR 识别速度 5-25 倍提升，视频导出 20-40 倍提升
- **用户体验**: 离线使用、大文件支持、原生系统集成
- **开发体验**: 现有代码 100% 保留，零重构风险

## 🛣️ 迁移路线图

1. **Phase 1**: 基础桌面化 (2-3周)
2. **Phase 2**: AI 本地化 (1-2周)
3. **Phase 3**: 视频处理本地化 (1-2周)
4. **Phase 4**: 功能增强 (1-2周)

详细信息请参考 [本地化迁移指南](./migration-guide.md)。
