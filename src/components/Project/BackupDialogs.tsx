import { useRef } from 'react';
import { AlertTriangle, Archive, CheckCircle2, Download, FileArchive, Loader2, ShieldCheck, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useClientRuntime } from '@/runtime/context';
import { useProjectStore } from '@/stores/projectStore';
import { isTauriRuntime } from '@/utils/runtime';
import { useProjectText } from './useProjectText';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function BackupExportDialog() {
  const { projects } = useClientRuntime();
  const state = useProjectStore((s) => s.backupExport);
  const projectList = useProjectStore((s) => s.projects);
  const { tp } = useProjectText();
  const open = state.phase !== 'idle';
  const preview = state.preview;
  const processing = state.phase === 'processing';

  const handleOpenProject = () => {
    const pid = state.projectId;
    projects.closeBackupExport();
    if (!pid) return;
    const item = projectList.find((p) => p.id === pid);
    if (item && item.videoCount > 1) void projects.openDetail(pid);
    else void projects.open(pid);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !state.savingToDisk) projects.closeBackupExport(); }}>
      <DialogContent className="sm:max-w-lg" data-testid="backup-export-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Archive className="h-4 w-4 text-primary" />
            <span>{tp('backupExportTitle')}</span>
            {state.projectName && <span className="truncate text-sm font-normal text-muted-foreground">· {state.projectName}</span>}
          </DialogTitle>
          <DialogDescription className="flex items-center gap-1.5 text-xs">
            <ShieldCheck className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
            <span>{tp('backupSecretsNotice')}</span>
          </DialogDescription>
        </DialogHeader>

        {state.phase === 'loading' && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>{tp('backupLoading')}</span>
          </div>
        )}

        {(state.phase === 'ready' || state.phase === 'missing-resource' || state.phase === 'stale') && preview && (
          <div className="space-y-4">
            {preview.empty && (
              <div className="rounded-lg border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                <p className="font-medium text-foreground">{tp('backupEmpty')}</p>
                <p className="mt-0.5">{tp('backupEmptyProjectHint')}</p>
              </div>
            )}

            <dl className="grid grid-cols-2 gap-2.5 rounded-lg border border-border bg-card p-3 text-xs">
              <div>
                <dt className="text-muted-foreground">{tp('backupLabelVideos')}</dt>
                <dd className="mt-0.5 font-medium text-foreground">{preview.videoCount}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{tp('backupLabelSubtitles')}</dt>
                <dd className="mt-0.5 font-medium text-foreground">{preview.subtitleCount}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{tp('backupLabelEdits')}</dt>
                <dd className="mt-0.5 font-medium text-foreground">{preview.editCount}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{tp('backupLabelArtifacts')}</dt>
                <dd className="mt-0.5 font-medium text-foreground">{preview.artifactCount}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-muted-foreground">{tp('backupLabelStyles')}</dt>
                <dd className="mt-0.5 font-medium text-foreground">
                  {tp('backupStyleSummary', {
                    project: preview.styleSummary.hasProjectStyle ? tp('backupStyleYes') : tp('backupStyleNo'),
                    custom: preview.styleSummary.customVideoStyleCount,
                  })}
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-muted-foreground">{tp('backupLabelMediaSize')}</dt>
                <dd className="mt-0.5 font-medium text-foreground">{formatBytes(preview.estimatedMediaBytes)}</dd>
              </div>
            </dl>

            {preview.missingMedia.length > 0 && (
              <div className="space-y-2 rounded-lg border border-aimu-coral/40 bg-aimu-coral/5 p-3 text-xs">
                <div className="flex items-start gap-2 text-aimu-coral">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                  <div>
                    <p className="font-medium">{tp('backupMissingMediaWarning')}</p>
                    <ul className="mt-1 list-disc pl-4">
                      {preview.missingMedia.map((m) => (
                        <li key={m.videoId}>{m.videoName} ({m.fileName})</li>
                      ))}
                    </ul>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <label className="flex cursor-pointer items-center gap-2 text-foreground">
                    <input
                      type="checkbox"
                      checked={state.includeMissingMedia}
                      onChange={(e) => projects.setBackupIncludeMissingMedia(e.target.checked)}
                    />
                    <span>{tp('backupSkipMissingMedia')}</span>
                  </label>
                  <Button type="button" variant="outline" size="sm" onClick={handleOpenProject}>
                    {tp('backupRelinkMissing')}
                  </Button>
                </div>
              </div>
            )}

            {state.phase === 'stale' && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-foreground" role="alert">
                <span>{tp('backupStale')}</span>
                <Button type="button" size="sm" variant="outline" onClick={() => { if (state.projectId) void projects.openBackupExport(state.projectId, state.projectName); }}>
                  {tp('backupReviewAgain')}
                </Button>
              </div>
            )}
          </div>
        )}

        {processing && (
          <div className="space-y-3 py-4" role="status">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2 font-medium text-foreground">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                {state.savingToDisk ? tp('backupSavingToDisk') : tp('backupProcessing')}
              </span>
              <span className="font-mono text-xs text-muted-foreground">{state.progress}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-all" style={{ width: `${state.progress}%` }} />
            </div>
            {state.statusText && <p className="text-xs text-muted-foreground">{state.statusText}</p>}
          </div>
        )}

        {state.phase === 'completed' && state.result && (
          <div className="space-y-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 text-xs">
            <div className="flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              <span>{tp('backupCompleted')}</span>
            </div>
            <p className="font-medium text-foreground">{state.result.filename} · {formatBytes(state.result.size)}</p>
            {state.savedPath && <p className="truncate text-muted-foreground" title={state.savedPath}>{state.savedPath}</p>}
          </div>
        )}

        {state.phase === 'error' && (
          <div className="space-y-2 rounded-lg border border-aimu-coral/40 bg-aimu-coral/5 p-3 text-xs text-aimu-coral" role="alert">
            <p className="font-medium">{state.error}</p>
            {state.uncertain && <p className="text-muted-foreground">{tp('backupUncertain')}</p>}
          </div>
        )}

        <DialogFooter>
          {(state.phase === 'ready' || state.phase === 'missing-resource' || state.phase === 'stale') && (
            <>
              <Button type="button" variant="outline" onClick={() => projects.closeBackupExport()}>
                {tp('backupCancel')}
              </Button>
              <Button
                type="button"
                disabled={
                  state.phase === 'stale' ||
                  (Boolean(preview?.missingMedia.length) && !state.includeMissingMedia)
                }
                onClick={() => { void projects.startBackupExport(); }}
              >
                <Download className="h-3.5 w-3.5" />
                {tp('backupExportConfirm')}
              </Button>
            </>
          )}
          {state.phase === 'loading' && (
            <Button type="button" variant="outline" onClick={() => projects.closeBackupExport()}>
              {tp('backupCancel')}
            </Button>
          )}
          {processing && (
            <Button type="button" variant="outline" disabled={state.savingToDisk} onClick={() => projects.cancelBackupExport()}>
              {tp('backupCancel')}
            </Button>
          )}
          {state.phase === 'completed' && (
            <>
              {!state.savedPath && (
                <Button type="button" variant="outline" onClick={() => { void projects.downloadLastBackup(); }}>
                  <Download className="h-3.5 w-3.5" />
                  {tp('backupDownloadAgain')}
                </Button>
              )}
              <Button type="button" onClick={() => projects.closeBackupExport()}>{tp('backupClose')}</Button>
            </>
          )}
          {state.phase === 'error' && (
            <>
              <Button type="button" variant="outline" onClick={() => projects.closeBackupExport()}>
                {tp('backupBack')}
              </Button>
              <Button
                type="button"
                onClick={() => {
                  if (state.preview) void projects.startBackupExport();
                  else if (state.projectId) void projects.openBackupExport(state.projectId, state.projectName);
                }}
              >
                {tp('backupRetry')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function BackupImportDialog() {
  const { projects } = useClientRuntime();
  const state = useProjectStore((s) => s.backupImport);
  const { tp } = useProjectText();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const open = state.phase !== 'idle';
  const busy = state.phase === 'uploading' || state.phase === 'inspecting' || state.phase === 'importing';
  const inspection = state.inspection;

  const handleChooseFile = async () => {
    if (isTauriRuntime()) {
      const { invoke } = await import('@tauri-apps/api/core');
      const path = await invoke<string | null>('pick_backup_file');
      if (path) void projects.selectBackupFile(path);
      return;
    }
    fileInputRef.current?.click();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) projects.closeBackupImport(); }}>
      <DialogContent className="sm:max-w-lg" data-testid="backup-import-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileArchive className="h-4 w-4 text-primary" />
            <span>{tp('backupImportTitle')}</span>
          </DialogTitle>
          <DialogDescription className="text-xs">{tp('backupImportNewNameHint')}</DialogDescription>
        </DialogHeader>

        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,.flycut,.flycut.zip"
          className="hidden"
          data-testid="backup-import-file-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void projects.selectBackupFile(file);
          }}
        />

        {state.phase === 'empty' && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-10 text-center">
            <Upload className="h-7 w-7 text-muted-foreground" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">{tp('backupEmpty')}</p>
              <p className="text-xs text-muted-foreground">{tp('backupDropHint')}</p>
            </div>
            <Button type="button" size="sm" onClick={() => { void handleChooseFile(); }}>
              {tp('backupChooseFile')}
            </Button>
          </div>
        )}

        {busy && (
          <div className="space-y-3 py-4" role="status">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2 font-medium text-foreground">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                {state.phase === 'inspecting' ? tp('backupLoading') : tp('backupProcessing')}
              </span>
              <span className="font-mono text-xs text-muted-foreground">{state.progress}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-all" style={{ width: `${state.progress}%` }} />
            </div>
            {state.fileName && <p className="text-xs text-muted-foreground">{state.fileName}</p>}
          </div>
        )}

        {state.phase === 'rejected' && (
          <div className="space-y-2 rounded-lg border border-aimu-coral/40 bg-aimu-coral/5 p-4 text-xs" role="alert">
            <div className="flex items-center gap-2 text-sm font-medium text-aimu-coral">
              <AlertTriangle className="h-4 w-4" />
              <span>{tp('backupCannotImport')}</span>
            </div>
            <p className="text-foreground">{state.error}</p>
          </div>
        )}

        {(state.phase === 'ready' || state.phase === 'stale') && inspection && (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-2.5 rounded-lg border border-border bg-card p-3 text-xs">
              <div>
                <dt className="text-muted-foreground">{tp('backupLabelVideos')}</dt>
                <dd className="mt-0.5 font-medium text-foreground">{inspection.videoCount}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{tp('backupLabelSubtitles')}</dt>
                <dd className="mt-0.5 font-medium text-foreground">{inspection.subtitleCount}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{tp('backupLabelEdits')}</dt>
                <dd className="mt-0.5 font-medium text-foreground">{inspection.editCount}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{tp('backupLabelArtifacts')}</dt>
                <dd className="mt-0.5 font-medium text-foreground">{inspection.artifactCount}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{tp('backupLabelRequiredSpace')}</dt>
                <dd className="mt-0.5 font-medium text-foreground">{formatBytes(inspection.requiredBytes)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{tp('backupLabelAvailableSpace')}</dt>
                <dd className="mt-0.5 font-medium text-foreground">{formatBytes(inspection.availableBytes)}</dd>
              </div>
            </dl>

            <div className="space-y-1.5">
              <Label htmlFor="backup-import-name" className="text-xs">{tp('backupLabelNewName')}</Label>
              <Input
                id="backup-import-name"
                value={state.projectName}
                onChange={(e) => projects.setBackupImportName(e.target.value)}
                disabled={state.phase === 'stale'}
              />
            </div>

            {state.phase === 'stale' && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-foreground" role="alert">
                <span>{tp('backupStale')}</span>
                <Button type="button" size="sm" variant="outline" onClick={() => { void handleChooseFile(); }}>
                  {tp('backupChooseAnother')}
                </Button>
              </div>
            )}
          </div>
        )}

        {state.phase === 'completed' && state.result && (
          <div className="space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 text-xs">
            <div className="flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              <span>{tp('backupCompleted')}</span>
            </div>
            <p className="font-medium text-foreground">{state.result.name}</p>
            <p className="text-muted-foreground">{tp('videoCount', { count: state.result.videoCount })}</p>
          </div>
        )}

        {state.phase === 'error' && (
          <div className="space-y-2 rounded-lg border border-aimu-coral/40 bg-aimu-coral/5 p-3 text-xs text-aimu-coral" role="alert">
            <p className="font-medium">{state.error}</p>
            {state.uncertain && <p className="text-muted-foreground">{tp('backupUncertain')}</p>}
          </div>
        )}

        <DialogFooter>
          {state.phase === 'empty' && (
            <Button type="button" variant="outline" onClick={() => projects.closeBackupImport()}>{tp('backupCancel')}</Button>
          )}
          {busy && (
            <Button type="button" variant="outline" onClick={() => projects.cancelBackupImport()}>{tp('backupCancel')}</Button>
          )}
          {state.phase === 'rejected' && (
            <>
              <Button type="button" variant="outline" onClick={() => projects.closeBackupImport()}>{tp('backupBack')}</Button>
              <Button type="button" onClick={() => { void handleChooseFile(); }}>{tp('backupChooseAnother')}</Button>
            </>
          )}
          {(state.phase === 'ready' || state.phase === 'stale') && (
            <>
              <Button type="button" variant="outline" onClick={() => projects.closeBackupImport()}>{tp('backupCancel')}</Button>
              <Button type="button" disabled={state.phase === 'stale'} onClick={() => { void projects.confirmBackupImport(); }}>
                {tp('backupImportConfirm')}
              </Button>
            </>
          )}
          {state.phase === 'completed' && state.result && (
            <>
              <Button type="button" variant="outline" onClick={() => projects.closeBackupImport()}>{tp('backupClose')}</Button>
              <Button type="button" onClick={() => { void projects.openImportedProject(state.result!.projectId); }}>
                {tp('backupOpenImported')}
              </Button>
            </>
          )}
          {state.phase === 'error' && (
            <>
              <Button type="button" variant="outline" onClick={() => projects.closeBackupImport()}>{tp('backupBack')}</Button>
              <Button type="button" onClick={() => { void projects.confirmBackupImport(); }}>{tp('backupRetry')}</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
