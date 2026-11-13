import { useTranslation } from '@/contexts/LocaleProvider';
import { fillPlatformText, platformPresetCopy } from '@/locales/platformPresets';
import { cn } from '@/lib/utils';
import { resolveEffectiveSafeZone, type SubtitleStyle } from '@/subtitle';

interface SafeZoneOverlayProps {
  style: SubtitleStyle;
  width: number;
  height: number;
}

export function SafeZoneOverlay({ style, width, height }: SafeZoneOverlayProps) {
  const { language } = useTranslation();
  const copy = platformPresetCopy(language);
  const effective = resolveEffectiveSafeZone(style);

  if (!effective.visible || width <= 0 || height <= 0) return null;

  const { preset, insets, bottomOccluded } = effective;
  const isZh = language.startsWith('zh');
  const platformName = isZh ? preset.nameZh : preset.nameEn;
  const statusText = preset.verification.verified ? copy.verifiedBadge : copy.unverifiedBadge;
  const metaLabel = fillPlatformText(copy.referenceMeta, {
    platform: platformName,
    aspect: preset.aspectLabel,
    date: preset.verification.referenceDate,
    status: statusText,
  });

  const topPct = `${(insets.top * 100).toFixed(2)}%`;
  const bottomPct = `${(insets.bottom * 100).toFixed(2)}%`;
  const leftPct = `${(insets.left * 100).toFixed(2)}%`;
  const rightPct = `${(insets.right * 100).toFixed(2)}%`;

  return (
    <div
      data-testid="safe-zone-overlay"
      data-platform={effective.platformId}
      data-verified={String(preset.verification.verified)}
      data-occluded={String(bottomOccluded)}
      aria-hidden="true"
      className="pointer-events-none absolute left-[50%] top-[50%] -translate-x-1/2 -translate-y-1/2 overflow-hidden select-none"
      style={{ width, height }}
    >
      {/* Top / Bottom / Left / Right reference UI occlusion bands (never exported) */}
      <div
        className="absolute inset-x-0 top-0 bg-amber-500/15"
        style={{ height: topPct }}
      />
      <div
        className={cn(
          'absolute inset-x-0 bottom-0 transition-colors',
          bottomOccluded ? 'bg-rose-500/25' : 'bg-amber-500/15',
        )}
        style={{ height: bottomPct }}
      />
      <div
        className="absolute left-0 bg-amber-500/12"
        style={{ top: topPct, bottom: bottomPct, width: leftPct }}
      />
      <div
        className="absolute right-0 bg-amber-500/12"
        style={{ top: topPct, bottom: bottomPct, width: rightPct }}
      />

      {/* Dashed inner safe-zone rectangle */}
      <div
        className={cn(
          'absolute border border-dashed border-sky-400/90',
          bottomOccluded && 'border-b-2 border-b-rose-400',
        )}
        style={{ top: topPct, bottom: bottomPct, left: leftPct, right: rightPct }}
      />

      {/* Reference metadata badge */}
      <div
        data-testid="safe-zone-badge"
        className="absolute left-2 top-2 max-w-[calc(100%-1rem)] truncate rounded bg-black/75 px-2 py-0.5 text-[10px] font-medium text-white shadow-sm"
      >
        {metaLabel}
      </div>

      {bottomOccluded && (
        <div
          data-testid="safe-zone-occlusion-alert"
          className="absolute left-1/2 -translate-x-1/2 -translate-y-1 rounded bg-rose-600/90 px-2 py-0.5 text-[10px] font-medium text-white shadow-sm whitespace-nowrap"
          style={{ bottom: bottomPct }}
        >
          {copy.overlayOcclusionBadge}
        </div>
      )}
    </div>
  );
}
