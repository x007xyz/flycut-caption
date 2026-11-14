import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createHost } from '../../server/app';
import { BackupZipReader, BackupZipWriter } from '../../server/projects/backupArchive';
import { importProjectBackup, inspectBackupStaging, saveBackupStagingFromFile } from '../../server/projects/backup';
import { ProjectStore } from '../../server/projects/store';
import { BACKUP_FORMAT_VERSION, type BackupExportResult, type BackupImportResult, type BackupInspectionResult, type BackupPreviewResult } from '../../shared/backup';
import { HostRpcError } from '../../shared/errors';
import { PROJECT_FORMAT_VERSION } from '../../shared/projects';
import type { JobSnapshot } from '../../shared/protocol';

const FFMPEG = process.env.FFMPEG_PATH ?? (existsSync(resolve('src-tauri/binaries/ffmpeg')) ? resolve('src-tauri/binaries/ffmpeg') : 'ffmpeg');

function createTestMp4(target: string): Buffer | null {
  const res = spawnSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=1.5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', target,
  ], { encoding: 'utf8' });
  if (res.status !== 0) return null;
  return readFileSync(target);
}

async function bootHost(options: { home?: string; token?: string; shellToken?: string } = {}) {
  const home = options.home ?? await mkdtemp(join(tmpdir(), 'flycut-f0023-host-'));
  const token = options.token ?? 'f0023-test-token-secret';
  const shellToken = options.shellToken ?? 'f0023-shell-secret';
  const ctx = await createHost({ home, token, shellToken, port: 0, resourceRoot: resolve('.') }, {
    profile: 'desktop',
    providers: [],
    patches: [{ source: 'f0023-test', patch: { config: { 'ai-settings': { secretBackend: 'memory' } } } }],
  });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async <T = any>(method: string, payload: unknown = {}): Promise<T> => {
    const response = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
    });
    const envelope = await response.json() as any;
    if (!envelope.result.ok) {
      const err = new Error(envelope.result.error.message) as Error & { code?: string; details?: Record<string, unknown> };
      err.code = envelope.result.error.code;
      err.details = envelope.result.error.details;
      throw err;
    }
    return envelope.result.value;
  };
  const waitJob = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const job = await call<JobSnapshot>('jobs.get', { id });
      if (['complete', 'error', 'cancelled'].includes(job.status)) return job;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`Job ${id} timed out`);
  };
  const uploadAsset = async (bytes: Buffer) => {
    const response = await fetch(`${base}/assets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: new Uint8Array(bytes),
    });
    assert.equal(response.status, 201);
    return ((await response.json()) as { assetId: string }).assetId;
  };
  return { home, token, shellToken, ctx, base, call, waitJob, uploadAsset };
}

test('F-0023/AC-1 AC-3 AC-4 AC-8 full dual-Host backup migration with stored & linked media, EDL, styles, secrets stripping and idempotency', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'flycut-f0023-work-'));
  const mp4Path = join(workDir, 'clip.mp4');
  const mp4Bytes = createTestMp4(mp4Path) ?? Buffer.from('00000018ftypmp42' + 'X'.repeat(4096));
  const hasRealFfmpeg = mp4Bytes.length > 5000;
  const linkedPath = join(workDir, 'linked-clip.mp4');
  await writeFile(linkedPath, mp4Bytes);

  const hostA = await bootHost({ token: 'secret-token-A-12345' });
  const hostB = await bootHost({ token: 'secret-token-B-67890' });
  try {
    // Save an AI secret on Host A to prove secrets are never included in project backups
    await hostA.call('aiSettings.save', {
      hostId: (await hostA.call<{ hostId: string }>('projects.identity')).hostId,
      expectedRevision: 0,
      config: {
        name: 'Secret AI',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-super-secret-do-not-export-123456',
        model: 'gpt-4o-mini',
      },
    });

    const assetId1 = await hostA.uploadAsset(mp4Bytes);
    const created = await hostA.call<{ projectId: string; videoId: string; revision: number }>('projects.create', {
      name: '口播项目 Alpha',
      videoName: 'clip1.mp4',
      durationSeconds: 1.5,
      media: { assetId: assetId1, mimeType: 'video/mp4' },
    });

    // Add a second video via shell linked media
    const shellReg = await fetch(`${hostA.base}/shell/projects/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hostA.shellToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: linkedPath }),
    });
    assert.equal(shellReg.status, 201);
    const { mediaRef } = (await shellReg.json()) as { mediaRef: string };
    const added = await hostA.call<{ videoId: string; revision: number }>('projects.addVideo', {
      projectId: created.projectId,
      videoName: 'linked-clip.mp4',
      durationSeconds: 1.5,
      media: { mediaRef },
    });

    // Save transcript, edits + EDL, custom style & project style
    await hostA.call('projects.saveTranscript', {
      projectId: created.projectId,
      videoId: created.videoId,
      transcript: {
        text: '你好世界',
        chunks: [{ id: 'c1', text: '你好世界', timestamp: [0, 1.2] }],
        language: 'zh',
        duration: 1.5,
      },
    });
    await hostA.call('projects.saveVideoEdits', {
      projectId: created.projectId,
      videoId: created.videoId,
      styleSource: 'custom',
      baseRevision: 0,
      edits: {
        chunks: [{ id: 'c1', text: '你好FlyCut', timestamp: [0, 1.2], secondText: 'Hello FlyCut' }],
        deletedWordIds: [],
        stylePair: { primary: { fontSize: 36, color: '#ffffff' }, secondary: { fontSize: 24 } },
        editing: {
          edl: {
            version: 1,
            sourceDurationUs: 1_500_000,
            origin: 'explicit',
            deleted: [{ startUs: 1_200_000, endUs: 1_500_000 }],
          },
          history: [{
            id: 'h1',
            at: new Date().toISOString(),
            kind: 'cut',
            edl: {
              version: 1,
              sourceDurationUs: 1_500_000,
              origin: 'explicit',
              deleted: [{ startUs: 1_200_000, endUs: 1_500_000 }],
            },
            deletedIds: [],
            deletedWordIds: [],
          }],
        },
      },
    });
    await hostA.call('projects.saveProjectStyle', {
      projectId: created.projectId,
      baseRevision: 0,
      style: { primary: { fontSize: 28 }, secondary: { fontSize: 20 } },
    });

    const preview = await hostA.call<BackupPreviewResult>('projects.backupPreview', { projectId: created.projectId });
    assert.equal(preview.videoCount, 2);
    assert.equal(preview.subtitleCount, 1);
    assert.ok(preview.editCount >= 2);
    assert.equal(preview.styleSummary.hasProjectStyle, true);
    assert.equal(preview.styleSummary.customVideoStyleCount, 1);
    assert.equal(preview.missingMedia.length, 0);
    assert.equal(preview.excludesSecretsNotice, true);

    // Stale revision must fail with CONTENT_CHANGED (AC-8)
    const staleJob = await hostA.call<JobSnapshot>('projects.backupExport', {
      projectId: created.projectId,
      expectedRevision: preview.revision + 99,
    });
    const staleDone = await hostA.waitJob(staleJob.id);
    assert.equal(staleDone.status, 'error');
    assert.match(staleDone.error ?? '', /内容已更新/);

    // Real backup export on Host A
    const exportJob = await hostA.call<JobSnapshot>('projects.backupExport', {
      projectId: created.projectId,
      expectedRevision: preview.revision,
      operationId: randomUUID(),
    });
    const exportDone = await hostA.waitJob(exportJob.id);
    assert.equal(exportDone.status, 'complete', exportDone.error);
    const exportResult = exportDone.result as BackupExportResult;
    assert.match(exportResult.filename, /\.flycut\.zip$/);

    // Download exported archive from Host A
    const dlRes = await fetch(`${hostA.base}/assets/${exportResult.assetId}`, {
      headers: { Authorization: `Bearer ${hostA.token}` },
    });
    assert.equal(dlRes.status, 200);
    const archiveBytes = Buffer.from(await dlRes.arrayBuffer());
    assert.equal(createHash('sha256').update(archiveBytes).digest('hex'), exportResult.sha256);

    // Verify archive contents never contain secrets, token, linked paths, or host-id
    const backupDiskFile = join(workDir, 'saved-backup.flycut.zip');
    await writeFile(backupDiskFile, archiveBytes);
    const reader = await BackupZipReader.open(backupDiskFile);
    try {
      assert.equal(reader.entries.has('manifest.json'), true);
      assert.equal(reader.entries.has('project.json'), true);
      const projectRaw = (await reader.readBuffer('project.json')).buffer.toString('utf8');
      assert.equal(projectRaw.includes('sk-super-secret'), false);
      assert.equal(projectRaw.includes(hostA.token), false);
      assert.equal(projectRaw.includes(linkedPath), false);
      assert.equal(projectRaw.includes('"linked"'), false);
      assert.equal(reader.entries.has('host-id.json'), false);
    } finally {
      await reader.close();
    }

    // Also create a same-name project on Host B first to verify AC-3 never overwrites
    const preExisting = await hostB.call<{ projectId: string }>('projects.createEmpty', { name: '口播项目 Alpha' });

    // Upload backup to Host B and inspect + import
    const upRes = await fetch(`${hostB.base}/projects/backups/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hostB.token}` },
      body: new Uint8Array(archiveBytes),
    });
    assert.equal(upRes.status, 201);
    const { stagingId } = (await upRes.json()) as { stagingId: string };

    const inspectJob = await hostB.call<JobSnapshot>('projects.backupInspect', { stagingId });
    const inspectDone = await hostB.waitJob(inspectJob.id);
    assert.equal(inspectDone.status, 'complete', inspectDone.error);
    const inspection = inspectDone.result as BackupInspectionResult;
    assert.equal(inspection.projectName, '口播项目 Alpha');
    assert.equal(inspection.videoCount, 2);
    assert.equal(inspection.subtitleCount, 1);

    const importOpId = randomUUID();
    const importJob = await hostB.call<JobSnapshot>('projects.backupImport', {
      stagingId,
      expectedDigest: inspection.stagingDigest,
      operationId: importOpId,
    });
    const importDone = await hostB.waitJob(importJob.id);
    assert.equal(importDone.status, 'complete', importDone.error);
    const importRes = importDone.result as BackupImportResult;
    assert.notEqual(importRes.projectId, created.projectId);
    assert.notEqual(importRes.projectId, preExisting.projectId);
    assert.equal(importRes.videoCount, 2);

    // Idempotent retry with same operationId returns exact same projectId
    const retryJob = await hostB.call<JobSnapshot>('projects.backupImport', {
      stagingId,
      expectedDigest: inspection.stagingDigest,
      operationId: importOpId,
    });
    assert.equal(retryJob.id, importJob.id);

    // Open imported project on Host B and check subtitles, EDL, styles, and media playback
    const opened = await hostB.call<any>('projects.open', { projectId: importRes.projectId });
    assert.equal(opened.status, 'ok');
    assert.equal(opened.project.videos.length, 2);
    assert.notEqual(opened.video.id, created.videoId);
    assert.notEqual(opened.project.videos[1].id, added.videoId);
    assert.equal(opened.edits.chunks[0].text, '你好FlyCut');
    assert.equal(opened.edits.editing.edl.deleted.length, 1);
    assert.deepEqual(opened.projectStyle, { primary: { fontSize: 28 }, secondary: { fontSize: 20 } });
    assert.equal(opened.media.status, 'ok');
    assert.equal(opened.media.playback.kind, 'url');

    // Check ranged media streaming on Host B
    const playRes = await fetch(`${hostB.base}${opened.media.playback.path}`, {
      headers: { Authorization: `Bearer ${hostB.token}`, Range: 'bytes=0-15' },
    });
    assert.equal(playRes.status, 206);

    // If real FFmpeg mp4 was generated, test real Host B export on the imported project
    if (hasRealFfmpeg) {
      const expB = await hostB.call<JobSnapshot>('projects.export', {
        projectId: importRes.projectId,
        videoId: opened.video.id,
        format: 'mp4',
        subtitleProcessing: 'none',
      });
      const expBDone = await hostB.waitJob(expB.id);
      assert.equal(expBDone.status, 'complete', expBDone.error);
    }

    // Original source backup file on disk was never deleted (AC-3)
    assert.equal((await stat(backupDiskFile)).isFile(), true);
  } finally {
    await hostA.ctx.fiber.dispose();
    await hostB.ctx.fiber.dispose();
    await rm(hostA.home, { recursive: true, force: true });
    await rm(hostB.home, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
});

