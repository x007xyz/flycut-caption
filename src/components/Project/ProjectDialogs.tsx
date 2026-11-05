// 项目相关的对话框和提示条（F-0002 AC-4、AC-7、AC-8、AC-9）。只负责展示。
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
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

/** 重命名项目（E-02/6） */
export function RenameProjectDialog({ open, initialName, onSubmit, onCancel }: RenameProjectDialogProps) {
  const { t, tp } = useProjectText();
  const [name, setName] = useState(initialName);
  const trimmed = name.trim();
  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onCancel(); else setName(initialName); }}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={e => { e.preventDefault(); if (trimmed) onSubmit(trimmed); }}>
          <DialogHeader className="px-6 pt-6"><DialogTitle>{tp('renameTitle')}</DialogTitle></DialogHeader>
          <DialogBody className="space-y-2 px-6 pt-4">
            <Label htmlFor="project-name">{tp('renameLabel')}</Label>
            <Input id="project-name" autoFocus value={name} onChange={e => setName(e.target.value)} maxLength={120} />
          </DialogBody>
          <DialogFooter className="px-6 pt-4 pb-6">
            <Button type="button" variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={!trimmed || trimmed === initialName}>{t('common.save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export interface DeleteProjectDialogProps {
  open: boolean;
  projectName: string;
  videoCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 删除项目确认（E-02/6） */
export function DeleteProjectDialog({ open, projectName, videoCount, onConfirm, onCancel }: DeleteProjectDialogProps) {
  const { t, tp } = useProjectText();
  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onCancel(); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader className="flex-row items-start gap-3 px-6 pt-6">
          <Trash2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-aimu-coral" />
          <div>
            <DialogTitle>{tp('deleteTitle', { name: projectName })}</DialogTitle>
            <DialogDescription className="mt-1.5">{tp('deleteDescription', { count: videoCount })}</DialogDescription>
          </div>
        </DialogHeader>
        <DialogFooter className="px-6 pt-4 pb-6">
          <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="destructive" onClick={onConfirm}>{tp('deleteConfirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
