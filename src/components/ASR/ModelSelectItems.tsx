// 模型下拉选项公共组件
// 按 family 分组渲染已下载的模型，供 ASRSettingsPanel 与 ASRPanel 共用。
// 仅渲染 <SelectGroup> + <SelectItem>，外层 <SelectContent> 由调用方提供。

import { SelectGroup, SelectItem, SelectLabel } from '@/components/ui/select';
import type { AvailableModel } from '@/types/model';
import { MODEL_FAMILY_LABELS } from '@/types/model';

interface ModelSelectItemsProps {
  /** 全部 manifest 模型（来自 Host models.list） */
  allModels: AvailableModel[];
  /** 已下载的模型 id 集合（来自 Host models.status） */
  downloadedModelIds: string[];
}

export function ModelSelectItems({ allModels, downloadedModelIds }: ModelSelectItemsProps) {
  const families = [...new Set(allModels.map(model => model.family))];

  return (
    <>
      {families.map((family) => {
        const models = allModels.filter(
          (m) => m.family === family && downloadedModelIds.includes(m.id),
        );
        if (models.length === 0) return null;

        return (
          <SelectGroup key={family}>
            <SelectLabel>{MODEL_FAMILY_LABELS[family] ?? family}</SelectLabel>
            {models.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                <span className="flex items-center gap-1.5">
                  <span>{m.name}</span>
                  {m.recommended && (
                    <span className="text-[10px] px-1 py-0.5 rounded bg-primary/10 text-primary font-medium">
                      推荐
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
