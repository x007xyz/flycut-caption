import { z } from 'zod';
import { deriveKept, edlSchema, projectCues, toUs, type Cue } from '../editing/edl';

export const JIANYING_WINDOWS_TARGET = 'jianying-windows-5.9.0' as const;
export const JIANYING_MAC_TARGET = 'jianying-macos-11.7.0' as const;
export const JIANYING_RESEARCH_DATE = '2026-11-09' as const;
export const JIANYING_DIRECTORY_TTL_MS = 15 * 60_000;
export const JIANYING_PREFLIGHT_TTL_MS = 10 * 60_000;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** A user-visible directory name. The Host checks the same rule again at commit time. */
export const jianyingDraftNameSchema = z.string().trim().min(1).max(120)
  .refine(name => !/[<>:"/\\|?*]/.test(name) && ![...name].some(character => character.charCodeAt(0) < 32),
    'Draft name contains a Windows-invalid character')
  .refine(name => name !== '.' && name !== '..' && !name.endsWith('.') && !name.endsWith(' '), 'Draft name is not a portable Windows directory name')
  .refine(name => !WINDOWS_RESERVED.test(name), 'Draft name is reserved by Windows');

export const jianyingStyleSchema = z.strictObject({
  fontId: z.string(),
  fontSizeRatio: z.number().finite().positive().max(1),
  bottomOffsetRatio: z.number().finite().nonnegative().max(1),
  fontWeight: z.enum(['normal', 'bold']),
  fontStyle: z.enum(['normal', 'italic']),
  textDecoration: z.enum(['none', 'underline']),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  colorOpacity: z.number().finite().min(0).max(1),
  backgroundColor: z.string().regex(/^#[0-9a-f]{6}$/i),
  borderColor: z.string().regex(/^#[0-9a-f]{6}$/i),
  borderOpacity: z.number().finite().min(0).max(1),
  textAlign: z.enum(['left', 'center', 'right']),
  lineHeight: z.number().finite().positive(),
  letterSpacing: z.number().finite(),
  borderWidth: z.number().finite().nonnegative(),
  backgroundOpacity: z.number().finite().min(0).max(1),
});
export type JianyingStyle = z.infer<typeof jianyingStyleSchema>;

export const jianyingCueSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  secondText: z.string().optional(),
  timestamp: z.tuple([z.number().finite().nonnegative(), z.number().finite().nonnegative()]),
}).refine(cue => cue.timestamp[1] > cue.timestamp[0], 'Subtitle cue has no duration');

export const jianyingSnapshotSchema = z.strictObject({
  edl: edlSchema,
  cues: z.array(jianyingCueSchema).max(100_000),
  style: jianyingStyleSchema,
  videoWidth: z.number().int().positive().max(32_768),
  videoHeight: z.number().int().positive().max(32_768),
  projectId: z.uuid().optional(),
  projectName: z.string().trim().min(1).max(200).optional(),
  videoId: z.uuid().optional(),
  videoName: z.string().trim().min(1).max(260).optional(),
}).superRefine((snapshot, ctx) => {
  const durationUs = snapshot.edl.sourceDurationUs;
  for (const [index, cue] of snapshot.cues.entries()) {
    if (toUs(cue.timestamp[1]) > durationUs) ctx.addIssue({ code: 'custom', path: ['cues', index], message: 'Subtitle cue exceeds media duration' });
  }
});
export type JianyingSnapshot = z.infer<typeof jianyingSnapshotSchema>;

/** Only opaque Host-issued identifiers cross ordinary RPC; local paths travel through the desktop shell route. */
export const jianyingDirectoryGrantSchema = z.uuid();
export const jianyingSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('asset'), assetId: z.uuid() }),
  z.strictObject({ kind: z.literal('project'), projectId: z.uuid(), videoId: z.uuid() }),
]);
export type JianyingSource = z.infer<typeof jianyingSourceSchema>;

export const jianyingPreflightInputSchema = z.strictObject({
  directoryGrant: jianyingDirectoryGrantSchema,
  draftName: jianyingDraftNameSchema,
  source: jianyingSourceSchema,
  snapshot: jianyingSnapshotSchema,
});
export type JianyingPreflightInput = z.infer<typeof jianyingPreflightInputSchema>;
export const jianyingStartInputSchema = z.strictObject({ preflightId: z.uuid() });
export type JianyingStartInput = z.infer<typeof jianyingStartInputSchema>;

