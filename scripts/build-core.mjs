import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

for (const name of ['cosmokit', 'cordis']) {
  const directory = `core/${name}`;
  await mkdir(`${directory}/lib`, { recursive: true });
  const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc',
    `${directory}/src/index.ts`, '--declaration', '--emitDeclarationOnly', '--noCheck',
    '--outDir', `${directory}/lib/types`, '--module', 'esnext', '--moduleResolution', 'bundler',
    '--target', 'es2022', '--allowImportingTsExtensions', '--skipLibCheck', '--types', 'node',
  ], { stdio: 'inherit' });
  if (result.status) process.exit(result.status);
  await build({ entryPoints: [`${directory}/src/index.ts`], outfile: `${directory}/lib/index.js`,
    bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', packages: 'external', sourcemap: true });
  const manifest = JSON.parse(await readFile(`${directory}/package.json`, 'utf8'));
  manifest.types = 'lib/types/index.d.ts';
  manifest.exports['.'].types = './lib/types/index.d.ts';
  await writeFile(`${directory}/package.json`, JSON.stringify(manifest, null, 2) + '\n');
}
