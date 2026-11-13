// 字幕项组件 - Aimu 风格

import { useCallback, useMemo, useState, useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { SubtitleChunk } from '@/types/subtitle';
import { Trash2, RotateCcw, Plus, SplitSquareHorizontal } from 'lucide-react';
import { useUpdate, useDelete, useHistoryStore } from '@/stores/historyStore';
import { useAppStore } from '@/stores/appStore';
import { useTranslation } from '@/contexts/LocaleProvider';
import { findCopy } from '@/locales/findReplace';
import { correctionCopy } from '@/locales/correction';
import { translationCopy, fillTranslation } from '@/locales/translation';
import type { FindMatch } from '../../../shared/text/findReplace';
import { markTextDiff, type CorrectionSuggestion } from '../../../shared/text/corrections';
import { isTranslationOutdated } from '../../../shared/languageTracks';
import { evaluateTranslationConstraints } from '../../../shared/text/translation';
import { languageTrackCopy } from '@/locales/languageTracks';
import { keywordCopy } from '@/locales/keywords';
import { removeChunkKeyword, toggleChunkKeyword, tokenizeSubtitleForKeywords } from '../../../shared/text/keywords';
import { Tag } from 'lucide-react';

interface SubtitleItemProps {
  chunk: SubtitleChunk;
  index: number;
  findMatches?: FindMatch[];
  findActive?: boolean;
  isSelected: boolean;
  isCurrent: boolean;
  isActive: boolean;
  /** F-0013 pending AI correction for this row; never written to the formal chunk by itself. */
  textSuggestion?: CorrectionSuggestion;
  textPreview?: boolean;
  onSuggestionChange?: (id: string, text: string) => void;
  onToggleSelection: (chunkId: string) => void;
  onSeekTo: (time: number) => void;
  /** Uncommitted text and expansion survive virtual-row unmounting until blur or an offscreen flush. */
  draft?: SubtitleItemDraft;
  onDraftChange?: (id: string, patch: SubtitleItemDraft) => void;
  onDraftCommitted?: (id: string, field: 'mainText' | 'secondText') => void;
  className?: string;
}

export interface SubtitleItemDraft {
  mainText?: string;
  secondText?: string;
  isExpanded?: boolean;
}

// Aimu 风格时间格式化：HH:MM:SS.mmm
const COLLAPSED_TEXTAREA_HEIGHT = 72;

const formatAimuTime = (seconds: number) => {
  if (isNaN(seconds) || !isFinite(seconds)) return '00:00:00.000';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
};

export function SubtitleItem(props: SubtitleItemProps) {
  const {
    chunk,
    index,
    isCurrent,
    isActive,
    onSeekTo,
    className,
    isSelected,
    onToggleSelection,
    findMatches,
    findActive,
    textSuggestion,
    textPreview = false,
    onSuggestionChange,
    draft,
    onDraftChange,
    onDraftCommitted,
  } = props;
  
  const { t, language } = useTranslation();
  const trackCopy = languageTrackCopy(language);
  const findText = findCopy(language);
  const correctionText = correctionCopy(language);
  const translationText = translationCopy(language);
  const update = useUpdate();
  const deleteChunk = useDelete();
  const displayMode = useAppStore(state => state.display);
  const setChunkKeywords = useHistoryStore(state => state.setChunkKeywords);
  const setDisplayMode = useAppStore(state => state.setDisplay);
  const translationLimits = useAppStore(state => state.translationLimits);
  const activeTrack = useHistoryStore(state => state.languageTracks.find(track => track.id === state.activeLanguageTrackId));
  const keepTranslation = useHistoryStore(state => state.keepLanguageTranslation);
  const suggestionEditable = textPreview && !!textSuggestion?.selected;
  const displayText = suggestionEditable ? textSuggestion!.after : chunk.text;

  // 本地状态，用于即时编辑
  const [mainText, setMainText] = useState(() => draft?.mainText ?? displayText);
  const [secondText, setSecondText] = useState(() => draft?.secondText ?? (chunk.secondText || ''));
  const [isExpanded, setIsExpanded] = useState(() => draft?.isExpanded ?? false);
  const [hasOverflowText, setHasOverflowText] = useState(false);
  const [keywordPickerOpen, setKeywordPickerOpen] = useState(false);
  const [keywordSelection, setKeywordSelection] = useState<{ start: number; end: number } | null>(null);
  const [keywordAnchor, setKeywordAnchor] = useState<number | null>(null);
  const previousDisplayTextRef = useRef(displayText);
  const previousSecondTextRef = useRef(chunk.secondText || '');
  const mainTextareaRef = useRef<HTMLTextAreaElement>(null);
  const secondTextareaRef = useRef<HTMLTextAreaElement>(null);

  const resizeTextarea = useCallback((textarea: HTMLTextAreaElement | null) => {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${isExpanded ? textarea.scrollHeight : Math.min(textarea.scrollHeight, COLLAPSED_TEXTAREA_HEIGHT)}px`;
  }, [isExpanded]);

  // 当 store 中的数据真正改变时同步；首次挂载保留虚拟化 transient draft。
  useEffect(() => {
    if (previousDisplayTextRef.current === displayText) return;
    previousDisplayTextRef.current = displayText;
    setMainText(displayText);
  }, [displayText]);

  useEffect(() => {
    const next = chunk.secondText || '';
    if (previousSecondTextRef.current === next) return;
    previousSecondTextRef.current = next;
    setSecondText(next);
  }, [chunk.secondText]);

  useEffect(() => {
    resizeTextarea(mainTextareaRef.current);
  }, [mainText, resizeTextarea]);

  useEffect(() => {
    resizeTextarea(secondTextareaRef.current);
  }, [secondText, resizeTextarea]);

  useEffect(() => {
    const textareas = [mainTextareaRef.current, secondTextareaRef.current].filter(
      (textarea): textarea is HTMLTextAreaElement => textarea !== null
    );
    setHasOverflowText(textareas.some((textarea) => textarea.scrollHeight > COLLAPSED_TEXTAREA_HEIGHT));
  }, [mainText, secondText, displayMode]);

  const handleChunkClick = useCallback(() => {
    const [start, end] = chunk.timestamp;
    // 添加微小偏移，避免相邻字幕共享边界时间时点击不触发跳转
    const offset = Math.min(0.001, (end - start) * 0.01);
    onSeekTo(start + offset);
  }, [chunk.timestamp, onSeekTo]);

  const keywords = useMemo(() => chunk.keywords ?? [], [chunk.keywords]);
  const kwCopy = keywordCopy(language);
  const keywordTokens = keywordPickerOpen ? tokenizeSubtitleForKeywords(mainText) : [];

  const commitKeywords = useCallback((next: ReturnType<typeof toggleChunkKeyword>) => {
    setChunkKeywords(chunk.id, next);
  }, [chunk.id, setChunkKeywords]);

  const handleKeywordSelection = useCallback(() => {
    const textarea = mainTextareaRef.current;
    if (!textarea) { setKeywordSelection(null); return; }
    const { selectionStart, selectionEnd } = textarea;
    setKeywordSelection(selectionEnd > selectionStart ? { start: selectionStart, end: selectionEnd } : null);
  }, []);

  const toggleSelectionKeyword = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    if (!keywordSelection) return;
    commitKeywords(toggleChunkKeyword(keywords, mainText, keywordSelection.start, keywordSelection.end, 'manual'));
    setKeywordSelection(null);
  }, [commitKeywords, keywordSelection, keywords, mainText]);

  const toggleTokenKeyword = useCallback((tokenStart: number, tokenEnd: number, shift: boolean) => {
    const start = shift && keywordAnchor !== null ? Math.min(keywordAnchor, tokenStart) : tokenStart;
    const end = shift && keywordAnchor !== null ? Math.max(keywordAnchor, tokenEnd) : tokenEnd;
    commitKeywords(toggleChunkKeyword(keywords, mainText, start, end, 'manual'));
    setKeywordAnchor(tokenStart);
  }, [commitKeywords, keywordAnchor, keywords, mainText]);

  const removeKeyword = useCallback((start: number, end: number) => {
    commitKeywords(removeChunkKeyword(keywords, mainText, start, end));
  }, [commitKeywords, keywords, mainText]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    deleteChunk(chunk.id);
  }, [chunk.id, deleteChunk]);

  // 保存主字幕
  const handleMainBlur = useCallback(() => {
    if (textPreview) {
      if (suggestionEditable && mainText !== textSuggestion?.after) onSuggestionChange?.(chunk.id, mainText);
      onDraftCommitted?.(chunk.id, 'mainText');
      return;
    }
    if (mainText.trim() !== chunk.text) {
      update(chunk.id, { text: mainText.trim() });
    }
    onDraftCommitted?.(chunk.id, 'mainText');
  }, [chunk.id, mainText, chunk.text, update, textPreview, suggestionEditable, textSuggestion?.after, onSuggestionChange, onDraftCommitted]);

  // 保存副字幕
  const handleSecondBlur = useCallback(() => {
    const trimmed = secondText.trim();
    if (trimmed !== (chunk.secondText || '')) {
      update(chunk.id, { secondText: trimmed || undefined });
    }
    onDraftCommitted?.(chunk.id, 'secondText');
  }, [chunk.id, secondText, chunk.secondText, update, onDraftCommitted]);

  const translationEntry = activeTrack?.entries[chunk.id];
  const translationOutdated = !!translationEntry && isTranslationOutdated(translationEntry, chunk);
  const translationConstraints = secondText.trim()
    ? evaluateTranslationConstraints(secondText, chunk.timestamp, translationLimits)
    : null;

  const handleRetranslate = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    if (displayMode === 'Main') setDisplayMode('Second');
    window.setTimeout(() => secondTextareaRef.current?.focus(), 0);
  }, [displayMode, setDisplayMode]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      (e.target as HTMLTextAreaElement).blur(); // 触发 blur 保存
    }
  }, []);

  const duration = (chunk.timestamp[1] - chunk.timestamp[0]).toFixed(1);

  const correctionDiff = textSuggestion && textPreview ? markTextDiff(textSuggestion.before, textSuggestion.selected ? textSuggestion.after : textSuggestion.before) : null;

  const findSnippet = findMatches?.length ? (
    <div className="mb-1 rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1" data-testid="find-snippet">
      <span className="mr-1 text-[10px] font-medium text-aimu-text-muted">{findText.snippet}</span>
      <span className="text-xs text-aimu-text-secondary">
        {findMatches.reduce<ReactNode[]>((parts, match, index) => {
          const cursor = index === 0 ? 0 : findMatches[index - 1].end;
          parts.push(chunk.text.slice(cursor, match.start));
          parts.push(
            <mark
              key={`${match.start}-${match.end}`}
              aria-label={findText.matchLabel.replace('{text}', match.text)}
              className="rounded-sm bg-amber-300/70 px-0.5 text-aimu-text-primary"
            >
              {chunk.text.slice(match.start, match.end)}
            </mark>,
          );
          return parts;
        }, []).concat(chunk.text.slice(findMatches.at(-1)?.end ?? 0))}
      </span>
    </div>
  ) : null;

  // 空白占位段：紧凑渲染
  if (chunk.isBlankSpacer) {
    const isCut = chunk.deleted === true;
    return (
      <div
        className={cn(
          'group flex items-stretch border-b border-aimu-border-light hover:bg-aimu-hover transition-colors min-h-[48px]',
          isCut ? 'bg-aimu-red-bg/15' : 'bg-green-500/10',
          isCurrent && 'aimu-row-active',
          className
        )}
        onClick={handleChunkClick}
      >
        {/* 左侧：切换标记按钮 */}
        <div className="w-8 flex-shrink-0 flex items-center justify-center border-r border-transparent">
          <button
            onClick={handleDeleteClick}
            className={cn(
              'p-1 rounded transition-colors',
              isCut ? 'text-aimu-coral hover:text-aimu-red' : 'text-green-500 hover:text-green-600'
            )}
            title={isCut ? t('components.workstation.restoreSegment') : t('components.workstation.deleteSegment')}
          >
            {isCut ? <RotateCcw className="w-3.5 h-3.5" /> : <Trash2 className="w-3.5 h-3.5" />}
          </button>
        </div>

        {/* 时间码 */}
        <div className="w-[120px] flex-shrink-0 flex flex-col justify-center px-3 py-2 gap-1 border-r border-transparent select-none">
          <div className="font-mono text-[11px] text-aimu-text-muted">{formatAimuTime(chunk.timestamp[0])}</div>
          <div className="font-mono text-[11px] text-aimu-text-muted">{formatAimuTime(chunk.timestamp[1])}</div>
        </div>

        {/* 空白段标签 */}
        <div className="flex-1 flex items-center px-4">
          <span className={cn('text-xs font-medium', isCut ? 'text-aimu-coral' : 'text-green-500')}>
            {t('components.workstation.blankSegment')} · {duration}s
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      data-chunk-id={chunk.id}
      aria-current={findActive ? 'true' : undefined}
      className={cn(
        'group flex items-stretch border-b border-aimu-border-light hover:bg-aimu-hover transition-colors bg-transparent min-h-[104px] cursor-pointer',
        isCurrent && 'aimu-row-active',
        !isActive && 'opacity-60',
        isSelected && 'bg-aimu-hover/50',
        findActive && 'ring-1 ring-inset ring-amber-400/70 bg-amber-400/5',
        className
      )}
      onClick={handleChunkClick}
    >
      {/* 左侧：操作图标列 (~32px) */}
      <div className="w-8 flex-shrink-0 flex flex-col items-center py-3 gap-3 border-r border-transparent">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={(e) => {
            e.stopPropagation();
            onToggleSelection(chunk.id);
          }}
          onClick={(e) => e.stopPropagation()}
          className="w-3.5 h-3.5 rounded border-aimu-border text-aimu-purple focus:ring-aimu-purple/20 cursor-pointer"
        />
        <button
          onClick={handleDeleteClick}
          className={cn(
            'p-1 rounded transition-colors',
            isActive ? 'text-aimu-text-muted hover:text-aimu-coral' : 'text-aimu-text-muted hover:text-green-500'
          )}
          title={isActive ? t('components.workstation.deleteSegment') : t('components.workstation.restoreSegment')}
        >
          {isActive ? <Trash2 className="w-3.5 h-3.5" /> : <RotateCcw className="w-3.5 h-3.5" />}
        </button>
        {isActive && (
          <>
            <button className="p-1 rounded transition-colors text-aimu-text-muted hover:text-aimu-text-primary" title={t('components.workstation.splitMerge')}>
              <SplitSquareHorizontal className="w-3.5 h-3.5" />
            </button>
            <button className="p-1 rounded transition-colors text-aimu-text-muted hover:text-aimu-text-primary" title={t('components.subtitleEditor.addSubtitle')}>
              <Plus className="w-3.5 h-3.5" />
            </button>
            <button
              data-testid="keyword-picker-toggle"
              onClick={(e) => { e.stopPropagation(); setKeywordPickerOpen(open => !open); }}
              className={cn('p-1 rounded transition-colors', keywordPickerOpen ? 'text-aimu-purple' : 'text-aimu-text-muted hover:text-aimu-text-primary')}
              title={kwCopy.keywordsButton}
            >
              <Tag className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>

      {/* 中间：时间码列 (~120px) */}
      <div className="w-[120px] flex-shrink-0 flex flex-col justify-center px-3 py-2 gap-1 border-r border-transparent select-none">
        <div className="font-mono text-[11px] text-aimu-text-muted">{formatAimuTime(chunk.timestamp[0])}</div>
        <div className="font-mono text-[11px] text-aimu-text-muted">{formatAimuTime(chunk.timestamp[1])}</div>
        <div className="flex items-center justify-between mt-1">
          <div className="font-bold text-xs text-aimu-text-primary">{duration}</div>
          <div className="text-xs text-aimu-text-muted">{index}</div>
        </div>
      </div>

      {/* 右侧：双语文本编辑列 (flex-1) */}
      <div className="flex-1 flex flex-col justify-center py-2 px-4">
        {chunk.speaker && <span className="text-[11px] text-aimu-text-muted">{chunk.speaker}</span>}
        {findSnippet}
        {textSuggestion && (
          <div data-testid="correction-row-badge" className="mb-1 rounded border border-aimu-purple/30 bg-aimu-purple/5 px-2 py-1 text-[10px]">
            <span className="font-medium text-aimu-purple">
              {!textSuggestion.selected ? correctionText.keepOriginalBadge
                : textSuggestion.adjusted ? correctionText.adjusted
                  : textPreview ? correctionText.aiSuggestion : correctionText.pendingBadge}
            </span>
            {correctionDiff && (correctionDiff.before || correctionDiff.after) && (
              <span className="ml-1 text-aimu-text-muted">
                {correctionDiff.before && <del className="rounded bg-red-500/10 px-0.5 text-red-700 dark:text-red-300">{correctionDiff.before}</del>}
                {correctionDiff.after && <ins className="rounded bg-emerald-500/10 px-0.5 text-emerald-700 no-underline dark:text-emerald-300">{correctionDiff.after}</ins>}
              </span>
            )}
          </div>
        )}
        {/* 主字幕输入框 */}
        {(displayMode === 'Bilingual' || displayMode === 'Main') && (
          <div className={cn('flex-1 flex', isExpanded ? 'items-start' : 'items-center')}>
            <textarea
              ref={mainTextareaRef}
              value={mainText}
              data-testid="subtitle-main-text"
              readOnly={textPreview && !suggestionEditable}
              onChange={(e) => {
                const value = e.target.value;
                setMainText(value);
                onDraftChange?.(chunk.id, { mainText: value });
                if (suggestionEditable) onSuggestionChange?.(chunk.id, value);
              }}
              onBlur={handleMainBlur}
              onKeyDown={handleKeyDown}
              onSelect={handleKeywordSelection}
              onClick={(e) => e.stopPropagation()}
              className={cn(
                'w-full bg-transparent border-none focus:outline-none focus:ring-0 text-sm leading-6 p-1 text-aimu-text-primary resize-none overflow-hidden whitespace-pre-wrap break-words cursor-text',
                textPreview && textSuggestion?.selected && 'bg-aimu-purple/5',
                !isActive && 'line-through text-aimu-text-muted'
              )}
              placeholder={t('components.workstation.mainSubtitlePlaceholder')}
              rows={1}
              style={{ minHeight: '24px' }}
            />
          </div>
        )}

        {isActive && (keywordSelection || keywords.length > 0 || keywordPickerOpen) && (
          <div className="mt-1 flex flex-col gap-1" data-testid="keyword-row-tools">
            {keywordSelection && (
              <button
                type="button"
                data-testid="keyword-mark-selection"
                onClick={toggleSelectionKeyword}
                className="self-start rounded border border-aimu-purple/40 bg-aimu-purple/10 px-2 py-0.5 text-[10px] font-medium text-aimu-purple"
              >
                {keywords.some(kw => kw.start === keywordSelection.start && kw.end === keywordSelection.end)
                  ? kwCopy.unmarkKeyword : kwCopy.markKeyword}
              </button>
            )}
            {keywordPickerOpen && (
              <div data-testid="keyword-token-picker" className="flex flex-wrap items-center gap-1 rounded border border-aimu-border-light bg-aimu-input/40 px-2 py-1">
                <span className="text-[10px] text-aimu-text-muted">{kwCopy.pickerHint}</span>
                {keywordTokens.filter(token => token.selectable).map(token => {
                  const active = keywords.some(kw => kw.start === token.start && kw.end === token.end);
                  return (
                    <button
                      key={`${token.start}-${token.end}`}
                      type="button"
                      data-testid="keyword-token"
                      data-active={active ? 'true' : undefined}
                      onClick={(event) => { event.stopPropagation(); toggleTokenKeyword(token.start, token.end, event.shiftKey); }}
                      className={cn('rounded px-1 text-[11px] transition-colors',
                        active ? 'bg-aimu-purple text-white' : 'bg-aimu-panel text-aimu-text-secondary hover:text-aimu-text-primary')}
                    >
                      {token.text}
                    </button>
                  );
                })}
              </div>
            )}
            {keywords.length > 0 && (
              <div data-testid="keyword-chips" className="flex flex-wrap items-center gap-1">
                {keywords.map(kw => (
                  <span key={`${kw.start}-${kw.end}`} className="inline-flex items-center gap-1 rounded bg-amber-300/20 px-1.5 py-0.5 text-[10px] text-amber-800 dark:text-amber-200">
                    {kw.text}
                    <button
                      type="button"
                      data-testid="keyword-remove"
                      aria-label={kwCopy.removeKeyword.replace('{text}', kw.text)}
                      onClick={(event) => { event.stopPropagation(); removeKeyword(kw.start, kw.end); }}
                      className="text-aimu-text-muted hover:text-aimu-coral"
                    >×</button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 分割线 */}
        {displayMode === 'Bilingual' && (
          <div className="h-px w-full bg-aimu-border-light my-1 opacity-50"></div>
        )}

        {/* 副字幕输入框 */}
        {(displayMode === 'Bilingual' || displayMode === 'Second') && (
          <div className="flex-1 flex flex-col items-stretch">
            {translationOutdated && (
              <div className="mb-1 flex items-center gap-2 self-start rounded border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[10px] whitespace-nowrap text-amber-700 dark:text-amber-300"
                data-testid="translation-outdated">
                <span>{trackCopy.outdated}</span>
                <button type="button" className="underline underline-offset-2" onClick={event => {
                  event.stopPropagation(); keepTranslation(chunk.id);
                }}>{trackCopy.keep}</button>
                <button type="button" className="underline underline-offset-2" onClick={handleRetranslate}>{trackCopy.retranslate}</button>
              </div>
            )}
            {translationConstraints?.tooLong && (
              <div className="mb-1 self-start rounded border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[10px] whitespace-nowrap text-amber-700 dark:text-amber-300"
                data-testid="subtitle-translation-too-long">
                {translationText.tooLong} · {fillTranslation(translationText.tooLongDetail, {
                  line: translationConstraints.maxLineChars,
                  maxLine: translationLimits.maxCharsPerLine,
                  cps: translationConstraints.cps.toFixed(1),
                  maxCps: translationLimits.maxCps,
                })}
              </div>
            )}
            <textarea
              ref={secondTextareaRef}
              value={secondText}
              data-testid="subtitle-secondary-text"
              onChange={(e) => {
                const value = e.target.value;
                setSecondText(value);
                onDraftChange?.(chunk.id, { secondText: value });
              }}
              onBlur={handleSecondBlur}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              className={cn(
                'w-full bg-transparent border-none focus:outline-none focus:ring-0 text-sm leading-6 p-1 text-aimu-text-secondary resize-none overflow-hidden whitespace-pre-wrap break-words cursor-text',
                !isActive && 'line-through text-aimu-text-muted'
              )}
              placeholder={t('components.workstation.secondSubtitlePlaceholder')}
              rows={1}
              style={{ minHeight: '24px' }}
            />
          </div>
        )}
        {hasOverflowText && (
          <button
            type="button"
            className="mt-1 self-start text-xs font-medium text-aimu-purple hover:text-aimu-purple/80"
            onClick={(e) => {
              e.stopPropagation();
              setIsExpanded((expanded) => {
                const next = !expanded;
                onDraftChange?.(chunk.id, { isExpanded: next });
                return next;
              });
            }}
          >
            {isExpanded ? '收起' : '展开'}
          </button>
        )}
      </div>
    </div>
  );
}
