---
id: F-0010
stage: 02-research
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-09
---

# F-0010 剪映草稿格式与兼容性调研：调研报告

> 调研日期：2026-11-09。范围仅限 F-0010。只做只读检查：没有启动剪映 GUI，没有导入草稿，没有修改任何现有草稿，没有尝试破解 macOS 新格式的加密，也没有复制第三方代码。真实导入状态：**Not run**。

## 摘要

本机安装的是 `/Applications/VideoFusion-macOS.app`，bundle id `com.lemon.lvpro`，`CFBundleShortVersionString` 与 `CFBundleVersion` 都是 **11.7.0**。本机草稿目录中能完整读取的明文样本是 **Windows 5.9.0** 写出的 `AI包装口播_v3`：36.125 秒、30fps、1080x1490，20 条轨道、118 个片段、36 个文本素材、9 个视频素材、9 个音频素材。

结论分两层。格式层面，Windows 5.9.0 的明文 JSON 足够完整：视频切点、字幕文本、时间、样式和媒体引用都能从文件恢复，具备生成最小草稿的结构条件。产品层面，**没有任何版本经过真实剪映打开验证**，所以现在不能把任何组合标成“支持”。macOS 11.7.0 走的是另一套格式：原生草稿没有 `draft_content.json`，`draft_info.json` 和 `draft_meta_info.json` 是 base64 包裹的高熵二进制，`Timelines/<id>/draft_info.json` 也不是明文。当前研究无法生成这套格式。

因此，F-0011 的首发矩阵只能把 **Windows 5.9.0 明文格式**列为候选，并在验收前补真实导入；macOS 11.7.0 必须标为不支持或待验证，除非维护者接受先做一轮真实导入实验。

## 调研边界

- 只读：使用 `cat`、`ls`、`file`、`find`、`sips`、`ffprobe` 和 Python 的 `json` 解析读取文件，没有写入草稿目录。
- 不启动 `VideoFusion-macOS.app`，不点击剪映界面，不导入任何草稿。
- 不修改 `AI包装口播_v3`、`AI包装口播_v2`、`AI包装口播_desk_full` 或 `7月17日` 中的任何文件。
- 不尝试解密 macOS 新格式，不绕过授权或加密限制；只记录“不可读”这一事实。
- 不复制第三方项目代码；许可证部分只做公开仓库信息核对，格式结论来自本机草稿的实际 JSON。
- 大型草稿文件没有复制进仓库；只放了小型合成片段和字段速记在 `experiments/f-0010-jianying-draft/`。

## 要回答的问题

1. Windows 5.9.0 与 macOS 11.7.0 的草稿目录、文件和版本字段分别是什么？
2. 时间单位、fps、duration、canvas 如何表示？
3. 视频和文本轨道的 segment、material 引用、媒体路径、clip 范围、speed、transform 如何组织？
4. 字幕/文本如何表示，样式字段有哪些，主/副/双语和多保留区间能否表达？
5. 从 Windows 5.9.0 迁移到 macOS 11.7.0 有哪些版本和兼容风险？
6. F-0011 可以生成的最小草稿是什么，需要哪些字段和媒体策略？
7. 兼容矩阵、许可证和维护成本是什么？

## 评估标准

- **可读性**：能否从文件直接恢复轨道、切点、字幕、样式和媒体关系。
- **可生成性**：能否在不破解加密、不复制专有代码的前提下写出新草稿。
- **可编辑性**：打开后视频切点、字幕文本/时间/样式是否仍可修改。
- **可搬迁性**：移动草稿目录或源媒体后是否仍能打开。
- **证据强度**：真实导入 > 真实草稿结构 > 合成样例；未做的一律写 Not run。
- **许可与维护**：许可证明确、维护活跃、版本可锁定；没有许可证的代码不作为依赖。

## 调研对象

| 样本 | 来源/平台 | 可读内容 | 关键尺寸 | 用途 |
|---|---|---|---|---|
| `AI包装口播_v3` | Windows 5.9.0 明文 | `draft_content.json`、`draft_info.json`、`draft_meta_info.json` 全部明文 | 404,687 B；20 轨；118 段；36 文本；9 视频；9 音频；36.125s；30fps；1080x1490 | 主分析样本 |
| `AI包装口播_v2` | Windows 5.9.0 明文，后来在 macOS 保存过 | `draft_content.json` 明文 282,169 B；`draft_info.json` 209,816 B 已变为 base64 二进制；`draft_meta_info.json` 6,516 B 同上 | 14 轨；36.125s；30fps；1080x1490 | 迁移/混合状态证据 |
| `7月17日` | macOS 11.7.0 原生新格式 | `Timelines/project.json` 明文；`draft_info.json` 3,748 B、`draft_meta_info.json` 3,324 B 为 base64 高熵二进制；无 `draft_content.json` | root index 时长 65.700s；封面 720x960（3:4） | macOS 新格式证据 |
| `AI包装口播_desk_full` | Windows 5.9.0 明文 | 仅用于交叉核对 | 282,267 B；14 轨；36.125s；1080x1490 | 版本/轨道数对照 |

## 实际版本与环境

| 项目 | 值 | 来源 |
|---|---|---|
| 安装应用 | `/Applications/VideoFusion-macOS.app` | 文件系统 |
| bundle id | `com.lemon.lvpro` | `Info.plist` |
| `CFBundleShortVersionString` | `11.7.0` | `Info.plist` |
| `CFBundleVersion` | `11.7.0` | `Info.plist` |
| Windows 草稿平台字段 | `app_version: "5.9.0", os: "windows", app_id: 3704` | `draft_content.platform` |
| Windows 草稿格式版本 | `version: 360000, new_version: "110.0.0"` | `draft_content` |
| macOS 新格式 | 无 `draft_content.json`；`Timelines` + 加密的 `draft_info.json` | `7月17日` |

“实际版本”要分开写：本机安装的是 macOS **11.7.0**；Windows **5.9.0** 是草稿元数据里的版本，不是本机运行的版本。Windows 应用本身没有在本机运行。

用 `ffprobe` 核对 `AI包装口播_v3/materials`：

