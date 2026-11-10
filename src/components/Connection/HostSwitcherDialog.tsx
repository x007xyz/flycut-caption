// F-0014 AC-2、AC-3、AC-6：切换目标必须先确认；候选连接成功前旧运行时保持挂载。
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { validateHostUrl } from '@/runtime/connectionModel';
import { useConnectionState, useHostSession } from '@/runtime/connectionHooks';
import { useConnectionText } from './useConnectionText';

export function HostSwitcherDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { tc } = useConnectionText();
  const session = useHostSession();
  const snapshot = useConnectionState();
  const [input, setInput] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    if (!open) return;
    setInput(snapshot.target?.url ?? session.lastTargetUrl() ?? '');
    setTouched(false); setError(undefined); setBusy(false);
  }, [open, snapshot.target?.url, session]);
  const checked = validateHostUrl(input);
  const invalid = touched && !checked.ok;
  const submit = async () => {
    setTouched(true);
    if (!checked.ok || !checked.url) return;
    setBusy(true); setError(undefined);
    const ok = await session.switchHost(checked.url);
    setBusy(false);
    if (ok) onOpenChange(false);
    else setError(session.snapshot().error?.message ?? tc('switchFailed'));
  };
  return (
    <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-lg" data-testid="host-switcher-dialog">
        <DialogHeader>
          <DialogTitle>{tc('switchTitle')}</DialogTitle>
          <DialogDescription>{tc('switchDescription')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {tc('currentHost')}: <span className="font-mono text-foreground">{snapshot.target?.url ?? tc('unknown')}</span>
          </div>
          <label htmlFor="switch-host-url" className="text-xs font-medium text-muted-foreground">{tc('targetHost')}</label>
          <Input id="switch-host-url" data-testid="switch-host-input" value={input} autoComplete="off" spellCheck={false}
            onChange={event => { setInput(event.target.value); setTouched(true); }} onKeyDown={event => { if (event.key === 'Enter') void submit(); }}
            placeholder="https://flycut.example.com" aria-invalid={invalid || undefined} />
          {invalid && <p role="alert" className="text-xs text-aimu-coral">{tc('invalidAddress')}</p>}
          {error && <p role="alert" className="rounded-md bg-aimu-red-bg px-3 py-2 text-xs text-aimu-coral">{error}</p>}
          <p className="text-[11px] leading-5 text-muted-foreground">{tc('switchHint')}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>{tc('cancel')}</Button>
          <Button onClick={() => void submit()} disabled={busy || !checked.ok} data-testid="switch-host-confirm">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}{tc('confirmSwitch')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
