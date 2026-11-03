// FlyCut Caption React Component Library
// Main entry point for npm package

// Import styles
import './index.css'

// Main component export
export { default as FlyCutCaption } from './FlyCutCaption'

// Type exports for TypeScript users
export type {
  FlyCutCaptionProps,
  FlyCutCaptionConfig,
  SubtitleChunk,
  VideoFile,
  ASRProgress,
  VideoSegment,
  VideoProcessingProgress,
  SubtitleStyle,
  SubtitleStylePair
} from './types'

// Configuration export
export { defaultConfig } from './types'

// Utility exports
export { formatTime } from './utils/timeUtils'
export { isVideoFile, formatFileSize } from './utils/fileUtils'

// Locale exports
export {
  LocaleProvider,
  useLocale,
  useTranslation,
  zhCN,
  enUS,
  defaultLocale
} from './contexts/LocaleProvider'

export type { FlyCutCaptionLocale } from './locales'

// Version info（构建时从 package.json 注入）
export const version = __FLYCUT_VERSION__

// Component metadata
export const metadata = {
  name: '@flycut/caption-react',
  description: 'Complete video subtitle editing React component with AI-powered speech recognition',
  author: 'FlyCut Team',
  license: 'SEE LICENSE IN LICENSE'
} as const
