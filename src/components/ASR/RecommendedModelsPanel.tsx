import { ASR_RECOMMENDATIONS } from '@/config/asrRecommendations';

export function RecommendedModelsPanel() {
  return <details className="rounded-md border p-3 space-y-3">
    <summary className="text-sm font-medium cursor-pointer">推荐模型与下载指引</summary>
    <p className="text-xs text-muted-foreground">请自行从官方来源下载并解压，再指定本地模型文件夹。推荐代表适配方向，识别质量与速度仍需用自己的音频验证。</p>
    {ASR_RECOMMENDATIONS.map(model => <article key={model.name} className="border-t pt-2 space-y-1">
      <h5 className="text-xs font-medium">{model.name}</h5>
      <p className="text-xs">{model.use}</p>
      <p className="text-[11px] text-muted-foreground">{model.format}</p>
      <p className="text-[11px] text-muted-foreground">{model.timing}</p>
      <a className="text-xs text-primary hover:underline" href={model.url} target="_blank" rel="noreferrer">{model.label} ↗</a>
    </article>)}
    <a className="text-xs text-primary hover:underline" href="https://github.com/snakers4/silero-vad" target="_blank" rel="noreferrer">Silero VAD 官方项目 ↗</a>
  </details>;
}
