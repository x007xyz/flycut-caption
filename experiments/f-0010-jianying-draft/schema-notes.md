# F-0010 草稿字段速记

只读研究笔记，不是剪映官方 schema，也不是完整草稿。来源是 2026-11-09 对 `AI包装口播_v3`（Windows 5.9.0 明文）和 `7月17日`（macOS 11.7.0 新格式）的只读检查。真实导入未执行。

## 文件布局

Windows 5.9.0 的最小可读样本只有：

```
<draft>/
  draft_content.json
  draft_info.json       # 与 draft_content.json 字节相同
  draft_meta_info.json
  draft_cover.jpg
  materials/            # 可选的媒体副本
```

macOS 11.7.0 原生样本使用：

```
<draft>/
  draft_info.json       # base64 包裹的高熵二进制，不是明文 JSON
  draft_meta_info.json  # 同上
  draft_cover.jpg
  draft_settings
  key_value.json
  timeline_layout.json
  draft_virtual_store.json
  Timelines/
    project.json        # 明文
    <timeline-id>/
      draft_info.json   # 同上，非明文
      draft.extra
      attachment_editing.json
      attachment_pc_common.json
  Resources/cover/
  common_attachment/
  .backup/
```

## `draft_content.json` 顶层字段（样本）

| 字段 | 样本值 | 说明 |
|---|---|---|
| `version` | `360000` | 整数；不是语义化版本 |
| `new_version` | `"110.0.0"` | Windows 5.9.0 写入 |
| `platform` | `{app_id:3704, app_source:"lv", app_version:"5.9.0", os:"windows"}` | 复制到 Mac 后仍保留 |
| `last_modified_platform` | 同上 | 不能用来判断当前主机 |
| `id` | `91E08AC5-22FB-47e2-9AA0-7DC300FAEA2B` | 样本中三个 Windows 草稿复用；更像时间线 ID |
| `duration` | `36125000` | 微秒；36.125 秒 |
| `fps` | `30` | 工程帧率；源视频可以是 24fps |
| `canvas_config` | `{width:1080, height:1490, ratio:"original"}` | 1080x1490，不是标准 3:4 |
| `tracks` | 20 条 | video/text/audio |
| `materials` | 46 个数组 | 未使用的数组也存在，多为空 |
| `config` | 见样本 | 字幕同步、导出范围等默认值 |
| `keyframes` | 8 个空数组 | 样本中顶层为空；关键帧在 segment.common_keyframes |
| `create_time` / `update_time` | `0` | 样本未填 |
| `source` | `"default"` | |
| `color_space` | `0` | |
| `free_render_index_mode_on` / `render_index_track_mode_on` | `false` | |

`draft_meta_info.draft_id` 是草稿 ID（样本 `ECBAA080-...`），与 `draft_content.id` 不同。文件夹名和 `draft_meta_info.draft_name` 才是显示名；`draft_content.name` 可以为空。

## 轨道模板

```json
{
  "type": "video",
  "name": "口播主轨",
  "id": "<32 hex>",
  "attribute": 0,
  "flag": 0,
  "is_default_name": false,
  "segments": []
}
```

`type` 观测到 `video`、`text`、`audio`。`render_index` 在样本中等于轨道下标；`track_render_index` 在所有片段中都是 0，不能当作轨道下标。

## 视频/音频片段模板

