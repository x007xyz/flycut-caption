import { useTranslation } from '@/contexts/LocaleProvider';
import { fill } from './format';

/** 读取 components.project 下的文案，支持 {name} 这类占位符 */
export function useProjectText() {
  const { t, language } = useTranslation();
  const tp = (key: string, values?: Record<string, string | number>) => {
    const text = t(`components.project.${key}`);
    return values ? fill(text, values) : text;
  };
  return { t, tp, language };
}
