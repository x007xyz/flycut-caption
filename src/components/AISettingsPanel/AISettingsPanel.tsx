// Host-backed AI model settings. Public snapshots never contain API keys.
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/appStore'
import { useRuntimeStoreApi } from '@/stores/runtimeStore'
import { useTranslation } from '@/contexts/LocaleProvider'
import { useClientRuntime } from '@/runtime/context'
import type { AIModelView } from '@/types/ai'
import { completeAIMigration, prepareAIMigration, type LegacyAISettingsSource } from '@/services/aiMigration'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AlertTriangle, Check, Cpu, Loader2, Pencil, Plus, RefreshCw, TestTube2, Trash2 } from 'lucide-react'

interface FormState {
  name: string
  baseUrl: string
  apiKey: string
  clearApiKey: boolean
  model: string
  temperature: string
  headers: string
}
const EMPTY_FORM: FormState = {
  name: '',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  clearApiKey: false,
  model: 'gpt-4o-mini',
  temperature: '0.2',
  headers: '',
}

type Message = { kind: 'error' | 'success' | 'warning'; text: string }

export function AISettingsPanel() {
  const { t } = useTranslation()
  const { connection } = useClientRuntime()
  const app = useRuntimeStoreApi('app')
  const aiModels = useAppStore((s) => s.aiModels)
  const selectedAIModelId = useAppStore((s) => s.selectedAIModelId)
  const hostId = useAppStore((s) => s.aiSettingsHostId)
  const revision = useAppStore((s) => s.aiSettingsRevision)
  const applyAISettings = useAppStore((s) => s.applyAISettings)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [busy, setBusy] = useState<'reload' | 'save' | 'delete' | 'select' | 'test' | 'migrate' | null>(null)
  const [message, setMessage] = useState<Message | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AIModelView | null>(null)
  const [migration, setMigration] = useState<{ source: LegacyAISettingsSource; migrationId: string } | null>(null)
  const [migrationOpen, setMigrationOpen] = useState(false)
  const requestEpoch = useRef(0)

  useEffect(() => {
    const epoch = ++requestEpoch.current
    setBusy(null); setDialogOpen(false); setEditingId(null); setDeleteTarget(null); setMigrationOpen(false); setForm(EMPTY_FORM)
    setMigration(hostId ? prepareAIMigration(hostId) : null)
    setMessage(null)
    return () => { if (requestEpoch.current === epoch) requestEpoch.current += 1 }
  }, [hostId])

  const currentHost = () => app.getState().aiSettingsHostId
  const currentRevision = () => app.getState().aiSettingsRevision
  const sameHost = (responseHostId: string, expectedHostId: string) => responseHostId === expectedHostId && currentHost() === expectedHostId
  const requestIsCurrent = (epoch: number, expectedHostId: string) => epoch === requestEpoch.current && currentHost() === expectedHostId

  const reload = async () => {
    if (!hostId) return
    const expectedHostId = hostId; const epoch = requestEpoch.current
    setBusy('reload'); setMessage(null)
    try {
      const snapshot = await connection.call('aiSettings.list')
      if (!requestIsCurrent(epoch, expectedHostId)) return
      if (!sameHost(snapshot.hostId, expectedHostId)) {
        setMessage({ kind: 'warning', text: t('components.aiSettings.hostChanged') })
        return
      }
      applyAISettings(snapshot); setMessage({ kind: 'success', text: t('components.aiSettings.refreshed') })
    } catch (error) {
      if (requestIsCurrent(epoch, expectedHostId)) setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally { if (requestIsCurrent(epoch, expectedHostId)) setBusy(null) }
  }

  const openAdd = () => {
    setEditingId(null); setForm(EMPTY_FORM); setMessage(null); setDialogOpen(true)
  }

  const openEdit = (model: AIModelView) => {
    setEditingId(model.id)
    setForm({ name: model.name, baseUrl: model.baseUrl, apiKey: '', clearApiKey: false, model: model.model,
      temperature: model.temperature !== undefined ? String(model.temperature) : '',
      headers: model.headers ? JSON.stringify(model.headers) : '' })
    setMessage(null); setDialogOpen(true)
  }

  const handleSave = async () => {
    if (!hostId || !form.name.trim() || !form.baseUrl.trim() || !form.model.trim()) return
    let headers: Record<string, string> | undefined
    if (form.headers.trim()) {
      try {
        const parsed = JSON.parse(form.headers) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
          || Object.values(parsed).some(value => typeof value !== 'string')) throw new Error('invalid')
        headers = parsed as Record<string, string>
      } catch {
        setMessage({ kind: 'error', text: '请求头必须是 JSON 对象，值必须是字符串 / Headers must be a JSON object of strings' })
        return
      }
    }
    const expectedHostId = hostId; const epoch = requestEpoch.current
    setBusy('save'); setMessage(null)
    try {
      const result = await connection.call('aiSettings.save', {
        hostId: expectedHostId, expectedRevision: revision, configId: editingId ?? undefined,
        config: { name: form.name.trim(), baseUrl: form.baseUrl.trim(), model: form.model.trim(),
          temperature: form.temperature.trim() ? Number(form.temperature) : undefined,
          ...(headers ? { headers } : {}),
          apiKey: form.apiKey || undefined, clearApiKey: form.clearApiKey || undefined },
      })
      if (epoch !== requestEpoch.current) return
      if (!sameHost(result.snapshot.hostId, expectedHostId)) return
      applyAISettings(result.snapshot)
      if (result.status === 'conflict') {
        setMessage({ kind: 'warning', text: t('components.aiSettings.conflict') })
        return
      }
      setDialogOpen(false); setForm(EMPTY_FORM)
      setMessage({ kind: 'success', text: t('components.aiSettings.saved') })
    } catch (error) {
      if (requestIsCurrent(epoch, expectedHostId)) setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally { if (requestIsCurrent(epoch, expectedHostId)) setBusy(null) }
  }

  const remove = async () => {
    if (!deleteTarget || !hostId) return
    const expectedHostId = hostId; const epoch = requestEpoch.current
    setBusy('delete'); setMessage(null)
    try {
      const result = await connection.call('aiSettings.remove', { hostId: expectedHostId,
        expectedRevision: currentRevision(), configId: deleteTarget.id })
      if (epoch !== requestEpoch.current) return
      if (!sameHost(result.snapshot.hostId, expectedHostId)) return
      applyAISettings(result.snapshot)
      setDeleteTarget(null)
      setMessage(result.status === 'conflict'
        ? { kind: 'warning', text: t('components.aiSettings.conflict') }
        : { kind: 'success', text: t('components.aiSettings.deleted') })
    } catch (error) {
      if (requestIsCurrent(epoch, expectedHostId)) setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally { if (requestIsCurrent(epoch, expectedHostId)) setBusy(null) }
  }

  const select = async (configId: string) => {
    if (!hostId || configId === selectedAIModelId) return
    const expectedHostId = hostId; const epoch = requestEpoch.current
    setBusy('select'); setMessage(null)
    try {
      const result = await connection.call('aiSettings.select', { hostId: expectedHostId,
        expectedRevision: currentRevision(), configId })
      if (epoch !== requestEpoch.current) return
      if (!sameHost(result.snapshot.hostId, expectedHostId)) return
      applyAISettings(result.snapshot)
      if (result.status === 'conflict') setMessage({ kind: 'warning', text: t('components.aiSettings.conflict') })
    } catch (error) {
      if (requestIsCurrent(epoch, expectedHostId)) setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally { if (requestIsCurrent(epoch, expectedHostId)) setBusy(null) }
  }

  const test = async (model: AIModelView) => {
    if (!hostId) return
    const expectedHostId = hostId; const epoch = requestEpoch.current
    setBusy('test'); setMessage(null)
    try {
      const result = await connection.call('aiSettings.test', { hostId: expectedHostId, configId: model.id })
      if (!requestIsCurrent(epoch, expectedHostId)) return
      setMessage({ kind: result.status === 'ok' ? 'success' : 'error', text: result.message })
    } catch (error) {
      if (requestIsCurrent(epoch, expectedHostId)) setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally { if (requestIsCurrent(epoch, expectedHostId)) setBusy(null) }
  }

  const migrate = async () => {
    if (!hostId || !migration) return
    const expectedHostId = hostId; const migrationId = migration.migrationId; const epoch = requestEpoch.current
    setBusy('migrate'); setMessage(null)
    try {
      const result = await connection.call('aiSettings.import', { hostId: expectedHostId,
        expectedRevision: currentRevision(), migrationId, selectedSourceId: migration.source.selectedSourceId,
        configs: migration.source.configs })
      if (epoch !== requestEpoch.current || !sameHost(result.snapshot.hostId, expectedHostId)) return
      applyAISettings(result.snapshot)
      if (result.status === 'conflict') {
        setMessage({ kind: 'warning', text: t('components.aiSettings.conflict') })
        return
      }
      if (!completeAIMigration(expectedHostId, migrationId)) {
        setMessage({ kind: 'warning', text: t('components.aiSettings.migrationChanged') })
        return
      }
      setMigration(null); setMigrationOpen(false)
      setMessage({ kind: 'success', text: t('components.aiSettings.migrationDone') })
    } catch (error) {
      if (epoch === requestEpoch.current && currentHost() === expectedHostId) {
        setMessage({ kind: 'error', text: `${t('components.aiSettings.migrationFailed')}: ${error instanceof Error ? error.message : String(error)}` })
      }
    } finally { if (epoch === requestEpoch.current && currentHost() === expectedHostId) setBusy(null) }
  }

  const editingHasKey = !!editingId && !!aiModels.find(model => model.id === editingId)?.hasApiKey
  const canSave = !!hostId && !!form.name.trim() && !!form.baseUrl.trim() && !!form.model.trim()
    && (!!editingId || !!form.apiKey.trim()) && busy !== 'save'

  return (
    <div className="flex h-full flex-col space-y-3" data-testid="ai-settings-panel">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-aimu-purple" />
          <span className="text-sm font-medium">{t('components.aiSettings.title')}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="outline" onClick={() => void reload()} disabled={!hostId || !!busy} data-testid="ai-settings-refresh">
            <RefreshCw className={cn('mr-1 h-3.5 w-3.5', busy === 'reload' && 'animate-spin')} />
            {t('components.aiSettings.refresh')}
          </Button>
          <Button size="sm" onClick={openAdd} disabled={!hostId || !!busy} data-testid="ai-config-add">
            <Plus className="mr-1 h-3.5 w-3.5" />{t('components.aiSettings.addModel')}
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">{t('components.aiSettings.description')}</p>
      {!hostId && <p className="text-xs text-aimu-coral" data-testid="ai-no-host">{t('components.aiSettings.noHost')}</p>}
      {hostId && <p className="text-[11px] text-muted-foreground">{t('components.aiSettings.hostTarget')}: {hostId}</p>}

      {message && <div role="status" data-testid={`ai-message-${message.kind}`} className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-xs',
        message.kind === 'error' && 'border-destructive/40 text-destructive',
        message.kind === 'warning' && 'border-amber-500/40 text-amber-700 dark:text-amber-300',
        message.kind === 'success' && 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300')}>
        {message.kind === 'success' ? <Check className="mt-0.5 h-3.5 w-3.5" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5" />}
        <span>{message.text}</span>
      </div>}

      {busy && <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="ai-processing">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />{t('components.aiSettings.processing')}
      </div>}

      {migration && hostId && <section className="rounded-md border border-aimu-purple/40 bg-aimu-purple/5 p-3" data-testid="ai-migration-card">
        <p className="text-sm font-medium">{t('components.aiSettings.migrationTitle')}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t('components.aiSettings.migrationDescription').replace('{{count}}', String(migration.source.configs.length))}</p>
        <ul className="mt-2 space-y-1 text-[11px] text-muted-foreground">
          {migration.source.configs.map(item => <li key={item.sourceId}>{item.name} · {item.model}</li>)}
        </ul>
        <Button size="sm" className="mt-2 h-8" onClick={() => setMigrationOpen(true)} disabled={!!busy} data-testid="ai-migration-review">
          {t('components.aiSettings.migrationReview')}
        </Button>
      </section>}

      {!hostId ? null : aiModels.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-center" data-testid="ai-empty">
          <Cpu className="mb-2 h-8 w-8 text-muted-foreground/40" />
          <p className="text-xs text-muted-foreground">{t('components.aiSettings.emptyTip')}</p>
        </div>
      ) : (
        <div className="space-y-2" data-testid="ai-config-list">
          {aiModels.map((model) => {
            const isSelected = model.id === selectedAIModelId
            return <div key={model.id} data-testid="ai-config-row" className={cn('flex items-center justify-between rounded-md border p-3',
              isSelected ? 'border-aimu-purple bg-aimu-purple/5' : 'border-border')}>
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => void select(model.id)} disabled={!!busy}>
                <span className="flex items-center gap-2 text-sm font-medium"><span className={cn('h-2 w-2 rounded-full', model.hasApiKey ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />{model.name}{isSelected && <Check className="h-3.5 w-3.5 text-aimu-purple" />}</span>
                <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{model.model} · {model.baseUrl} · {model.hasApiKey ? t('components.aiSettings.keyConfigured') : t('components.aiSettings.keyMissing')}</span>
              </button>
              <div className="ml-2 flex items-center gap-1">
                <button type="button" onClick={() => void test(model)} disabled={!!busy || !model.hasApiKey} className="rounded p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-40" title={t('components.aiSettings.test')} data-testid="ai-config-test"><TestTube2 className="h-3.5 w-3.5" /></button>
                <button type="button" onClick={() => openEdit(model)} disabled={!!busy} className="rounded p-1.5 text-muted-foreground hover:text-foreground" title={t('components.aiSettings.editModel')} data-testid="ai-config-edit"><Pencil className="h-3.5 w-3.5" /></button>
                <button type="button" onClick={() => setDeleteTarget(model)} disabled={!!busy} className="rounded p-1.5 text-muted-foreground hover:text-aimu-coral" title={t('components.aiSettings.delete')} data-testid="ai-config-delete"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          })}
        </div>
      )}

      <p className="mt-2 text-[11px] text-muted-foreground">{t('components.aiSettings.apiKeyHint')}</p>

      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!busy) setDialogOpen(open) }}>
        <DialogContent className="sm:max-w-md" data-testid="ai-config-dialog">
          <DialogHeader><DialogTitle>{editingId ? t('components.aiSettings.editModel') : t('components.aiSettings.addModel')}</DialogTitle></DialogHeader>
          <DialogBody className="space-y-3">
            <div className="space-y-1"><Label>{t('components.aiSettings.name')}</Label><Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="My GPT-4o" /></div>
            <div className="space-y-1"><Label>{t('components.aiSettings.baseUrl')}</Label><Input value={form.baseUrl} onChange={e => setForm(f => ({ ...f, baseUrl: e.target.value }))} placeholder="https://api.openai.com/v1" /></div>
            <div className="space-y-1"><Label>{t('components.aiSettings.model')}</Label><Input value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} placeholder="gpt-4o-mini" /></div>
            <div className="space-y-1"><Label>{t('components.aiSettings.apiKey')}</Label><Input data-testid="ai-api-key" type="password" autoComplete="new-password" value={form.apiKey} onChange={e => setForm(f => ({ ...f, apiKey: e.target.value, ...(e.target.value ? { clearApiKey: false } : {}) }))} placeholder={editingId ? t('components.aiSettings.keepKey') : 'sk-...'} />
              {editingHasKey && !form.apiKey && <button type="button" className="text-[11px] text-destructive underline underline-offset-2" onClick={() => setForm(f => ({ ...f, clearApiKey: !f.clearApiKey }))} data-testid="ai-clear-api-key">
                {form.clearApiKey ? t('components.aiSettings.cancelClearKey') : t('components.aiSettings.clearKey')}
              </button>}
              {form.clearApiKey && <p className="text-[11px] text-amber-600 dark:text-amber-300">{t('components.aiSettings.clearKeyPending')}</p>}
            </div>
            <div className="space-y-1"><Label>{t('components.aiSettings.temperature')}</Label><Input value={form.temperature} onChange={e => setForm(f => ({ ...f, temperature: e.target.value }))} placeholder="0.2" /></div>
            <div className="space-y-1"><Label>请求头 JSON / Headers JSON（可选）</Label><Input data-testid="ai-headers" value={form.headers} onChange={e => setForm(f => ({ ...f, headers: e.target.value }))} placeholder='{"x-opencode-session":"ses_..."}' /></div>
          </DialogBody>
          <DialogFooter className="border-t">
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={!!busy}>{t('components.aiSettings.cancel')}</Button>
            <Button onClick={() => void handleSave()} disabled={!canSave} data-testid="ai-config-save">
              {busy === 'save' && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}{t('components.aiSettings.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open && !busy) setDeleteTarget(null) }}>
        <DialogContent className="sm:max-w-sm"><DialogHeader><DialogTitle>{t('components.aiSettings.deleteConfirmTitle')}</DialogTitle></DialogHeader>
          <DialogBody><p className="text-sm">{t('components.aiSettings.deleteConfirm').replace('{{name}}', deleteTarget?.name ?? '')}</p></DialogBody>
          <DialogFooter><Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={!!busy}>{t('components.aiSettings.cancel')}</Button>
            <Button variant="destructive" onClick={() => void remove()} disabled={!!busy} data-testid="ai-delete-confirm">{t('components.aiSettings.delete')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={migrationOpen} onOpenChange={(open) => { if (!busy) setMigrationOpen(open) }}>
        <DialogContent className="sm:max-w-md" data-testid="ai-migration-dialog">
          <DialogHeader><DialogTitle>{t('components.aiSettings.migrationConfirmTitle')}</DialogTitle></DialogHeader>
          <DialogBody className="space-y-2 text-sm">
            <p>{t('components.aiSettings.migrationTarget').replace('{{host}}', hostId ?? '')}</p>
            <p className="text-xs text-muted-foreground">{t('components.aiSettings.migrationWarning')}</p>
          </DialogBody>
          <DialogFooter><Button variant="outline" onClick={() => setMigrationOpen(false)} disabled={!!busy} data-testid="ai-migration-cancel">{t('components.aiSettings.cancel')}</Button>
            <Button onClick={() => void migrate()} disabled={!!busy} data-testid="ai-migration-run">{busy === 'migrate' && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}{t('components.aiSettings.migrationRun')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

