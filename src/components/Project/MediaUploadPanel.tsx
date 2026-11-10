// F-0015：项目媒体断点续传面板。源文件只留在 ProjectService 的内存里，刷新后必须重新选择并校验摘要。
import { useRef, useState } from 'react';
import { FileVideo, Pause, Play, RefreshCw, UploadCloud, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useClientRuntime } from '@/runtime/context';
import { useProjectStore, type MediaUploadPhase } from '@/stores/projectStore';
import { formatFileSize } from '@/utils/fileUtils';
import { videoFileFromFile } from '@/hooks/useMediaLoader';
import { useProjectText } from './useProjectText';

const STATUS_KEY: Record<MediaUploadPhase, string> = {
  checking: 'uploadChecking', unsupported: 'uploadUnsupported', rejected: 'uploadRejected', hashing: 'uploadHashing',
  uploading: 'uploadUploading', paused: 'uploadPaused', interrupted: 'uploadInterrupted', 'needs-file': 'uploadNeedsFile',
  mismatch: 'uploadMismatch', verifying: 'uploadVerifying', failed: 'uploadFailed', expired: 'uploadExpired', complete: 'uploadComplete',
};

const ERROR_KEY: Record<string, string> = {
  'unsupported-media-type': 'uploadUnsupportedType', 'too-large': 'uploadTooLarge', 'insufficient-storage': 'uploadNoSpace',
  'invalid-session': 'uploadSessionLost', 'chunk-conflict': 'uploadChunkConflict', 'integrity-mismatch': 'uploadIntegrityFailed',
  incomplete: 'uploadIncomplete', expired: 'uploadExpired', cancelled: 'uploadCancelled', forbidden: 'uploadPermission',
};

export function MediaUploadPanel({ kind, projectId }: { kind: 'create' | 'add'; projectId?: string }) {
  const { projects } = useClientRuntime();
  const allUploads = useProjectStore(state => state.uploads);
  const { tp } = useProjectText();
  const input = useRef<HTMLInputElement>(null);
  const [selectKey, setSelectKey] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  const uploads = allUploads.filter(item => item.kind === kind && (kind === 'create' || item.projectId === projectId));
  if (!uploads.length) return null;

  const choose = (key: string) => { setSelectKey(key); input.current?.click(); };
  const progress = (bytes: number, total: number) => total > 0 ? Math.max(0, Math.min(100, Math.round(bytes / total * 100))) : 0;

  return (
    <section className="mt-4 space-y-2" aria-label={tp('uploadPanelTitle')} data-testid="media-upload-panel">
      <input ref={input} type="file" className="hidden" data-testid="upload-resume-input" accept="video/*,audio/*"
        onChange={event => {
          const file = event.target.files?.[0]; const key = selectKey ?? (uploads.length === 1 ? uploads[0].key : null); event.target.value = '';
          setSelectKey(null);
          if (!file || !key) return;
          void videoFileFromFile(file).then(video => projects.chooseResumeFile(key, video));
        }} />
      {uploads.map(upload => {
        const percent = progress(upload.uploadedBytes, upload.size);
        const canCancel = !['verifying', 'unsupported', 'complete'].includes(upload.phase);
        const canChoose = ['needs-file', 'mismatch', 'rejected', 'expired'].includes(upload.phase);
        return (
          <article key={upload.key} className="rounded-xl border border-border bg-card px-4 py-3"
            data-testid="media-upload-row" data-upload-phase={upload.phase} aria-live="polite">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <FileVideo className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <p className="truncate text-sm font-medium text-foreground" title={upload.fileName}>{upload.fileName}</p>
                  <span className="text-xs text-muted-foreground">{formatFileSize(upload.size)}</span>
                  <span className="text-xs text-muted-foreground">{tp('uploadTarget', { target: upload.target })}</span>
                </div>
                <p className="mt-1 text-xs text-foreground">{tp(STATUS_KEY[upload.phase])}{upload.phase === 'uploading' ? ` · ${percent}%` : ''}</p>
                {['uploading', 'paused', 'interrupted'].includes(upload.phase) && (
                  <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <div className="h-1.5 w-56 overflow-hidden rounded bg-muted"><div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} /></div>
                    <span>{formatFileSize(upload.uploadedBytes)} / {formatFileSize(upload.size)}</span>
                  </div>
                )}
                {upload.error && !['mismatch', 'expired'].includes(upload.phase) && (
                  <p className="mt-1 text-xs text-aimu-coral">{ERROR_KEY[upload.error] ? tp(ERROR_KEY[upload.error]) : tp('uploadFailedReason')}</p>
                )}
              </div>
              <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-1">
                {upload.phase === 'paused' && <Button size="sm" variant="outline" onClick={() => { void projects.resumeUpload(upload.key); }}><Play className="h-3.5 w-3.5" />{tp('uploadContinue')}</Button>}
                {['interrupted', 'failed'].includes(upload.phase) && <Button size="sm" variant="outline" onClick={() => { void projects.retryUpload(upload.key); }}><RefreshCw className="h-3.5 w-3.5" />{tp('uploadRetryNow')}</Button>}
                {['hashing', 'uploading', 'interrupted'].includes(upload.phase) && <Button size="sm" variant="ghost" onClick={() => projects.pauseUpload(upload.key)}><Pause className="h-3.5 w-3.5" />{tp('uploadPause')}</Button>}
                {canChoose && <Button size="sm" variant="outline" onClick={() => choose(upload.key)}><UploadCloud className="h-3.5 w-3.5" />{tp(upload.phase === 'rejected' ? 'uploadChooseAgain' : 'uploadSelectOriginal')}</Button>}
                {upload.phase === 'unsupported' && <Button size="sm" variant="ghost" onClick={() => projects.dismissUpload(upload.key)}>{tp('uploadClose')}</Button>}
                {canCancel && (confirmCancel === upload.key
                  ? <><Button size="sm" variant="ghost" onClick={() => setConfirmCancel(null)}>{tp('uploadKeep')}</Button>
                    <Button size="sm" variant="destructive" onClick={() => { setConfirmCancel(null); void projects.cancelUpload(upload.key); }}>{tp('uploadCancelConfirm')}</Button></>
                  : <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(upload.key)}><X className="h-3.5 w-3.5" />{tp('uploadCancel')}</Button>)}
              </div>
            </div>
          </article>
        );
      })}
    </section>
  );
}
