// 设置弹窗 - 模型（Provider）+ 编辑插件 / 智能剪切空白段阈值

import { ModelsPanel } from '@/components/ASR/ModelsPanel';
import { PluginRegistryPanel } from '@/components/ProcessingPanel/PluginRegistryPanel';
import { ConnectionDetails } from '@/components/Connection';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Slider } from '@/components/ui/slider';
import { Boxes, Package, PlugZap, Puzzle, Wand2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useTranslation } from '@/contexts/LocaleProvider';
import { asrModelsCopy } from '@/locales/models';
import { useState, type ReactNode } from 'react';

type SettingsSection = 'models' | 'plugins' | 'connection';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { t, language } = useTranslation();
  const mc = asrModelsCopy(language);
  const [section, setSection] = useState<SettingsSection>('models');
  const smartCutSilenceThreshold = useAppStore(state => state.smartCutSilenceThreshold);
  const setSmartCutSilenceThreshold = useAppStore(state => state.setSmartCutSilenceThreshold);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:!max-w-4xl">
        <DialogHeader className="border-b border-aimu-border">
          <DialogTitle className="flex items-center space-x-2">
            <Package className="h-5 w-5" />
            <div>
              <span>{t('components.workstation.tools')}</span>
              <p className="mt-0.5 text-xs font-normal text-muted-foreground">{mc.settingsSubtitle}</p>
            </div>
          </DialogTitle>
        </DialogHeader>

        <DialogBody className="p-0">
          <div className="flex min-h-[460px] flex-col md:flex-row">
            <nav className="border-b border-aimu-border bg-muted/20 p-2 md:w-44 md:border-b-0 md:border-r">
              <div className="grid grid-cols-2 gap-1 md:grid-cols-1">
                <SectionButton active={section === 'models'} icon={<Boxes className="h-4 w-4" />} label={mc.tabModels} onClick={() => setSection('models')} />
                <SectionButton active={section === 'plugins'} icon={<Puzzle className="h-4 w-4" />} label={mc.tabPlugins} onClick={() => setSection('plugins')} />
                <SectionButton active={section === 'connection'} icon={<PlugZap className="h-4 w-4" />} label={mc.tabConnection} onClick={() => setSection('connection')} />
              </div>
            </nav>

            <div className="min-w-0 flex-1 overflow-y-auto px-4 pb-5 md:px-6">
              {section === 'models' && <>
                <div className="pt-4">
                  <h2 className="text-sm font-semibold text-aimu-text-primary">{mc.tabModels}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">{mc.modelsSectionDesc}</p>
                </div>
                <ModelsPanel />
              </>}

              {section === 'plugins' && <>
                <PluginRegistryPanel />
                <div className="pt-4 mt-4 border-t border-aimu-border">
                  <div className="flex items-center gap-2 mb-3">
                    <Wand2 className="h-4 w-4 text-aimu-coral" />
                    <span className="text-sm font-medium text-aimu-text-primary">{t('components.workstation.smartCutBlankTitle')}</span>
                  </div>
                  <div className="px-1">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-aimu-text-muted">{t('components.workstation.smartCutThreshold')}</span>
                      <span className="text-xs font-mono text-aimu-text-primary">{smartCutSilenceThreshold.toFixed(1)}s</span>
                    </div>
                    <Slider value={[smartCutSilenceThreshold]} min={0.2} max={5} step={0.1} onValueChange={(v) => setSmartCutSilenceThreshold(v[0])} />
                  </div>
                </div>
              </>}

              {section === 'connection' && <>
                <div className="pt-4">
                  <h2 className="text-sm font-semibold text-aimu-text-primary">{mc.tabConnection}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">{mc.connectionSectionDesc}</p>
                </div>
                <div className="mt-4"><ConnectionDetails /></div>
              </>}
            </div>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function SectionButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={`flex min-h-9 items-center justify-center gap-2 rounded-md px-2 text-xs transition-colors md:justify-start ${active ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>
    {icon}<span className="hidden md:inline">{label}</span><span className="md:hidden">{label.slice(0, 2)}</span>
  </button>;
}
