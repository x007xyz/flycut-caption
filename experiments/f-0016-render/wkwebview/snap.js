const ids = ['static-outline', 'static-shadow', 'static-shadow-manual', 'static-box', 'anim-landscape', 'anim-portrait', 'anim-square'];
const out = {};
for (const id of ids) { out[id] = await window.snap(id); out[id + ':layouts'] = window.layouts(id); }
out.ua = navigator.userAgent;
return JSON.stringify(out);
