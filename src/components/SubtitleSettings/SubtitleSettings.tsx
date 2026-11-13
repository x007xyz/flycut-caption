import { useCallback, useState } from 'react';
import {
  Ban,
  ChevronDown,
  ChevronUp,
  Sparkles,
} from 'lucide-react';
import { keywordCopy } from '@/locales/keywords';
import { platformPresetCopy } from '@/locales/platformPresets';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useTranslation } from '@/contexts/LocaleProvider';
import { useChunks, useHasWordTimestamps, useWordChunks } from '@/stores/historyStore';
import { SUBTITLE_FONTS } from '@/config/subtitleFonts';
import {
  type AspectPreset,
  type SubtitleStyle,
  type SubtitleStylePair,
  type SubtitleDisplayMode,
  fontSizeAtReference,
  bottomOffsetAtReference,
  fontSizeRatioFromReference,
  bottomOffsetRatioFromReference,
  applyAspectPreset,
  STYLE_PRESETS,
  applyStylePreset,
  hasReliableWordHighlight,
  matchActiveStylePreset,
} from '@/subtitle';
import { PlatformPresetsSection } from './PlatformPresetsSection';

interface SubtitleSettingsProps {
  stylePair: SubtitleStylePair;
  onStylePairChange: (pair: SubtitleStylePair) => void;
  /** 显示模式（控制播放器预览），由 appStore 管理 */
  displayMode?: SubtitleDisplayMode;
  onDisplayModeChange?: (mode: SubtitleDisplayMode) => void;
  className?: string;
}


function SettingRow({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-2 min-h-7', className)}>
      <span className="w-14 shrink-0 text-xs text-aimu-text-secondary">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
    </div>
  );
}

function NumberInput({
  value,
  min,
  max,
  step = 1,
  onChange,
  className,
  testId,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  className?: string;
  testId?: string;
  ariaLabel?: string;
}) {
  const clamp = (next: number) => Math.min(max, Math.max(min, next));

  return (
    <Input
      type="number"
      data-testid={testId}
      aria-label={ariaLabel}
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        const parsed = Number(e.target.value);
        if (!Number.isNaN(parsed)) onChange(clamp(parsed));
      }}
      className={cn(
        'h-6 w-12 shrink-0 border-aimu-border bg-aimu-input px-1.5 text-center text-[11px] text-aimu-text-primary [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
        className,
      )}
    />
  );
}

function SliderWithInput({
  label,
  value,
  min,
  max,
  onChange,
  testId,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  testId?: string;
}) {
  return (
    <SettingRow label={label}>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={1}
        onValueChange={([next]) => onChange(next)}
        className="aimu-slider flex-1 [&_[data-slot=slider-track]]:h-1"
      />
      <NumberInput value={value} min={min} max={max} onChange={onChange} testId={testId} ariaLabel={label} />
    </SettingRow>
  );
}

function normalizeHexColor(value: string): string {
  const normalized = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(normalized)) return normalized.toUpperCase();
  return '#FFFFFF';
}

