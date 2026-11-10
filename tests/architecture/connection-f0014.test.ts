// F-0014 AC-2、AC-5：URL 规则、只读重放白名单、退避和日志脱敏。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  READ_ONLY_RPC_METHODS, RECONNECT_BASE_DELAYS_MS, classifyHttpStatus, isReadOnlyRpc, legacyBootstrap,
  reconnectDelay, redactSecrets, validateHostUrl,
} from '../../src/runtime/connectionModel';

test('F-0014/AC-2 accepts https origins and loopback http only', () => {
  assert.deepEqual(validateHostUrl('https://flycut.example.com'), { ok: true, url: 'https://flycut.example.com' });
  assert.deepEqual(validateHostUrl('https://flycut.example.com/'), { ok: true, url: 'https://flycut.example.com' });
  assert.deepEqual(validateHostUrl('http://127.0.0.1:8766'), { ok: true, url: 'http://127.0.0.1:8766' });
  assert.deepEqual(validateHostUrl('http://localhost:5173'), { ok: true, url: 'http://localhost:5173' });
  assert.deepEqual(validateHostUrl('http://[::1]:8766'), { ok: true, url: 'http://[::1]:8766' });
});

test('F-0014/AC-2 rejects insecure, credential-bearing and non-origin URLs without any request', () => {
  for (const value of ['http://flycut.example.com', 'javascript:alert(1)', 'data:text/html,x', 'file:///tmp/x',
    'https://user:password@flycut.example.com', 'https://flycut.example.com/path', 'https://flycut.example.com?x=1',
    'https://flycut.example.com#x', 'ftp://flycut.example.com', 'http://localhost.evil.com']) {
    assert.equal(validateHostUrl(value).ok, false, value);
  }
});

test('F-0014/AC-5 backoff is bounded and jittered around the published sequence', () => {
  assert.deepEqual([...RECONNECT_BASE_DELAYS_MS], [500, 1000, 2000, 4000, 8000, 15000, 30000]);
  assert.equal(reconnectDelay(0, () => 0.5), 500);
  assert.equal(reconnectDelay(6, () => 0.5), 30000);
  assert.equal(reconnectDelay(99, () => 0.5), 30000);
  assert.equal(reconnectDelay(0, () => 0), 400);
  assert.equal(reconnectDelay(0, () => 1), 600);
});

test('F-0014/AC-5 only reads are replayable after reconnect', () => {
  assert.equal(isReadOnlyRpc('host.info'), true);
  assert.equal(isReadOnlyRpc('jobs.get'), true);
  assert.equal(isReadOnlyRpc('projects.open'), true);
  assert.equal(isReadOnlyRpc('projects.identity'), true);
  for (const write of ['workflow.start', 'export.start', 'text.start', 'agent.start', 'projects.saveVideoEdits',
    'projects.create', 'projects.addVideo', 'projects.trash', 'assets.delete']) {
    assert.equal(isReadOnlyRpc(write), false, write);
  }
  assert.ok(READ_ONLY_RPC_METHODS.has('projects.list'));
});

test('F-0014/AC-4 HTTP statuses classify without retrying auth failures forever', () => {
  assert.equal(classifyHttpStatus(401), 'auth-expired');
  assert.equal(classifyHttpStatus(403), 'access-denied');
  assert.equal(classifyHttpStatus(429), 'rate-limited');
  assert.equal(classifyHttpStatus(500), 'server-error');
  assert.equal(classifyHttpStatus(503), 'server-error');
  assert.equal(classifyHttpStatus(404), 'request');
});

test('F-0014/AC-8 logs redact authorization, cookies, CSRF and legacy query tokens', () => {
  const redacted = redactSecrets('Authorization: Bearer secret Cookie: flycut_session=abc X-Flycut-CSRF: csrf /rpc?token=old');
  assert.doesNotMatch(redacted, /secret|flycut_session=abc|csrf\b|old/);
  assert.match(redacted, /\[redacted\]/);
});

test('F-0014 legacy bootstrap only turns a token into in-memory bearer', () => {
  assert.deepEqual(legacyBootstrap({ token: 'abc' }), { auth: { kind: 'bearer', token: 'abc' } });
  assert.equal(legacyBootstrap({ auth: 'session' }), null);
  assert.equal(legacyBootstrap(null), null);
});