| 媒体 | 尺寸/声道 | 帧率/采样率 | 时长 |
|---|---|---|---|
| `desk_full.mp4` | 464x640，视频+音频 | 24fps | 36.125s |
| `b1.mp4` | 1080x1490，仅视频 | 30fps | 3.300s |
| `bgm.wav` | 48kHz，双声道 | 音频 | 36.125s |

两个关键事实：草稿工程是 30fps，但主口播源是 24fps；画布 1080x1490 是把 464x640 按比例放大后的尺寸，不是标准 1080x1440。也就是说，草稿的 `fps` 是工程帧率，不是源视频帧率；切点用微秒表达，不保证落在工程帧边界上。

## 草稿目录与文件布局

### Windows 5.9.0 的最小可读布局

`AI包装口播_v3` 只有 5 类文件：

```
AI包装口播_v3/
  draft_content.json      404,687 B
  draft_info.json         404,687 B，与 draft_content.json 字节相同
  draft_meta_info.json    2,020 B
  draft_cover.jpg         26,287 B，360x496
  materials/              19 个文件，约 19.37 MB
```

样本里没有 `.backup/`、`draft_settings`、`Timelines/`、`Resources/`、`draft_virtual_store.json`，也没有各类 `attachment_*.json`。这说明 Windows 5.9.0 的便携草稿可以只靠 4 个 JSON/JPG 加媒体目录存在；但这只是“样本存在”，不是“应用只要求这些文件”的证明。

父目录的 `root_meta_info.json` 是草稿库索引，`all_draft_store` 里每条记录包含 `draft_id`、`draft_name`、`draft_fold_path`、`draft_json_file`、`draft_new_version`、`tm_duration` 等字段。对 `AI包装口播_v3`，`draft_json_file` 指向 `draft_info.json`，不是 `draft_content.json`。这解释了为什么 Windows 样本要维护两份字节相同的文件。

### macOS 11.7.0 的新布局

`7月17日` 的结构完全不同：

```
7月17日/
  draft_info.json          3,748 B，base64 包裹的高熵二进制
  draft_meta_info.json     3,324 B，同上
  draft_cover.jpg          87,717 B，720x960
  draft_settings
  key_value.json
  timeline_layout.json
  draft_virtual_store.json
  attachment_pc_common.json
  draft_agency_config.json
  draft_biz_config.json
  performance_opt_info.json
  Timelines/
    project.json           明文
    E4660189-0E5C-4AFD-BF00-6F14BC62BC0A/
      draft_info.json      3,748 B，与顶层 draft_info.json 相同
      draft.extra          26 B 二进制
      attachment_editing.json
      attachment_pc_common.json
      draft_cover.jpg
      template.tmp
      template-2.tmp
      draft_info.json.bak
  Resources/cover/AA96E273-....jpg
  common_attachment/
  .backup/
```

`Timelines/project.json` 是明文，结构如下（省略部分值）：

```json
{
  "config": {
    "color_space": -1,
    "mixed_track_mode_on": false,
    "render_index_track_mode_on": false,
    "use_float_render": false
  },
  "create_time": 1784263361586124,
  "id": "DD6D65F6-61CD-4036-90CA-BDF612DEA9DC",
  "main_timeline_id": "E4660189-0E5C-4AFD-BF00-6F14BC62BC0A",
  "timelines": [{
    "create_time": 1784263361586124,
    "id": "E4660189-0E5C-4AFD-BF00-6F14BC62BC0A",
    "is_marked_delete": false,
    "name": "时间线01",
    "update_time": 1784263361586124
  }],
  "update_time": 1784263361586124,
  "version": 0
}
```

这说明 macOS 11.7.0 的草稿可以包含多条时间线，`project.json` 只描述时间线列表；真正的轨道内容在 `Timelines/<id>/draft_info.json` 里，而该文件不是明文。当前研究没有尝试解密，也无法从它恢复轨道、字幕或画布。

### 混合状态：v2 被 macOS 保存过

`AI包装口播_v2` 是迁移风险最直接的证据：

| 文件 | 大小 | 状态 |
|---|---|---|
| `draft_content.json` | 282,169 B | 仍是 Windows 5.9.0 明文 JSON |
| `draft_info.json` | 209,816 B | base64 包裹的高熵二进制，不再是 content 的副本 |
| `draft_meta_info.json` | 6,516 B | 同上 |
| `template-2.tmp` | 209,816 B | 与 draft_info.json 相同大小 |
| `draft_settings` | 143 B | 含 `cloud_last_modify_platform=mac` |

从文件状态看，macOS 11.7.0 保存过这个草稿后，`draft_info.json` 和 `draft_meta_info.json` 变成了新封装，但旧的 `draft_content.json` 还留在目录里。应用实际读哪一份、是否会在下次保存时删除旧文件，本研究没有验证。生成器不能假设“有 draft_content.json 就一定能被 macOS 打开”。

## 版本字段与时间单位

### 版本字段

| 位置 | 字段 | `AI包装口播_v3` | `AI包装口播_v2`（Mac 保存后） | `7月17日` |
|---|---|---|---|---|
| `draft_content` | `version` | `360000` | `360000` | 文件不存在 |
| `draft_content` | `new_version` | `110.0.0` | `110.0.0` | 文件不存在 |
| `draft_content.platform` | `os` | `windows` | `windows` | 文件不存在 |
| `draft_content.platform` | `app_version` | `5.9.0` | `5.9.0` | 文件不存在 |
| `draft_meta_info` | `draft_new_version` | `""` | 加密，不可读 | 加密，不可读 |
| `root_meta_info` | `draft_new_version` | `""` | `164.0.0` | `""` |
| `root_meta_info` | `tm_duration` | `36125000` | `36133333` | `65700000` |

三个版本号同时存在，而且不一致：内容文件的 `new_version` 是 `110.0.0`，Mac 保存后根索引变成 `164.0.0`，`draft_meta_info.draft_new_version` 又是空。F-0011 不能只读一个字段做版本门禁；必须同时检查文件布局、`platform`、`version`、`new_version` 和根索引。

### 时间单位

样本中的时间字段全部是**整数微秒**：