function rgbaPreview(color: string, opacity: number): string {
  const hex = normalizeHexColor(color).replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

function ColorControl({
  label,
  value,
  opacity,
  onChange,
  onOpacityChange,
  allowNone = false,
  testId,
  noneLabel = '无',
  opacityLabel = '透明',
  noneTestId,
  opacityTestId,
}: {
  label: string;
  value: string;
  opacity: number;
  onChange: (value: string) => void;
  onOpacityChange: (value: number) => void;
  allowNone?: boolean;
  testId?: string;
  noneLabel?: string;
  opacityLabel?: string;
  noneTestId?: string;
  opacityTestId?: string;
}) {
  const disabled = allowNone && opacity === 0;

  return (
    <div className="space-y-1.5 rounded border border-aimu-border bg-aimu-input p-2">
      <div className="flex items-center gap-2">
        <span className="w-10 shrink-0 text-[10px] text-aimu-text-muted">{label}</span>
        <label className="relative h-7 w-9 shrink-0 cursor-pointer overflow-hidden rounded border border-aimu-border subtitle-alpha-bg">
          <input
            type="color"
            aria-label={label}
            value={normalizeHexColor(value)}
            onChange={(e) => {
              onChange(e.target.value.toUpperCase());
              if (disabled) onOpacityChange(1);
            }}
            className="absolute -left-2 -top-2 h-12 w-12 cursor-pointer opacity-0"
          />
          <span className="block h-full w-full" style={{ backgroundColor: rgbaPreview(value, opacity) }} />
        </label>
        <Input
          data-testid={testId}
          value={normalizeHexColor(value)}
          onChange={(e) => onChange(normalizeHexColor(e.target.value))}
          className="h-7 flex-1 border-aimu-border bg-aimu-panel px-2 text-[11px] text-aimu-text-primary"
        />
        {allowNone && (
          <button
            type="button"
            data-testid={noneTestId}
            data-active={disabled}
            onClick={() => onOpacityChange(disabled ? 1 : 0)}
            className="subtitle-none-color h-7 w-9 shrink-0 rounded border border-aimu-border text-[10px] text-aimu-text-muted transition-colors"
          >
            {noneLabel}
          </button>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="w-10 shrink-0 text-[10px] text-aimu-text-muted">{opacityLabel}</span>
        <Slider
          value={[Math.round(opacity * 100)]}
          min={0}
          max={100}
          step={1}
          onValueChange={([next]) => onOpacityChange(next / 100)}
          className="aimu-slider flex-1 [&_[data-slot=slider-track]]:h-1"
        />
        <NumberInput
          testId={opacityTestId}
          ariaLabel={opacityLabel}
          value={Math.round(opacity * 100)}
          min={0}
          max={100}
          onChange={(next) => onOpacityChange(next / 100)}
        />
      </div>
    </div>
  );
}

const toggleGroupClass = 'subtitle-settings-toggle h-7 border-aimu-border';

function PresetButton({
  active,
  onClick,
  preview,
  label,
}: {
  active: boolean;
  onClick: () => void;
  preview: (typeof STYLE_PRESETS)[number]['preview'];
  label: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-active={active}
      onClick={onClick}
      className="subtitle-preset-btn flex h-9 w-full items-center justify-center rounded-md border transition-colors"
      style={{
        backgroundColor: preview.backgroundColor ?? undefined,
      }}
    >
      {preview.showNone ? (
        <Ban className="h-4 w-4 text-aimu-text-muted" />
      ) : (
        <span
          className="text-lg font-bold leading-none"
          style={{
            color: preview.textColor,
            WebkitTextStroke: preview.borderColor ? `1px ${preview.borderColor}` : undefined,
            // 无描边纯色字时用轻微阴影保证在浅/深底上可辨
            textShadow: !preview.borderColor && !preview.backgroundColor
              ? '0 0 2px rgba(0,0,0,0.55)'
              : undefined,
          }}
        >
          T
        </span>
      )}
    </button>
  );
}

export function SubtitleSettings({
  stylePair,
  onStylePairChange,
  displayMode = 'Bilingual',
  onDisplayModeChange,
  className,
}: SubtitleSettingsProps) {
  const { t, language } = useTranslation();
  const kwCopy = keywordCopy(language);
  const ppCopy = platformPresetCopy(language);
  const chunks = useChunks();
  const wordChunks = useWordChunks();
  const hasWordTimestamps = useHasWordTimestamps();
  const [positionOpen, setPositionOpen] = useState(true);
  const [activeStyleTab, setActiveStyleTab] = useState<'primary' | 'secondary'>('primary');

  // 当前编辑的样式：primary 决定位置/比例，secondary 共享 primary 的位置
  const activeStyle = activeStyleTab === 'primary' ? stylePair.primary : stylePair.secondary;
  const isPrimaryTab = activeStyleTab === 'primary';

  const updateActiveStyle = useCallback(
    (updates: Partial<SubtitleStyle>) => {
      onStylePairChange({
        ...stylePair,
        [activeStyleTab]: { ...activeStyle, ...updates },
      });
    },
    [stylePair, activeStyle, activeStyleTab, onStylePairChange],
  );

  const fontSizeDisplay = fontSizeAtReference(activeStyle);
  const bottomOffsetDisplay = bottomOffsetAtReference(stylePair.primary);
  const activePreset = matchActiveStylePreset(activeStyle);
  const wordHighlightEnabled = activeStyle.wordHighlightMode === 'word';
  const reliableWords = hasReliableWordHighlight(chunks, wordChunks, hasWordTimestamps);
  const hasVisibleSubtitle = chunks.some(chunk => !chunk.deleted && !chunk.isBlankSpacer && chunk.text.trim());
  const showSentenceFallback = hasVisibleSubtitle && wordHighlightEnabled && (!isPrimaryTab || !reliableWords);

  const displayModes: Array<{ id: SubtitleDisplayMode; label: string }> = [
    { id: 'Bilingual', label: t('components.workstation.displayBilingual') },
    { id: 'Main', label: t('components.workstation.displayMain') },
    { id: 'Second', label: t('components.workstation.displaySecond') },
  ];

  return (
    <div className={cn('space-y-2.5 text-xs text-aimu-text-primary', className)}>
      {/* 显示模式选择器：控制播放器预览（双字幕/主字幕/副字幕） */}
      {onDisplayModeChange && (
        <div className="flex items-center gap-1.5">
          <span className="w-14 shrink-0 text-xs text-aimu-text-secondary">
            {t('components.workstation.display')}
          </span>
          <div className="flex flex-1 overflow-hidden rounded border border-aimu-border">
            {displayModes.map((mode) => (
              <button
                key={mode.id}
                type="button"
                onClick={() => onDisplayModeChange(mode.id)}
                className={cn(
                  'flex-1 px-2 py-1 text-[11px] transition-colors',
                  displayMode === mode.id
                    ? 'bg-aimu-purple text-white'
                    : 'bg-aimu-input text-aimu-text-secondary hover:bg-aimu-hover',
                )}
              >
                {mode.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="h-px bg-aimu-border" />

      {/* 主/副字幕 Tab：始终显示两个 Tab，分别编辑各自样式 */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setActiveStyleTab('primary')}
          className={cn(
            'flex-1 rounded px-2 py-1 text-[11px] font-medium transition-colors',
            isPrimaryTab
              ? 'bg-aimu-purple text-white'
              : 'bg-aimu-input text-aimu-text-secondary hover:bg-aimu-hover',
          )}
        >
          {t('components.workstation.primarySubtitleTab')}
        </button>
        <button
          type="button"
          onClick={() => setActiveStyleTab('secondary')}
          className={cn(
            'flex-1 rounded px-2 py-1 text-[11px] font-medium transition-colors',
            !isPrimaryTab
              ? 'bg-aimu-purple text-white'
              : 'bg-aimu-input text-aimu-text-secondary hover:bg-aimu-hover',
          )}
        >
          {t('components.workstation.secondarySubtitleTab')}
        </button>
      </div>

      <div className="space-y-1.5">
        <div className="text-xs font-medium text-aimu-text-secondary">
          {t('components.workstation.presetStyles')}
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(2.25rem,1fr))] gap-1.5 sm:grid-cols-[repeat(auto-fit,minmax(3.25rem,1fr))]">
          {STYLE_PRESETS.map((preset) => (
            <PresetButton
              key={preset.id}
              active={activePreset === preset.id}
              label={preset.id === 'word-highlight' ? t('components.workstation.wordHighlightPreset') : preset.label}
              preview={preset.preview}
              onClick={() => updateActiveStyle(applyStylePreset(activeStyle, preset.id))}
            />
          ))}
        </div>
        {showSentenceFallback && (
          <div
            role="status"
            data-testid="word-highlight-fallback"
            className="rounded border border-aimu-border bg-aimu-input px-2 py-1.5 text-[11px] text-aimu-text-secondary"
          >
            {t('components.workstation.sentenceHighlightFallback')}
          </div>
        )}
      </div>

      <PlatformPresetsSection
        primaryStyle={stylePair.primary}
        onPrimaryStyleChange={(nextPrimary) => onStylePairChange({ ...stylePair, primary: nextPrimary })}
        isPrimaryTab={isPrimaryTab}
      />

      <div className="h-px bg-aimu-border" />

      <SettingRow label={t('components.workstation.font')}>
        <Select value={activeStyle.fontId} onValueChange={(value) => updateActiveStyle({ fontId: value })}>
          <SelectTrigger data-testid="subtitle-font-select" className="h-7 flex-1 border-aimu-border bg-aimu-input px-2 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SUBTITLE_FONTS.map((font) => (
              <SelectItem key={font.id} value={font.id} className="text-xs">
                <span style={{ fontFamily: font.family }}>{font.label}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>

      <SliderWithInput
        label={t('components.workstation.fontSize')}
        value={fontSizeDisplay}
        min={18}
        max={72}
        onChange={(value) => updateActiveStyle({ fontSizeRatio: fontSizeRatioFromReference(value) })}
      />

      <SettingRow label={t('components.workstation.textStyle')}>
        <ToggleGroup
          type="multiple"
          variant="outline"
          size="sm"
          value={[
            ...(activeStyle.fontWeight === 'bold' ? ['bold'] : []),
            ...(activeStyle.textDecoration === 'underline' ? ['underline'] : []),
            ...(activeStyle.fontStyle === 'italic' ? ['italic'] : []),
          ]}
          onValueChange={(values) => {
            updateActiveStyle({
              fontWeight: values.includes('bold') ? 'bold' : 'normal',
              textDecoration: values.includes('underline') ? 'underline' : 'none',
              fontStyle: values.includes('italic') ? 'italic' : 'normal',
            });
          }}
          className={toggleGroupClass}
        >
          <ToggleGroupItem value="bold" className="h-7 w-8 px-0 text-xs font-bold">
            B
          </ToggleGroupItem>
          <ToggleGroupItem value="underline" className="h-7 w-8 px-0 text-xs underline underline-offset-2">
            U
          </ToggleGroupItem>
          <ToggleGroupItem value="italic" className="h-7 w-8 px-0 text-xs italic">
            I
          </ToggleGroupItem>
        </ToggleGroup>
      </SettingRow>

      <SettingRow label={t('components.workstation.color')} className="items-start">
        <div className="grid flex-1 gap-2">
          <ColorControl
            label={t('components.workstation.fontColor')}
            value={activeStyle.color}
            opacity={activeStyle.colorOpacity}
            testId="subtitle-base-color"
            onChange={(value) => updateActiveStyle({ color: value })}
            onOpacityChange={(value) => updateActiveStyle({ colorOpacity: value })}
          />
          {wordHighlightEnabled && (
            <div className="flex items-center gap-2 rounded border border-aimu-border bg-aimu-input p-2">
              <span className="w-10 shrink-0 text-[10px] text-aimu-text-muted">
                {t('components.workstation.highlightColor')}
              </span>
              <label className="relative h-7 w-9 shrink-0 cursor-pointer overflow-hidden rounded border border-aimu-border">
                <input
                  type="color"
                  aria-label={t('components.workstation.highlightColor')}
                  data-testid="word-highlight-color"
                  value={normalizeHexColor(activeStyle.wordHighlightColor ?? '#FFE100')}
                  onChange={(event) => updateActiveStyle({ wordHighlightColor: event.target.value.toUpperCase() })}
                  className="absolute -left-2 -top-2 h-12 w-12 cursor-pointer opacity-0"
                />
                <span className="block h-full w-full" style={{ backgroundColor: normalizeHexColor(activeStyle.wordHighlightColor ?? '#FFE100') }} />
              </label>
              <Input
                aria-label={`${t('components.workstation.highlightColor')} HEX`}
                value={normalizeHexColor(activeStyle.wordHighlightColor ?? '#FFE100')}
                onChange={(event) => updateActiveStyle({ wordHighlightColor: normalizeHexColor(event.target.value) })}
                className="h-7 flex-1 border-aimu-border bg-aimu-panel px-2 text-[11px] text-aimu-text-primary"
              />
            </div>
          )}
          <ColorControl
            label={t('components.workstation.outline')}
            value={activeStyle.borderColor}
            opacity={activeStyle.borderOpacity}
            onChange={(value) => updateActiveStyle({ borderColor: value, borderWidth: activeStyle.borderWidth || 2 })}
            onOpacityChange={(value) => updateActiveStyle({ borderOpacity: value, borderWidth: value === 0 ? 0 : activeStyle.borderWidth || 2 })}
            allowNone
          />
          <ColorControl
            label={t('components.workstation.background')}
            value={activeStyle.backgroundColor}
            opacity={activeStyle.backgroundOpacity}
            onChange={(value) => updateActiveStyle({ backgroundColor: value })}
            onOpacityChange={(value) => updateActiveStyle({ backgroundOpacity: value })}
            allowNone
          />
        </div>
      </SettingRow>

      <SettingRow label="">
        <div className="flex flex-1 gap-2">
          <div className="flex flex-1 items-center gap-1.5">
            <span className="w-10 shrink-0 text-[10px] text-aimu-text-muted">
              {t('components.workstation.letterSpacing')}
            </span>
            <NumberInput
              value={activeStyle.letterSpacing}
              min={0}
              max={10}
              step={0.5}
              onChange={(value) => updateActiveStyle({ letterSpacing: value })}
              className="flex-1"
            />
          </div>
          <div className="flex flex-1 items-center gap-1.5">
            <span className="w-10 shrink-0 text-[10px] text-aimu-text-muted">
              {t('components.workstation.lineSpacing')}
            </span>
            <NumberInput
              value={Math.round(activeStyle.lineHeight * 10)}
              min={8}
              max={30}
              onChange={(value) => updateActiveStyle({ lineHeight: value / 10 })}
              className="flex-1"
            />
          </div>
        </div>
      </SettingRow>

      <div className="h-px bg-aimu-border" />

      <div className="space-y-2" data-testid="keyword-style-section">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-aimu-text-secondary">{kwCopy.sectionTitle}</span>
          {isPrimaryTab && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="keyword-recommend-from-settings"
              className="h-6 px-2 text-[11px]"
              onClick={() => window.dispatchEvent(new CustomEvent('flycut:open-keyword-recommend'))}
            >
              <Sparkles className="mr-1 h-3 w-3 text-aimu-purple" />
              {kwCopy.recommendFromSettings}
            </Button>
          )}
        </div>
        {!isPrimaryTab ? (
          <div className="text-[10px] text-aimu-text-muted">{kwCopy.primaryOnlyHint}</div>
        ) : (
          <div className="space-y-2">
            <div className="space-y-1.5 rounded border border-aimu-border bg-aimu-input p-2">
              <div className="flex items-center gap-2">
                <label className="flex w-14 shrink-0 cursor-pointer items-center gap-1 text-[10px] text-aimu-text-muted">
                  <input
                    type="checkbox"
                    data-testid="keyword-color-enabled"
                    checked={activeStyle.keywordColorEnabled !== false}
                    onChange={(event) => updateActiveStyle({ keywordColorEnabled: event.target.checked })}
                    className="h-3 w-3 rounded border-aimu-border text-aimu-purple"
                  />
                  {kwCopy.colorEnabled}
                </label>
                <label className={cn('relative h-7 w-9 shrink-0 cursor-pointer overflow-hidden rounded border border-aimu-border', activeStyle.keywordColorEnabled === false && 'opacity-40 pointer-events-none')}>
                  <input
                    type="color"
                    aria-label={kwCopy.colorLabel}
                    data-testid="keyword-color-picker"
                    value={normalizeHexColor(activeStyle.keywordColor ?? '#FFE100')}
                    onChange={(event) => updateActiveStyle({ keywordColor: event.target.value.toUpperCase(), keywordColorEnabled: true })}
                    className="absolute -left-2 -top-2 h-12 w-12 cursor-pointer opacity-0"
                  />
                  <span className="block h-full w-full" style={{ backgroundColor: normalizeHexColor(activeStyle.keywordColor ?? '#FFE100') }} />
                </label>
                <Input
                  data-testid="keyword-color"
                  aria-label={kwCopy.colorLabel}
                  disabled={activeStyle.keywordColorEnabled === false}
                  value={normalizeHexColor(activeStyle.keywordColor ?? '#FFE100')}
                  onChange={(event) => updateActiveStyle({ keywordColor: normalizeHexColor(event.target.value), keywordColorEnabled: true })}
                  className="h-7 flex-1 border-aimu-border bg-aimu-panel px-2 text-[11px] text-aimu-text-primary"
                />
              </div>
            </div>
            <SettingRow label={kwCopy.scaleLabel}>
              <Slider
                aria-label={kwCopy.scaleLabel}
                value={[Math.round((activeStyle.keywordScale ?? 1.2) * 100)]}
                min={100}
                max={180}
                step={5}
                onValueChange={([next]) => updateActiveStyle({ keywordScale: Number((next / 100).toFixed(2)) })}
                className="aimu-slider flex-1 [&_[data-slot=slider-track]]:h-1"
              />
              <NumberInput
                testId="keyword-scale-input"
                ariaLabel={kwCopy.scaleLabel}
                value={Math.round((activeStyle.keywordScale ?? 1.2) * 100)}
                min={100}
                max={180}
                step={5}
                onChange={(next) => updateActiveStyle({ keywordScale: Number((next / 100).toFixed(2)) })}
                className="w-14"
              />
              <span className="text-[10px] text-aimu-text-muted">%</span>
            </SettingRow>
            <ColorControl
              label={kwCopy.backgroundLabel}
              value={activeStyle.keywordBackgroundColor ?? '#FF5B57'}
              opacity={activeStyle.keywordBackgroundOpacity ?? 0}
              testId="keyword-bg-color"
              noneLabel={kwCopy.none}
              opacityLabel={kwCopy.opacity}
              noneTestId="keyword-bg-none"
              opacityTestId="keyword-bg-opacity"
              onChange={(value) => updateActiveStyle({ keywordBackgroundColor: value })}
              onOpacityChange={(value) => updateActiveStyle({ keywordBackgroundOpacity: value })}
              allowNone
            />
          </div>
        )}
      </div>

      <div className="h-px bg-aimu-border" />

      <Collapsible open={positionOpen} onOpenChange={setPositionOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-between py-1 text-xs text-aimu-text-secondary hover:text-aimu-text-primary">
          <span>{t('components.workstation.positionSize')}</span>
          {positionOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 pt-1">
          <div className={cn(!isPrimaryTab && 'pointer-events-none opacity-50')}>
            <SettingRow label={t('components.workstation.aspectPreset')} className="mb-2">
              <div className="flex flex-1 overflow-hidden rounded border border-aimu-border" role="group" aria-label={t('components.workstation.aspectPreset')}>
                {([
                  ['landscape', ppCopy.aspectLandscape],
                  ['portrait_9_16', ppCopy.aspectPortrait],
                  ['square_1_1', ppCopy.aspectSquare],
                ] as Array<[AspectPreset, string]>).map(([preset, label]) => (
                  <button
                    key={preset}
                    type="button"
                    data-testid={`aspect-preset-${preset}`}
                    aria-pressed={stylePair.primary.aspectPreset === preset}
                    disabled={!isPrimaryTab}
                    onClick={() => {
                      if (isPrimaryTab) {
                        onStylePairChange({ ...stylePair, primary: applyAspectPreset(stylePair.primary, preset) });
                      }
                    }}
                    className={cn(
                      'flex-1 px-1.5 py-1 text-[10px] transition-colors',
                      stylePair.primary.aspectPreset === preset
                        ? 'bg-aimu-purple text-white'
                        : 'bg-aimu-input text-aimu-text-secondary hover:bg-aimu-hover',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </SettingRow>
            <SliderWithInput
              label={t('components.workstation.bottomOffset')}
              value={bottomOffsetDisplay}
              min={0}
              max={540}
              testId="subtitle-bottom-offset-input"
              onChange={(value) => {
                // 底边距位置共享 primary：secondary Tab 下禁用，仅 primary 可调
                if (isPrimaryTab) {
                  updateActiveStyle({ bottomOffsetRatio: bottomOffsetRatioFromReference(value) });
                }
              }}
            />
          </div>
          {!isPrimaryTab && (
            <div className="text-[10px] text-aimu-text-muted">
              {t('components.workstation.bottomOffsetLocked')}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
