import { build } from 'esbuild';
import { chmod, readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
await build({
  entryPoints: ['cli/flycut.ts'],
  outfile: 'dist-cli/flycut.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  tsconfig: 'server/tsconfig.json',
  sourcemap: true,
  define: { __FLYCUT_CLI_VERSION__: JSON.stringify(pkg.version) },
});
await chmod('dist-cli/flycut.mjs', 0o755);
