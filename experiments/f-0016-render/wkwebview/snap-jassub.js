const out = await window.snapComposite();
return JSON.stringify({ ua: navigator.userAgent, dpr: devicePixelRatio, shots: out });
