import { useTranslation } from '@/contexts/LocaleProvider';
import { fill } from '@/components/Project/format';

/** 读取 components.connection 下的文案，支持 {name} 这类占位符。 */
export function useConnectionText() {
  const { t, language } = useTranslation();
  const tc = (key: string, values?: Record<string, string | number>) => {
    const text = t(`components.connection.${key}`);
    return values ? fill(text, values) : text;
  };
  return { t, tc, language };
}
