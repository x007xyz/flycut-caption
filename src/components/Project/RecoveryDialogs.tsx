// 崩溃恢复的对话框和提示条（F-0004 AC-2 到 AC-10）。只负责展示；状态来自 `stores.project.recovery`，操作经 `ctx.projects`。
import { AlertTriangle, History, Loader2, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useProjectText } from './useProjectText';

/** 不能点外面或按 Esc 关掉的对话框：恢复期间的选择必须由按钮做出 */
const locked = { onEscapeKeyDown: (event: Event) => event.preventDefault(), onInteractOutside: (event: Event) => event.preventDefault() };

export interface RecoveryCheckingDialogProps {
  open: boolean;
  onBack: () => void;
}

/** AC-2：正在检查恢复内容，编辑区不可修改，可以返回首页 */
export function RecoveryCheckingDialog({ open, onBack }: RecoveryCheckingDialogProps) {
  const { tp } = useProjectText();
  return (
    <Dialog open={open}>
      <DialogContent showCloseButton={false} className="sm:max-w-sm" {...locked}>
        <DialogHeader className="flex-row items-center gap-3 px-6 pt-6">
          <Loader2 className="h-5 w-5 flex-shrink-0 animate-spin text-muted-foreground" />
          <DialogTitle role="status">{tp('recoveryChecking')}</DialogTitle>
          <DialogDescription className="sr-only">{tp('recoveryChecking')}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="px-6 pt-4 pb-6">
          <Button variant="ghost" onClick={onBack}>{tp('recoveryBack')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface RecoveryChoice { key: string; label: string; recordedAt: string }

export interface RecoveryChooseDialogProps {
  open: boolean;
  choices: RecoveryChoice[];
  selectedKey: string | null;
  /** 选中副本的记录时间（已格式化） */
  recordedAt: string;
  /** Host 上最后保存时间（已格式化） */
  hostSavedAt: string;
  /** AC-4：正在恢复，按钮不可重复点击 */
  applying?: boolean;
  onSelect: (key: string) => void;
  onRecover: () => void;
  onDiscard: () => void;
  onLater: () => void;
}

/** AC-3：发现未保存的修改。多个会话按记录时间倒序列出，只能选一份 */
export function RecoveryChooseDialog({ open, choices, selectedKey, recordedAt, hostSavedAt, applying, onSelect, onRecover, onDiscard, onLater }: RecoveryChooseDialogProps) {
  const { tp } = useProjectText();
  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !applying) onLater(); }}>
      <DialogContent showCloseButton={!applying} className="sm:max-w-md" onInteractOutside={event => event.preventDefault()}
        onEscapeKeyDown={event => { if (applying) event.preventDefault(); }}>
        <DialogHeader className="flex-row items-start gap-3 px-6 pt-6">
          <History className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-500" />
          <div>
            <DialogTitle>{tp('recoveryFoundTitle')}</DialogTitle>
            <DialogDescription className="mt-1.5">{tp('recoveryFoundDescription', { time: recordedAt })}</DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody className="space-y-3 px-6 pt-3">
          {hostSavedAt && <p className="text-xs text-muted-foreground">{tp('recoveryHostSaved', { time: hostSavedAt })}</p>}
          {choices.length > 1 && (
            <div role="radiogroup" aria-label={tp('recoveryChooseHint')} className="space-y-1.5">
              <p className="text-xs text-muted-foreground">{tp('recoveryChooseHint')}</p>
              {choices.map(choice => (
                <label key={choice.key} className="flex cursor-pointer items-center gap-2 rounded border border-border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-aimu-input">
                  <input type="radio" name="recovery-copy" className="accent-primary" checked={choice.key === selectedKey} disabled={applying}
                    onChange={() => onSelect(choice.key)} />
                  <span>{choice.label}</span>
                </label>
              ))}
            </div>
          )}
        </DialogBody>
        <DialogFooter className="px-6 pt-4 pb-6">
          <Button variant="ghost" onClick={onLater} disabled={applying}>{tp('recoveryLater')}</Button>
          <Button variant="outline" className="text-aimu-coral" onClick={onDiscard} disabled={applying}>{tp('recoveryDiscard')}</Button>
          <Button onClick={onRecover} disabled={applying}>
            {applying && <Loader2 className="h-4 w-4 animate-spin" />}{applying ? tp('recoveryApplying') : tp('recoveryRecover')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface RecoveryFailedDialogProps {
  open: boolean;
  missing?: boolean;
  uncertain?: boolean;
  onRetry: () => void;
  onBack: () => void;
}

/** AC-6：检查或恢复失败。现有项目没有被覆盖，副本保留 */
export function RecoveryFailedDialog({ open, missing, uncertain, onRetry, onBack }: RecoveryFailedDialogProps) {
  const { tp } = useProjectText();
  return (
    <Dialog open={open}>
      <DialogContent showCloseButton={false} className="sm:max-w-md" {...locked}>
        <DialogHeader className="flex-row items-start gap-3 px-6 pt-6">
          <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-aimu-coral" />
          <div>
            <DialogTitle>{tp('recoveryFailedTitle')}</DialogTitle>
            <DialogDescription className="mt-1.5">{tp('recoveryFailedDescription')}</DialogDescription>
          </div>
        </DialogHeader>
        {(missing || uncertain) && (
          <DialogBody className="space-y-1.5 px-6 pt-3">
            {uncertain && <p role="alert" className="rounded bg-aimu-input px-3 py-2 text-xs text-foreground">{tp('recoveryUncertain')}</p>}
            {missing && <p role="alert" className="rounded bg-aimu-input px-3 py-2 text-xs text-foreground">{tp('recoveryMissing')}</p>}
          </DialogBody>
        )}
        <DialogFooter className="px-6 pt-4 pb-6">
          <Button variant="ghost" onClick={onBack}>{tp('recoveryBack')}</Button>
          <Button onClick={onRetry}>{tp('recoveryRetry')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface RecoveryConflictDialogProps {
  open: boolean;
  busy?: boolean;
  onOverwrite: () => void;
  onSaveAsNew: () => void;
  onCancel: () => void;
}

/** AC-7：恢复副本基于的版本已经不是项目当前版本：显式覆盖 / 另存为新项目 / 取消 */
export function RecoveryConflictDialog({ open, busy, onOverwrite, onSaveAsNew, onCancel }: RecoveryConflictDialogProps) {
  const { t, tp } = useProjectText();
  return (
    <Dialog open={open}>
      <DialogContent showCloseButton={false} className="sm:max-w-md" {...locked}>
        <DialogHeader className="flex-row items-start gap-3 px-6 pt-6">
          <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-500" />
          <div>
            <DialogTitle>{tp('conflictTitle')}</DialogTitle>
            <DialogDescription className="mt-1.5">{tp('recoveryConflictDescription')}</DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody className="px-6 pt-3">
          <p className="rounded bg-aimu-input px-3 py-2 text-xs text-muted-foreground">{tp('conflictHint')}</p>
        </DialogBody>
        <DialogFooter className="px-6 pt-4 pb-6">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="outline" className="text-aimu-coral" onClick={onOverwrite} disabled={busy}>{tp('conflictOverwrite')}</Button>
          <Button onClick={onSaveAsNew} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{tp('conflictSaveAsNew')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface RecoveryDiscardDialogProps {
  open: boolean;
  busy?: boolean;
  failed?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** AC-8、AC-9：放弃确认；处理中禁用按钮，失败保留确认框并可重试 */
export function RecoveryDiscardDialog({ open, busy, failed, onConfirm, onCancel }: RecoveryDiscardDialogProps) {
  const { t, tp } = useProjectText();
  return (
    <Dialog open={open}>
      <DialogContent showCloseButton={false} className="sm:max-w-md" {...locked}>
        <DialogHeader className="flex-row items-start gap-3 px-6 pt-6">
          <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-aimu-coral" />
          <div>
            <DialogTitle>{tp('recoveryDiscardTitle')}</DialogTitle>
            <DialogDescription className="mt-1.5">{tp('recoveryDiscardDescription')}</DialogDescription>
          </div>
        </DialogHeader>
        {(busy || failed) && (
          <DialogBody className="px-6 pt-3">
            {busy ? <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{tp('recoveryDiscarding')}</p>
              : <p role="alert" className="text-xs text-aimu-coral">{tp('recoveryDiscardFailed')}</p>}
          </DialogBody>
        )}
        <DialogFooter className="px-6 pt-4 pb-6">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>{failed ? tp('recoveryRetry') : tp('recoveryDiscard')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface RecoveryUnavailableBannerProps {
  retrying?: boolean;
  onRetry: () => void;
  onSaveNow: () => void;
}

/** AC-10：本地恢复记录失败时在编辑器里一直显示，直到重试成功 */
export function RecoveryUnavailableBanner({ retrying, onRetry, onSaveNow }: RecoveryUnavailableBannerProps) {
  const { tp } = useProjectText();
  return (
    <div role="alert" className="fixed top-14 left-1/2 z-40 flex w-[min(640px,calc(100vw-32px))] -translate-x-1/2 items-start gap-3 rounded-md border border-aimu-coral/40 bg-background px-4 py-3 shadow-lg">
      <ShieldAlert className="mt-0.5 h-5 w-5 flex-shrink-0 text-aimu-coral" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{tp('recoveryUnavailableTitle')}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{tp('recoveryUnavailableDescription')}</p>
      </div>
      <div className="flex flex-shrink-0 gap-2">
        <Button size="sm" variant="ghost" onClick={onRetry} disabled={retrying}>{retrying && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{tp('recoveryRetry')}</Button>
        <Button size="sm" onClick={onSaveNow}>{tp('recoverySaveNow')}</Button>
      </div>
    </div>
  );
}
