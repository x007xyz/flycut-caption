import type { MediaUploadView } from '@/stores/projectStore';

export interface UploadLocator {
  version: 1;
  hostId: string;
  sessionId: string;
  operationId: string;
  kind: 'create' | 'add';
  projectId?: string;
  fileName: string;
  size: number;
  mimeType: string;
  sha256: string;
  target: string;
  createdAt: string;
}

const PREFIX = 'flycut.upload.sessions.';

/** Locator metadata only: no source media, transcript, token, API key or account data. */
export class UploadLocatorStore {
  private key(hostId: string) { return `${PREFIX}${hostId}`; }

  read(hostId: string): UploadLocator[] {
    try {
      const parsed = JSON.parse(localStorage.getItem(this.key(hostId)) ?? '[]') as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is UploadLocator => !!item && typeof item === 'object'
        && (item as UploadLocator).version === 1 && (item as UploadLocator).hostId === hostId
        && typeof (item as UploadLocator).sessionId === 'string' && typeof (item as UploadLocator).sha256 === 'string');
    } catch { return []; }
  }

  save(locator: UploadLocator) {
    const items = this.read(locator.hostId).filter(item => item.sessionId !== locator.sessionId);
    items.push(locator);
    this.write(locator.hostId, items.slice(-20));
  }

  remove(hostId: string, sessionId: string) {
    this.write(hostId, this.read(hostId).filter(item => item.sessionId !== sessionId));
  }

  removeKey(hostId: string, key: string) {
    this.write(hostId, this.read(hostId).filter(item => item.operationId !== key));
  }

  private write(hostId: string, items: UploadLocator[]) {
    try { localStorage.setItem(this.key(hostId), JSON.stringify(items)); } catch { /* locator is best-effort; Host remains authoritative */ }
  }
}

export function viewFromLocator(locator: UploadLocator): MediaUploadView {
  return { key: locator.operationId, kind: locator.kind, projectId: locator.projectId, operationId: locator.operationId,
    sessionId: locator.sessionId, fileName: locator.fileName, size: locator.size, mimeType: locator.mimeType,
    target: locator.target, phase: 'needs-file', uploadedBytes: 0, sha256: locator.sha256, attempts: 0 };
}
