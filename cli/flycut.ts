#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { z } from 'zod';
import { redactSecrets } from '../shared/errors';
import type { ProjectExportResult, ProjectSuggestResult, ProjectTranscribeResult } from '../shared/projectOps';
import type { OptionValue, ProviderModels } from '../shared/providers';
import { CliHostError, discoverHostConnection, EXIT_CODES, HostCliClient } from './client';
import { ROOT_HELP, SUBCOMMAND_HELP } from './help';

declare const __FLYCUT_CLI_VERSION__: string | undefined;
const CLI_VERSION = typeof __FLYCUT_CLI_VERSION__ === 'string' ? __FLYCUT_CLI_VERSION__ : '2.0.2';

type UuidString = `${string}-${string}-${string}-${string}-${string}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALUE_FLAGS = new Set([
  'host', 'token', 'token-file', 'home', 'operation-id', 'name', 'file', 'asset-id',
  'video', 'provider', 'model', 'language', 'option', 'kind', 'silence-method',
  'config-id', 'vad-provider', 'vad-model', 'gap-threshold', 'out', 'format',
  'quality', 'subtitles', 'subtitle-mode', 'confirmation-id',
]);

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '-h') { flags.help = true; continue; }
    if (arg === '-v') { flags.version = true; continue; }
    if (arg === '-y') { flags.yes = true; continue; }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = (eq >= 0 ? arg.slice(2, eq) : arg.slice(2)).trim();
      if (eq >= 0) {
        const val = arg.slice(eq + 1);
        appendFlag(flags, key, val);
      } else if (VALUE_FLAGS.has(key)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-')) {
          throw new CliHostError('INVALID_ARGUMENT', `选项 --${key} 缺少参数值`, { next: '运行 flycut --help 查看用法。' });
        }
        appendFlag(flags, key, next);
        i += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      throw new CliHostError('INVALID_ARGUMENT', `未知短选项：${arg}`, { next: '运行 flycut --help 查看支持的选项。' });
    }
    positionals.push(arg);
  }
  return { positionals, flags };
}

function appendFlag(flags: ParsedArgs['flags'], key: string, value: string) {
  const prev = flags[key];
  if (prev === undefined) flags[key] = value;
  else if (Array.isArray(prev)) prev.push(value);
  else flags[key] = [String(prev), value];
}

function strFlag(flags: ParsedArgs['flags'], key: string): string | undefined {
  const v = flags[key];
  if (v === undefined || typeof v === 'boolean') return undefined;
  return Array.isArray(v) ? v.at(-1) : v;
}

function boolFlag(flags: ParsedArgs['flags'], key: string): boolean {
  return flags[key] === true || flags[key] === 'true';
}

function listFlag(flags: ParsedArgs['flags'], key: string): string[] {
  const v = flags[key];
  if (v === undefined || typeof v === 'boolean') return [];
  return Array.isArray(v) ? v : [v];
}

function requireUuid(value: string | undefined, label: string): UuidString {
  if (!value || !UUID_RE.test(value)) {
    throw new CliHostError('INVALID_ID', `${label} 必须是合法 UUID（收到：${value ?? '空'}）`, {
      next: `请传入有效的 UUID 格式 ${label}。`,
    });
  }
  return value as UuidString;
}

function optionalUuid(value: string | undefined, label: string): UuidString | undefined {
  return value === undefined ? undefined : requireUuid(value, label);
}

function parseOptionValues(entries: string[]): Record<string, OptionValue> | undefined {
  if (!entries.length) return undefined;
  const out: Record<string, OptionValue> = {};
  for (const item of entries) {
    const eq = item.indexOf('=');
    if (eq <= 0) throw new CliHostError('INVALID_ARGUMENT', `无效模型选项 ${item}，应为 key=value`);
    const key = item.slice(0, eq).trim();
    const raw = item.slice(eq + 1);
    if (raw === 'true') out[key] = true;
    else if (raw === 'false') out[key] = false;
    else if (/^-?\d+(\.\d+)?$/.test(raw)) out[key] = Number(raw);
    else out[key] = raw;
  }
  return out;
}

function resolveAsrModelRef(groups: ProviderModels[], providerArg?: string, modelArg?: string) {
  let providerId = providerArg;
  let modelId = modelArg;
  if (modelId && !providerId && modelId.includes('/')) {
    const slash = modelId.indexOf('/');
    providerId = modelId.slice(0, slash);
    modelId = modelId.slice(slash + 1);
  }
  if (!modelId) {
    throw new CliHostError('MODEL_REQUIRED', '缺少转写模型参数 --model <modelId>', {
      next: '请运行 flycut providers models 查看可用模型，并指定 --provider <id> --model <id>。',
    });
  }
  if (providerId) return { providerId, modelId };
  const matches = groups.filter(g => g.models.some(m => m.id === modelId && m.role === 'asr'));
  if (matches.length === 1) return { providerId: matches[0].provider.id, modelId };
  if (matches.length > 1) {
    throw new CliHostError('MODEL_REQUIRED', `多个 Provider 提供模型 ${modelId}，请显式指定 --provider`, {
      next: `可用 Provider：${matches.map(m => m.provider.id).join(', ')}`,
    });
  }
  throw new CliHostError('NOT_FOUND', `找不到识别模型 ${modelId}`, {
    next: '请运行 flycut providers models 查看可用识别模型。',
  });
}

function writeStdout(text: string) {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function writeStderr(text: string) {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

async function runCommand(parsed: ParsedArgs, client: HostCliClient, log: (msg: string) => void): Promise<{ data: unknown; exitCode?: number; human?: string }> {
  const [cmd, sub, ...rest] = parsed.positionals;
  const { flags } = parsed;
  const operationId = optionalUuid(strFlag(flags, 'operation-id'), 'operationId') ?? randomUUID();
  const noWait = boolFlag(flags, 'no-wait');
  const bypassRequested = boolFlag(flags, 'yes') || boolFlag(flags, 'force') || boolFlag(flags, 'no-confirm');

  if (cmd === 'status' || (cmd === 'host' && sub === 'info')) {
    const [info, identity] = await Promise.all([client.call('host.info'), client.call('projects.identity')]);
    return {
      data: { url: client.url, hostId: identity.hostId, protocolVersion: info.protocolVersion, generation: info.generation, capabilities: info.capabilities, providers: info.providers },
      human: `Host 已连接: ${client.url}\nhostId: ${identity.hostId}\n协议版本: v${info.protocolVersion}\nProviders: ${info.providers.map(p => p.id).join(', ') || '(无)'}`,
    };
  }

  if (cmd === 'providers') {
    if (sub === 'list') {
      const providers = await client.call('providers.list');
      return { data: providers, human: providers.length ? providers.map(p => `${p.id}\t${p.name}\t${p.kind}`).join('\n') : '暂无可用 Provider。' };
    }
    if (sub === 'models') {
      const groups = await client.call('providers.models');
      const lines: string[] = [];
      for (const g of groups) {
        for (const m of g.models) lines.push(`${g.provider.id}/${m.id}\t${m.role}\t${m.status}\t${m.name}`);
        if (g.error) lines.push(`${g.provider.id}\terror\t${g.error}`);
      }
      return { data: groups, human: lines.length ? lines.join('\n') : '暂无模型。' };
    }
    if (sub === 'prepare') {
      const providerId = strFlag(flags, 'provider');
      const modelId = strFlag(flags, 'model');
      if (!providerId || !modelId) {
        throw new CliHostError('MODEL_REQUIRED', '准备模型需要 --provider 与 --model', { next: '运行 flycut providers models 查看 ID。' });
      }
      const job = await client.call('providers.prepare', { providerId, modelId });
      if (noWait) return { data: { jobId: job.id, status: job.status, providerId, modelId }, human: `已提交模型准备任务: ${job.id}` };
      const settled = await client.waitForJob(job.id);
      return { data: { jobId: settled.id, status: settled.status, result: settled.result }, human: `模型已就绪: ${providerId}/${modelId}` };
    }
    throw new CliHostError('INVALID_ARGUMENT', `未知 providers 子命令：${sub ?? '(空)'}`, { next: SUBCOMMAND_HELP.providers });
  }

  if (cmd === 'ai' && sub === 'list') {
    const snapshot = await client.call('aiSettings.list');
    return {
      data: snapshot,
      human: snapshot.configs.length
        ? snapshot.configs.map(c => `${c.id === snapshot.selectedId ? '*' : ' '} ${c.id}\t${c.name}\t${c.model}\thasKey=${c.hasApiKey}`).join('\n')
        : 'Host 尚未配置 AI 模型。',
    };
  }

  if (cmd === 'media' && sub === 'upload') {
    const file = rest[0] ?? strFlag(flags, 'file');
    if (!file) throw new CliHostError('INVALID_ARGUMENT', '请提供要上传的媒体文件路径', { next: SUBCOMMAND_HELP.media });
    const uploaded = await client.uploadMediaFile(file, operationId);
    return { data: uploaded, human: `上传成功 assetId=${uploaded.assetId} (${uploaded.size} bytes)` };
  }

  if (cmd === 'projects') {
    if (sub === 'list') {
      const items = await client.call('projects.list');
      return { data: items, human: items.length ? items.map(p => `${p.id}\t${p.name}\tvideos=${p.videoCount}\trev=${p.revision}`).join('\n') : '暂无项目。' };
    }
    if (sub === 'create') {
      const name = strFlag(flags, 'name')?.trim();
      if (!name) throw new CliHostError('INVALID_ARGUMENT', '创建项目需要 --name <名称>', { next: SUBCOMMAND_HELP.projects });
      const file = strFlag(flags, 'file');
      const assetArg = optionalUuid(strFlag(flags, 'asset-id'), 'assetId');
      const empty = boolFlag(flags, 'empty');
      if (empty || (!file && !assetArg)) {
        if (!empty && !file && !assetArg) throw new CliHostError('INVALID_ARGUMENT', '请指定 --file <路径>、--asset-id <uuid> 或 --empty', { next: SUBCOMMAND_HELP.projects });
        const created = await client.call('projects.createEmpty', { name });
        return { data: created, human: `已创建空项目: ${created.projectId}` };
      }
      let assetId = assetArg;
      let videoName = basename(file ?? 'media');
      let mimeType = '';
      if (file) {
        const uploaded = await client.uploadMediaFile(file, operationId);
        assetId = uploaded.assetId as UuidString;
        videoName = uploaded.fileName;
        mimeType = uploaded.mimeType;
      }
      const created = await client.call('projects.create', {
        name,
        videoName,
        durationSeconds: 0,
        media: { assetId: assetId!, mimeType },
        operationId,
      });
      return {
        data: { projectId: created.projectId, videoId: created.videoId, revision: created.revision, assetId },
        human: `已创建项目: ${created.projectId} (videoId=${created.videoId})`,
      };
    }
    if (sub === 'get' || sub === 'detail' || sub === 'open') {
      const projectId = requireUuid(rest[0], 'projectId');
      const videoId = optionalUuid(strFlag(flags, 'video'), 'videoId');
      const opened = await client.call('projects.open', { projectId, ...(videoId ? { videoId } : {}) });
      if (opened.status !== 'ok') {
        throw new CliHostError(opened.status === 'trashed' ? 'PROJECT_TRASHED' : 'VERSION_CONFLICT', `项目不可打开（${opened.status}）：${opened.name}`);
      }
      const suggestions = await client.call('projects.suggestions.list', { projectId, videoId: opened.video.id });
      const summary = {
        status: opened.status,
        project: { id: opened.project.id, name: opened.project.name, revision: opened.project.revision, styleRevision: opened.project.styleRevision, updatedAt: opened.project.updatedAt },
        video: opened.video,
        videos: opened.videos,
        media: opened.media,
        hasTranscript: !!opened.transcript,
        transcript: opened.transcript ? { language: opened.transcript.language, duration: opened.transcript.duration, chunkCount: opened.transcript.chunks.length, wordCount: opened.transcript.wordChunks?.length ?? 0, hasWordTimestamps: opened.transcript.hasWordTimestamps === true } : null,
        edits: opened.edits ? { chunkCount: opened.edits.chunks.length, deletedCount: opened.edits.editing?.edl.deleted.length ?? 0 } : null,
        pendingSuggestionsCount: suggestions.reduce((n, item) => n + item.batch.items.length, 0),
      };
      return {
        data: summary,
        human: `项目: ${opened.project.name} (${opened.project.id})\n视频: ${opened.video.name} (${opened.video.id})\n转写: ${summary.hasTranscript ? `${summary.transcript!.chunkCount} 句` : '未转写'}\n待审建议批次: ${suggestions.length}`,
      };
    }
    if (sub === 'add-video') {
      const projectId = requireUuid(rest[0], 'projectId');
      const file = strFlag(flags, 'file');
      const assetArg = optionalUuid(strFlag(flags, 'asset-id'), 'assetId');
      if (!file && !assetArg) throw new CliHostError('INVALID_ARGUMENT', 'add-video 需要 --file 或 --asset-id', { next: SUBCOMMAND_HELP.projects });
      let assetId = assetArg;
      let videoName = strFlag(flags, 'name') ?? basename(file ?? 'video');
      let mimeType = '';
      if (file) {
        const uploaded = await client.uploadMediaFile(file, operationId);
        assetId = uploaded.assetId as UuidString;
        videoName = strFlag(flags, 'name') ?? uploaded.fileName;
        mimeType = uploaded.mimeType;
      }
      const added = await client.call('projects.addVideo', { projectId, videoName, durationSeconds: 0, media: { assetId: assetId!, mimeType }, operationId });
      return { data: { projectId, ...added, assetId }, human: `已添加视频: ${added.videoId} (rev=${added.revision})` };
    }
    if (sub === 'delete' || sub === 'trash') {
      const projectId = requireUuid(rest[0], 'projectId');
      const purge = boolFlag(flags, 'purge');
      const confirmation = await client.call('confirmations.create', {
        kind: purge ? 'purge-project' : 'trash-project',
        source: 'cli',
        target: { projectId },
        operationId,
      });
      log(`破坏性操作已生成客户端确认请求（${confirmation.id}）${bypassRequested ? '；注意：命令行 --yes/--force 不能绕过客户端确认' : ''}`);
      return {
        exitCode: EXIT_CODES.CONFIRMATION,
        data: {
          status: 'pending_confirmation',
          confirmationId: confirmation.id,
          bypassRejected: bypassRequested,
          confirmation,
          next: '请在 FlyCut UI 客户端确认或拒绝该请求；可通过 flycut confirmations get ' + confirmation.id + ' 查询状态。',
        },
        human: `等待客户端确认（未执行）：${confirmation.summary}\nconfirmationId: ${confirmation.id}${bypassRequested ? '\n提示: --yes 参数不能绕过客户端确认。' : ''}`,
      };
    }
    if (sub === 'remove-video') {
      const projectId = requireUuid(rest[0], 'projectId');
      const videoId = requireUuid(rest[1], 'videoId');
      const confirmation = await client.call('confirmations.create', {
        kind: 'remove-video',
        source: 'cli',
        target: { projectId, videoId },
        operationId,
      });
      log(`破坏性操作已生成客户端确认请求（${confirmation.id}）${bypassRequested ? '；注意：命令行 --yes/--force 不能绕过客户端确认' : ''}`);
      return {
        exitCode: EXIT_CODES.CONFIRMATION,
        data: {
          status: 'pending_confirmation',
          confirmationId: confirmation.id,
          bypassRejected: bypassRequested,
          confirmation,
          next: '请在 FlyCut UI 客户端确认或拒绝该请求。',
        },
        human: `等待客户端确认（未执行）：${confirmation.summary}\nconfirmationId: ${confirmation.id}`,
      };
    }
    throw new CliHostError('INVALID_ARGUMENT', `未知 projects 子命令：${sub ?? '(空)'}`, { next: SUBCOMMAND_HELP.projects });
  }

  if (cmd === 'transcribe') {
    const projectId = requireUuid(sub, 'projectId');
    const videoId = optionalUuid(strFlag(flags, 'video'), 'videoId');
    const groups = await client.call('providers.models');
    const model = resolveAsrModelRef(groups, strFlag(flags, 'provider'), strFlag(flags, 'model'));
    const language = strFlag(flags, 'language') ?? 'auto';
    const options = parseOptionValues(listFlag(flags, 'option'));
    const job = await client.call('projects.transcribe', { projectId, videoId, model, language, options, operationId });
    if (noWait) {
      return {
        data: { jobId: job.id, status: job.status, operationId: job.operationId, projectId, videoId },
        human: `已提交转写任务: ${job.id} (status=${job.status})`,
      };
    }
    const settled = await client.waitForJob(job.id);
    const result = settled.result as ProjectTranscribeResult;
    return {
      data: { jobId: settled.id, status: settled.status, ...result },
      human: `转写完成: projectId=${result.projectId}, videoId=${result.videoId}, chunks=${result.chunkCount}, words=${result.wordCount}, rev=${result.revision}`,
    };
  }

  if (cmd === 'suggest') {
    const projectId = requireUuid(sub, 'projectId');
    const videoId = optionalUuid(strFlag(flags, 'video'), 'videoId');
    const kind = z.enum(['fillers', 'silence', 'semantic', 'all']).parse(strFlag(flags, 'kind') ?? 'fillers');
    const silenceMethod = z.enum(['auto', 'vad', 'gap']).parse(strFlag(flags, 'silence-method') ?? 'auto');
    const configId = optionalUuid(strFlag(flags, 'config-id'), 'configId');
    const vadProvider = strFlag(flags, 'vad-provider');
    const vadModelId = strFlag(flags, 'vad-model');
    const vadModel = vadProvider && vadModelId ? { providerId: vadProvider, modelId: vadModelId } : undefined;
    const gapStr = strFlag(flags, 'gap-threshold');
    const gapThresholdSeconds = gapStr ? Number(gapStr) : undefined;
    const job = await client.call('projects.suggestEdits', {
      projectId, videoId, kind, silenceMethod, configId, vadModel, gapThresholdSeconds, operationId,
    });
    if (noWait) {
      return { data: { jobId: job.id, status: job.status, operationId: job.operationId, projectId }, human: `已提交建议生成任务: ${job.id}` };
    }
    const settled = await client.waitForJob(job.id);
    const result = settled.result as ProjectSuggestResult;
    return {
      data: { jobId: settled.id, jobStatus: settled.status, ...result },
      human: `已生成待审建议（未修改正式 EDL）：suggestionId=${result.suggestionId}, total=${result.total}, selected=${result.selected}`,
    };
  }

  if (cmd === 'suggestions') {
    if (sub === 'list') {
      const projectId = requireUuid(rest[0], 'projectId');
      const videoId = optionalUuid(strFlag(flags, 'video'), 'videoId');
      const items = await client.call('projects.suggestions.list', { projectId, videoId });
      return { data: items, human: items.length ? items.map(s => `${s.id}\trev=${s.baseRevision}\titems=${s.batch.items.length}\t${s.createdAt}`).join('\n') : '暂无待审建议。' };
    }
    if (sub === 'dismiss') {
      const projectId = requireUuid(rest[0], 'projectId');
      const videoId = requireUuid(rest[1], 'videoId');
      const suggestionId = requireUuid(rest[2], 'suggestionId');
      const res = await client.call('projects.suggestions.dismiss', { projectId, videoId, suggestionId });
      return { data: res, human: `已忽略待审建议: ${suggestionId}` };
    }
    throw new CliHostError('INVALID_ARGUMENT', `未知 suggestions 子命令：${sub ?? '(空)'}`, { next: SUBCOMMAND_HELP.suggestions });
  }

  if (cmd === 'export') {
    const projectId = requireUuid(sub, 'projectId');
    const videoId = optionalUuid(strFlag(flags, 'video'), 'videoId');
    const out = strFlag(flags, 'out');
    if (!out) throw new CliHostError('INVALID_ARGUMENT', '导出需要指定新输出路径 --out <filePath>', { next: SUBCOMMAND_HELP.export });
    const absOut = resolve(out);
    const format = z.enum(['mp4', 'webm', 'srt', 'vtt', 'json', 'ass']).parse(strFlag(flags, 'format') ?? 'mp4');
    const quality = z.enum(['high', 'medium', 'low']).parse(strFlag(flags, 'quality') ?? 'medium');
    const subtitleProcessing = z.enum(['none', 'soft', 'hard']).parse(strFlag(flags, 'subtitles') ?? 'none');
    const subtitleExportMode = z.enum(['Bilingual', 'Main', 'Second']).parse(strFlag(flags, 'subtitle-mode') ?? 'Bilingual');
    const preserveAudio = !boolFlag(flags, 'no-audio');
    const confirmationId = optionalUuid(strFlag(flags, 'confirmation-id'), 'confirmationId');
    const targetExists = !!(await stat(absOut).catch(() => undefined));
    const forceOverwriteFlag = boolFlag(flags, 'overwrite');
    let allowOverwrite = false;

    if (targetExists || forceOverwriteFlag) {
      if (confirmationId) {
        await client.call('confirmations.consume', { id: confirmationId });
        allowOverwrite = true;
      } else {
        const confirmation = await client.call('confirmations.create', {
          kind: 'overwrite-export',
          source: 'cli',
          target: { projectId, ...(videoId ? { videoId } : {}), outputName: basename(absOut), format },
          operationId,
        });
        log(`目标文件已存在或请求覆盖导出，已生成客户端确认请求（${confirmation.id}）${bypassRequested ? '；--yes 不能绕过' : ''}`);
        return {
          exitCode: EXIT_CODES.CONFIRMATION,
          data: {
            status: 'pending_confirmation',
            confirmationId: confirmation.id,
            bypassRejected: bypassRequested,
            outPath: absOut,
            confirmation,
            next: `请在 FlyCut UI 客户端确认后，使用 --confirmation-id ${confirmation.id} 重新执行导出。`,
          },
          human: `目标已存在，等待客户端确认（未覆盖）：${absOut}\nconfirmationId: ${confirmation.id}`,
        };
      }
    }

    const job = await client.call('projects.export', {
      projectId, videoId, format, quality, preserveAudio, subtitleProcessing, subtitleExportMode, operationId,
    });
    if (noWait) {
      return {
        data: { jobId: job.id, status: job.status, operationId: job.operationId, projectId, format, outPath: absOut },
        human: `已提交导出任务: ${job.id}`,
      };
    }
    const settled = await client.waitForJob(job.id);
    const result = settled.result as ProjectExportResult;
    const downloaded = await client.downloadAssetToFile(result.assetId, absOut, allowOverwrite);
    await client.call('assets.delete', { assetId: result.assetId }).catch(() => undefined);
    return {
      data: { jobId: settled.id, status: settled.status, ...result, outPath: downloaded.outPath, sizeBytes: downloaded.sizeBytes },
      human: `导出完成: ${downloaded.outPath} (${downloaded.sizeBytes} bytes, assetId=${result.assetId})`,
    };
  }

  if (cmd === 'jobs') {
    if (sub === 'list') {
      const jobs = await client.call('jobs.list');
      return { data: jobs, human: jobs.length ? jobs.map(j => `${j.id}\t${j.status}\t${j.updatedAt}`).join('\n') : '暂无任务。' };
    }
    if (sub === 'get') {
      const id = requireUuid(rest[0], 'jobId');
      const job = await client.call('jobs.get', { id });
      return { data: job, human: `任务 ${job.id}: status=${job.status}${job.progress?.progress !== undefined ? ` (${Math.round(job.progress.progress)}%)` : ''}${job.error ? ` error=${job.error}` : ''}` };
    }
    if (sub === 'cancel') {
      const id = requireUuid(rest[0], 'jobId');
      const job = await client.call('jobs.cancel', { id });
      return { data: job, human: `任务已请求取消: ${job.id} (status=${job.status})` };
    }
    throw new CliHostError('INVALID_ARGUMENT', `未知 jobs 子命令：${sub ?? '(空)'}`, { next: SUBCOMMAND_HELP.jobs });
  }

  if (cmd === 'confirmations') {
    if (sub === 'list') {
      const pendingOnly = boolFlag(flags, 'pending');
      const items = await client.call('confirmations.list', pendingOnly ? { status: 'pending' } : {});
      return { data: items, human: items.length ? items.map(c => `${c.id}\t${c.status}\t${c.kind}\t${c.summary}`).join('\n') : '暂无确认请求。' };
    }
    if (sub === 'get') {
      const id = requireUuid(rest[0], 'confirmationId');
      const item = await client.call('confirmations.get', { id });
      return { data: item, human: `确认请求 ${item.id}: status=${item.status} (${item.summary})` };
    }
    throw new CliHostError('INVALID_ARGUMENT', `未知 confirmations 子命令：${sub ?? '(空)'}`, { next: SUBCOMMAND_HELP.confirmations });
  }

  throw new CliHostError('INVALID_ARGUMENT', `未知命令：${cmd ?? '(空)'}`, { next: '运行 flycut --help 查看支持的命令。' });
}

export async function main(argv = process.argv.slice(2)) {
  let jsonMode = argv.includes('--json');
  const log = (msg: string) => writeStderr(`[flycut] ${msg}`);
  let client: HostCliClient | undefined;

  try {
    const parsed = parseArgs(argv);
    jsonMode = boolFlag(parsed.flags, 'json');
    if (boolFlag(parsed.flags, 'version')) {
      if (jsonMode) writeStdout(JSON.stringify({ ok: true, data: { version: CLI_VERSION } }));
      else writeStdout(CLI_VERSION);
      return EXIT_CODES.OK;
    }
    if (boolFlag(parsed.flags, 'help') || parsed.positionals.length === 0) {
      const topic = parsed.positionals[0];
      const text = (topic && SUBCOMMAND_HELP[topic]) ? SUBCOMMAND_HELP[topic] : ROOT_HELP;
      if (jsonMode) writeStdout(JSON.stringify({ ok: true, data: { help: text, commands: Object.keys(SUBCOMMAND_HELP) } }));
      else writeStdout(text);
      return EXIT_CODES.OK;
    }

    const conn = await discoverHostConnection({
      host: strFlag(parsed.flags, 'host'),
      token: strFlag(parsed.flags, 'token'),
      tokenFile: strFlag(parsed.flags, 'token-file'),
      home: strFlag(parsed.flags, 'home'),
    });
    client = new HostCliClient(conn, log);
    const outcome = await runCommand(parsed, client, log);
    const exitCode = outcome.exitCode ?? EXIT_CODES.OK;
    if (jsonMode) {
      const payload = exitCode === EXIT_CODES.OK
        ? { ok: true, data: outcome.data }
        : { ok: false, error: { code: 'CONFIRMATION_REQUIRED', message: outcome.human ?? '需要客户端确认', ...(typeof outcome.data === 'object' && outcome.data ? outcome.data : {}) } };
      writeStdout(redactSecrets(JSON.stringify(payload)));
    } else {
      writeStdout(redactSecrets(outcome.human ?? JSON.stringify(outcome.data, null, 2)));
    }
    return exitCode;
  } catch (error) {
    const cliErr = error instanceof CliHostError
      ? error
      : error instanceof z.ZodError
        ? new CliHostError('INVALID_ARGUMENT', error.issues.map(i => i.message).join('; '), { next: '运行 flycut --help 查看参数格式。' })
        : new CliHostError('RPC_ERROR', error instanceof Error ? error.message : String(error));
    const safeMsg = client ? client.redact(cliErr.message) : redactSecrets(cliErr.message);
    const safeNext = cliErr.next ? (client ? client.redact(cliErr.next) : redactSecrets(cliErr.next)) : undefined;
    if (jsonMode) {
      writeStdout(JSON.stringify({
        ok: false,
        error: {
          code: cliErr.code,
          message: safeMsg,
          ...(safeNext ? { next: safeNext } : {}),
          ...(Object.keys(cliErr.details).length ? { details: cliErr.details } : {}),
        },
      }));
    } else {
      writeStderr(`错误 [${cliErr.code}]: ${safeMsg}`);
      if (safeNext) writeStderr(`下一步: ${safeNext}`);
    }
    return cliErr.exitCode;
  }
}

const code = await main();
process.exit(code);
