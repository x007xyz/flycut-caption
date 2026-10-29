// 字幕项组件 - Aimu 风格

import { useCallback, useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import type { SubtitleChunk } from '@/types/subtitle';
import { Trash2, RotateCcw, Plus, SplitSquareHorizontal } from 'lucide-react';
import { useUpdate, useDelete } from '@/stores/historyStore';
import { useAppStore } from '@/stores/appStore';
import { useTranslation } from '@/contexts/LocaleProvider';

interface SubtitleItemProps {
  chunk: SubtitleChunk;
  index: number;
  isSelected: boolean;
  isCurrent: boolean;
  isActive: boolean;
  onToggleSelection: (chunkId: string) => void;
  onSeekTo: (time: number) => void;
  className?: string;
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
    onToggleSelection
  } = props;
  
  const { t } = useTranslation();
  const update = useUpdate();
  const deleteChunk = useDelete();
  const displayMode = useAppStore(state => state.display);

  // 本地状态，用于即时编辑
  const [mainText, setMainText] = useState(chunk.text);
  const [secondText, setSecondText] = useState(chunk.secondText || '');
  const [isExpanded, setIsExpanded] = useState(false);
  const [hasOverflowText, setHasOverflowText] = useState(false);
  const mainTextareaRef = useRef<HTMLTextAreaElement>(null);
  const secondTextareaRef = useRef<HTMLTextAreaElement>(null);

  const resizeTextarea = useCallback((textarea: HTMLTextAreaElement | null) => {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${isExpanded ? textarea.scrollHeight : Math.min(textarea.scrollHeight, COLLAPSED_TEXTAREA_HEIGHT)}px`;
  }, [isExpanded]);

  // 当 store 中的数据改变时，同步本地状态
  useEffect(() => {
    setMainText(chunk.text);
  }, [chunk.text]);

  useEffect(() => {
    setSecondText(chunk.secondText || '');
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

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    deleteChunk(chunk.id);
  }, [chunk.id, deleteChunk]);

  // 保存主字幕
  const handleMainBlur = useCallback(() => {
    if (mainText.trim() !== chunk.text) {
      update(chunk.id, { text: mainText.trim() });
    }
  }, [chunk.id, mainText, chunk.text, update]);

  // 保存副字幕
  const handleSecondBlur = useCallback(() => {
    const trimmed = secondText.trim();
    if (trimmed !== (chunk.secondText || '')) {
      update(chunk.id, { secondText: trimmed || undefined });
    }
  }, [chunk.id, secondText, chunk.secondText, update]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      (e.target as HTMLTextAreaElement).blur(); // 触发 blur 保存
    }
  }, []);

  const duration = (chunk.timestamp[1] - chunk.timestamp[0]).toFixed(1);

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
      className={cn(
        'group flex items-stretch border-b border-aimu-border-light hover:bg-aimu-hover transition-colors bg-transparent min-h-[104px] cursor-pointer',
        isCurrent && 'aimu-row-active',
        !isActive && 'opacity-60',
        isSelected && 'bg-aimu-hover/50',
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
        {/* 主字幕输入框 */}
        {(displayMode === 'Bilingual' || displayMode === 'Main') && (
          <div className={cn('flex-1 flex', isExpanded ? 'items-start' : 'items-center')}>
            <textarea
              ref={mainTextareaRef}
              value={mainText}
              onChange={(e) => setMainText(e.target.value)}
              onBlur={handleMainBlur}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              className={cn(
                'w-full bg-transparent border-none focus:outline-none focus:ring-0 text-sm leading-6 p-1 text-aimu-text-primary resize-none overflow-hidden whitespace-pre-wrap break-words cursor-text',
                !isActive && 'line-through text-aimu-text-muted'
              )}
              placeholder={t('components.workstation.mainSubtitlePlaceholder')}
              rows={1}
              style={{ minHeight: '24px' }}
            />
          </div>
        )}

        {/* 分割线 */}
        {displayMode === 'Bilingual' && (
          <div className="h-px w-full bg-aimu-border-light my-1 opacity-50"></div>
        )}

        {/* 副字幕输入框 */}
        {(displayMode === 'Bilingual' || displayMode === 'Second') && (
          <div className={cn('flex-1 flex', isExpanded ? 'items-start' : 'items-center')}>
            <textarea
              ref={secondTextareaRef}
              value={secondText}
              onChange={(e) => setSecondText(e.target.value)}
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
              setIsExpanded((expanded) => !expanded);
            }}
          >
            {isExpanded ? '收起' : '展开'}
          </button>
        )}
      </div>
    </div>
  );
}