- `duration: 36125000` = 36.125 秒。
- `target_timerange: {start, duration}` 是输出时间线；`source_timerange: {start, duration}` 是原媒体时间线。
- `draft_meta_info.tm_duration` 也是微秒。
- `draft_meta_info.tm_draft_create` / `tm_draft_modified` 是微秒级 Unix 时间；`draft_settings.draft_create_time` 是秒。
- 视频片段示例：`target 0..2,220,000`，`source 0..2,220,000`，`speed 1.0`。
- 文本片段示例：`target 0..660,000`，`source_timerange: null`。

30fps 下一帧是 33,333.33 微秒。36.125 秒 = 1083.75 帧，不是整数帧。`AI包装口播_v2` 在 macOS 保存后，根索引的 `tm_duration` 变成 36.133333 秒，正好是 1084 帧；内容文件仍是 36.125 秒。这个差异表现为 macOS 把根索引时长按工程帧向上取整，而 Windows 内容文件允许非整帧时长。F-0011 如果直接写任意微秒切点，必须预料到目标应用可能量化。

### 画布

`AI包装口播_v3` 的 `canvas_config` 是：

```json
{ "width": 1080, "height": 1490, "ratio": "original" }
```

1080x1490 的宽高比是 0.7248，和主口播 464x640 的 0.725 一致；它不是标准 3:4（1080x1440）。B-roll `b1.mp4` 本身就是 1080x1490。macOS `7月17日` 的封面是 720x960（3:4），但画布在加密时间线里，当前不可读，不能据此断言它的 `canvas_config`。

## 轨道与片段结构

### 轨道总览

`AI包装口播_v3` 的 20 条轨道按顺序如下：

| # | type | name | segments |
|---|---|---|---|
| 0 | video | 口播主轨 | 18 |
| 1 | video | B-roll | 4 |
| 2 | video | 预览窗人物 | 1 |
| 3 | video | 小窗描边 | 4 |
| 4 | video | 人物小窗 | 4 |
| 5 | video | CTA卡片 | 1 |
| 6 | video | 状态条 | 2 |
| 7 | text | 字幕 | 30 |
| 8 | text | 花字关键词 | 4 |
| 9 | text | 开场标题 | 1 |
| 10 | text | 开场副标题 | 1 |
| 11 | audio | 背景音乐 | 1 |
| 12 | audio | 音效-click | 2 |
| 13 | audio | 音效-ding | 1 |
| 14 | audio | 音效-hit | 2 |
| 15 | audio | 音效-pop | 13 |
| 16 | audio | 音效-swipe | 3 |
| 17 | audio | 音效-tick | 6 |
| 18 | audio | 音效-type | 12 |
| 19 | audio | 音效-whoosh | 8 |

轨道对象的键是 `attribute`、`flag`、`id`、`is_default_name`、`name`、`segments`、`type`。样本中 `attribute=0`、`flag=0`、`is_default_name=false`。`render_index` 在片段上等于轨道下标；`track_render_index` 在所有片段中都是 0，不能把它当轨道下标。

### 视频片段

主轨第一个片段（截断）：

```json
{
  "id": "9e70200193ed47dda20c8717ef35eaea",
  "material_id": "2f6e61e802b04d33abc4479fe08ecc0e",
  "target_timerange": { "start": 0, "duration": 2220000 },
  "source_timerange": { "start": 0, "duration": 2220000 },
  "speed": 1.0,
  "volume": 1.0,
  "visible": true,
  "render_index": 0,
  "clip": {
    "alpha": 1.0,
    "flip": { "horizontal": false, "vertical": false },
    "rotation": 0.0,
    "scale": { "x": 1.0, "y": 1.0 },
    "transform": { "x": 0.0, "y": -0.0 }
  },
  "uniform_scale": { "on": true, "value": 1.0 },
  "hdr_settings": { "intensity": 1.0, "mode": 1, "nits": 1000 },
  "extra_material_refs": ["da92562f4fc84f238bfd25f411e50c32"],
  "common_keyframes": [],
  "keyframe_refs": [],
  "is_tone_modify": false,
  "last_nonzero_volume": 1.0,
  "reverse": false,
  "track_attribute": 0,
  "track_render_index": 0,
  "enable_adjust": true,
  "enable_color_correct_adjust": false,
  "enable_color_curves": true,
  "enable_color_match_adjust": false,
  "enable_color_wheels": true,
  "enable_lut": true,
  "enable_smart_color_adjust": false
}
```

主轨 18 个片段的 `target_timerange` 从 0 连续到 36.125 秒，`source_timerange` 也连续覆盖 0..36.125 秒；样本没有真正的中段删除。片段的 `clip.scale` 在 1.0 到 1.34 之间变化，`clip.transform.y` 在 0 到 -0.14 之间，说明这些片段主要是在做推拉/构图，不是切点。`common_keyframes` 里有缩放和位置关键帧；顶层 `keyframes` 是空的，所以关键帧要看片段内的 `common_keyframes`。

B-roll、人物小窗、CTA、状态条等轨道用不同的 `material_id` 指向不同视频/图片素材；有些片段的 `volume=0`，用来静音底层素材。`extra_material_refs` 可以同时指向 `speeds`、`material_animations`、`masks`、`common_mask`。

### 文本片段

字幕轨第 1 个片段（截断）：

```json
{
  "id": "cb1e9a4bfbd84431b8eadedd496bf0e0",
  "material_id": "4a57e8bdbdf749c785d1aa7bc4b9aed5",
  "target_timerange": { "start": 0, "duration": 660000 },
  "source_timerange": null,
  "speed": 1.0,
  "volume": 1.0,
  "visible": true,
  "render_index": 7,
  "clip": {
    "alpha": 1.0,
    "flip": { "horizontal": false, "vertical": false },
    "rotation": 0.0,
    "scale": { "x": 1.0, "y": 1.0 },
    "transform": { "x": 0.0, "y": -0.47651006711409394 }
  },
  "uniform_scale": { "on": true, "value": 1.0 },
  "extra_material_refs": ["1bbed9a3a1df427ebc09728e0cbdd8cd"],
  "common_keyframes": [],
  "keyframe_refs": [],
  "is_tone_modify": false,
  "last_nonzero_volume": 1.0,
  "reverse": false,
  "track_attribute": 0,
  "track_render_index": 0,
  "enable_adjust": true,
  "enable_color_correct_adjust": false,
  "enable_color_curves": true,
  "enable_color_match_adjust": false,
  "enable_color_wheels": true,
  "enable_lut": true,
  "enable_smart_color_adjust": false
}
```

