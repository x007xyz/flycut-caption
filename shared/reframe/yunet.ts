// YuNet 2023mar post-processing, following OpenCV's FaceDetectorYN decode and NMS.
export interface FaceBox { x: number; y: number; w: number; h: number; score: number; landmarks: Array<[number, number]> }

const strides = [8, 16, 32];
const clamp = (value: number) => Math.min(1, Math.max(0, value));

function iou(a: FaceBox, b: FaceBox) {
  const x1 = Math.max(a.x, b.x); const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w); const y2 = Math.min(a.y + a.h, b.y + b.h);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - intersection;
  return union > 0 ? intersection / union : 0;
}

function nms(faces: FaceBox[], threshold: number): FaceBox[] {
  const sorted = [...faces].sort((a, b) => b.score - a.score);
  const kept: FaceBox[] = [];
  for (const face of sorted) {
    if (kept.every(other => iou(face, other) < threshold)) kept.push(face);
  }
  return kept;
}

/** Outputs are the 12 YuNet tensors; coordinates are in the 640×640 model input. */
export function decodeYunet(outputs: Record<string, Float32Array>, options: { scoreThreshold?: number; nmsThreshold?: number } = {}): FaceBox[] {
  const scoreThreshold = options.scoreThreshold ?? 0.6;
  const faces: FaceBox[] = [];
  for (const stride of strides) {
    const space = stride === 8 ? 8 : stride === 16 ? 16 : 32;
    const cols = 640 / space; const rows = 640 / space;
    const cls = outputs[`cls_${stride}`]; const obj = outputs[`obj_${stride}`];
    const bbox = outputs[`bbox_${stride}`]; const kps = outputs[`kps_${stride}`];
    if (!cls || !obj || !bbox || !kps) continue;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const idx = r * cols + c;
        const score = Math.sqrt(clamp(cls[idx]) * clamp(obj[idx]));
        if (score < scoreThreshold) continue;
        const cx = (c + bbox[idx * 4]) * space;
        const cy = (r + bbox[idx * 4 + 1]) * space;
        const w = Math.exp(bbox[idx * 4 + 2]) * space;
        const h = Math.exp(bbox[idx * 4 + 3]) * space;
        const landmarks: Array<[number, number]> = [];
        for (let n = 0; n < 5; n += 1) landmarks.push([(kps[idx * 10 + n * 2] + c) * space, (kps[idx * 10 + n * 2 + 1] + r) * space]);
        faces.push({ x: cx - w / 2, y: cy - h / 2, w, h, score, landmarks });
      }
    }
  }
  return nms(faces, options.nmsThreshold ?? 0.3);
}
