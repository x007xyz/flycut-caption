import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await build({ entryPoints: ['server/main.ts'], outfile: 'dist-host/main.mjs', bundle: true,
  platform: 'node', format: 'esm', target: 'node22', packages: 'external', tsconfig: 'server/tsconfig.json', sourcemap: true });

await mkdir("server/lib", { recursive: true });
await copyFile("dist-host/main.mjs", "server/lib/main.mjs");