test('F-0023/AC-2 AC-3 rejects future versions, linked media, low disk space, and cleans up on cancel without leaving partial projects', async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0023-neg-'));
  const workDir = await mkdtemp(join(tmpdir(), 'flycut-f0023-neg-work-'));
  try {
    const store = new ProjectStore(home);
    await store.init();

    // Helper to build a minimal valid ZIP with custom manifest/project
    async function makeArchive(filename: string, manifestOverride: Record<string, unknown>, projectOverride: Record<string, unknown>) {
      const path = join(workDir, filename);
      const projBuf = Buffer.from(JSON.stringify(projectOverride), 'utf8');
      const projSha = createHash('sha256').update(projBuf).digest('hex');
      const manifest = {
        backupVersion: BACKUP_FORMAT_VERSION,
        projectFormatVersion: PROJECT_FORMAT_VERSION,
        appVersion: '2.0.2',
        exportedAt: new Date().toISOString(),
        projectName: 'Test',
        videoCount: 0,
        subtitleCount: 0,
        editCount: 0,
        styleSummary: { hasProjectStyle: false, customVideoStyleCount: 0 },
        artifactCount: 0,
        mediaBytes: 0,
        missingMedia: [],
        entries: [{ path: 'project.json', size: projBuf.length, sha256: projSha, kind: 'meta', method: 'deflate' }],
        ...manifestOverride,
      };
      const writer = await BackupZipWriter.open(path);
      await writer.addBuffer('manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8'), 'deflate');
      await writer.addBuffer('project.json', projBuf, 'deflate');
      await writer.finalize();
      return saveBackupStagingFromFile(home, path);
    }

    const validProj = {
      formatVersion: PROJECT_FORMAT_VERSION,
      id: randomUUID(),
      name: 'NegTest',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      revision: 1,
      videos: [],
      styleRevision: 0,
    };

    // 1. Future backupVersion
    const futureBackup = await makeArchive('future-backup.zip', { backupVersion: BACKUP_FORMAT_VERSION + 1 }, validProj);
    await assert.rejects(
      () => inspectBackupStaging({ home, stagingId: futureBackup.stagingId }),
      (err: unknown) => err instanceof HostRpcError && err.details.reason === 'UNSUPPORTED_BACKUP_VERSION',
    );

    // 2. Future projectFormatVersion
    const futureProj = await makeArchive('future-proj.zip', { projectFormatVersion: PROJECT_FORMAT_VERSION + 1 }, { ...validProj, formatVersion: PROJECT_FORMAT_VERSION + 1 });
    await assert.rejects(
      () => inspectBackupStaging({ home, stagingId: futureProj.stagingId }),
      (err: unknown) => err instanceof HostRpcError && err.details.reason === 'UNSUPPORTED_PROJECT_VERSION',
    );

    // 3. Malicious linked media path
    const linkedArchive = await makeArchive('linked.zip', {}, {
      ...validProj,
      videos: [{
        id: randomUUID(),
        name: 'evil.mp4',
        durationSeconds: 1,
        createdAt: new Date().toISOString(),
        media: { kind: 'linked', path: '/etc/passwd', size: 10, mtimeMs: 1, fingerprint: 'abc' },
        hasTranscript: false,
        revision: 0,
        styleSource: 'project',
      }],
    });
    await assert.rejects(
      () => inspectBackupStaging({ home, stagingId: linkedArchive.stagingId }),
      (err: unknown) => err instanceof HostRpcError && err.details.reason === 'UNSAFE_LINKED_MEDIA',
    );

    // 4. Insufficient disk space
    const okStaging = await makeArchive('ok.zip', {}, validProj);
    await assert.rejects(
      () => inspectBackupStaging({ home, stagingId: okStaging.stagingId, statAvailableBytes: async () => 1024 }),
      (err: unknown) => err instanceof HostRpcError && err.code === 'INSUFFICIENT_SPACE',
    );

    // 5. Cancelled import leaves zero projects or .import-* dirs
    const ac = new AbortController();
    ac.abort(new Error('Job cancelled'));
    await assert.rejects(() => importProjectBackup({ home, store, stagingId: okStaging.stagingId, signal: ac.signal }));
    const projectEntries = await readdir(store.root);
    assert.equal(projectEntries.length, 0);

    // 6. finishPurges removes orphaned .import-* directories
    const orphan = join(store.root, '.import-orphan-crash');
    await mkdir(orphan, { recursive: true });
    await store.finishPurges();
    assert.equal((await readdir(store.root)).length, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
});