字幕轨 30 个片段的 `target_timerange` 总和正好是 36,125,000 微秒，首段从 0 开始，末段到 36.125 秒结束，中间没有空隙。每个片段的 `source_timerange` 都是 `null`。文本位置由 `clip.transform` 控制；样本字幕的 `transform.y` 是 -0.4765，花字/标题轨道的 `clip.rotation` 有 -4、-3、3 度的样本。transform 的确切像素映射没有验证，F-0011 只能先复用样本值并在真实导入时校准。

### 音频片段

音频轨道的片段也用 `target_timerange` 和 `source_timerange`，但 `clip` 是 `null`，没有 `uniform_scale`，`hdr_settings` 是 `null`。样本音量在 0.125 到 1.0 之间；`extra_material_refs` 指向 `speeds`。背景音乐轨从 0 到 36.125 秒，音效轨是短片段。

### 素材引用

- 片段的 `material_id` 指向 `materials.videos`、`materials.audios` 或 `materials.texts` 中的 `id`。样本里所有 `material_id` 都能解析。
- `extra_material_refs` 指向辅助素材。视频/音频样本主要指向 `speeds`；部分视频还指向 `material_animations`、`masks`、`common_mask`。
- 文本片段的 `extra_material_refs` 在本样本中是**悬空引用**：36 个文本片段各有一个 ID，在 `materials` 所有数组中都不存在。应用仍能保存和显示这些草稿，说明悬空引用可以被容忍；生成器不应复制这些 ID。
- `materials.common_mask` 和 `materials.masks` 里存在相同的 ID（5 对），说明同一遮罩会在两个数组中各存一份；解析时要允许重复 ID，不能简单用“ID 全局唯一”做校验。

### 媒体路径

视频和音频素材的 `path` 都是绝对路径，`media_path` 为空：

```json
{
  "material_name": "desk_full.mp4",
  "path": "/Users/zhangxiangchen/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/AI包装口播_v3/materials/desk_full.mp4",
  "media_path": "",
  "local_material_id": "",
  "duration": 36125000,
  "width": 464,
  "height": 640,
  "type": "video"
}
```

这意味着“把媒体复制到 `materials/`”并不自动等于“草稿可搬迁”：JSON 里仍然是绝对路径。如果把整个草稿目录移到新位置，旧路径就会失效；应用是否会按 `materials/` 里的文件名自动重连，本研究没有验证。macOS `7月17日` 的 `key_value.json` 记录了 `story_with_audio.mp4` 这个素材名，但加密时间线里没有可读路径，无法确认它引用的是草稿内副本还是外部原文件。

F-0011 的媒体策略必须明确二选一：

1. **复制到草稿目录**：把源媒体复制进 `<draft>/materials/`，JSON 写最终绝对路径。优点是源文件移动后草稿仍有自己的副本；缺点是占空间，而且移动草稿目录本身仍可能让绝对路径失效。只有在最终输出目录确定后再写路径，才能避免“先写临时目录再搬”造成的路径错误。
2. **引用原媒体**：JSON 写源文件绝对路径，不复制。优点是省空间；缺点是源文件移动/删除后草稿失联。

两种策略都要在导出前告知用户；AC-9 的搬迁验证必须真实执行，不能用“文件存在”代替。

## 字幕与文本表示

### 没有独立的 subtitle 素材

样本中不存在 `materials.subtitles` 数组。字幕就是普通的 `materials.texts` + `type: "text"` 轨道。字幕轨的 30 个片段与 30 个文本素材一一对应；每个片段只负责时间，文本素材负责内容。这个结构对 F-0011 很关键：生成字幕不需要特殊的“字幕格式”，按普通文本素材写即可。

### 文本素材的 content 是嵌套 JSON 字符串

`materials.texts[].content` 不是对象，而是**字符串**，里面再放一个 JSON。样本第一段：

```json
{
  "styles": [{
    "fill": {
      "alpha": 1.0,
      "content": {
        "render_type": "solid",
        "solid": { "alpha": 1.0, "color": [1.0, 1.0, 1.0] }
      }
    },
    "range": [0, 5],
    "size": 10.0,
    "bold": true,
    "italic": false,
    "underline": false,
    "strokes": [{
      "content": { "solid": { "alpha": 1.0, "color": [0.1686, 0.1412, 0.1255] } },
      "width": 0.09
    }]
  }],
  "text": "这是我做过"
}
```

`styles[].range` 是字符区间；样本单段文本的 range 覆盖全部字符（例如 5 个字就是 `[0,5]`）。多段样式在 schema 上可行，但样本里没有多 range 的真实字幕，不能据此宣布双语/多色样式已验证。

### 文本素材外层字段

| 字段 | 样本值 | 说明 |
|---|---|---|
| `type` | `"text"` | |
| `alignment` | `1` | 样本全部为 1；左/右/两端对齐未验证 |
| `typesetting` | `0` | 横排 |
| `letter_spacing` | `0.0` | |
| `line_spacing` | `0.02` | |
| `line_feed` | `1` | |
| `line_max_width` | `0.82` | 归一化 |
| `force_apply_line_max_width` | `false` | |
| `check_flag` | `15` 或 `23` | 有背景时为 23 |
| `global_alpha` | `1.0` | |

带背景的文本还包含 `background_style`、`background_color`（如 `"#FF6A1A"`）、`background_alpha`、`background_round_radius`、`background_height`、`background_width`、`background_horizontal_offset`、`background_vertical_offset`。

样本里没有字体 family/path 字段；36 个文本素材都没有。字体看起来由应用默认值决定。F-0011 如果要把 FlyCut 的字体映射过去，需要额外的真实导入实验；当前不能承诺字体一致。

### FlyCut 样式到草稿字段的候选映射

