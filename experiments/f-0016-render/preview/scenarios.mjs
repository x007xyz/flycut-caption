// 预览性能场景：基线（只播放）、Canvas 方案（默认 / 每帧重画）、JASSUB（方案 D 预览）；30fps 与 60fps 两种视频。
export const SCENARIOS = [];
for (const fps of [30, 60]) {
  const video = `video=/out/clip${fps}.mp4`;
  SCENARIOS.push(
    { id: `none-${fps}`, query: `engine=none&variant=anim-landscape&${video}` },
    { id: `canvas-anim-${fps}`, query: `engine=canvas&variant=anim-landscape&${video}` },
    { id: `canvas-anim-nodedupe-${fps}`, query: `engine=canvas&variant=anim-landscape&nodedupe=1&${video}` },
    { id: `canvas-shadow-native-nodedupe-${fps}`, query: `engine=canvas&variant=static-shadow&nodedupe=1&${video}` },
    { id: `jassub-anim-${fps}`, query: `engine=jassub&variant=anim-landscape&${video}` },
  );
}
