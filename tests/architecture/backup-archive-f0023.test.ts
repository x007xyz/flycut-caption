import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { validateBackupEntryPath } from '../../shared/backup';
import { HostRpcError } from '../../shared/errors';
import { BackupZipReader, BackupZipWriter } from '../../server/projects/backupArchive';

function buildRawSingleEntryZip(entryName: string, content: Buffer, options: { externalAttributes?: number; versionMadeBy?: number } = {}): Buffer {
  const nameBytes = Buffer.from(entryName, 'utf8');
  const lfh = Buffer.alloc(30 + nameBytes.length);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(0x0800, 6);
  lfh.writeUInt16LE(0, 8);
  lfh.writeUInt32LE(content.length, 18);
  lfh.writeUInt32LE(content.length, 22);
  lfh.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(lfh, 30);

  const cdh = Buffer.alloc(46 + nameBytes.length);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(options.versionMadeBy ?? (3 << 8) | 45, 4);
  cdh.writeUInt16LE(20, 6);
  cdh.writeUInt16LE(0x0800, 8);
  cdh.writeUInt16LE(0, 10);
  cdh.writeUInt32LE(content.length, 20);
  cdh.writeUInt32LE(content.length, 24);
  cdh.writeUInt16LE(nameBytes.length, 28);
  cdh.writeUInt32LE(options.externalAttributes ?? 0, 38);
  cdh.writeUInt32LE(0, 42);
  nameBytes.copy(cdh, 46);

  const cdOffset = lfh.length + content.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdh.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([lfh, content, cdh, eocd]);
}

test('F-0023/AC-1 AC-4 validateBackupEntryPath rejects traversal, absolute, drive, backslash and unknown entries', () => {
  const vid = randomUUID();
  assert.equal(validateBackupEntryPath('manifest.json').ok, true);
  assert.equal(validateBackupEntryPath('project.json').ok, true);
  assert.equal(validateBackupEntryPath(`videos/${vid}/transcript.json`).ok, true);
  assert.equal(validateBackupEntryPath(`videos/${vid}/edits.json`).ok, true);
  assert.equal(validateBackupEntryPath(`videos/${vid}/thumbnail.jpg`).ok, true);
  assert.equal(validateBackupEntryPath(`videos/${vid}/pending-suggestions.json`).ok, true);
  assert.equal(validateBackupEntryPath(`media/${vid}.mp4`).ok, true);

  for (const bad of [
    '',
    '../evil.json',
    'videos/../../etc/passwd',
    '/etc/passwd',
    'C:\\evil.txt',
    'media\\file.mp4',
    'host-id.json',
    'ai-settings.json',
    'secrets/keys.json',
    `videos/${vid}/transcript.json\0.txt`,
  ]) {
    assert.equal(validateBackupEntryPath(bad).ok, false, `Expected rejection for ${bad}`);
  }
});

test('F-0023/AC-1 AC-2 streaming ZIP writer & reader roundtrip with ZIP64 headers and integrity verification', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flycut-f0023-zip-'));
  try {
    const archivePath = join(dir, 'test.flycut.zip');
    const mediaSrc = join(dir, 'sample.mp4');
    const mediaBytes = Buffer.from('fake-mp4-binary-payload-0123456789'.repeat(100));
    await writeFile(mediaSrc, mediaBytes);
    const vid = randomUUID();
    const jsonBytes = Buffer.from(JSON.stringify({ hello: 'flycut', count: 42 }), 'utf8');

    // Exercise ZIP64 path using a low threshold
    const writer = await BackupZipWriter.open(archivePath, { zip64Threshold: 64 });
    const e1 = await writer.addBuffer('manifest.json', jsonBytes, 'deflate');
    const e2 = await writer.addFile(`media/${vid}.mp4`, mediaSrc, 'store');
    await writer.finalize();

    assert.equal(e1.sha256, createHash('sha256').update(jsonBytes).digest('hex'));
    assert.equal(e2.sha256, createHash('sha256').update(mediaBytes).digest('hex'));

    const reader = await BackupZipReader.open(archivePath);
    try {
      const readJson = await reader.readBuffer('manifest.json');
      assert.deepEqual(readJson.buffer, jsonBytes);
      assert.equal(readJson.sha256, e1.sha256);

      const out = new PassThrough();
      const chunks: Buffer[] = [];
      out.on('data', (c: Buffer) => chunks.push(c));
      const verifiedMedia = await reader.streamEntry(`media/${vid}.mp4`, out);
      assert.equal(verifiedMedia.sha256, e2.sha256);
      assert.deepEqual(Buffer.concat(chunks), mediaBytes);
    } finally {
      await reader.close();
    }

    // Corrupt one byte inside the media payload and verify reader catches CRC32/SHA-256 mismatch
    const corruptedPath = join(dir, 'corrupted.flycut.zip');
    const raw = await readFile(archivePath);
    const targetByte = e2.localHeaderOffset + 120;
    raw[targetByte] = raw[targetByte]! ^ 0xff;
    await writeFile(corruptedPath, raw);

    const badReader = await BackupZipReader.open(corruptedPath);
    try {
      await assert.rejects(
        () => badReader.verifyEntry(`media/${vid}.mp4`, e2.sha256),
        (err: unknown) => err instanceof HostRpcError && err.code === 'BACKUP_INVALID',
      );
    } finally {
      await badReader.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('F-0023/AC-2 AC-4 rejects traversal entries, symlink entries, and truncated archives', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flycut-f0023-sec-'));
  try {
    const traversalZip = join(dir, 'traversal.zip');
    await writeFile(traversalZip, buildRawSingleEntryZip('../escape.json', Buffer.from('{}')));
    await assert.rejects(
      () => BackupZipReader.open(traversalZip),
      (err: unknown) => err instanceof HostRpcError && err.code === 'BACKUP_INVALID' && err.details.reason === 'UNSAFE_PATH',
    );

    const vid = randomUUID();
    const symlinkZip = join(dir, 'symlink.zip');
    await writeFile(
      symlinkZip,
      buildRawSingleEntryZip(`media/${vid}.mp4`, Buffer.from('/etc/passwd'), {
        externalAttributes: (0o120777 << 16) >>> 0,
      }),
    );
    await assert.rejects(
      () => BackupZipReader.open(symlinkZip),
      (err: unknown) => err instanceof HostRpcError && err.code === 'BACKUP_INVALID' && err.details.reason === 'UNSAFE_PATH',
    );

    const truncatedZip = join(dir, 'truncated.zip');
    await writeFile(truncatedZip, Buffer.from('PK\x03\x04short'));
    await assert.rejects(
      () => BackupZipReader.open(truncatedZip),
      (err: unknown) => err instanceof HostRpcError && err.code === 'BACKUP_INVALID' && err.details.reason === 'CORRUPT_ARCHIVE',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