| FlyCut `SubtitleStyle` | 草稿字段 | 置信度 |
|---|---|---|
| `color` / `colorOpacity` | `content.styles[].fill.content.solid.color` / `alpha` | JSON 结构明确；颜色空间按 0..1 RGB 处理 |
| `borderColor` / `borderOpacity` / `borderWidth` | `content.styles[].strokes[].content.solid.color` / `alpha` / `width` | 结构明确；宽度换算未校准 |
| `fontWeight` / `fontStyle` / `textDecoration` | `bold` / `italic` / `underline` | 直接对应 |
| `fontSizeRatio` | `content.styles[].size` | 样本 10.0 对应 1080x1490 字幕；换算公式未验证 |
| `textAlign` | `alignment` | 只见到 1；左/右未验证 |
| `letterSpacing` | `letter_spacing` | 直接对应 |
| `lineHeight` | `line_spacing` | 样本 0.02；与 1.2 的换算未验证 |
| `backgroundColor` / `backgroundOpacity` / `backgroundRadius` / `backgroundPadding` | `background_color` / `background_alpha` / `background_round_radius` / `background_width/height` | 字段存在；padding 映射未验证 |
| `bottomOffsetRatio` | 片段 `clip.transform.y` | 样本字幕 -0.4765；归一化语义未验证 |

### 主字幕、副字幕和双语

样本没有副字幕，也没有双语文本。可选方案有两个：

1. **一个文本框两行**：`text` 写成 `主字幕 + "\n" + 副字幕`，用两个 `styles[]` range 给第二行更小字号/不同颜色。这样只占一个文本素材，编辑时两行在同一个文本框里。风险是 `styles[].range` 跨行、换行符和字号差异没有真实样本。
2. **两条文本轨**：主字幕一条轨，副字幕另一条轨，同一个 `target_timerange`，用不同的 `clip.transform.y` 错开。这样两条字幕可以独立编辑；风险是轨道层级、位置和行距需要真实导入校准。

F-0011 的 PRD 要求主/副/双语可编辑。当前证据只能证明“多条文本轨”存在（样本有 4 条文本轨），不能证明“同一条文本素材的多 range 双语”可用。建议首发先做单语主字幕；副字幕/双语要么单独开实验，要么在支持矩阵里明确降级。

### 多保留区间

结构上，多个保留区间是**可以表达**的：一条视频轨可以放多个 segment，每个 segment 有自己的 `source_timerange`。一个 segment 的 `target_timerange.duration` 等于 `source_timerange.duration`（speed=1 时），下一个 segment 可以把 `source_timerange.start` 跳到后面，从而跳过中间删除的内容。字幕则按 F-0005 的 `projectCues` 拆成多个 cue，每个 cue 生成一个文本片段；跨切点的字幕会变成多条文本片段，文本相同、目标时间不同。

但样本没有真实的“中段删除”草稿：`AI包装口播_v3` 主轨 18 段虽然多，source 仍然连续覆盖 0..36.125 秒。所以“多保留区间在真实剪映中能打开、能播放、能继续编辑”仍然是 **Not run**。`experiments/f-0010-jianying-draft/sample-segments.json` 只给出合成结构：第一段 target 0..2s / source 0..2s，第二段 target 2..8s / source 4..10s，故意跳过 source 2..4s。它不是完整草稿，也没有导入。

一个必须注意的点：文本片段的 `source_timerange` 是 `null`，所以字幕不能用“source 跳转”表达删除；只能按输出时间重新铺。F-0005 已经提供 `projectCues`，生成器应直接消费它的输出，不要自己再算一套时间。

## macOS 11.7.0 的格式变化

macOS 11.7.0 的原生草稿和 Windows 5.9.0 不是同一种文件格式：

- Windows：`draft_content.json` + 字节相同的 `draft_info.json` + 明文 `draft_meta_info.json`。
- macOS 11.7.0：没有 `draft_content.json`；`draft_info.json` 和 `draft_meta_info.json` 是 base64 包裹的高熵二进制；时间线在 `Timelines/<id>/draft_info.json`，同样不是明文；`Timelines/project.json` 是明文的多时间线描述。

`7月17日` 的 `draft_info.json` 解码后前 32 字节是 `7378b9ad283a020d69928ef0045bef160f4653c169935e0a462e87f114abef67`，没有 gzip、zstd、lz4 等常见压缩头，也不是 JSON 的 `{`。`draft_meta_info.json` 解码后同样是高熵二进制。可以把它描述为“私有封装/疑似加密”，但不能在没有证据时断言具体算法。本研究没有解密。

`AI包装口播_v2` 展示了迁移的中间态：旧的 `draft_content.json` 还在，但 `draft_info.json` 和 `draft_meta_info.json` 已经被 macOS 改写；`draft_settings` 记录 `cloud_last_modify_platform=mac`。根索引的 `draft_new_version` 变成 `164.0.0`，而 `draft_content.new_version` 仍是 `110.0.0`。这说明 macOS 打开旧草稿时可能做了一次格式迁移，而且迁移后的版本字段和旧内容字段不一致。

## 迁移与版本风险

1. **macOS 11.7.0 不能按明文 JSON 生成。** 原生草稿没有 `draft_content.json`，核心时间线是私有封装。F-0011 如果只写 Windows 格式，不能宣称 macOS 11.7.0 可用。
2. **macOS 可能迁移旧草稿。** v2 的 `draft_info.json` 已被改写，但 `draft_content.json` 还在；应用实际读哪份、何时删除旧文件未知。生成器不能依赖“旧文件还在”判断兼容。
3. **版本字段互相矛盾。** `draft_content.new_version=110.0.0`、根索引 `draft_new_version=164.0.0`、`draft_meta_info.draft_new_version=""`。单一字段不能作为版本门禁。
4. **platform 是粘性的。** v2 在 Mac 保存后，`draft_content.platform.os` 仍是 `windows`，`app_version` 仍是 `5.9.0`。不能靠它判断当前主机或实际打开版本。
5. **Mac 会把时长对齐到帧。** 36.125 秒在根索引变成 36.133333 秒（1084 帧）；内容文件仍是 36.125 秒。F-0011 的切点/字幕时间如果不在帧边界，目标应用可能量化。
6. **源视频帧率和工程帧率可以不同。** 主口播是 24fps，工程是 30fps。切点用微秒表达；F-0005 的帧级容差需要在“目标工程帧率”下定义，不能直接拿源视频帧率算。
7. **绝对路径不可搬迁。** 素材 `path`、`draft_fold_path`、`draft_root_path` 都是绝对路径。复制媒体到 `materials/` 后，移动草稿目录仍可能失联；AC-9 必须真实测。
8. **根索引更新策略未知。** `root_meta_info.json` 是库索引；新草稿是否会被应用自动扫描发现，还是必须写索引，没有验证。写索引又会改用户现有文件，和“不覆盖用户草稿”的边界冲突。
9. **draft_content.id 被复用。** v2/v3/desk_full 的 `draft_content.id` 都是 `91E08AC5-...`（看起来是模板时间线 ID），但 `draft_meta_info.draft_id` 各自不同。F-0011 应生成唯一 `draft_id`，并确认 `draft_content.id` 是否也需要唯一。
10. **字体和样式不能完全复刻。** 文本素材没有字体 family/path；样本只覆盖一种字体、一种 alignment、单 range 样式。字体、左/右对齐、多 range 双语都需要真实导入实验。
11. **文本悬空引用。** 36 个文本片段都有不存在的 `extra_material_refs`，应用仍能保存。生成器应写空数组或省略，不要复制悬空 ID。
12. **专有格式会随应用更新变化。** 没有公开规范；11.7.0 已经换了封装。任何生成器都需要版本探测、失败关闭和回归样本。

