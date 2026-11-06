const play = await window.playFor(20, 30);
const seek = await window.seekTest(20);
return JSON.stringify({ ...play, seek, ua: navigator.userAgent });
