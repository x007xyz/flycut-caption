import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFontDir } from '../../server/subtitle-render.ts';

test('F-0058/AC-3 packaged Host finds fonts beside the Tauri _up_ resource root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flycut-subtitle-assets-'));
  try {
    const resourceRoot = join(root, 'Resources', '_up_');
    const expected = join(root, 'Resources', 'shared_assets', 'subtitle-fonts');
    await mkdir(resourceRoot, { recursive: true });
    await mkdir(expected, { recursive: true });
    await writeFile(join(expected, 'NotoSansSC-Regular.otf'), '');

    assert.equal(await findFontDir(resourceRoot), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
