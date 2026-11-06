// 一致性测试的场景组合：3 种静态样式 × 横屏，加动画场景 × 3 种画幅。
export const VARIANTS = [
  { id: 'static-outline', style: 'outline', animation: 'none', aspect: 'landscape' },
  { id: 'static-shadow', style: 'shadow', animation: 'none', aspect: 'landscape' },
  { id: 'static-shadow-manual', style: 'shadow', animation: 'none', aspect: 'landscape', manualShadow: true },
  { id: 'static-box', style: 'box', animation: 'none', aspect: 'landscape' },
  { id: 'anim-landscape', style: 'gradient', animation: 'pop', aspect: 'landscape' },
  { id: 'anim-portrait', style: 'gradient', animation: 'pop', aspect: 'portrait' },
  { id: 'anim-square', style: 'gradient', animation: 'pop', aspect: 'square' },
];