export interface JianyingPreflightResult {
  preflightId: string;
  expiresAt: string;
  draftName: string;
  mediaStrategy: 'copy';
  sourceBytes: number;
  estimatedBytes: number;
  availableBytes: number;
  videoSegmentCount: number;
  textSegmentCount: number;
  degradationKeys: JianyingDegradation[];
}

export interface JianyingJobResult {
  draftName: string;
  draftPath: string;
  createdAt: string;
  sourceBytes: number;
  copiedBytes: number;
  videoSegmentCount: number;
  textSegmentCount: number;
  degradationKeys: JianyingDegradation[];
}

export interface JianyingSourceMedia {
  path: string;
  materialName: string;
  durationUs: number;
  width: number;
  height: number;
  size: number;
}

export interface JianyingDraftLocation {
  draftName: string;
  finalPath: string;
  parentPath: string;
}

export interface JianyingBuildOptions {
  snapshot: JianyingSnapshot;
  media: JianyingSourceMedia;
  location: JianyingDraftLocation;
  timestampUs: number;
  id: () => string;
}

export interface JianyingDraftBundle {
  content: Record<string, unknown>;
  meta: Record<string, unknown>;
  contentText: string;
  metaText: string;
  videoSegmentCount: number;
  textSegmentCount: number;
  degradationKeys: JianyingDegradation[];
}

const MATERIAL_KEYS = [
  'ai_translates', 'audio_balances', 'audio_effects', 'audio_fades', 'audio_track_indexes', 'audios', 'beats', 'canvases',
  'chromas', 'color_curves', 'common_mask', 'digital_humans', 'drafts', 'effects', 'flowers', 'green_screens', 'handwrites',
  'hsl', 'images', 'log_color_wheels', 'loudnesses', 'manual_deformations', 'masks', 'material_animations', 'material_colors',
  'multi_language_refs', 'placeholders', 'plugin_effects', 'primary_color_wheels', 'realtime_denoises', 'shapes', 'smart_crops',
  'smart_relights', 'sound_channel_mappings', 'speeds', 'stickers', 'tail_leaders', 'text_templates', 'texts', 'time_marks',
  'transitions', 'video_effects', 'video_trackings', 'videos', 'vocal_beautifys', 'vocal_separations',
] as const;

const DRAFT_CONFIG = {
  adjust_max_index: 1, attachment_info: [], combination_max_index: 1, export_range: null, extract_audio_last_index: 1,
  lyrics_recognition_id: '', lyrics_sync: true, lyrics_taskinfo: [], maintrack_adsorb: true, material_save_mode: 0,
  multi_language_current: 'none', multi_language_list: [], multi_language_main: 'none', multi_language_mode: 'none',
  original_sound_last_index: 1, record_audio_last_index: 1, sticker_max_index: 1, subtitle_keywords_config: null,
  subtitle_recognition_id: '', subtitle_sync: true, subtitle_taskinfo: [], system_font_list: [], video_mute: false,
  zoom_info_params: null,
};

const META_DEFAULTS = {
  cloud_draft_cover: false, cloud_draft_sync: false, cloud_package_completed_time: '',
  draft_cloud_capcut_purchase_info: '', draft_cloud_last_action_download: false, draft_cloud_package_type: '',
  draft_cloud_purchase_info: '', draft_cloud_template_id: '', draft_cloud_tutorial_info: '',
  draft_cloud_videocut_purchase_info: '', draft_cover: 'draft_cover.jpg', draft_deeplink_url: '',
  draft_enterprise_info: { draft_enterprise_extra: '', draft_enterprise_id: '', draft_enterprise_name: '', enterprise_material: [] },
  draft_has_unfinished_aigc_video_effect: false, draft_is_ae_produce: false, draft_is_ai_packaging_used: false,
  draft_is_ai_shorts: false, draft_is_ai_translate: false, draft_is_article_video_draft: false,
  draft_is_cloud_temp_draft: false, draft_is_from_deeplink: 'false', draft_is_infinite_canvas_draft: false,
  draft_is_invisible: false, draft_is_pippit_draft: false, draft_is_web_article_video: false,
  draft_materials: [0, 1, 2, 3, 6, 7, 8].map(type => ({ type, value: [] })), draft_materials_copied_info: [],
  draft_need_rename_folder: false, draft_new_version: '', draft_removable_storage_device: '', draft_segment_extra_info: [],
  draft_type: '', draft_web_article_video_enter_from: '', pippit_avatar_url: '', pippit_extra_info: '', pippit_id: '',
  pippit_user_name: '', tm_draft_cloud_completed: '', tm_draft_cloud_entry_id: -1, tm_draft_cloud_modified: 0,
  tm_draft_cloud_parent_entry_id: -1, tm_draft_cloud_space_id: -1, tm_draft_cloud_user_id: -1, tm_draft_removed: 0,
};

