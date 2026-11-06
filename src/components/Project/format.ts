// 展示用的格式化：时长与相对时间

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3_600], ['minute', 60],
];

export function formatRelativeTime(iso: string, language: string, justNow: string, now = Date.now()): string {
  const diff = (new Date(iso).getTime() - now) / 1000;
  if (Math.abs(diff) < 60) return justNow;
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size) return rtf.format(Math.round(diff / size), unit);
  }
  return justNow;
}

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`));
}

/** 「立即保存」快捷键的显示文字（AC-20）：macOS 为 ⌘S，其他平台为 Ctrl+S。 */
export const isMacPlatform = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const saveShortcutLabel = isMacPlatform ? '⌘S' : 'Ctrl+S';

const DAY_MS = 86_400_000;

/** 回收站里的项目还剩几天彻底删除（F-0003 AC-23）；不足 1 天为 0（显示「今天彻底删除」）。 */
export function daysUntilPurge(purgeAfter: string, now = Date.now()) {
  const left = new Date(purgeAfter).getTime() - now;
  return left < DAY_MS ? 0 : Math.ceil(left / DAY_MS);
}
