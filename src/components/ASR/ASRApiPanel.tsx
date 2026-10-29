import { useState } from 'react';
import { useASRApiStore } from '@/stores/asrApiStore';
import { useAppStore } from '@/stores/appStore';
import type { ASRApiConfig } from '@/types/asrApi';
import { newCorrelationId, validateASRApiConfig } from '../../../shared/asr/apiProtocol';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ASRSourceSelector } from './ASRSourceSelector';

const blankConfig = (): ASRApiConfig => ({ id: newCorrelationId(), name: '', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1', timestamps: 'word', timeoutSeconds: 120, apiKey: '' });

export function ASRApiPanel() {
  const configs = useASRApiStore(s => s.configs);
  const save = useASRApiStore(s => s.save);
  const remove = useASRApiStore(s => s.remove);
  const busy = useAppStore(s => s.isLoading);
  const setEngine = useAppStore(s => s.setASREngineType);
  const [form, setForm] = useState<ASRApiConfig>(blankConfig);
  const [message, setMessage] = useState('');
  const patch = (values: Partial<ASRApiConfig>) => setForm(prev => ({ ...prev, ...values }));
  return <section className="space-y-3 border-b pb-4 mb-4">
    <ASRSourceSelector />
    <details className="border rounded-md p-3 space-y-3">
      <summary className="text-sm font-medium cursor-pointer">ASR API 配置</summary>
      <p className="text-xs text-muted-foreground">支持 OpenAI 兼容的文件转写接口 /audio/transcriptions。识别会上传音频至所填服务，可能产生费用。浏览器版需服务允许 CORS，桌面版不受该限制。</p>
      <fieldset disabled={busy} className="space-y-3 disabled:opacity-60">
        {configs.map(config => <div className="flex items-center justify-between gap-2 text-xs" key={config.id}>
          <span className="truncate">{config.name} · {config.model}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => { setForm({ ...config, apiKey: config.apiKey ?? '' }); setMessage(''); }}>编辑</Button>
            <Button size="sm" variant="ghost" onClick={() => { remove(config.id); if (form.id === config.id) setForm(blankConfig()); }}>移除</Button>
          </div>
        </div>)}
        <label className="block text-xs space-y-1"><span>配置名称</span><Input value={form.name} placeholder="我的转写服务" onChange={e => patch({ name: e.target.value })} /></label>
        <label className="block text-xs space-y-1"><span>Base URL 或完整转写接口地址</span><Input value={form.baseUrl} placeholder="https://example.com/v1" onChange={e => patch({ baseUrl: e.target.value })} /></label>
        <label className="block text-xs space-y-1"><span>模型名称</span><Input value={form.model} onChange={e => patch({ model: e.target.value })} /></label>
        <label className="block text-xs space-y-1"><span>API Key（本机免认证服务可留空）</span><Input type="password" autoComplete="off" value={form.apiKey ?? ''} onChange={e => patch({ apiKey: e.target.value })} /></label>
        <p className="text-xs text-muted-foreground">密钥仅保存在当前应用会话内，重启后需要重新填写；其他配置会保存。</p>
        <label className="block text-xs space-y-1"><span>请求的时间戳格式</span>
          <select className="w-full border rounded p-2 bg-background" value={form.timestamps} onChange={e => patch({ timestamps: e.target.value as ASRApiConfig['timestamps'] })}>
            <option value="word">句子与词级（verbose_json）</option><option value="segment">分段（verbose_json）</option><option value="none">仅文字（json，粗粒度剪辑）</option>
          </select>
        </label>
        <p className="text-xs text-muted-foreground">OpenAI whisper-1 支持词级时间戳；gpt-4o-transcribe 等模型请选择仅文字。其他服务以其协议为准。不会把仅文字输出伪造成词级时间戳。</p>
        <label className="block text-xs space-y-1"><span>每段请求超时（秒，10～600）</span><Input type="number" min={10} max={600} value={form.timeoutSeconds} onChange={e => patch({ timeoutSeconds: Number(e.target.value) })} /></label>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => {
            try { validateASRApiConfig(form); save({ ...form, name: form.name.trim(), model: form.model.trim(), baseUrl: form.baseUrl.trim(), apiKey: form.apiKey?.trim() }); setEngine('api'); setMessage('配置已保存并选用。开始识别时才会发送音频请求。'); }
            catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
          }}>保存并使用</Button>
          <Button size="sm" variant="outline" onClick={() => { setForm(blankConfig()); setMessage(''); }}>新增配置</Button>
        </div>
      </fieldset>
      {message && <p role="status" className="text-xs break-all">{message}</p>}
    </details>
  </section>;
}