const PLATFORM = { app_id: 3704, app_source: 'lv', app_version: '5.9.0', os: 'windows' };

export type JianyingDegradation =
  | 'secondary-subtitles-omitted'
  | 'font-family-not-preserved'
  | 'exact-text-position-not-preserved'
  | 'font-size-and-spacing-unverified'
  | 'background-style-not-written'
  | 'subtitle-frame-quantization-unverified';

export function jianyingDegradations(snapshot: JianyingSnapshot): JianyingDegradation[] {
  const result: JianyingDegradation[] = [
    'font-family-not-preserved', 'exact-text-position-not-preserved', 'font-size-and-spacing-unverified',
    'subtitle-frame-quantization-unverified',
  ];
  if (snapshot.cues.some(cue => cue.secondText?.trim())) result.unshift('secondary-subtitles-omitted');
  if (snapshot.style.backgroundOpacity > 0) result.push('background-style-not-written');
  return result;
}

/** Cues on one Jianying text track must not overlap; importing overlapping cues can reorder them silently. */
export function projectedJianyingCues(snapshot: JianyingSnapshot): Cue[] {
  return projectCues(snapshot.edl, snapshot.cues as Cue[]).filter(cue => cue.text.length > 0);
}

export function assertNonOverlappingJianyingCues(snapshot: JianyingSnapshot): Cue[] {
  const cues = projectedJianyingCues(snapshot);
  for (let index = 1; index < cues.length; index++) {
    if (toUs(cues[index].timestamp[0]) < toUs(cues[index - 1].timestamp[1])) {
      throw new Error(`Jianying text segments overlap at cue ${index}; resolve them before export`);
    }
  }
  return cues;
}

export type JianyingTargetStatus = 'unverified' | 'observed-unverified' | 'internal-validation' | 'unsupported';
export interface JianyingTarget {
  id: string;
  platform: 'windows' | 'macos' | 'cross-platform' | 'web';
  version: string;
  status: JianyingTargetStatus;
  labelZh?: string;
  labelEn?: string;
  reason?: string;
  capabilities?: {
    timeline: 'single';
    videoTracks: 1;
    subtitleTracks: 1;
    subtitleModes: Array<'Main'>;
    mediaStrategy: 'copy';
    rootIndexUpdate: false;
    bilingual: false;
    fontMapping: false;
    exactPosition: false;
  };
}

export interface JianyingCapabilities {
  research: 'F-0010';
  checkedAt: string;
  verifiedByImport: boolean;
  exportEnabled: boolean;
  exportMode: 'disabled' | 'internal-validation';
  activeTargetId?: string;
  reason: string;
  evidence: {
    macCandidateImported: boolean;
    macPlaybackObserved: boolean;
    subtitleTimingVerified: boolean;
    subtitleEditingVerified: boolean;
    savedReopenVerified: boolean;
    relocationVerified: boolean;
  };
  targets: JianyingTarget[];
}

const CANDIDATE_CAPABILITIES: NonNullable<JianyingTarget['capabilities']> = {
  timeline: 'single', videoTracks: 1, subtitleTracks: 1, subtitleModes: ['Main'], mediaStrategy: 'copy',
  rootIndexUpdate: false, bilingual: false, fontMapping: false, exactPosition: false,
};

/**
 * Product gate. The normal build never turns a candidate into a supported export. An explicit developer-only
 * validation mode can exercise the complete flow, but it remains labelled as internal and cannot claim support.
 */
