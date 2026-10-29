import { useEffect, useRef, useState } from 'react';
import { useClientRuntime } from '@/runtime/context';
import { processAudioForASR } from '@/utils/audioUtils';
import { encodePcmWav } from '../../shared/asr/apiProtocol';
import type { AgentMessage, AsrInput } from '../../shared/protocol';
import { Button } from '@/components/ui/button';

export function AgentPanel() {
  const { connection, stores } = useClientRuntime();
  const [prompt, setPrompt] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const controller = useRef<AbortController | null>(null);
  const disposers = useRef<Array<() => void>>([]);
  useEffect(() => () => { disposers.current.forEach(dispose => dispose()); controller.current?.abort(); }, []);
  const run = async () => {
    const app = stores.app.getState();
    const model = app.aiModels.find(model => model.id === app.selectedAIModelId);
    if (!model) { setStatus('请先在 API 设置中选择一个文本模型。'); return; }
    setBusy(true); setAnswer(''); setStatus('正在处理…');
    const current = new AbortController(); controller.current = current;
    let uploaded: string | undefined;
    try {
      let asr: AsrInput | undefined;
      if (app.videoFile) {
        let buffer: ArrayBuffer;
        if (app.videoFile.path && !app.videoFile.file.size) {
          const { convertFileSrc } = await import('@tauri-apps/api/core');
          buffer = await fetch(convertFileSrc(app.videoFile.path)).then(response => response.arrayBuffer());
        } else buffer = await app.videoFile.file.arrayBuffer();
        const samples = await processAudioForASR(buffer); current.signal.throwIfAborted();
        const assetId = await connection.upload(encodePcmWav(samples)); uploaded = assetId;
        const apis = stores.asrApi.getState();
        asr = { providerId: app.asrEngineType, modelId: app.asrEngineType === 'transformers' ? app.webModelId : app.asrModelId,
          assetId, language: app.language, api: app.asrEngineType === 'api' ? apis.configs.find(item => item.id === apis.selectedId) : undefined };
      }
      current.signal.throwIfAborted();
      // Subscribe before starting: events may arrive before the RPC response carries the job id.
      const started: { jobId?: string } = {};
      const early: Array<{ jobId: string; text: string }> = [];
      const show = (text: string) => { if (text) setAnswer(text); };
      const offMessage = connection.on('agent/message', ({ jobId: id, message }) => {
        if (message.role !== 'ai') return;
        const text = typeof message.content === 'string' ? message.content : '';
        if (started.jobId === undefined) early.push({ jobId: id, text }); else if (id === started.jobId) show(text);
        if (message.toolCalls?.length && (started.jobId === undefined || id === started.jobId)) setStatus(`调用工具：${message.toolCalls.map(call => call.name).join('、')}`);
      });
      const offTool = connection.on('agent/tool-result', ({ jobId: id, name, status }) => {
        if (id === started.jobId) setStatus(status === 'error' ? `工具 ${name} 失败` : `工具 ${name} 已返回`);
      });
      disposers.current = [offMessage, offTool];
      const job = await connection.call('agent.start', { prompt, asr,
        model: { baseUrl: model.baseUrl, model: model.model, apiKey: model.apiKey } });
      started.jobId = job.id; early.filter(item => item.jobId === job.id).forEach(item => show(item.text));
      const result = await connection.waitJob<{ messages: AgentMessage[] }>(job.id,
        job => { if (job.progress?.data) setStatus(job.progress.data); }, current.signal);
      const last = result.messages.filter(message => message.role === 'ai').at(-1);
      setAnswer(typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '')); setStatus('完成');
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally {
      if (uploaded) void connection.call('assets.delete', { assetId: uploaded }).catch(() => undefined);
      disposers.current.forEach(dispose => dispose()); disposers.current = []; setBusy(false); controller.current = null;
    }
  };
  return <section className="space-y-3 border-b pb-4 mb-4">
    <h3 className="text-sm font-medium">字幕助手</h3>
    <p className="text-xs text-muted-foreground">描述识别或剪空白的需求。助手可以分析当前素材并提出建议。</p>
    <textarea aria-label="助手需求" className="w-full min-h-24 rounded-md border bg-background p-2 text-sm" value={prompt} disabled={busy} onChange={event => setPrompt(event.target.value)} />
    <div className="flex gap-2"><Button size="sm" disabled={busy || !prompt.trim()} onClick={() => void run()}>开始</Button>
      {busy && <Button size="sm" variant="outline" onClick={() => controller.current?.abort(new Error('已取消'))}>取消</Button>}</div>
    {status && <p role="status" className="text-xs">{status}</p>}
    {answer && <div className="text-sm whitespace-pre-wrap break-words">{answer}</div>}
  </section>;
}
