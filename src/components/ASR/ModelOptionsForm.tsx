// 模型选项表单：字段完全来自 Provider 返回的 ModelInfo.options
import type { OptionField, OptionValue } from '../../../shared/providers';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface ModelOptionsFormProps {
  fields: Record<string, OptionField>;
  values: Record<string, OptionValue>;
  onChange: (values: Record<string, OptionValue>) => void;
  disabled?: boolean;
}

/** Only values that differ from the declared default are kept, so the Host receives the user's choices alone. */
export function ModelOptionsForm({ fields, values, onChange, disabled }: ModelOptionsFormProps) {
  const set = (key: string, value: OptionValue | undefined) => {
    const next = { ...values };
    if (value === undefined || value === '' || value === fields[key].default) delete next[key]; else next[key] = value;
    onChange(next);
  };
  const entries = Object.entries(fields);
  if (!entries.length) return null;
  return (
    <div className="grid grid-cols-2 gap-3">
      {entries.map(([key, field]) => {
        const value = values[key] ?? field.default;
        return (
          <label key={key} className={`space-y-1 text-xs ${field.type === 'string' ? 'col-span-2' : ''}`} title={field.description}>
            <span className="font-medium text-muted-foreground">{field.label}</span>
            {field.type === 'select' ? (
              <Select value={String(value ?? '')} onValueChange={(next) => set(key, next)} disabled={disabled}>
                <SelectTrigger size="sm" className="h-8 w-full text-xs"><SelectValue placeholder="请选择" /></SelectTrigger>
                <SelectContent>{field.options?.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
              </Select>
            ) : field.type === 'boolean' ? (
              <div className="flex h-8 items-center"><Switch checked={value === true} onCheckedChange={(next) => set(key, next)} disabled={disabled} /></div>
            ) : (
              <Input className="h-8 text-xs" type={field.type === 'number' ? 'number' : 'text'} disabled={disabled}
                value={value === undefined ? '' : String(value)} min={field.min} max={field.max} step={field.step} placeholder={field.description}
                onChange={(event) => {
                  const text = event.target.value;
                  set(key, field.type === 'number' ? (text === '' || Number.isNaN(Number(text)) ? undefined : Number(text)) : text);
                }} />
            )}
          </label>
        );
      })}
    </div>
  );
}
