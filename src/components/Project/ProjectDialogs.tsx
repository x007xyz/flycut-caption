// 项目相关的对话框和提示条（F-0002 AC-4、AC-7、AC-8、AC-9；F-0003 AC-21、AC-22、AC-24、AC-28、AC-31、AC-32）。只负责展示。
import { useState } from 'react';
import { AlertTriangle, FileWarning, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fill } from './format';
import { useProjectText } from './useProjectText';

export interface UnsavedChangesDialogProps {
  open: boolean;
  retrying?: boolean;
  onRetry: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

/** 自动保存失败时关闭窗口或切换项目：重试 / 放弃修改 / 取消 */
export function UnsavedChangesDialog({ open, retrying, onRetry, onDiscard, onCancel }: UnsavedChangesDialogProps) {
  const { t, tp } = useProjectText();
  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !retrying) onCancel(); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader className="flex-row items-start gap-3 px-6 pt-6">
          <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-aimu-coral" />
          <div>
            <DialogTitle>{tp('unsavedTitle')}</DialogTitle>
            <DialogDescription className="mt-1.5">{tp('unsavedDescription')}</DialogDescription>
          </div>
        </DialogHeader>
        <DialogFooter className="px-6 pt-4 pb-6">
          {/* AC-24：重试期间三个按钮都不可点 */}
          <Button variant="ghost" onClick={onCancel} disabled={retrying}>{t('common.cancel')}</Button>
          <Button variant="outline" className="text-aimu-coral" onClick={onDiscard} disabled={retrying}>{tp('unsavedDiscard')}</Button>
          <Button onClick={onRetry} disabled={retrying}>
            {retrying && <Loader2 className="h-4 w-4 animate-spin" />}{retrying ? tp('unsavedRetrying') : tp('unsavedRetry')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface SaveConflictDialogProps {
  open: boolean;
  projectName: string;
  /** 对方保存的时间（已格式化） */
  otherSavedAt: string;
  onOverwrite: () => void;
  onSaveAsNew: () => void;
  onCancel: () => void;
}

/** 版本冲突：覆盖 / 另存为新项目 / 取消 */
export function SaveConflictDialog({ open, projectName, otherSavedAt, onOverwrite, onSaveAsNew, onCancel }: SaveConflictDialogProps) {
  const { t, tp } = useProjectText();
  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onCancel(); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader className="flex-row items-start gap-3 px-6 pt-6">
          <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-500" />
          <div>
            <DialogTitle>{tp('conflictTitle')}</DialogTitle>
            <DialogDescription className="mt-1.5">{fill(tp('conflictDescription'), { name: projectName, time: otherSavedAt })}</DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody className="px-6 pt-3">
          <p className="rounded bg-aimu-input px-3 py-2 text-xs text-muted-foreground">{tp('conflictHint')}</p>
        </DialogBody>
        <DialogFooter className="px-6 pt-4 pb-6">
          <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="outline" className="text-aimu-coral" onClick={onOverwrite}>{tp('conflictOverwrite')}</Button>
          <Button onClick={onSaveAsNew}>{tp('conflictSaveAsNew')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface ProjectOpenErrorDialogProps {
  open: boolean;
  projectName: string;
  onClose: () => void;
}

/** 项目由更新版本保存，不能打开（AC-8） */
export function ProjectOpenErrorDialog({ open, projectName, onClose }: ProjectOpenErrorDialogProps) {
  const { t, tp } = useProjectText();
  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader className="flex-row items-start gap-3 px-6 pt-6">
          <FileWarning className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-500" />
          <div>
            <DialogTitle>{tp('newerVersionTitle')}</DialogTitle>
            <DialogDescription className="mt-1.5">{fill(tp('newerVersionDescription'), { name: projectName })}</DialogDescription>
          </div>
        </DialogHeader>
        <DialogFooter className="px-6 pt-4 pb-6">
          <Button onClick={onClose}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface MediaMissingBannerProps {
  fileName: string;
  onRelocate: () => void;
}

/** 媒体丢失时放在播放器区域的提示（AC-7），字幕仍可编辑 */
export function MediaMissingBanner({ fileName, onRelocate }: MediaMissingBannerProps) {
  const { tp } = useProjectText();
  return (
    <div role="alert" className="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
      <FileWarning className="h-8 w-8 text-aimu-coral" />
      <div>
        <p className="text-sm font-medium text-foreground">{tp('mediaMissingTitle')}</p>
        <p className="mt-1 text-xs text-muted-foreground">{fill(tp('mediaMissingDescription'), { file: fileName })}</p>
      </div>
      <Button size="sm" onClick={onRelocate}>{tp('mediaMissingRelocate')}</Button>
    </div>
  );
}

export interface RenameProjectDialogProps {
  open: boolean;
  initialName: string;
  /** 保存中：按钮转圈、输入框不可编辑（F-0003 AC-21） */
  saving?: boolean;
  /** 保存失败的提示；对话框不关闭 */
  error?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

/** 重命名项目（F-0003 AC-21）：打开时填好当前名称并全选；空名称或没有改动时不能保存。 */
export function RenameProjectDialog({ open, initialName, saving, error, onSubmit, onCancel }: RenameProjectDialogProps) {
  const { t, tp } = useProjectText();
  const [name, setName] = useState(initialName);
  const [openedWith, setOpenedWith] = useState<string | null>(null);
  // 每次打开都从当前名称开始
  if (open && openedWith !== initialName) { setOpenedWith(initialName); setName(initialName); }
  if (!open && openedWith !== null) setOpenedWith(null);
  const trimmed = name.trim();
  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !saving) onCancel(); }}>
      <DialogContent className="sm:max-w-md" onOpenAutoFocus={event => {
        event.preventDefault();
        const input = (event.currentTarget as HTMLElement | null)?.querySelector('input');
        input?.focus(); input?.select();
      }}>
        <form onSubmit={e => { e.preventDefault(); if (trimmed && trimmed !== initialName && !saving) onSubmit(trimmed); }}>
          <DialogHeader className="px-6 pt-6"><DialogTitle>{tp('renameTitle')}</DialogTitle></DialogHeader>
          <DialogBody className="space-y-2 px-6 pt-4">
            <Label htmlFor="project-name">{tp('renameLabel')}</Label>
            <Input id="project-name" value={name} onChange={e => setName(e.target.value)} maxLength={200} disabled={saving} />
            {error && <p role="alert" className="text-xs text-aimu-coral">{error}</p>}
          </DialogBody>
          <DialogFooter className="px-6 pt-4 pb-6">
            <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={!trimmed || trimmed === initialName || saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}{t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export interface DeleteProjectDialogProps {
  open: boolean;
  projectName: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 删除项目：移到回收站（F-0003 AC-22） */
export function DeleteProjectDialog({ open, projectName, busy, onConfirm, onCancel }: DeleteProjectDialogProps) {
  const { tp } = useProjectText();
  return (
    <ConfirmDialog open={open} icon={<Trash2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-aimu-coral" />} title={tp('deleteTitle', { name: projectName })}
      description={tp('deleteDescription')} confirmLabel={tp('deleteConfirm')} destructive busy={busy} onConfirm={onConfirm} onCancel={onCancel} />
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  icon?: React.ReactNode;
  /** 危险操作：确认按钮用危险样式 */
  destructive?: boolean;
  /** 执行中：按钮转圈、都不可点击 */
  busy?: boolean;
  /** 执行失败的提示；对话框不关闭 */
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 确认对话框：彻底删除、清空回收站、移除视频、恢复跟随项目样式（F-0003 AC-24、AC-28、AC-31）。 */
export function ConfirmDialog({ open, title, description, confirmLabel, icon, destructive, busy, error, onConfirm, onCancel }: ConfirmDialogProps) {
  const { t } = useProjectText();
  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !busy) onCancel(); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader className="flex-row items-start gap-3 px-6 pt-6">
          {icon}
          <div>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="mt-1.5">{description}</DialogDescription>
          </div>
        </DialogHeader>
        {error && <DialogBody className="px-6 pt-3"><p role="alert" className="text-xs text-aimu-coral">{error}</p></DialogBody>}
        <DialogFooter className="px-6 pt-4 pb-6">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant={destructive ? 'destructive' : 'default'} onClick={onConfirm} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}{confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface ProjectDeletedDialogProps {
  open: boolean;
  projectName: string;
  /** 还在回收站（可以恢复）或已彻底删除 */
  state: 'trashed' | 'deleted';
  busy?: boolean;
  error?: string;
  onRestore: () => void;
  onSaveAsNew: () => void;
  onDiscard: () => void;
}

/** 编辑中的项目在别处被删除（F-0003 AC-32） */
export function ProjectDeletedDialog({ open, projectName, state, busy, error, onRestore, onSaveAsNew, onDiscard }: ProjectDeletedDialogProps) {
  const { tp } = useProjectText();
  return (
    <Dialog open={open}>
      <DialogContent showCloseButton={false} className="sm:max-w-md" onEscapeKeyDown={event => event.preventDefault()} onInteractOutside={event => event.preventDefault()}>
        <DialogHeader className="flex-row items-start gap-3 px-6 pt-6">
          <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-aimu-coral" />
          <div>
            <DialogTitle>{tp('projectDeletedTitle')}</DialogTitle>
            <DialogDescription className="mt-1.5">{tp('projectDeletedDescription', { name: projectName })}</DialogDescription>
          </div>
        </DialogHeader>
        {error && <DialogBody className="px-6 pt-3"><p role="alert" className="text-xs text-aimu-coral">{error}</p></DialogBody>}
        <DialogFooter className="px-6 pt-4 pb-6">
          <Button variant="ghost" className="text-aimu-coral" onClick={onDiscard} disabled={busy}>{tp('unsavedDiscard')}</Button>
          <Button variant={state === 'trashed' ? 'outline' : 'default'} onClick={onSaveAsNew} disabled={busy}>{tp('conflictSaveAsNew')}</Button>
          {state === 'trashed' && <Button onClick={onRestore} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{tp('restoreAndSave')}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