export function buildJianyingCapabilities(internalValidation = false): JianyingCapabilities {
  return {
    research: 'F-0010', checkedAt: JIANYING_RESEARCH_DATE,
    verifiedByImport: false,
    exportEnabled: internalValidation,
    exportMode: internalValidation ? 'internal-validation' : 'disabled',
    ...(internalValidation ? { activeTargetId: JIANYING_MAC_TARGET } : {}),
    reason: internalValidation
      ? 'Internal validation only: one Mac 11.7.0 candidate passed observed subtitle timing checks, but subtitle editing, save/reopen, two-source and relocation evidence is incomplete.'
      : 'The format has structural and limited Mac import evidence, but the target has not passed the required editing, two-source and reopen gate.',
    evidence: {
      macCandidateImported: true, macPlaybackObserved: true, subtitleTimingVerified: true,
      subtitleEditingVerified: false, savedReopenVerified: false, relocationVerified: false,
    },
    targets: [
      { id: JIANYING_WINDOWS_TARGET, platform: 'windows', version: '5.9.0', status: 'unverified',
        labelZh: '候选格式，尚未完成真实导入验证', labelEn: 'Candidate format; real import is not verified',
        capabilities: CANDIDATE_CAPABILITIES },
      { id: JIANYING_MAC_TARGET, platform: 'macos', version: '11.7.0',
        status: internalValidation ? 'internal-validation' : 'observed-unverified',
        labelZh: internalValidation ? '仅供实机内部验证' : '可导入观察，但时序和编辑未验证',
        labelEn: internalValidation ? 'Internal device validation only' : 'Import observed; timing and editing unverified',
        reason: 'One candidate was imported and played on Mac 11.7.0; AX currentProgress observed the expected 20–22 second subtitle. Subtitle editing, reopen, relocation and two-source evidence remain unverified.',
        capabilities: CANDIDATE_CAPABILITIES },
      { id: 'jianying-windows-other-builds', platform: 'windows', version: 'other', status: 'unsupported',
        reason: 'Only the inspected 5.9.0 plaintext draft is a candidate.' },
      { id: 'capcut', platform: 'cross-platform', version: 'any', status: 'unsupported',
        reason: 'CapCut compatibility was not researched.' },
      { id: 'jianying-web', platform: 'web', version: 'any', status: 'unsupported',
        reason: 'Jianying draft directory writes require the desktop shell and Host.' },
    ],
  };
}

export const JIANYING_CAPABILITIES = buildJianyingCapabilities(false);

function id32(next: () => string): string { return next().replace(/-/g, '').toLowerCase(); }
function uuidUpper(next: () => string): string { return next().toUpperCase(); }
function color(value: string): number[] {
  return [Number.parseInt(value.slice(1, 3), 16) / 255, Number.parseInt(value.slice(3, 5), 16) / 255,
    Number.parseInt(value.slice(5, 7), 16) / 255];
}
const timerange = (start: number, duration: number) => ({ start, duration });

function textMaterial(cue: Cue, style: JianyingStyle, materialId: string): Record<string, unknown> {
  const text = cue.text;
  const content = {
    styles: [{
      fill: { alpha: style.colorOpacity, content: { render_type: 'solid', solid: { alpha: 1, color: color(style.color) } } },
      range: [0, [...text].length],
      size: 10,
      bold: style.fontWeight === 'bold',
      italic: style.fontStyle === 'italic',
      underline: style.textDecoration === 'underline',
      strokes: style.borderWidth > 0 ? [{
        content: { solid: { alpha: style.borderOpacity, color: color(style.borderColor) } }, width: 0.09,
      }] : [],
    }],
    text,
  };
  return {
    id: materialId, content: JSON.stringify(content), typesetting: 0, alignment: 1, letter_spacing: 0,
    line_spacing: 0.02, line_feed: 1, line_max_width: 0.82, force_apply_line_max_width: false,
    check_flag: 15, type: 'text', global_alpha: 1,
  };
}

function segmentBase(id: string, materialId: string, startUs: number, durationUs: number, renderIndex: number): Record<string, unknown> {
  return {
    id, material_id: materialId, target_timerange: timerange(startUs, durationUs), source_timerange: null,
    speed: 1, volume: 1, visible: true, render_index: renderIndex,
    clip: { alpha: 1, flip: { horizontal: false, vertical: false }, rotation: 0, scale: { x: 1, y: 1 },
      transform: { x: 0, y: -0.47651006711409394 } },
    uniform_scale: { on: true, value: 1 }, extra_material_refs: [], common_keyframes: [], keyframe_refs: [],
    is_tone_modify: false, last_nonzero_volume: 1, reverse: false, track_attribute: 0, track_render_index: 0,
    enable_adjust: true, enable_color_correct_adjust: false, enable_color_curves: true,
    enable_color_match_adjust: false, enable_color_wheels: true, enable_lut: true,
    enable_smart_color_adjust: false,
  };
}