```json
{
  "id": "<32 hex>",
  "material_id": "<32 hex>",
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
    "transform": { "x": 0.0, "y": 0.0 }
  },
  "uniform_scale": { "on": true, "value": 1.0 },
  "hdr_settings": { "intensity": 1.0, "mode": 1, "nits": 1000 },
  "extra_material_refs": ["<32 hex speed id>"],
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

音频片段的 `clip` 为 `null`，没有 `uniform_scale`，`hdr_settings` 为 `null@@。文本片段的 `source_timerange` 为 `null@@。

## 文本片段模板

```json
{
  "id": "<32 hex>",
  "material_id": "<32 hex>",
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
  "extra_material_refs": [],
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

样本中 36 个文本片段的 `extra_material_refs` 都指向不存在的 ID（悬空引用），但草稿仍存在。生成器不应复制这些悬空引用。

## 文本素材

`materials.texts[]` 的 `content` 是**字符串**，里面再放一个 JSON：

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

外层文本素材字段：

| 字段 | 观测值 | 说明 |
|---|---|---|
| `type` | `"text"` | |
| `alignment` | `1` | 样本全部为 1，未验证左/右 |
| `typesetting` | `0` | 横排 |
| `letter_spacing` | `0.0` | |
| `line_spacing` | `0.02` | |
| `line_feed` | `1` | |
| `line_max_width` | `0.82` | 归一化 |
| `force_apply_line_max_width` | `false` | |
| `check_flag` | `15` 或 `23` | 有背景时为 23 |
| `global_alpha` | `1.0` | |

带背景的样本还包含 `background_style`、`background_color`（如 `"#FF6A1A"`）、`background_alpha`、`background_round_radius`、`background_height`、`background_width`、`background_horizontal_offset`、`background_vertical_offset`。

没有观察到字体 family/path 字段；字体映射和字号换算未验证。

## 视频/音频素材

视频素材样本字段：

```json
{
  "id": "<32 hex>",
  "material_id": "<32 hex>",
  "local_material_id": "",
  "material_name": "desk_full.mp4",
  "path": "/absolute/path/to/draft/materials/desk_full.mp4",
  "media_path": "",
  "duration": 36125000,
  "width": 464,
  "height": 640,
  "type": "video",
  "category_name": "local",
  "check_flag": 63487,
  "crop": { "upper_left_x": 0.0, "upper_left_y": 0.0, "upper_right_x": 1.0, "upper_right_y": 0.0, "lower_left_x": 0.0, "lower_left_y": 1.0, "lower_right_x": 1.0, "lower_right_y": 1.0 },
  "crop_ratio": "free",
  "crop_scale": 1.0
}
```

静态图片也放在 `materials.videos`，`type` 为 `"photo"`，样本 `duration` 为 `10800000000` 微秒（3 小时）。音频素材使用 `materials.audios`，`type` 为 `"extract_music"`，`path` 同样是绝对路径。

## 时间与版本

- 所有 `target_timerange`、`source_timerange`、`duration`、`tm_duration` 都是整数微秒。
- 样本 `duration=36125000` 对应 36.125 秒；30fps 下是 1083.75 帧，不是整帧。
- macOS 打开 `AI包装口播_v2` 后，根索引 `root_meta_info.json` 的 `tm_duration` 变成 `36133333`，正好是 1084 帧。内容文件仍是 `36125000`。这说明 Mac 会把时长向上对齐到工程帧。
- `draft_content.create_time` 为 0；`draft_meta_info.tm_draft_create`/`tm_draft_modified` 是微秒级 Unix 时间；`draft_settings` 的 `draft_create_time` 是秒。
- Windows 样本 `draft_content.new_version="110.0.0"`；Mac 保存后根索引 `draft_new_version="164.0.0"`，但内容文件仍是 `110.0.0`。

## F-0011 最小生成顺序（候选）

1. 从 F-0005 取 `Edl`，验证 `version=1`、`sourceDurationUs>0`、保留区间非空。
2. `deriveKept(edl)` 得到每个保留区间；每个区间生成一个视频片段，`target_timerange.start` 用 `outputStartUs`，`source_timerange.start` 用 `startUs`，两者 `duration` 相同。
3. `projectCues(edl, chunks)` 得到投影后的字幕；每个 cue 生成一个文本素材和一个文本片段，时间用 cue 的输出时间。
4. 为每个视频/音频片段生成一个 `materials.speeds` 记录（`speed:1.0, mode:0, curve_speed:null, type:"speed"`），片段 `extra_material_refs` 引用它。
5. 写 `draft_content.json`；复制为 `draft_info.json`；写 `draft_meta_info.json`；生成/复制 `draft_cover.jpg`。
6. 媒体策略二选一：复制到 `<draft>/materials/` 并写最终绝对路径，或引用原媒体绝对路径。两种都要在导出前告知用户；移动目录/媒体后的行为未验证。
7. 先写临时目录，校验 JSON 和文件存在，再原子重命名到最终目录；不覆盖已有目录。

## 不能从本样本推出的结论

- 不能推出 macOS 11.7.0 支持明文草稿；它使用不同的私有格式。
- 不能推出多保留区间、双语字幕、字体、背景样式在真实剪映中可用；需要真实导入。
- 不能推出 `root_meta_info.json` 必须手工更新，或应用会自动扫描新目录。
- 不能推出任意 `fps`、`canvas_config`、`speed != 1` 的行为。

