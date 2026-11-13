import { z } from 'zod';
import { DEFAULT_SUBTITLE_FONT_ID, resolveSubtitleFontFamily } from './fonts';

export const subtitleGraphicStyleSchema = z.object({
  fontId: z.string().min(1).max(64),
  fontFamily: z.string().min(1).max(200),
  fontSizeRatio: z.number().min(0.001).max(0.5),
  bottomOffsetRatio: z.number().min(0).max(1),
  fontWeight: z.enum(['normal', 'bold']),
  fontStyle: z.enum(['normal', 'italic']),
  textDecoration: z.enum(['none', 'underline']),
  color: z.string().min(1).max(64),
  colorOpacity: z.number().min(0).max(1),
  backgroundColor: z.string().min(1).max(64),
  borderColor: z.string().min(1).max(64),
  borderOpacity: z.number().min(0).max(1),
  shadowColor: z.string().min(1).max(64),
  textAlign: z.enum(['left', 'center', 'right']),
  lineHeight: z.number().min(0.8).max(5),
  letterSpacing: z.number().min(-20).max(100),
  borderWidth: z.number().min(0).max(100),
  shadowOffsetX: z.number().min(-100).max(100),
  shadowOffsetY: z.number().min(-100).max(100),
  shadowBlur: z.number().min(0).max(100),
  backgroundOpacity: z.number().min(0).max(1),
  backgroundRadius: z.number().min(0).max(200),
  backgroundPadding: z.number().min(0).max(200),
  /** Optional for F-0028 scenes created before word highlighting. */
  wordHighlightMode: z.enum(['none', 'word']).optional(),
  wordHighlightColor: z.string().min(1).max(64).optional(),
  visible: z.boolean(),
});
export type SubtitleGraphicStyle = z.infer<typeof subtitleGraphicStyleSchema>;

export const subtitleGraphicWordSchema = z.object({
  text: z.string().max(2000),
  start: z.number().min(0),
  end: z.number().min(0),
  keyword: z.boolean().optional(),
}).refine(word => word.end > word.start, 'Subtitle word must have a positive duration');
export type SubtitleGraphicWord = z.infer<typeof subtitleGraphicWordSchema>;

export const subtitleGraphicCueSchema = z.object({
  id: z.string().min(1).max(300),
  start: z.number().min(0),
  end: z.number().min(0),
  text: z.string().max(20000),
  secondText: z.string().max(20000).optional(),
  words: z.array(subtitleGraphicWordSchema).max(5000).optional(),
}).refine(cue => cue.end > cue.start, 'Subtitle cue must have a positive duration')
  .superRefine((cue, ctx) => {
    let previousEnd = -Infinity;
    for (const [index, word] of (cue.words ?? []).entries()) {
      if (word.start < cue.start - 0.02 || word.end > cue.end + 0.02) {
        ctx.addIssue({ code: 'custom', message: 'Subtitle word time is outside its cue', path: [index] });
      }
      if (word.start < previousEnd - 0.02) {
        ctx.addIssue({ code: 'custom', message: 'Subtitle words must be in time order without overlap', path: [index] });
      }
      previousEnd = word.end;
    }
  });

export const subtitleGraphicSceneSchema = z.object({
  version: z.literal(1),
  width: z.number().int().min(2).max(8192),
  height: z.number().int().min(2).max(8192),
  fps: z.number().min(0.1).max(240),
  duration: z.number().min(0).max(86400),
  fontId: z.string().min(1).max(64),
  fontFamily: z.string().min(1).max(200),
  displayMode: z.enum(['Bilingual', 'Main', 'Second']),
  maxWidthRatio: z.number().min(0.1).max(1),
  primary: subtitleGraphicStyleSchema,
  secondary: subtitleGraphicStyleSchema.optional(),
  cues: z.array(subtitleGraphicCueSchema).max(20000),
});
export type SubtitleGraphicScene = z.infer<typeof subtitleGraphicSceneSchema>;
export type SubtitleGraphicCue = z.infer<typeof subtitleGraphicCueSchema>;
export type SubtitleDisplayMode = SubtitleGraphicScene['displayMode'];

export function emptySubtitleGraphicStyle(fontId = DEFAULT_SUBTITLE_FONT_ID): SubtitleGraphicStyle {
  return {
    fontId,
    fontFamily: resolveSubtitleFontFamily(fontId),
    fontSizeRatio: 0.045,
    bottomOffsetRatio: 60 / 1080,
    fontWeight: 'bold',
    fontStyle: 'normal',
    textDecoration: 'none',
    color: '#FFFFFF',
    colorOpacity: 1,
    backgroundColor: '#000000',
    borderColor: '#000000',
    borderOpacity: 1,
    shadowColor: '#000000',
    textAlign: 'center',
    lineHeight: 1.2,
    letterSpacing: 0,
    borderWidth: 2,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    shadowBlur: 0,
    backgroundOpacity: 0,
    backgroundRadius: 4,
    backgroundPadding: 8,
    wordHighlightMode: 'none',
    wordHighlightColor: '#FFE100',
    visible: true,
  };
}

export function validateSubtitleGraphicScene(value: unknown): SubtitleGraphicScene {
  return subtitleGraphicSceneSchema.parse(value);
}
