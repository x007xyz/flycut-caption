import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cropXForCenter, selectPrimaryFaces, smoothCropPath } from '../shared/reframe/tracking.ts';

const face = (x, w = 40, score = 0.9) => ({ x, y: 100, w, h: 50, score, landmarks: [] });

describe('F-0048 subject tracking', () => {
  it('sticks to the previous subject instead of jumping to a slightly larger new face', () => {
    const samples = selectPrimaryFaces([
      { time: 0, faces: [face(100), face(400, 45)] },
      { time: 0.5, faces: [face(104), face(400, 60)] },
    ]);
    assert.equal(samples[0].centerX, 120);
    assert.equal(samples[1].centerX, 124);
  });
  it('keeps the last position through a short detection gap', () => {
    const samples = selectPrimaryFaces([{ time: 0, faces: [face(100)] }, { time: 0.5, faces: [] }], { maxGapSeconds: 1 });
    assert.equal(samples.length, 2);
    assert.equal(samples[1].centerX, 120);
  });
  it('refocuses after the subject is lost for a long time', () => {
    const samples = selectPrimaryFaces([{ time: 0, faces: [face(100)] }, { time: 4, faces: [face(400)] }], { refocusAfterSeconds: 2 });
    assert.equal(samples[1].centerX, 420);
  });
  it('limits movement and clamps the crop inside the frame', () => {
    const smooth = smoothCropPath([{ time: 0, centerX: 0, confidence: 1 }, { time: 0.5, centerX: 600, confidence: 1 }], { maxStep: 10, smoothing: 0 });
    assert.equal(smooth[1].centerX, 10);
    assert.equal(cropXForCenter(0), 0);
    assert.equal(cropXForCenter(640), 640 - 640 * 9 / 16);
  });
});
