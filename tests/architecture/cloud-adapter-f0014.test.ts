import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCurrentBackendCloudAdapter } from '../../src/runtime/cloudAdapter';

test('F-0014 current backend Cloud adapter restores the Host bootstrap', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ auth: 'session', csrf: 'csrf-1', expiresAt: '2026-11-10T00:00:00Z' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const adapter = createCurrentBackendCloudAdapter({ baseUrl: 'https://cloud.example.com', fetchImpl });
  assert.equal(adapter.available(), true);
  const bootstrap = await adapter.restore();
  assert.equal(bootstrap?.hostUrl, 'https://cloud.example.com');
  assert.deepEqual(bootstrap?.auth, { kind: 'cookie' });
  assert.equal(bootstrap?.csrf, 'csrf-1');
  assert.equal(bootstrap?.subject.id, 'current-backend:https://cloud.example.com');
  assert.equal(calls[0].url, 'https://cloud.example.com/__flycut/connection');
  assert.equal(calls[0].init?.credentials, 'include');
});

test('F-0014 current backend Cloud adapter logs out with CSRF and reports expiry', async () => {
  let status = 200;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (status === 401) return new Response('unauthorized', { status });
    return new Response(JSON.stringify({ auth: 'cookie', csrf: 'csrf-2' }), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const adapter = createCurrentBackendCloudAdapter({ baseUrl: 'https://cloud.example.com', fetchImpl });
  await adapter.beginSignIn();
  await adapter.logout();
  const logout = calls.at(-1)!;
  assert.equal(logout.url, 'https://cloud.example.com/session');
  assert.equal(logout.init?.method, 'DELETE');
  assert.deepEqual(logout.init?.headers, { 'X-Flycut-CSRF': 'csrf-2' });
  status = 401;
  assert.equal(await adapter.refresh(), 'expired');
});
