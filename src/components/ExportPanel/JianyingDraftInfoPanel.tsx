import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle, FolderOpen, Info, Loader2, ShieldAlert, X } from 'lucide-react';
import { useClientRuntime } from '@/runtime/context';
import { useLocale } from '@/contexts/LocaleProvider';
import { useRuntimeStoreApi } from '@/stores/runtimeStore';
import type { RpcOutput } from '../../../shared/protocol';
import type { JianyingDegradation, JianyingJobResult, JianyingPreflightResult, JianyingSnapshot, JianyingSource } from '../../../shared/jianying/draft';
import { jianyingCopy } from '@/locales/jianying';
import { loadMediaBlob } from '@/utils/mediaSource';
import { isTauriRuntime } from '@/utils/runtime';
import {
  buildJianyingSnapshot, formatJianyingBytes, pickJianyingOutputDirectory, type SelectedJianyingDirectory,
} from '@/utils/jianyingDraft';

type Capabilities = RpcOutput<'jianying.capabilities'>;
type LoadState = { phase: 'loading' } | { phase: 'error' } | { phase: 'ready'; value: Capabilities };
type ExportPhase = 'idle' | 'preparing' | 'prepared' | 'running' | 'cancelling' | 'success' | 'error';
interface Prepared {
  result: JianyingPreflightResult;
  snapshot: JianyingSnapshot;
  assetId?: string;
  capturedAt: string;
}
interface Failure { title: string; detail: string }
interface SuccessState { result: JianyingJobResult; snapshot: JianyingSnapshot; capturedAt: string }

function failureCopy(error: unknown, copy: ReturnType<typeof jianyingCopy>): Failure {
  const detail = error instanceof Error ? error.message : String(error);
  if (/Source media is missing|media is missing/i.test(detail)) return { title: copy.errorMedia, detail };
  if (/space/i.test(detail)) return { title: copy.errorSpace, detail };
  if (/permission|EACCES|EPERM|access/i.test(detail)) return { title: copy.errorPermission, detail };
  if (/overlap/i.test(detail)) return { title: copy.errorOverlap, detail };
  if (/already exists|folder with this name/i.test(detail)) return { title: copy.errorConflict, detail };
  if (/grant|directory|Prepared export/i.test(detail)) return { title: copy.errorDirectory, detail };
  return { title: copy.errorFormat, detail };
}

function degradationText(key: JianyingDegradation, copy: ReturnType<typeof jianyingCopy>): string {
  return copy.degradations[key];
}

