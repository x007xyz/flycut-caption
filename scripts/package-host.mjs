import { copyFile, chmod, cp, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { copyNodeBinary, validateNodeBinary } from './package-host-node.mjs';

const nodeBinary = resolve(process.env.FLYCUT_NODE_BINARY || process.execPath);
const validatedNode = validateNodeBinary({ nodeBinary });

try {
  const previous = JSON.parse(await readFile('src-tauri/host/package.json', 'utf8'));
  if (previous.name !== '@flycut/host') throw new Error('Refusing to replace an unrecognized Host directory');
  await rm('src-tauri/host', { recursive: true });
} catch (error) { if (error.code !== 'ENOENT') throw error; }

// Tauri copies resources without keeping symlinks, so pnpm's linked layout (a package reaches its
// dependencies through `.pnpm/*` links) breaks once bundled. Lay the installed production
// dependencies out as plain directories instead, npm style: a package goes to the top level when only
// one version of it is needed, otherwise next to the package that depends on it.
const readPackage = dir => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
function resolveFrom(dir, name) {
  for (let at = dir; ; at = dirname(at)) {
    const candidate = join(at, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(at) === at) return undefined;
  }
}
const dependencies = new Map();
function dependenciesOf(dir) {
  if (!dependencies.has(dir)) {
    const pkg = readPackage(dir);
    const names = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies });
    // Missing ones are optional or peer dependencies this platform did not install.
    dependencies.set(dir, names.map(name => [name, resolveFrom(dir, name)]).filter(([, real]) => real));
  }
  return dependencies.get(dir);
}

const versions = new Map();
const pending = [realpathSync('server')];
for (const seen = new Set(pending); pending.length;) {
  for (const [name, real] of dependenciesOf(pending.pop())) {
    versions.set(name, (versions.get(name) ?? new Set()).add(real));
    if (!seen.has(real)) { seen.add(real); pending.push(real); }
  }
}
const lookup = (node, name) => { for (let at = node; at; at = at.parent) if (at.children.has(name)) return at.children.get(name); };
const root = { real: realpathSync('server'), children: new Map() };
const place = (parent, name, real) => { const child = { real, parent, children: new Map() }; parent.children.set(name, child); return child; };
const layout = queue => {
  while (queue.length) {
    const node = queue.shift();
    for (const [name, real] of dependenciesOf(node.real)) {
      if (lookup(node, name)?.real !== real) queue.push(place(versions.get(name).size > 1 ? node : root, name, real));
    }
  }
};
layout([root]);
// Some packages import what they never declare (transformers -> onnxruntime-common) and rely on
// pnpm's hoisting; give the top level the same version pnpm hoisted for every name still free there.
layout([...versions.keys()].filter(name => !root.children.has(name)).flatMap(name => {
  const hoisted = resolveFrom(realpathSync('node_modules/.pnpm'), name);
  return hoisted && versions.get(name).has(hoisted) ? [place(root, name, hoisted)] : [];
}));
// Every package must still resolve each dependency to the version pnpm installed for it.
for (const queue = [root]; queue.length;) {
  const node = queue.shift();
  for (const [name, real] of dependenciesOf(node.real)) {
    if (lookup(node, name)?.real !== real) throw new Error(`Host packaging: ${name} would resolve to the wrong version from ${node.real}`);
  }
  queue.push(...node.children.values());
}

async function write(node, destination) {
  for (const [name, child] of node.children) {
    const target = join(destination, 'node_modules', name);
    const nested = join(child.real, 'node_modules');
    await cp(child.real, target, { recursive: true, dereference: true, filter: source => source !== nested && !source.startsWith(nested + sep) });
    await write(child, target);
  }
}
await mkdir('src-tauri/host', { recursive: true });
await copyFile('server/package.json', 'src-tauri/host/package.json');
await cp('server/lib', 'src-tauri/host/lib', { recursive: true });
await write(root, 'src-tauri/host');

await mkdir('src-tauri/binaries', { recursive: true });
const destination = `src-tauri/binaries/flycut-node${process.platform === 'win32' ? '.exe' : ''}`;
await copyNodeBinary({ nodeBinary, destination });
if (process.platform !== 'win32') await chmod(destination, 0o755);
console.log(`Packaged ${versions.size} Host dependencies and Node ${validatedNode.version} from ${nodeBinary}.`);