## F-0011 最小草稿计划

### 范围

只针对 **Windows 5.9.0 明文格式**做一个候选生成器；单时间线、单视频轨、单文本轨、可选一条 BGM 音频轨。macOS 11.7.0 不在首发生成范围，除非另开实验证明旧格式可被它导入或迁移。

### 输出布局

```
<输出目录>/<草稿名>/
  draft_content.json
  draft_info.json          # 与 draft_content.json 字节相同
  draft_meta_info.json
  draft_cover.jpg          # 从首帧生成或复制占位图
  materials/               # 复制策略时存在
    <source-media>
```

### 生成算法

1. 从 F-0005 取已确认的 `Edl`，校验 `version=1`、`sourceDurationUs>0`、删除区间合法、保留区间非空。
2. `deriveKept(edl)` 得到保留区间。每个区间生成一个视频片段：
   - `target_timerange.start` = `outputStartUs`
   - `target_timerange.duration` = `endUs - startUs`
   - `source_timerange.start` = `startUs`
   - `source_timerange.duration` = 同上
   - `speed=1.0`、`volume=1.0`、`visible=true`、`render_index=0`
   - `clip` 用 identity（scale 1, transform 0, rotation 0），除非 F-0011 明确要保留构图
3. `projectCues(edl, chunks)` 得到投影后的字幕。每个 cue 生成一个文本素材 + 一个文本片段：
   - 文本片段的 `target_timerange` 用 cue 的输出时间
   - `source_timerange=null`
   - `render_index` = 文本轨下标
   - `clip.transform.y` 先用样本字幕值 `-0.47651006711409394`；后续用真实导入校准
4. 为每个视频/音频片段生成一个 `materials.speeds` 记录：
   ```json
   { "id": "<32 hex>", "speed": 1.0, "mode": 0, "curve_speed": null, "type": "speed" }
   ```
   片段 `extra_material_refs` 引用对应 speed ID。
5. 写 `draft_content.json`；复制为 `draft_info.json`；写 `draft_meta_info.json`；生成 `draft_cover.jpg`。
6. 写临时目录，校验 JSON 可解析、所有 `material_id` 可解析、所有媒体文件存在、时长/画布一致，再原子重命名到最终目录。失败时清理临时目录，不留下半成品。

### 最小 draft_content 字段

以下字段在样本中存在；在真实导入证明可以省略之前，按“需要”处理：

| 字段 | 最小值/来源 |
|---|---|
| `version` | `360000` |
| `new_version` | `"110.0.0"` |
| `platform` | `{app_id:3704, app_source:"lv", app_version:"5.9.0", os:"windows"}` |
| `last_modified_platform` | 同 `platform` |
| `id` | 新 UUID；是否必须与根索引一致待验证 |
| `name` | @@BT@""`（显示名放 meta） |
| `duration` | 输出时长微秒 |
| `fps` | 工程帧率；建议先用源视频帧率或 30，需真实导入确认 |
| `canvas_config` | 源视频/项目画布，如 1080x1920 或 1080x1490 |
| `tracks` | 至少 1 条 video、1 条 text |
| `materials` | 至少 videos/texts/speeds；其余空数组可保留 |
| `config` | 复制样本默认值，特别是 `subtitle_sync`、`export_range` |
| `keyframes` | 8 个空数组 |
| `create_time` / `update_time` | 0 或当前微秒 |
| `source` | `"default"` |
| `color_space` | 0 |
| `free_render_index_mode_on` / `render_index_track_mode_on` | false |

### 最小 draft_meta_info 字段

样本有 52 个键。最小生成不应只写 5 个键；最稳妥是复制完整键集，改以下值：

| 字段 | 值 |
|---|---|
| `draft_id` | 新 UUID（与 `draft_content.id` 分开） |
| `draft_name` | 用户可见草稿名 |
| `draft_fold_path` | 最终草稿目录绝对路径 |
| `draft_root_path` | 父目录绝对路径 |
| `draft_cover` | `"draft_cover.jpg"` |
| `draft_new_version` | @@BT@""` 或目标版本，待真实导入确认 |
| `tm_duration` | 输出时长微秒 |
| `tm_draft_create` / `tm_draft_modified` | 当前微秒级 Unix 时间 |
| `draft_timeline_materials_size_` | 媒体总字节数 |
| `draft_materials` | 保留 7 个 type 的空数组 |
| 其余布尔/字符串 | 复制样本默认值 |

### 媒体策略

推荐首发用**复制到草稿目录**，但必须把“最终目录”先确定再写路径：先生成到临时目录会导致 `path` 指向临时位置。可选流程是：用户选最终父目录 → 在最终目录旁生成临时目录 → 写 JSON 时使用最终目录的绝对路径 → 原子重命名。若跨文件系统不能原子重命名，则退化为“写临时目录 → 复制到最终目录 → 校验 → 删除临时目录”，并明确失败清理。

复制策略的代价是磁盘空间；F-0011 AC-4 要显示预计空间。引用策略的代价是源文件移动/删除后失联；AC-4 要提示。不能把空文件当媒体，也不能在媒体缺失时生成“成功”草稿。

### 桌面与 Web 的保存边界