/** Build the candidate in memory. Persistence and byte-level verification live in `server/jianying`. */
export function buildJianyingDraft(options: JianyingBuildOptions): JianyingDraftBundle {
  const snapshot = jianyingSnapshotSchema.parse(options.snapshot);
  jianyingDraftNameSchema.parse(options.location.draftName);
  const kept = deriveKept(snapshot.edl);
  if (!kept.length) throw new Error('No retained video ranges');
  const projected = assertNonOverlappingJianyingCues(snapshot);
  const videoMaterialId = id32(options.id);
  const speeds: Record<string, unknown>[] = [];
  const videoSegments = kept.map(range => {
    const speedId = id32(options.id);
    speeds.push({ id: speedId, speed: 1, mode: 0, curve_speed: null, type: 'speed' });
    const durationUs = range.endUs - range.startUs;
    return {
      ...segmentBase(id32(options.id), videoMaterialId, range.outputStartUs, durationUs, 0),
      source_timerange: timerange(range.startUs, durationUs),
      extra_material_refs: [speedId],
      clip: { alpha: 1, flip: { horizontal: false, vertical: false }, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } },
      hdr_settings: { intensity: 1, mode: 1, nits: 1000 },
    };
  });
  const texts: Record<string, unknown>[] = [];
  const textSegments = projected.map(cue => {
    const materialId = id32(options.id);
    texts.push(textMaterial(cue, snapshot.style, materialId));
    const startUs = toUs(cue.timestamp[0]);
    const durationUs = toUs(cue.timestamp[1]) - startUs;
    return segmentBase(id32(options.id), materialId, startUs, durationUs, 1);
  });
  const durationUs = kept.at(-1)!.outputEndUs;
  const materials = Object.fromEntries(MATERIAL_KEYS.map(key => [key, []])) as Record<string, unknown[]>;
  materials.speeds = speeds;
  materials.texts = texts;
  materials.videos = [{
    id: videoMaterialId, material_id: videoMaterialId, local_material_id: '', material_name: options.media.materialName,
    path: options.media.path, media_path: '', duration: options.media.durationUs, width: options.media.width,
    height: options.media.height, type: 'video', category_name: 'local', check_flag: 63487,
    crop: { upper_left_x: 0, upper_left_y: 0, upper_right_x: 1, upper_right_y: 0,
      lower_left_x: 0, lower_left_y: 1, lower_right_x: 1, lower_right_y: 1 },
    crop_ratio: 'free', crop_scale: 1,
  }];
  const content = {
    canvas_config: { width: snapshot.videoWidth, height: snapshot.videoHeight, ratio: 'original' },
    color_space: 0,
    config: structuredClone(DRAFT_CONFIG),
    cover: null,
    create_time: Math.floor(options.timestampUs / 1000),
    duration: durationUs,
    extra_info: null,
    fps: 30,
    free_render_index_mode_on: false,
    group_container: null,
    id: uuidUpper(options.id),
    keyframe_graph_list: [],
    keyframes: { adjusts: [], audios: [], effects: [], filters: [], handwrites: [], stickers: [], texts: [], videos: [] },
    last_modified_platform: structuredClone(PLATFORM),
    materials,
    mutable_config: null,
    name: '',
    new_version: '110.0.0',
    platform: structuredClone(PLATFORM),
    relationships: [],
    render_index_track_mode_on: false,
    retouch_cover: null,
    source: 'default',
    static_cover_image_path: '',
    time_marks: null,
    tracks: [
      { attribute: 0, flag: 0, id: id32(options.id), is_default_name: false, name: '口播主轨', segments: videoSegments, type: 'video' },
      { attribute: 0, flag: 0, id: id32(options.id), is_default_name: false, name: '字幕', segments: textSegments, type: 'text' },
    ],
    update_time: Math.floor(options.timestampUs / 1000),
    version: 360000,
  };
  const meta = {
    ...structuredClone(META_DEFAULTS),
    draft_fold_path: options.location.finalPath,
    draft_id: uuidUpper(options.id),
    draft_name: options.location.draftName,
    draft_root_path: options.location.parentPath,
    draft_timeline_materials_size_: options.media.size,
    tm_draft_create: options.timestampUs,
    tm_draft_modified: options.timestampUs,
    tm_duration: durationUs,
  };
  return {
    content, meta, contentText: JSON.stringify(content, null, 2) + '\n', metaText: JSON.stringify(meta, null, 2) + '\n',
    videoSegmentCount: videoSegments.length, textSegmentCount: textSegments.length,
    degradationKeys: jianyingDegradations(snapshot),
  };
}
