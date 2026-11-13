import { isIP } from 'node:net';

const PRIVATE_HOSTS = /^(localhost|.*\.local|.*\.internal)$/i;

export function isPrivateAddress(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (PRIVATE_HOSTS.test(host)) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(host) === 6) return host === '::1' || host === '::' || /^(fc|fd|fe8|fe9|fea|feb)/.test(host) || host.startsWith('::ffff:');
  return false;
}

/** Shared HTTP policy for user-supplied services. The server profile disables private-network access. */
export function assertServiceUrl(baseUrl: string | URL, allowPrivateNetwork: boolean) {
  const url = baseUrl instanceof URL ? baseUrl : new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('服务地址必须是 HTTP(S)，且不能包含账号密码、查询参数或锚点');
  }
  if (!allowPrivateNetwork && isPrivateAddress(url.hostname)) throw new Error('当前 Host 不允许连接本机或内网地址');
}
