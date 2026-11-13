// F-0030: multilingual subtitle tracks shared by the editor, Host, recovery and later export.
import { z } from 'zod';

export const LEGACY_LANGUAGE_TRACK_ID = 'legacy-second-text';
export const LEGACY_LANGUAGE_TRACK_NAME = 'Legacy translation';

const languageCodeSchema = z.string().trim().min(2).max(35)
  .regex(/^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*$/, 'Invalid language code');

/** A translation plus the exact source text it was written against. */
export const languageTrackEntrySchema = z.looseObject({
  text: z.string(),
  sourceText: z.string(),
  updatedAt: z.string().min(1),
});
export type LanguageTrackEntry = z.infer<typeof languageTrackEntrySchema>;

/** Language tracks keep unknown fields so a newer compatible writer does not lose data on read/write. */
export const languageTrackSchema = z.looseObject({
  id: z.string().min(1).max(128),
  name: z.string().trim().min(1).max(80),
  languageCode: languageCodeSchema.nullable(),
  origin: z.enum(['manual', 'legacy-second-text']).default('manual'),
  /** Subtitle chunk id -> translation. Timing remains on the source chunk and unified EDL. */
  entries: z.record(z.string().min(1), languageTrackEntrySchema),
});
export type LanguageTrack = z.infer<typeof languageTrackSchema>;

export interface LanguageTrackSource {
  id: string;
  text: string;
  secondText?: string;
}

export interface NormalizedLanguageTracks {
  languageTracks: LanguageTrack[];
  activeLanguageTrackId: string | null;
}

export function isTranslationOutdated(entry: Pick<LanguageTrackEntry, 'sourceText'>, source: Pick<LanguageTrackSource, 'text'>): boolean {
  return entry.sourceText !== source.text;
}

/** Count only entries for source cues that still exist; orphan entries stay on disk until the user edits the track. */
export function languageTrackCounts(track: LanguageTrack | undefined, chunks: readonly LanguageTrackSource[]) {
  if (!track) return { translated: 0, outdated: 0 };
  const byId = new Map(chunks.map(chunk => [chunk.id, chunk]));
  let translated = 0; let outdated = 0;
  for (const [id, entry] of Object.entries(track.entries)) {
    if (!entry.text.trim()) continue;
    const source = byId.get(id);
    if (!source) continue;
    translated += 1;
    if (isTranslationOutdated(entry, source)) outdated += 1;
  }
  return { translated, outdated };
}

function legacyTrack(chunks: readonly LanguageTrackSource[]): LanguageTrack | undefined {
  const entries: Record<string, LanguageTrackEntry> = {};
  for (const chunk of chunks) {
    if (!chunk.secondText?.trim()) continue;
    entries[chunk.id] = { text: chunk.secondText, sourceText: chunk.text, updatedAt: '1970-01-01T00:00:00.000Z' };
  }
  if (!Object.keys(entries).length) return undefined;
  return { id: LEGACY_LANGUAGE_TRACK_ID, name: LEGACY_LANGUAGE_TRACK_NAME, languageCode: null, origin: 'legacy-second-text', entries };
}

/**
 * Load-time migration. A missing array means a pre-F-0030 edits file: derive one track from non-empty secondText.
 * An explicit empty array means the user removed every track and must not be rebuilt from stale field values.
 * Existing tracks are returned unchanged except for choosing a valid active track.
 */
export function normalizeLanguageTracks(
  chunks: readonly LanguageTrackSource[],
  languageTracks: LanguageTrack[] | undefined,
  activeLanguageTrackId: string | null | undefined,
): NormalizedLanguageTracks {
  if (languageTracks === undefined) {
    const track = legacyTrack(chunks);
    return { languageTracks: track ? [track] : [], activeLanguageTrackId: track?.id ?? null };
  }
  const tracks = languageTracks.map(track => languageTrackSchema.parse(track));
  const active = activeLanguageTrackId && tracks.some(track => track.id === activeLanguageTrackId)
    ? activeLanguageTrackId
    : tracks[0]?.id ?? null;
  return { languageTracks: tracks, activeLanguageTrackId: active };
}

/** Make secondText the compatibility projection of the active track. */
export function projectLanguageTrack<T extends LanguageTrackSource>(chunks: readonly T[], tracks: readonly LanguageTrack[],
  activeId: string | null | undefined): T[] {
  const active = tracks.find(track => track.id === activeId);
  return chunks.map(chunk => {
    const text = active?.entries[chunk.id]?.text.trim();
    return text ? { ...chunk, secondText: text } : { ...chunk, secondText: undefined };
  });
}

export function createLanguageTrack(input: { name: string; languageCode: string | null; id?: string; origin?: LanguageTrack['origin'] }): LanguageTrack {
  return { id: input.id ?? crypto.randomUUID(), name: input.name.trim(), languageCode: input.languageCode,
    origin: input.origin ?? 'manual', entries: {} };
}

export function withTranslation(track: LanguageTrack, source: LanguageTrackSource, text: string,
  now = new Date().toISOString()): LanguageTrack {
  const trimmed = text.trim();
  const entries = { ...track.entries };
  if (trimmed) entries[source.id] = { text: trimmed, sourceText: source.text, updatedAt: now };
  else delete entries[source.id];
  return { ...track, entries };
}

/** Keep the translation while accepting the current source as its new baseline. */
export function keepTranslation(track: LanguageTrack, source: LanguageTrackSource,
  now = new Date().toISOString()): LanguageTrack {
  const entry = track.entries[source.id];
  if (!entry) return track;
  return { ...track, entries: { ...track.entries, [source.id]: { ...entry, sourceText: source.text, updatedAt: now } } };
}

export function findTrackForLanguage(tracks: readonly LanguageTrack[], languageCode: string): LanguageTrack | undefined {
  return tracks.find(track => track.languageCode?.toLowerCase() === languageCode.toLowerCase());
}

/**
 * Host write validation: track ids and active id are unambiguous and every translation points at a current source cue.
 * Orphan entries from read-only legacy files remain readable; attempting to save them asks the caller to remove them.
 */
export function validateLanguageTracks(tracks: readonly LanguageTrack[], activeId: string | null | undefined,
  chunks: readonly LanguageTrackSource[]): void {
  const ids = new Set<string>();
  const chunkIds = new Set(chunks.map(chunk => chunk.id));
  for (const track of tracks) {
    if (ids.has(track.id)) throw new Error('Duplicate language track id');
    ids.add(track.id);
    for (const id of Object.keys(track.entries)) {
      if (!chunkIds.has(id)) throw new Error('Language track entry references an unknown subtitle');
    }
  }
  if (activeId && !ids.has(activeId)) throw new Error('Active language track does not exist');
}
