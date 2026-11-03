// ASR 语言选择器组件 - 专用于语音识别语言选择
// selectable：Whisper 多语种，可搜索选择；fixed / auto：由模型决定，不可修改
// 下拉菜单通过 Portal + fixed 定位渲染，避免被 overflow 容器裁切

import { useState, useCallback, useMemo, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { WHISPER_LANGUAGES } from '@/constants/languages';
import { getAsrLanguageDisplayName } from '@/utils/modelLanguageConfig';
import type { ModelLanguageMode } from '@/utils/modelLanguageConfig';
import { Globe, Search, Check, ChevronDown, Lock } from 'lucide-react';

const DROPDOWN_GAP = 4;
const DROPDOWN_MAX_HEIGHT = 256;
const LIST_MAX_HEIGHT = 192;

interface DropdownPosition {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

interface ASRLanguageSelectorProps {
  language: string;
  onLanguageChange: (language: string) => void;
  disabled?: boolean;
  /** 由当前模型决定：可选 / 固定 / 自动检测 */
  mode?: ModelLanguageMode;
  /** 可选语言代码（来自模型声明）；缺省为 Whisper 全部语言 */
  options?: string[];
  className?: string;
  placeholder?: string;
}

function computeDropdownPosition(trigger: HTMLElement): DropdownPosition {
  const rect = trigger.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom - DROPDOWN_GAP;
  const spaceAbove = rect.top - DROPDOWN_GAP;
  const openUpward = spaceBelow < 160 && spaceAbove > spaceBelow;
  const maxHeight = Math.min(
    DROPDOWN_MAX_HEIGHT,
    Math.max(120, openUpward ? spaceAbove : spaceBelow),
  );

  if (openUpward) {
    return {
      left: rect.left,
      width: rect.width,
      bottom: window.innerHeight - rect.top + DROPDOWN_GAP,
      maxHeight,
    };
  }

  return {
    left: rect.left,
    width: rect.width,
    top: rect.bottom + DROPDOWN_GAP,
    maxHeight,
  };
}

export function ASRLanguageSelector({
  language,
  onLanguageChange,
  disabled = false,
  mode = 'selectable',
  options,
  className,
  placeholder = '搜索语音识别语言...',
}: ASRLanguageSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [dropdownPosition, setDropdownPosition] = useState<DropdownPosition | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isLocked = mode === 'fixed' || mode === 'auto';
  const displayName = getAsrLanguageDisplayName(language);

  const filteredLanguages = useMemo(() => {
    const allLanguages = options
      ? options.map((code) => ({ code, name: getAsrLanguageDisplayName(code) }))
      : Object.entries(WHISPER_LANGUAGES).map(([code, name]) => ({ code, name }));

    if (!searchTerm) {
      const commonOrder = ['auto', 'en', 'zh', 'ja', 'ko', 'fr', 'es', 'de', 'ru', 'it', 'pt'];
      return allLanguages.sort((a, b) => {
        const aIndex = commonOrder.indexOf(a.code);
        const bIndex = commonOrder.indexOf(b.code);

        if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
        if (aIndex !== -1) return -1;
        if (bIndex !== -1) return 1;

        return a.name.localeCompare(b.name);
      });
    }

    return allLanguages
      .filter(
        (lang) =>
          lang.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          lang.code.toLowerCase().includes(searchTerm.toLowerCase()),
      )
      .sort((a, b) => {
        const aStartsWith = a.name.toLowerCase().startsWith(searchTerm.toLowerCase());
        const bStartsWith = b.name.toLowerCase().startsWith(searchTerm.toLowerCase());

        if (aStartsWith && !bStartsWith) return -1;
        if (!aStartsWith && bStartsWith) return 1;

        return a.name.localeCompare(b.name);
      });
  }, [searchTerm, options]);

  const updateDropdownPosition = useCallback(() => {
    if (!triggerRef.current) return;
    setDropdownPosition(computeDropdownPosition(triggerRef.current));
  }, []);

  const closeDropdown = useCallback(() => {
    setIsOpen(false);
    setSearchTerm('');
    setDropdownPosition(null);
  }, []);

  useEffect(() => {
    if (isLocked) {
      closeDropdown();
    }
  }, [isLocked, closeDropdown]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    updateDropdownPosition();
  }, [isOpen, updateDropdownPosition]);

  useEffect(() => {
    if (!isOpen) return;

    const handleReposition = () => updateDropdownPosition();
    window.addEventListener('resize', handleReposition);
    window.addEventListener('scroll', handleReposition, true);

    return () => {
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
    };
  }, [isOpen, updateDropdownPosition]);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        containerRef.current?.contains(target) ||
        dropdownRef.current?.contains(target)
      ) {
        return;
      }
      closeDropdown();
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeDropdown();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, closeDropdown]);

  const handleToggleOpen = useCallback(() => {
    if (!disabled && !isLocked) {
      if (isOpen) {
        closeDropdown();
        return;
      }
      setIsOpen(true);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [disabled, isLocked, isOpen, closeDropdown]);

  const handleLanguageSelect = useCallback(
    (selectedLanguage: string) => {
      onLanguageChange(selectedLanguage);
      closeDropdown();
    },
    [onLanguageChange, closeDropdown],
  );

  const handleSearchChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(event.target.value);
  }, []);

  const listMaxHeight = dropdownPosition
    ? Math.max(80, dropdownPosition.maxHeight - 44)
    : LIST_MAX_HEIGHT;

  const dropdownMenu =
    isOpen && dropdownPosition
      ? createPortal(
          <div
            ref={dropdownRef}
            style={{
              position: 'fixed',
              left: dropdownPosition.left,
              width: dropdownPosition.width,
              top: dropdownPosition.top,
              bottom: dropdownPosition.bottom,
              maxHeight: dropdownPosition.maxHeight,
              zIndex: 9999,
            }}
            className={cn(
              'bg-popover border border-border',
              'rounded-md shadow-lg overflow-hidden',
              'animate-in fade-in-0 zoom-in-95 duration-200',
            )}
          >
            <div className="p-1.5 border-b border-gray-200 dark:border-gray-700">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 transform -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <input
                  ref={inputRef}
                  type="text"
                  value={searchTerm}
                  onChange={handleSearchChange}
                  placeholder={placeholder}
                  className={cn(
                    'w-full pl-8 pr-2 py-1.5 text-xs',
                    'bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600',
                    'rounded focus:ring-2 focus:ring-blue-500 focus:border-blue-500',
                    'placeholder-gray-400 dark:placeholder-gray-500',
                  )}
                />
              </div>
            </div>

            <div className="overflow-y-auto" style={{ maxHeight: listMaxHeight }}>
              {filteredLanguages.length > 0 ? (
                filteredLanguages.map(({ code, name }) => (
                  <button
                    key={code}
                    type="button"
                    onClick={() => handleLanguageSelect(code)}
                    className={cn(
                      'w-full flex items-center justify-between px-3 py-1.5 text-left text-sm',
                      'hover:bg-gray-50 dark:hover:bg-gray-700',
                      'focus:bg-gray-50 dark:focus:bg-gray-700',
                      'transition-colors duration-150',
                      {
                        'bg-blue-50 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400':
                          code === language,
                      },
                    )}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="text-[11px] font-mono text-muted-foreground w-5 flex-shrink-0">
                        {code}
                      </span>
                      <span className="truncate text-xs">{name}</span>
                    </div>

                    {code === language && (
                      <Check className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 flex-shrink-0" />
                    )}
                  </button>
                ))
              ) : (
                <div className="px-3 py-3 text-center text-muted-foreground">
                  <Search className="w-6 h-6 mx-auto mb-1.5 text-muted-foreground/50" />
                  <p className="text-xs">未找到匹配的语言</p>
                </div>
              )}
            </div>
          </div>,
          document.body,
        )
      : null;

  if (isLocked) {
    return (
      <div className={cn('relative', className)} ref={containerRef}>
        <div
          className={cn(
            'w-full flex items-center justify-between gap-2 px-3 py-1.5 h-8',
            'border border-gray-300 dark:border-gray-600 rounded-md',
            'bg-muted/40 text-foreground text-sm',
            'opacity-80 cursor-not-allowed',
          )}
          title={mode === 'auto' ? '当前模型自动检测语言' : '当前模型仅支持此语言'}
        >
          <div className="flex items-center gap-2 min-w-0 overflow-hidden">
            <Globe className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            <span className="truncate text-left">{displayName}</span>
          </div>
          <Lock className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        </div>
      </div>
    );
  }

  return (
    <div className={cn('relative', className)} ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggleOpen}
        disabled={disabled}
        className={cn(
          'w-full flex items-center justify-between gap-2 px-3 py-1.5 h-8',
          'border border-gray-300 dark:border-gray-600 rounded-md',
          'bg-background text-foreground text-sm',
          'hover:bg-gray-50 dark:hover:bg-gray-700',
          'focus:ring-2 focus:ring-blue-500 focus:border-blue-500',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          'transition-colors duration-200',
          {
            'ring-2 ring-blue-500 border-blue-500': isOpen,
          },
        )}
      >
        <div className="flex items-center gap-2 min-w-0 overflow-hidden">
          <Globe className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
          <span className="truncate text-left">{displayName}</span>
        </div>

        <ChevronDown
          className={cn(
            'w-3.5 h-3.5 text-muted-foreground transition-transform duration-200 flex-shrink-0',
            { 'rotate-180': isOpen },
          )}
        />
      </button>

      {dropdownMenu}
    </div>
  );
}