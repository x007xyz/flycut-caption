// 生成测试用贴图（一个渐变五角星 PNG），前后端读同一个文件。
import { createCanvas } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';
const c = createCanvas(256, 256); const g = c.getContext('2d');
const grad = g.createLinearGradient(0, 0, 256, 256); grad.addColorStop(0, '#FFE259'); grad.addColorStop(1, '#FFA751');
g.beginPath();
for (let i = 0; i < 10; i++) { const r = i % 2 ? 50 : 120; const a = -Math.PI / 2 + i * Math.PI / 5; g.lineTo(128 + r * Math.cos(a), 132 + r * Math.sin(a)); }
g.closePath(); g.fillStyle = grad; g.fill(); g.lineWidth = 10; g.strokeStyle = '#7A3B00'; g.lineJoin = 'round'; g.stroke();
writeFileSync(new URL('../assets/sticker.png', import.meta.url), c.toBuffer('image/png'));
console.log('ok');