- 桌面端：Tauri 只做外壳。新增一个“选择输出父目录”的原生对话框是允许的；Host 负责生成草稿内容，Tauri 负责把 Host 产物复制到用户选定目录。RPC 不应接收任意 Host 本地路径。
- Web 端：Host 生成一个目录/压缩包资产，浏览器下载；下载后的目录结构和绝对路径需要重新处理，不能假设 Web 下载的 zip 解开后还能用原来的绝对路径。
- 不要复用 `save_host_asset` 的单文件语义来保存整个草稿目录；需要目录级保存/复制，或在 Tauri 侧新增受控的目录保存命令。

### 根索引

`root_meta_info.json` 是草稿库索引。F-0011 生成新草稿后有两种策略：

1. 只写新草稿目录，让应用启动时扫描发现；
2. 在应用关闭时原子更新 `root_meta_info.json`。

哪一种可行没有验证。直接改用户的 `root_meta_info.json` 有风险：可能覆盖其他草稿记录、路径不一致、应用正在运行。建议先做实验；在实验前不要把“更新索引”写成已实现。

## 兼容性矩阵

| 目标 | 读取 | 生成候选 | 字幕可编辑 | 媒体策略 | 结论 |
|---|---|---|---|---|---|
| Windows 5.9.0 明文 | 可完整读取 | 可生成（候选） | 文本轨候选，未导入 | 复制/引用均可候选 | 仅格式级；真实导入 Not run |
| Windows 5.9.0 其他 build | 未验证 | 否 | 否 | 否 | 不支持 |
| macOS 11.7.0 旧明文草稿 | v2 的 content 可读，info/meta 已加密 | 未验证 | 未验证 | 未验证 | 不支持/待验证 |
| macOS 11.7.0 新 Timelines 格式 | 核心时间线不可读 | 否 | 否 | 否 | 不支持 |
| CapCut | 未调研 | 否 | 否 | 否 | 不在范围 |
| Web 下载 | 可生成文件夹/zip | 未验证 | 未验证 | 需重新处理路径 | 仅传输，不代表剪映支持 |

首发建议：**只把 Windows 5.9.0 明文格式列为候选支持**，并在 F-0011 验收前完成一次真实剪映打开、播放、改字幕、保存、重开。macOS 11.7.0 在支持矩阵里写“不支持此草稿版本 / Unsupported draft version”，除非维护者明确要求先做 macOS 导入实验。

## 许可证与维护性

下表是 2026-11-09 的公开仓库信息，只用于评估“能否参考/依赖”，不是法律意见。实现前应重新核对仓库 LICENSE 和当前版本。

