import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle, Info, Loader2, ShieldAlert } from 'lucide-react';
import { useClientRuntime } from '@/runtime/context';
import { useLocale } from '@/contexts/LocaleProvider';
import type { RpcOutput } from '../../../shared/protocol';
import { jianyingCopy } from '@/locales/jianying';

type Capabilities = RpcOutput<'jianying.capabilities'>;
type LoadState = { phase: 'loading' } | { phase: 'error' } | { phase: 'ready'; value: Capabilities };

export function JianyingDraftInfoPanel({ active }: { active: boolean }) {
  const { connection } = useClientRuntime();
  const { language } = useLocale();
  const copy = jianyingCopy(language);
  const [state, setState] = useState<LoadState>({ phase: 'loading' });

  const load = useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      const value = await connection.call('jianying.capabilities');
      setState({ phase: 'ready', value });
    } catch {
      setState({ phase: 'error' });
    }
  }, [connection]);

  useEffect(() => { if (active) void load(); }, [active, load]);

  if (state.phase === 'loading') {
    return <div data-testid="jianying-support-loading" role="status" className="flex items-center gap-2 rounded-lg bg-muted p-3 text-sm">
      <Loader2 className="h-4 w-4 animate-spin" />{copy.checking}
    </div>;
  }
  if (state.phase === 'error') {
    return <div data-testid="jianying-support-error" role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm">
      <div className="flex items-center gap-2 font-medium text-destructive"><AlertCircle className="h-4 w-4" />{copy.failed}</div>
      <button type="button" className="mt-2 rounded border px-3 py-1 text-xs hover:bg-muted" onClick={() => void load()}>{copy.retry}</button>
    </div>;
  }

  const windows = state.value.targets.find(target => target.id === 'jianying-windows-5.9.0');
  const mac = state.value.targets.find(target => target.id === 'jianying-macos-11.7.0');
  const other = state.value.targets.find(target => target.id === 'jianying-windows-other-builds');
  const capcut = state.value.targets.find(target => target.id === 'capcut');
  const web = state.value.targets.find(target => target.id === 'jianying-web');
  const row = (id: string, name: string, detail: string, unavailable: boolean) => (
    <div key={id} data-testid={`jianying-target-${id}`} className="flex gap-3 rounded-lg border p-3 text-sm">
      {unavailable ? <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /> : <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />}
      <div><div className="font-medium">{name}</div><div className="mt-1 text-muted-foreground">{detail}</div></div>
    </div>
  );

  return <div data-testid="jianying-support-matrix" className="space-y-4">
    <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm">
      <div className="flex items-center gap-2 font-semibold text-destructive"><AlertCircle className="h-4 w-4" />{copy.realImport}</div>
      <p className="mt-1 text-muted-foreground">{copy.realImportDetail}</p>
    </div>
    <div className="space-y-2">
      {windows && row(windows.id, copy.candidate, copy.candidateDetail, false)}
      {other && row(other.id, copy.unavailable, copy.otherBuildDetail, true)}
      {mac && row(mac.id, copy.unavailable, copy.macDetail, true)}
      {capcut && row(capcut.id, copy.unavailable, copy.capcutDetail, true)}
      {web && row(web.id, copy.unavailable, copy.webDetail, true)}
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <section className="rounded-lg bg-muted/50 p-3 text-sm"><h4 className="flex items-center gap-2 font-medium"><CheckCircle className="h-4 w-4" />{copy.scope}</h4>
        <ul className="mt-2 list-disc space-y-1 pl-4 text-muted-foreground">{copy.scopeItems.map(item => <li key={item}>{item}</li>)}</ul></section>
      <section className="rounded-lg bg-amber-500/10 p-3 text-sm"><h4 className="font-medium">{copy.limitations}</h4>
        <ul className="mt-2 list-disc space-y-1 pl-4 text-muted-foreground">{copy.limitationsItems.map(item => <li key={item}>{item}</li>)}</ul></section>
    </div>
    <p className="text-xs text-muted-foreground">{copy.research.replace('{date}', state.value.checkedAt)}</p>
    <button data-testid="jianying-export-disabled" type="button" disabled className="w-full rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground opacity-50">
      {copy.exportDisabled}
    </button>
  </div>;
}
