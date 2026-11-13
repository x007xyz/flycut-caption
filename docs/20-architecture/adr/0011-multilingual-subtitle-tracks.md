---
id: ADR-0011
status: accepted     # proposed → accepted → superseded / deprecated
date: 2026-11-12
deciders: zhangxiang.chen
feature: F-0030
superseded_by:
---

# ADR-0011 多语言字幕轨道与项目格式 4

## 背景

F-0030 要把每视频唯一的 `secondText` 扩展成可命名的多语言轨道，同时继续读取旧项目、保留旧字段、共享原文时间轴和 EDL，并沿用 Host 保存及视频修订冲突检测。轨道是后续 F-0031 翻译和 F-0033 多语导出的共同数据契约。

## 决策

在每视频 `edits.json` 增加 `languageTracks` 和 `activeLanguageTrackId`，每条译文以字幕 chunk id 为键并保存写入时的 `sourceText` 快照；项目格式升到 4，旧 `secondText` 读取时迁移为语言未知的 legacy 轨，`secondText` 继续作为活动轨的兼容投影。

语言轨结构：

```ts
interface LanguageTrackEntry {
  text: string;
  sourceText: string;
  updatedAt: string;
}

interface LanguageTrack {
  id: string;
  name: string;
  languageCode: string | null;
  origin: 'manual' | 'legacy-second-text';
  entries: Record<string, LanguageTrackEntry>;
}
```

- 时间不写入轨道。字幕、播放、剪辑和导出继续以原文 chunk 的 timestamp 与统一 EDL 为准。
- `sourceText` 是译文对应的原文版本。当前 chunk 文本不同即为过期；保留旧译文时把快照推进到当前原文。
- 旧格式 3 edits 没有上述字段时，Host 在内存中生成一条 `legacy-second-text` 轨。其 `languageCode` 为 `null`，不能推断为英语；没有非空 `secondText` 时不生成轨道。读取不写文件。
- `secondText` 不删除，并投影活动轨，保证旧双语显示、现有双语导出和旧项目兼容读取。
- 复用 `projects.saveVideoEdits` 和视频 `baseRevision`。轨道与原文、删除、EDL 在同一保存单元内，不增加轨道专用 RPC 或第二套冲突检测。
- `project.json` 的 3→4 迁移保留未知字段。第一次写入按 ADR-0001 保留 `project.v3.json`；旧客户端读取格式 4 时按现有规则拒绝。

## 备选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| 轨道放在每视频 edits，按 chunk id 关联（选定） | 与原文/EDL 同一修订和保存队列；不需要重复时间 | edits 文件变大，保存整份小文件 |
| 每条 chunk 内嵌 translations map | 修改集中 | 字词级数据也复制轨道，文件膨胀，时间与轨道耦合 |
| 独立语言轨文件 + RPC | 单轨文件更小 | 需要第二套修订号、事务和回收站清理，难以与原文原子保存 |
| 只保存原文 hash | 文件较小 | 无法显示或审计旧原文；legacy 迁移没有可靠基准 |

## 后果

- F-0031 可以按轨道写入译文并复用 `sourceText` 过期比较；F-0033 可以按轨道读取任意语言，同时继续读取 `secondText` 的旧导出路径。
- 旧项目第一次打开会多出对象，但磁盘文件不变；第一次保存后格式为 4，旧格式原文保留在备份中。
- 大项目会额外保存每个译文的原文副本，但仍小于原始字词转写。若实测产生不可接受的写盘量，后续格式应另行讨论增量存储。
- 所有写入仍经过 Host `ProjectStore`，恢复副本需包含轨道并继续使用 ADR-0004 的修订冲突。
- 验证必须覆盖旧 `secondText` 读取、未知语言、格式 4 备份、保存/重开、双客户端冲突、原文过期以及 EDL 后共用时间。
