import { RotateCcw, Workflow } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { usePipelineStore } from '@/stores/pipelineStore';
import { findProviderCapability } from '../../../shared/providerCatalog';
import { useHostQuery } from '@/runtime/hooks';

export function ProviderPipelinePanel() {
  const pipeline = usePipelineStore((state) => state.activePipeline);
  const updateStep = usePipelineStore((state) => state.updateStep);
  const resetPipeline = usePipelineStore((state) => state.resetPipeline);
  const { data: providers = [] } = useHostQuery('providers.catalog');

  return (
    <section className="pt-4 mt-4 border-t border-aimu-border space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2"><Workflow className="h-4 w-4 text-aimu-coral" /><div><h3 className="text-sm font-medium text-aimu-text-primary">Provider 流程</h3><p className="text-xs text-aimu-text-muted">Provider 包提供能力，Pipeline 决定执行顺序。</p></div></div>
        <button type="button" className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1" onClick={resetPipeline}><RotateCcw className="h-3 w-3" />重置</button>
      </div>
      <div className="rounded-md border border-aimu-border divide-y divide-aimu-border">
        {pipeline.steps.map((step) => {
          const provider = providers.find((item) => item.id === step.providerId);
          const capability = findProviderCapability(providers, step.providerId, step.capabilityId);
          const capabilities = provider?.capabilities ?? [];
          const isRecognizer = step.id === 'recognizer';
          const allowedProviders = providers.filter((item) => item.capabilities.some((itemCapability) => !isRecognizer || itemCapability.kind === 'transcribe'));
          return <div key={step.id} className="p-3 space-y-2">
            <div className="flex items-center justify-between"><span className="text-xs font-medium">{isRecognizer ? '识别' : '音频预处理'}</span><div className="flex items-center gap-2">{!step.enabled && <span className="text-[10px] text-muted-foreground">未启用</span>}{capability?.status === 'planned' && <span className="text-[10px] text-amber-600">待接入</span>}</div></div>
            <div className="grid grid-cols-2 gap-2">
              <Select value={step.providerId} onValueChange={(providerId) => { const next = providers.find((item) => item.id === providerId); const first = next?.capabilities[0]; if (first) updateStep(step.id, { providerId, capabilityId: first.id }); }}>
                <SelectTrigger size="sm" className="text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{allowedProviders.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}{item.status === 'planned' ? '（待接入）' : ''}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={step.capabilityId} disabled={capabilities.length <= 1} onValueChange={(capabilityId) => updateStep(step.id, { capabilityId })}>
                <SelectTrigger size="sm" className="text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{capabilities.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            {!isRecognizer && <button type="button" className="text-[11px] text-primary hover:underline" onClick={() => updateStep(step.id, { enabled: !step.enabled })}>{step.enabled ? '停用此步骤' : '启用此步骤'}</button>}
            <p className="text-[11px] text-muted-foreground">{capability?.description ?? '请选择一个 Provider 能力。'}</p>
          </div>;
        })}
      </div>
      <p className="text-[11px] text-muted-foreground">流程配置会保存到本机。人声分离 Provider 已登记，执行器接入后即可启用。</p>
    </section>
  );
}
