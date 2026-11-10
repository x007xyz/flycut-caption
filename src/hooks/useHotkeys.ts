// 快捷键管理Hook
import { useEffect } from 'react';
import hotkeys from 'hotkeys-js';
import { useUndo, useRedo, useCanUndo, useCanRedo } from '@/stores/historyStore';
import { useShowInfo } from '@/stores/messageStore';

interface UseHotkeysOptions {
  enableHistoryHotkeys?: boolean;
  enableGlobalHotkeys?: boolean;
}

export function useHotkeys(options: UseHotkeysOptions = {}) {
  const {
    enableHistoryHotkeys = true,
    enableGlobalHotkeys = false,
  } = options;

  // 历史记录操作
  const undo = useUndo();
  const redo = useRedo();
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();
  
  // 消息通知
  const showInfo = useShowInfo();

  useEffect(() => {
    if (!enableHistoryHotkeys) return;

    // 设置快捷键作用域
    const scope = enableGlobalHotkeys ? 'all' : 'history';
    hotkeys.setScope(scope);

    // 撤销操作 - Ctrl+Z (Windows) / Cmd+Z (Mac)
    hotkeys('ctrl+z,cmd+z', { scope }, (event) => {
      if (isTextEditing(event)) return;
      event.preventDefault();
      if (canUndo) {
        undo();
        showInfo('操作撤销', '已撤销上一步操作');
      } else {
        showInfo('无法撤销', '没有可撤销的操作');
      }
    });

    // 重做操作 - Ctrl+Y (Windows) / Cmd+Shift+Z (Mac) / Ctrl+Shift+Z (Windows)
    hotkeys('ctrl+y,cmd+shift+z,ctrl+shift+z', { scope }, (event) => {
      if (isTextEditing(event)) return;
      event.preventDefault();
      if (canRedo) {
        redo();
        showInfo('操作重做', '已重做上一步撤销的操作');
      } else {
        showInfo('无法重做', '没有可重做的操作');
      }
    });

    return () => {
      // 清理快捷键
      hotkeys.unbind('ctrl+z,cmd+z', scope);
      hotkeys.unbind('ctrl+y,cmd+shift+z,ctrl+shift+z', scope);
    };
  }, [enableHistoryHotkeys, enableGlobalHotkeys, undo, redo, canUndo, canRedo, showInfo]);

  // 返回快捷键信息供UI显示
  return {
    shortcuts: {
      undo: {
        keys: navigator.platform.includes('Mac') ? ['⌘', 'Z'] : ['Ctrl', 'Z'],
        description: '撤销',
        enabled: canUndo,
      },
      redo: {
        keys: navigator.platform.includes('Mac') ? ['⌘', '⇧', 'Z'] : ['Ctrl', 'Y'],
        description: '重做', 
        enabled: canRedo,
      },
    },
  };
}

/** Native text undo and IME composition must win while an editor has focus. */
function isTextEditing(event: KeyboardEvent) {
  if (event.isComposing) return true;
  const target = event.target as HTMLElement | null;
  return !!target?.closest('input, textarea, [contenteditable="true"]');
}

// 格式化快捷键显示
export function formatShortcut(keys: string[]): string {
  return keys.join(' + ');
}

// 检测操作系统并返回对应的快捷键
export function getOSShortcuts() {
  const isMac = navigator.platform.includes('Mac');
  
  return {
    undo: isMac ? ['⌘', 'Z'] : ['Ctrl', 'Z'],
    redo: isMac ? ['⌘', '⇧', 'Z'] : ['Ctrl', 'Y'],
    modifier: isMac ? '⌘' : 'Ctrl',
  };
}