export function JianyingDraftInfoPanel({ active, videoMeta }: { active: boolean; videoMeta: { width: number; height: number } }) {
  const { connection } = useClientRuntime();
  const appStore = useRuntimeStoreApi('app');
  const historyStore = useRuntimeStoreApi('history');
  const projectStore = useRuntimeStoreApi('project');
  const { language } = useLocale();
  const copy = jianyingCopy(language);
  const desktop = isTauriRuntime();
  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  const [directory, setDirectory] = useState<SelectedJianyingDirectory | null>(null);
  const [draftName, setDraftName] = useState('');
  const [phase, setPhase] = useState<ExportPhase>('idle');
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [success, setSuccess] = useState<SuccessState | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const cancelledRef = useRef(false);

  const load = useCallback(async () => {
    setState({ phase: 'loading' });
    setFailure(null);
    try {
      const value = await connection.call('jianying.capabilities');
      setState({ phase: 'ready', value });
      const name = appStore.getState().videoFile?.name ?? '';
      const base = name.replace(/\.[^.]+$/, '').trim() || 'FlyCut draft';
      setDraftName(`${base} - FlyCut`.slice(0, 120));
    } catch {
      setState({ phase: 'error' });
    }
  }, [connection, appStore]);

  useEffect(() => {
    if (active) {
      setDirectory(null); setPrepared(null); setSuccess(null); setFailure(null); setProgress(0); setPhase('idle');
      void load();
    }
  }, [active, load]);

  const cleanupAsset = useCallback((assetId?: string) => {
    if (assetId) void connection.call('assets.delete', { assetId }).catch(() => undefined);
  }, [connection]);

  const chooseDirectory = async () => {
    if (phase === 'preparing' || phase === 'running' || phase === 'cancelling') return;
    try {
      const selected = await pickJianyingOutputDirectory();
      if (!selected) return;
      cleanupAsset(prepared?.assetId);
      setPrepared(null); setDirectory(selected); setPhase('idle'); setFailure(null);
    } catch (error) {
      setFailure(failureCopy(error, copy)); setPhase('error');
    }
  };

  const capture = async (): Promise<{ snapshot: JianyingSnapshot; source: JianyingSource; assetId?: string }> => {
    const app = appStore.getState();
    const history = historyStore.getState();
    const current = projectStore.getState().current;
    if (!app.videoFile) throw new Error('No video is open');
    if (!history.edl || history.cutError || history.updatingCuts) throw new Error('The edit timeline is not ready');
    if (!history.chunks.some(cue => !cue.deleted && !cue.isBlankSpacer && cue.text.trim())) throw new Error('No subtitles to export');
    if (videoMeta.width <= 0 || videoMeta.height <= 0) throw new Error('Video dimensions are not ready');
    const project = current?.projectId && current.videoId
      ? { projectId: current.projectId, videoId: current.videoId, name: current.name }
      : undefined;
    const context = { edl: history.edl, chunks: history.chunks, style: app.subtitleStylePair.primary, videoMeta, videoFile: app.videoFile, project };
    const snapshot = buildJianyingSnapshot(context);
    if (project) return { snapshot, source: { kind: 'project', projectId: project.projectId, videoId: project.videoId } };
    const assetId = await connection.upload(await loadMediaBlob(app.videoFile));
    return { snapshot, source: { kind: 'asset', assetId }, assetId };
  };

  const prepare = async () => {
    if (!directory || !draftName.trim() || phase === 'preparing' || phase === 'running' || phase === 'cancelling') return;
    setPhase('preparing'); setFailure(null); setSuccess(null);
    let assetId: string | undefined;
    try {
      const captured = await capture(); assetId = captured.assetId;
      const result = await connection.call('jianying.preflight', {
        directoryGrant: directory.grant, draftName: draftName.trim(), source: captured.source, snapshot: captured.snapshot,
      });
      setPrepared({ result, snapshot: captured.snapshot, assetId, capturedAt: new Date().toISOString() });
      setPhase('prepared');
    } catch (error) {
      cleanupAsset(assetId);
      setFailure(failureCopy(error, copy)); setPhase('error');
    }
  };

  const start = async () => {
    if (!prepared || phase === 'running' || phase === 'cancelling') return;
    const controller = new AbortController(); abortRef.current = controller; cancelledRef.current = false;
    setPhase('running'); setProgress(0); setProgressText(copy.progressQueued); setFailure(null);
    try {
      const job = await connection.call('jianying.start', { preflightId: prepared.result.preflightId });
      const result = await connection.waitJob<JianyingJobResult>(job.id, snapshot => {
        const value = Math.max(0, Math.min(100, snapshot.progress?.progress ?? 0));
        setProgress(value); setProgressText(snapshot.progress?.data ?? copy.progressGenerating);
      }, controller.signal);
      setSuccess({ result, snapshot: prepared.snapshot, capturedAt: prepared.capturedAt });
      setPrepared(null); setDirectory(null); setProgress(100); setPhase('success');
    } catch (error) {
      setFailure(cancelledRef.current ? { title: copy.cancelled, detail: copy.cancelledDetail } : failureCopy(error, copy));
      setPrepared(null); setDirectory(null); setPhase(cancelledRef.current ? 'idle' : 'error');
    } finally {
      cleanupAsset(prepared.assetId);
      abortRef.current = null;
    }
  };

  const cancel = () => {
    if (!abortRef.current || phase !== 'running') return;
    cancelledRef.current = true; setPhase('cancelling'); setProgressText(copy.cancelling); abortRef.current.abort();
  };

  const resetAfterFailure = () => {
    setPrepared(null); setSuccess(null); setFailure(null); setDirectory(null); setProgress(0); setPhase('idle');
  };

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

  const capabilities = state.value;
  const activeTarget = capabilities.targets.find(target => target.id === capabilities.activeTargetId);
  const windows = capabilities.targets.find(target => target.id === 'jianying-windows-5.9.0');
  const mac = capabilities.targets.find(target => target.id === 'jianying-macos-11.7.0');
  const other = capabilities.targets.find(target => target.id === 'jianying-windows-other-builds');
  const capcut = capabilities.targets.find(target => target.id === 'capcut');
  const web = capabilities.targets.find(target => target.id === 'jianying-web');
  const row = (id: string, name: string, detail: string, status: string) => (
    <div key={id} data-testid={`jianying-target-${id}`} className="flex gap-3 rounded-lg border p-3 text-sm">
      {status === 'unsupported' ? <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /> : <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />}
      <div><div className="font-medium">{name}</div><div className="mt-1 text-muted-foreground">{detail}</div></div>
    </div>
  );
  const disabled = !capabilities.exportEnabled || !desktop;
  const busy = phase === 'preparing' || phase === 'running' || phase === 'cancelling';
  const canChooseDirectory = !disabled && !busy && phase !== 'prepared';
  const canPrepare = !disabled && !!directory && !!draftName.trim() && phase !== 'preparing' && phase !== 'running' && phase !== 'prepared';
  const estimatedSource = appStore.getState().videoFile?.size ?? 0;

  return <div data-testid="jianying-support-matrix" className="space-y-4">
    <div className={`rounded-lg border p-3 text-sm ${capabilities.exportEnabled ? 'border-amber-500/40 bg-amber-500/10' : 'border-destructive/30 bg-destructive/10'}`}>
      <div className={`flex items-center gap-2 font-semibold ${capabilities.exportEnabled ? 'text-amber-700 dark:text-amber-300' : 'text-destructive'}`}>
        <AlertCircle className="h-4 w-4" />{capabilities.exportEnabled ? copy.internalTitle : copy.realImport}
      </div>
      <p className="mt-1 text-muted-foreground">{capabilities.exportEnabled ? copy.internalDetail : copy.realImportDetail}</p>
    </div>
    <div className="space-y-2">
      {windows && row(windows.id, language.startsWith('zh') ? windows.labelZh ?? windows.labelEn ?? '' : windows.labelEn ?? windows.labelZh ?? '', copy.windowsDetail, windows.status)}
      {mac && row(mac.id, language.startsWith('zh') ? mac.labelZh ?? '' : mac.labelEn ?? '', copy.macDetail, mac.status)}
      {other && row(other.id, copy.unavailable, copy.otherBuildDetail, other.status)}
      {capcut && row(capcut.id, copy.unavailable, copy.capcutDetail, capcut.status)}
      {web && row(web.id, copy.unavailable, copy.webDetail, web.status)}
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <section className="rounded-lg bg-muted/50 p-3 text-sm"><h4 className="flex items-center gap-2 font-medium"><CheckCircle className="h-4 w-4" />{copy.scope}</h4>
        <ul className="mt-2 list-disc space-y-1 pl-4 text-muted-foreground">{copy.scopeItems.map(item => <li key={item}>{item}</li>)}</ul></section>
      <section className="rounded-lg bg-amber-500/10 p-3 text-sm"><h4 className="font-medium">{copy.limitations}</h4>
        <ul className="mt-2 list-disc space-y-1 pl-4 text-muted-foreground">{copy.limitationsItems.map(item => <li key={item}>{item}</li>)}</ul></section>
    </div>
    <p className="text-xs text-muted-foreground">{copy.research.replace('{date}', capabilities.checkedAt)}</p>

    {disabled ? (
      <button data-testid="jianying-export-disabled" type="button" disabled className="w-full rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground opacity-50">{copy.exportDisabled}</button>
    ) : (
      <section data-testid="jianying-export-flow" className="space-y-3 rounded-xl border p-3">
        <div className="flex items-center justify-between gap-3">
          <div><div className="text-sm font-semibold">{activeTarget ? (language.startsWith('zh') ? activeTarget.labelZh : activeTarget.labelEn) : copy.internalTitle}</div>
            <div className="mt-1 text-xs text-muted-foreground">{copy.mediaCopy}</div></div>
          <span className="rounded-full bg-amber-500/15 px-2 py-1 text-[10px] font-medium text-amber-700 dark:text-amber-300">{copy.internalBadge}</span>
        </div>
        <label className="block text-sm font-medium">{copy.draftName}
          <input data-testid="jianying-draft-name" value={draftName} maxLength={120} disabled={busy || phase === 'prepared'}
            onChange={event => setDraftName(event.target.value)} className="mt-1 w-full rounded border bg-background px-3 py-2 text-sm disabled:opacity-60" />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button data-testid="jianying-choose-directory" type="button" disabled={!canChooseDirectory} onClick={() => void chooseDirectory()}
            className="inline-flex items-center gap-2 rounded border px-3 py-2 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50">
            <FolderOpen className="h-4 w-4" />{directory ? copy.chooseAgain : copy.chooseDirectory}
          </button>
          <span data-testid="jianying-directory-state" className="text-xs text-muted-foreground">{directory ? copy.directorySelected : copy.directoryRequired}</span>
        </div>
        <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
          <div>{copy.estimated.replace('{size}', formatJianyingBytes(estimatedSource ? Math.ceil(estimatedSource * 1.01) + 4 * 1024 * 1024 : 0))}</div>
          <div className="mt-1">{copy.copyWarning}</div>
        </div>
        {phase === 'idle' && (
          <button data-testid="jianying-prepare" type="button" disabled={!canPrepare} onClick={() => void prepare()}
            className="w-full rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50">{copy.prepare}</button>
        )}
        {phase === 'preparing' && <div data-testid="jianying-preparing" role="status" className="flex items-center gap-2 text-sm text-primary"><Loader2 className="h-4 w-4 animate-spin" />{copy.preparing}</div>}
        {phase === 'prepared' && prepared && (
          <div data-testid="jianying-prepared" className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
            <div className="font-medium">{copy.prepared}</div>
            <div data-testid="jianying-snapshot-meta" className="text-xs text-muted-foreground">
              {[prepared.snapshot.projectName, prepared.snapshot.videoName, new Date(prepared.capturedAt).toLocaleString(language)].filter(Boolean).join(' · ')}
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
              <span>{copy.videoSegments.replace('{count}', String(prepared.result.videoSegmentCount))}</span>
              <span>{copy.textSegments.replace('{count}', String(prepared.result.textSegmentCount))}</span>
              <span>{copy.copySize.replace('{size}', formatJianyingBytes(prepared.result.sourceBytes))}</span>
              <span>{copy.freeSpace.replace('{size}', formatJianyingBytes(prepared.result.availableBytes))}</span>
            </div>
            <ul data-testid="jianying-degradations" className="list-disc space-y-1 pl-4 text-xs text-amber-700 dark:text-amber-300">
              {prepared.result.degradationKeys.map(key => <li key={key}>{degradationText(key, copy)}</li>)}
            </ul>
            <div className="flex gap-2">
              <button data-testid="jianying-start" type="button" onClick={() => void start()} className="flex-1 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">{copy.start}</button>
              <button type="button" onClick={() => { cleanupAsset(prepared.assetId); setPrepared(null); setDirectory(null); setPhase('idle'); }}
                className="rounded border px-3 py-2 text-sm hover:bg-muted">{copy.discardPrepared}</button>
            </div>
          </div>
        )}
        {(phase === 'running' || phase === 'cancelling') && (
          <div data-testid="jianying-running" role="status" className="space-y-2 rounded-lg border p-3 text-sm">
            <div className="flex items-center gap-2 font-medium"><Loader2 className="h-4 w-4 animate-spin" />{copy.generating}</div>
            <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-[width]" style={{ width: `${progress}%` }} /></div>
            <div className="flex items-center justify-between text-xs text-muted-foreground"><span>{progressText}</span><span>{progress}%</span></div>
            <button data-testid="jianying-cancel" type="button" disabled={phase === 'cancelling'} onClick={cancel}
              className="inline-flex items-center gap-1 rounded border border-destructive/40 px-3 py-1.5 text-xs text-destructive disabled:opacity-50"><X className="h-3.5 w-3.5" />{copy.cancel}</button>
          </div>
        )}
        {phase === 'success' && success && (
          <div data-testid="jianying-success" className="space-y-2 rounded-lg border border-green-500/40 bg-green-500/10 p-3 text-sm">
            <div className="flex items-center gap-2 font-semibold text-green-700 dark:text-green-300"><CheckCircle className="h-4 w-4" />{copy.success}</div>
            <div className="text-muted-foreground">{copy.successDetail}</div>
            <div data-testid="jianying-success-meta" className="text-xs text-muted-foreground">
              {[success.snapshot.projectName, success.snapshot.videoName, new Date(success.capturedAt).toLocaleString(language)].filter(Boolean).join(' · ')}
            </div>
            <code data-testid="jianying-draft-path" className="block break-all rounded bg-background/70 p-2 text-xs">{success.result.draftPath}</code>
            <div className="text-xs text-muted-foreground">{copy.successInstructions}</div>
          </div>
        )}
        {failure && (
          <div data-testid="jianying-error" role="alert" className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <div className="flex items-center gap-2 font-medium text-destructive"><AlertCircle className="h-4 w-4" />{failure.title}</div>
            <div className="break-all text-xs text-muted-foreground">{failure.detail}</div>
            {phase === 'error' && <button type="button" onClick={resetAfterFailure} className="rounded border px-3 py-1.5 text-xs hover:bg-muted">{copy.retry}</button>}
          </div>
        )}
      </section>
    )}
  </div>;
}
