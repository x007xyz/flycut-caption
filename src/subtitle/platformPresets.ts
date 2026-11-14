import {
  PLATFORM_PRESETS,
  getPlatformPreset,
  isBottomInSafeZoneOcclusion,
  isPlatformPresetId,
  resolveSafeZoneInsets,
  type PlatformPresetDefinition,
  type PlatformPresetId,
  type SafeZoneInsets,
} from '../../shared/subtitle-graphics';
import type { SubtitleStyle } from './subtitleStyle';

export {
  PLATFORM_PRESET_REFERENCE_DATE,
  PLATFORM_PRESETS,
  PLATFORM_PRESET_IDS,
  isPlatformPresetId,
  getPlatformPreset,
  clampSafeZoneInsets,
  resolveSafeZoneInsets,
  isBottomInSafeZoneOcclusion,
  getFontLanguageCoverage,
  hasUncoveredCjkSubtitles,
  type PlatformPresetId,
  type PlatformAspectPreset,
  type SafeZoneInsets,
  type PlatformVerificationInfo,
  type PlatformPresetStylePatch,
  type PlatformPresetDefinition,
} from '../../shared/subtitle-graphics';

export interface ResolvedSafeZoneState {
  visible: boolean;
  platformId: PlatformPresetId;
  preset: PlatformPresetDefinition;
  insets: SafeZoneInsets;
  bottomOccluded: boolean;
}

/** Apply a platform preset to the primary subtitle style without touching cues, timestamps, or EDL. */
export function applyPlatformPreset(
  style: SubtitleStyle,
  platformId: PlatformPresetId,
  options: { enableSafeZone?: boolean } = {},
): SubtitleStyle {
  const preset = getPlatformPreset(platformId);
  if (!preset) return style;
  return {
    ...style,
    ...preset.stylePatch,
    platformPresetId: preset.id,
    safeZonePlatformId: preset.id,
    safeZoneVisible: options.enableSafeZone ?? true,
    safeZoneInsets: { ...preset.safeZone },
  };
}

/** Toggle preview-only safe-zone guides while preserving the selected platform & margins. */
export function toggleSafeZoneGuide(
  style: SubtitleStyle,
  visible: boolean,
  platformId?: PlatformPresetId,
): SubtitleStyle {
  const targetId = platformId
    ?? (isPlatformPresetId(style.safeZonePlatformId) ? style.safeZonePlatformId : undefined)
    ?? (isPlatformPresetId(style.platformPresetId) ? style.platformPresetId : undefined)
    ?? PLATFORM_PRESETS[0].id;
  const nextInsets = platformId && platformId !== style.safeZonePlatformId
    ? resolveSafeZoneInsets(targetId)
    : resolveSafeZoneInsets(targetId, style.safeZoneInsets);
  return {
    ...style,
    safeZoneVisible: visible,
    safeZonePlatformId: targetId,
    safeZoneInsets: nextInsets,
  };
}

/** Switch which platform's reference safe zone is shown without overwriting custom subtitle colors. */
export function selectSafeZonePlatform(
  style: SubtitleStyle,
  platformId: PlatformPresetId,
  visible = true,
): SubtitleStyle {
  return {
    ...style,
    safeZoneVisible: visible,
    safeZonePlatformId: platformId,
    safeZoneInsets: resolveSafeZoneInsets(platformId),
  };
}

/** Adjust safe-zone reference margins (0..0.45) for the active reference platform. */
export function updateSafeZoneInsets(
  style: SubtitleStyle,
  patch: Partial<SafeZoneInsets>,
): SubtitleStyle {
  const resolved = resolveEffectiveSafeZone(style);
  const insets = resolveSafeZoneInsets(resolved.platformId, {
    ...resolved.insets,
    ...patch,
  });
  return {
    ...style,
    safeZoneVisible: style.safeZoneVisible ?? true,
    safeZonePlatformId: resolved.platformId,
    safeZoneInsets: insets,
  };
}

/** Reset safe-zone reference margins back to the selected platform's defaults. */
export function resetSafeZoneInsets(style: SubtitleStyle, platformId?: PlatformPresetId): SubtitleStyle {
  const targetId = platformId
    ?? (isPlatformPresetId(style.safeZonePlatformId) ? style.safeZonePlatformId : undefined)
    ?? (isPlatformPresetId(style.platformPresetId) ? style.platformPresetId : undefined)
    ?? PLATFORM_PRESETS[0].id;
  return {
    ...style,
    safeZoneVisible: style.safeZoneVisible ?? true,
    safeZonePlatformId: targetId,
    safeZoneInsets: resolveSafeZoneInsets(targetId),
  };
}

/** Align subtitle bottom offset right above the bottom safe-zone margin (with small breathing gap). */
export function alignSubtitleAboveSafeZone(style: SubtitleStyle, marginGap = 0.015): SubtitleStyle {
  const resolved = resolveEffectiveSafeZone(style);
  const bottomOffsetRatio = Math.min(0.6, Math.max(0, Math.round((resolved.insets.bottom + marginGap) * 1000) / 1000));
  return {
    ...style,
    bottomOffsetRatio,
  };
}

export function resolveEffectiveSafeZone(style: SubtitleStyle): ResolvedSafeZoneState {
  const platformId = (isPlatformPresetId(style.safeZonePlatformId) ? style.safeZonePlatformId : undefined)
    ?? (isPlatformPresetId(style.platformPresetId) ? style.platformPresetId : undefined)
    ?? PLATFORM_PRESETS[0].id;
  const preset = getPlatformPreset(platformId) ?? PLATFORM_PRESETS[0];
  const insets = resolveSafeZoneInsets(platformId, style.safeZoneInsets);
  const visible = style.safeZoneVisible === true;
  return {
    visible,
    platformId,
    preset,
    insets,
    bottomOccluded: isBottomInSafeZoneOcclusion(style.bottomOffsetRatio, insets),
  };
}

export function matchActivePlatformPreset(style: SubtitleStyle): PlatformPresetId | null {
  if (isPlatformPresetId(style.platformPresetId)) return style.platformPresetId;
  return null;
}
