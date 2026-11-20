import type { SubtitleChunk } from '@/types/subtitle';
import type { VideoSegment } from '@/types/video';
import { chunksToVtt } from './exportFormats';
import type { LanguageTrack } from '../../shared/languageTracks';
import { projectFromKept } from '../../shared/editing/edl';
import { stripSubtitleDisplayPunctuation } from './cjkPunctuation';
import type { SubtitleDisplayMode } from './subtitleRenderer';

export interface BuildBurnTextSubtitleOptions {
  chunks: SubtitleChunk[];
  keptSegments: VideoSegment[];
  exportMode: SubtitleDisplayMode;
}

function remapBurnSubtitleChunks(
  chunks: SubtitleChunk[],
  keptSegments: VideoSegment[],
): SubtitleChunk[] {
  // 合成进视频的字幕去掉标点（与预览画面一致），但不影响独立导出的字幕文件与编辑器原文。
  const activeChunks = chunks
    .filter((c) => !c.deleted)
    .map((c) => ({
      ...c,
      text: stripSubtitleDisplayPunctuation(c.text ?? ''),
      secondText: c.secondText
        ? stripSubtitleDisplayPunctuation(c.secondText)
        : c.secondText,
    }))
    .filter((c) => c.text.trim() || c.secondText?.trim());
  return projectFromKept(activeChunks, keptSegments);
}

/** 为软字幕轨生成时间轴已重映射的 WebVTT 内容。 */
export function buildBurnTextSubtitleContent(options: BuildBurnTextSubtitleOptions): string {
  const { chunks, keptSegments, exportMode } = options;
  const remapped = remapBurnSubtitleChunks(chunks, keptSegments);
  return chunksToVtt(remapped, exportMode);
}


export interface SoftSubtitleCandidate {
  id: string;
  name: string;
  languageCode: string;
  missing: number;
  outdated: number;
  total: number;
  active: boolean;
}

export interface SoftSubtitleBuild {
  tracks: Array<{ id: string; name: string; languageCode: string; content: string; default?: boolean }>;
  candidates: SoftSubtitleCandidate[];
}

/** Count what each language track can export; missing and outdated cues are never filled with source text. */
export function listSoftSubtitleTracks(input: {
  chunks: SubtitleChunk[];
  languageTracks: LanguageTrack[];
  activeTrackId?: string | null;
  primaryLanguage?: string;
}): SoftSubtitleCandidate[] {
  const active = input.chunks.filter(chunk => !chunk.deleted && !chunk.isBlankSpacer && chunk.text.trim());
  const candidates: SoftSubtitleCandidate[] = [{
    id: 'primary', name: 'Original', languageCode: input.primaryLanguage || 'und',
    missing: 0, outdated: 0, total: active.length, active: !input.activeTrackId,
  }];
  for (const track of input.languageTracks) {
    let missing = 0; let outdated = 0;
    for (const chunk of active) {
      const entry = track.entries[chunk.id];
      if (!entry?.text.trim()) { missing += 1; continue; }
      if (entry.sourceText !== chunk.text) outdated += 1;
    }
    candidates.push({ id: track.id, name: track.name, languageCode: track.languageCode || 'und',
      missing, outdated, total: active.length, active: track.id === input.activeTrackId });
  }
  return candidates;
}

export function buildSoftSubtitleTracks(input: {
  chunks: SubtitleChunk[];
  keptSegments: VideoSegment[];
  languageTracks: LanguageTrack[];
  activeTrackId?: string | null;
  primaryLanguage?: string;
  selectedIds: string[];
  allowPartial: boolean;
}): SoftSubtitleBuild {
  const candidates = listSoftSubtitleTracks(input);
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const active = input.chunks.filter(chunk => !chunk.deleted && !chunk.isBlankSpacer && chunk.text.trim());
  const tracks: SoftSubtitleBuild['tracks'] = [];
  for (const id of input.selectedIds) {
    const candidate = byId.get(id);
    if (!candidate) continue;
    if (candidate.missing + candidate.outdated > 0 && !input.allowPartial) continue;
    let cues: SubtitleChunk[];
    if (id === 'primary') {
      cues = active.map(chunk => ({ ...chunk, id: `primary:${chunk.id}`, secondText: undefined }));
    } else {
      const track = input.languageTracks.find(item => item.id === id);
      if (!track) continue;
      cues = active.flatMap(chunk => {
        const entry = track.entries[chunk.id];
        if (!entry?.text.trim() || entry.sourceText !== chunk.text) return [];
        return [{ ...chunk, id: `${id}:${chunk.id}`, text: entry.text, secondText: undefined }];
      });
    }
    if (!cues.length) continue;
    const projected = projectFromKept(cues, input.keptSegments);
    if (!projected.length) continue;
    tracks.push({ id, name: id === 'primary' ? 'Original' : candidate.name, languageCode: candidate.languageCode,
      content: chunksToVtt(projected, 'Main'), ...(id === input.activeTrackId ? { default: true } : {}) });
  }
  return { tracks, candidates };
}