| 项目 | 许可证 | 维护状态 | 与本研究的关系 |
|---|---|---|---|
| [pyJianYingDraft](https://github.com/GuanYixuan/pyJianYingDraft) | Apache License 2.0 | 活跃；README 标注 API 在 v0.2.0 与 v0.3.0 间有不兼容变化，升级需适配 | 可作为格式参考；不要直接复制代码 |
| [aoguai/pyJianYingDraft](https://github.com/aoguai/pyJianYingDraft) | Apache License 2.0（fork） | 活跃 fork | 同上；注意与上游差异 |
| [JianYingDraft.PY](https://github.com/xiaoyifang/JianYingDraft.PY) | 仓库未检测到 LICENSE 文件，README 声明 MIT | 以 README 为准，需复核 | 只能参考思路，不能直接复制未确认许可的代码 |
| [JianYingProDraft](https://github.com/YILING0013/JianYingProDraft) | 未声明许可证；默认保留所有权利 | 活跃，逆向格式 | 不要复制代码；只可读文档/行为 |
| [capcut-cli](https://github.com/reacher-z/capcut-cli) | MIT License | 活跃，CLI 封装 | 可参考结构；本项目不引入 CLI 依赖 |
| [pyCapCut](https://github.com/GuanYixuan/pyCapCut) | 未声明许可证 | 已归档 | 不使用 |

维护性判断：

- 这些项目都依赖逆向格式，剪映更新会破坏兼容；不能把某个库的“支持版本”直接当成 11.7.0 或 5.9.0 的支持证明。
- 许可证明确的项目（Apache-2.0 / MIT）可以作为参考或依赖候选，但仍要锁定版本、保留 NOTICE/LICENSE，并隔离适配层。
- 没有许可证的项目（JianYingProDraft、pyCapCut）不要复制代码；只能把公开行为当作线索，再用本机草稿验证。
- 最稳妥的路线是 clean-room 生成器：只依据本机草稿的实际 JSON 和本报告字段，不复制第三方实现。是否需要法律审查由维护者决定，本报告不做法律结论。

## 实验记录

### Inspected

| 项目 | 方法 | 结果 |
|---|---|---|
| 安装版本 | `PlistBuddy` 读取 `Info.plist` | 11.7.0 / com.lemon.lvpro |
| v3 目录/文件 | `ls`、`file`、`sha256` | 4 个 JSON/JPG + materials；content 与 info 字节相同 |
| v3 结构 | Python `json` 解析 | 20 轨、118 段、36 文本、9 视频、9 音频 |
| v3 时间 | 解析 timerange/duration | 36,125,000 微秒；30fps；1083.75 帧 |
| v3 媒体 | `ffprobe` | desk_full 464x640/24fps/36.125s；b1 1080x1490/30fps/3.3s；bgm 48kHz/36.125s |
| v2 迁移 | 文件大小/头部/哈希 | content 明文；info/meta 变 base64 高熵；settings 记录 mac |
| 7月17日 | 文件布局/头部/`project.json` | 新 Timelines 格式；核心 draft_info 非明文；project.json 明文 |
| 根索引 | `root_meta_info.json` | v3 36.125s；v2 36.133333s/164.0.0；7月17日 65.7s |
| 文本样式 | 解析 36 个 text material | 白字、10.0/16.0、bold、深色描边、部分背景色 |

### Not run

| 项目 | 原因 |
|---|---|
| 真实剪映打开/播放 Windows 5.9.0 草稿 | 用户明确要求不启动 GUI、不导入；Not run |
| 真实剪映打开/播放 macOS 11.7.0 草稿 | 同上；且新格式不可读；Not run |
| 多保留区间合成草稿导入 | 未生成完整草稿；Not run |
| 主/副/双语字幕导入 | 无真实双语样本；Not run |
| 媒体搬迁/重联测试 | 未导入、未移动；Not run |
| 10–60 分钟长草稿性能 | 未生成/未导入；Not run |
| Windows 应用实机验证 | 无 Windows 环境；只有草稿元数据；Not run |
| macOS 私有格式解密 | 不在范围，也未尝试；Not run |
| 根索引自动扫描/手工更新 | 未启动应用；Not run |

### 复现路径

- 草稿根目录：`/Users/zhangxiangchen/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/`
- 主样本：`AI包装口播_v3/draft_content.json`
- 迁移样本：`AI包装口播_v2/draft_info.json`、`draft_meta_info.json`、`draft_settings`
- macOS 新格式：`7月17日/Timelines/project.json`、`7月17日/Timelines/E4660189-0E5C-4AFD-BF00-6F14BC62BC0A/draft_info.json`
- 合成片段：`experiments/f-0010-jianying-draft/sample-segments.json`
- 字段速记：`experiments/f-0010-jianying-draft/schema-notes.md`

## 结论

1. **目录、文件、版本**：Windows 5.9.0 用 `draft_content.json` + 字节相同的 `draft_info.json` + 明文 `draft_meta_info.json` + `draft_cover.jpg` + 可选 `materials/`；版本字段是 `version=360000`、`new_version=110.0.0`、`platform.app_version=5.9.0`。macOS 11.7.0 用 `Timelines/project.json` + 加密的 `Timelines/<id>/draft_info.json`，没有 `draft_content.json`；根索引可出现 `164.0.0`，与内容字段不一致。
2. **时间单位、fps、duration、canvas**：全部是整数微秒；样本 36,125,000 微秒、30fps、1083.75 帧、1080x1490、`ratio:"original"`。源视频可以是 24fps，工程帧率和源帧率不同；Mac 会把根索引时长对齐到 1084 帧（36.133333s）。
3. **轨道/片段/素材/路径/clip/speed/transform**：轨道有 video/text/audio；片段用 `target_timerange` + `source_timerange` + `material_id` + `extra_material_refs`；视频/音频素材用绝对 `path`，`media_path` 为空；视频/文本片段有 `clip`（alpha/flip/rotation/scale/transform），音频 `clip=null`；speed 素材是独立数组，片段通过引用挂接；transform 是归一化浮点，像素映射未验证。
4. **字幕/样式/多区间**：字幕是普通 `materials.texts` + text 轨，不是独立 subtitle 素材；`content` 是嵌套 JSON 字符串，包含 `text` 和 `styles[]`（fill/range/size/bold/italic/underline/strokes）；样本没有字体字段，alignment 只见到 1。多保留区间在结构上可用多个 video segment 表达，但样本没有真实中段删除；双语/多 range 未验证。字幕跨切点要按 F-0005 的 `projectCues` 拆成多个文本片段。
5. **迁移/版本风险**：macOS 11.7.0 新格式不可生成；v2 显示旧 content 与加密 info/meta 并存的混合态；版本字段 110.0.0/164.0.0/空 不一致；platform 粘性；时长帧量化；绝对路径不可搬迁；根索引更新未知；字体/双语/多区间未验证；文本悬空引用可容忍但不应复制。
6. **F-0011 最小草稿**：Windows 5.9.0 明文、单时间线、单视频轨、单文本轨；用 F-0005 的 kept ranges 生成 video segments，用 `projectCues` 生成 text segments；写 `draft_content.json`、复制 `draft_info.json`、写 `draft_meta_info.json`、生成封面；媒体复制到 `materials/` 或引用原路径，必须在导出前说明；先写临时目录再原子提交，不覆盖已有目录。真实导入仍是验收门禁。
7. **兼容矩阵/许可证**：Windows 5.9.0 明文是唯一候选；macOS 11.7.0 不支持/待验证；CapCut 不在范围。Apache-2.0 的 pyJianYingDraft 和 MIT 的 capcut-cli 可作为参考候选；无许可证的 JianYingProDraft/pyCapCut 不复制。格式是专有的，必须锁定版本并做回归样本。

## 对后续需求的影响

- **F-0010 通过维护者审阅、且 F-0005 依赖满足后，F-0011 也只能按 Windows 5.9.0 明文候选进入技术设计**；PRD 的支持矩阵、AC-1、AC-4、AC-9 需要按本报告收窄。真实导入未完成前，不能把功能标为已验收。
- **F-0005 的 EDL 微秒模型与草稿 timerange 对得上**；但目标应用会按工程帧率量化。F-0011 的技术设计要明确“输出帧率、切点舍入、字幕 cue 拆分”的规则，不能把 F-0005 的源时间直接当成目标帧时间。
- **需要一份 ADR**：记录首发目标版本、媒体复制/引用策略、根索引处理、失败关闭和不支持 macOS 新格式的边界。按 `pnpm feature adr` 建，不要在本报告里代替维护者拍板。
- **macOS 11.7.0 需要单独的 spike 或明确不支持**：如果维护者要求 macOS 首发，先做“旧明文草稿能否被 11.7.0 导入/迁移”的真实实验；在当前证据下不能承诺。
- **不要修改用户现有草稿**：F-0011 只生成新目录；根索引如果要更新，必须在应用关闭、备份、原子写入的前提下做，并先验证应用是否会自动扫描。
- 本报告没有运行 git commit/tag/release；没有启动剪映 GUI；没有导入草稿。

## 参考资料

- 本机草稿：`/Users/zhangxiangchen/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/`
- [pyJianYingDraft](https://github.com/GuanYixuan/pyJianYingDraft)
- [aoguai/pyJianYingDraft](https://github.com/aoguai/pyJianYingDraft)
- [JianYingDraft.PY](https://github.com/xiaoyifang/JianYingDraft.PY)
- [JianYingProDraft](https://github.com/YILING0013/JianYingProDraft)
- [capcut-cli](https://github.com/reacher-z/capcut-cli)
- [pyCapCut](https://github.com/GuanYixuan/pyCapCut)
- 项目内参考：`docs/features/F-0011-jianying-draft-export/01-spec.md`、`docs/features/F-0005-unified-edit-decisions/01-spec.md`、`docs/subsystems/cordis-host.md`、`docs/decisions.md`

