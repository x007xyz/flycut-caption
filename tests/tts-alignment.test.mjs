import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planDubbingAlignment } from '../shared/tts/alignment.ts';

describe('F-0036 dubbing alignment planning', () => {
  it('keeps a cue that already fits', () => {
    const plan = planDubbingAlignment({ targetSeconds: 2, sourceSeconds: 1.8, durationControl: true });
    assert.equal(plan.mode, 'none');
    assert.equal(plan.speed, undefined);
  });
  it('uses speed within the accepted range when the model supports duration control', () => {
    const plan = planDubbingAlignment({ targetSeconds: 2, sourceSeconds: 2.4, durationControl: true });
    assert.equal(plan.mode, 'speed');
    assert.equal(plan.speed, 1.2);
    assert.ok(Math.abs(plan.outputSeconds - 2) < 0.001);
  });
  it('marks unresolved when the required speed exceeds the accepted maximum', () => {
    const plan = planDubbingAlignment({ targetSeconds: 2, sourceSeconds: 3, durationControl: true });
    assert.equal(plan.mode, 'unresolved');
    assert.equal(plan.speed, 1.25);
  });
  it('marks unresolved when the provider has no duration control', () => {
    const plan = planDubbingAlignment({ targetSeconds: 2, sourceSeconds: 3, durationControl: false });
    assert.equal(plan.mode, 'unresolved');
  });
  it('respects custom speed bounds', () => {
    const plan = planDubbingAlignment({ targetSeconds: 2, sourceSeconds: 2.4, durationControl: true, minSpeed: 0.9, maxSpeed: 1.1 });
    assert.equal(plan.mode, 'unresolved');
    assert.equal(plan.speed, 1.1);
  });
});
