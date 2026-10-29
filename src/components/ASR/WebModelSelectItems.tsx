// Web (Transformers) 模型下拉选项组件
// 按 family 分组渲染已下载的 Web 模型，供 ASRSettingsPanel / 其他位置共用。

import { SelectGroup, SelectItem, SelectLabel } from '@/components/ui/select';
import { WEB_ASR_MODELS, WEB_MODEL_FAMILY_LABELS } from '../../../shared/asr/webModels';

interface WebModelSelectItemsProps {
  /** 已下载的 Web 模型 id 列表 */
  downloadedModelIds: string[];
}

export function WebModelSelectItems({ downloadedModelIds }: WebModelSelectItemsProps) {
  const families = Object.keys(WEB_MODEL_FAMILY_LABELS);

  return (
    <>
      {families.map((family) => {
        const models = WEB_ASR_MODELS.filter(
          (m) => m.family === family && downloadedModelIds.includes(m.id),
        );
        if (models.length === 0) return null;

        const visible = models;
        if (visible.length === 0) return null;

        return (
          <SelectGroup key={family}>
            <SelectLabel>{WEB_MODEL_FAMILY_LABELS[family]}</SelectLabel>
            {visible.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                <span className="flex items-center gap-1.5">
                  <span>{m.name}</span>
                  {m.recommended && (
                    <span className="text-[10px] px-1 py-0.5 rounded bg-primary/10 text-primary font-medium">
                      推荐
                    </span>
                  )}
                  {m.family === 'moonshine' && (
                    <span className="text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground">
                      EN
                    </span>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        );
      })}
    </>
  );
}