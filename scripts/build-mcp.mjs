import { build } from 'esbuild';
import { chmod, readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
await build({
  entryPoints: ['mcp/server.ts'],
  outfile: 'dist-mcp/flycut-mcp.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  tsconfig: 'server/tsconfig.json',
  sourcemap: true,
  define: { __FLYCUT_MCP_VERSION__: JSON.stringify(pkg.version) },
});
await chmod('dist-mcp/flycut-mcp.mjs', 0o755);

