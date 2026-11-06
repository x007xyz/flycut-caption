const out = { vis: document.visibilityState, hasFocus: document.hasFocus() };
out.raf = await Promise.race([new Promise((r) => requestAnimationFrame(() => r('fired'))), new Promise((r) => setTimeout(() => r('timeout'), 2000))]);
const v = document.querySelector('video');
v.currentTime = 30.3;
out.seeked = await Promise.race([new Promise((r) => v.addEventListener('seeked', () => r('fired'), { once: true })), new Promise((r) => setTimeout(() => r('timeout'), 3000))]);
out.raf2 = await Promise.race([new Promise((r) => requestAnimationFrame(() => r('fired'))), new Promise((r) => setTimeout(() => r('timeout'), 2000))]);
return JSON.stringify(out);
