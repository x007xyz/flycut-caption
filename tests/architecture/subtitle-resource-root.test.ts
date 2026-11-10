import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findFontDir } from '../../server/subtitle-render.ts';

test('packaged Host finds subtitle fonts beside the Tauri _up_ resource root', async () => {
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
