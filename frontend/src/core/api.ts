// frontend/src/core/api.ts
//
// Typed REST client for the Titulus control plane (DEVELOPMENT_PROMPT §7.3).
// All paths are relative and proxied to the backend by Vite (§8.5).

import type { Template } from '@runtime';
import { getSessionToken } from '@/core/session';

export interface TemplateSummary {
  id: string;
  name: string;
  folder_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface TemplateRecord extends TemplateSummary {
  data: Template;
}

export type OutputMode = 'browser' | 'obs_vmix' | 'decklink' | 'stream';
export type KeyerMode = 'external' | 'internal' | 'fill_only';

export interface Channel {
  id: string;
  name: string;
  output_mode: OutputMode;
  device_index: number;
  display_mode: string;
  keyer_mode: KeyerMode;
  stream_url: string;
  created_at: string;
}

export interface RundownSlot {
  slotId: string;
  templateId: string;
  name: string;
  vars: Record<string, string | number>;
  // legacy aliases for older persisted data (normalized on backend read).
  id?: string;
  label?: string;
  variables?: Record<string, string | number>;
}

export interface Rundown {
  id: string;
  name: string;
  channel_id: string | null;
  slots: RundownSlot[];
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface UploadJob {
  id: string;
  type: 'image' | 'video';
  status: 'pending' | 'processing' | 'ready' | 'error';
  originalName?: string;
  src?: string;
  url: string;
  posterUrl: string;
  profile?: string | null;
  hasAlpha?: boolean;
  probe?: {
    codec?: string;
    width?: number;
    height?: number;
    fps?: number;
  };
  error: {
    code: string;
    message: string;
    details?: string;
    retriable?: boolean;
  } | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface LicenseState {
  status: 'unlicensed' | 'active' | 'expired' | 'invalid';
  plan: string;
  holder: string;
  hasKey: boolean;
  keyMasked: string;
  activatedAt: string | null;
  expiresAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export type UserRole = 'operator' | 'admin';

export interface AuthUser {
  id: string;
  tenantId: string;
  username: string;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Entitlements {
  status: 'unlicensed' | 'active' | 'expired' | 'invalid';
  plan: 'none' | 'starter' | 'pro' | 'enterprise';
  holder: string;
  expiresAt: string | null;
  limits: {
    maxChannels: number;
    decklink: boolean;
    stream: boolean;
    users: number;
  };
}

export interface AuditEvent {
  id: number;
  tenantId: string | null;
  userId: string | null;
  username: string | null;
  role: UserRole | null;
  eventType: string;
  method: string;
  path: string;
  status: number;
  ip: string;
  userAgent: string;
  details: unknown;
  createdAt: string;
}

export interface ValidationError {
  path: string;
  message: string;
  keyword?: string;
  schemaPath?: string;
  params?: unknown;
  code?: string;
  capabilities?: string[];
}

/** On-air snapshot: channelId -> templateIds currently on air. */
export type OnAirSnapshot = Record<string, string[]>;

export interface OnAirDetailsItem {
  templateId: string;
  slotId?: string;
  sourceTemplateId?: string;
  layerId?: number;
  waitingContinue: boolean;
}

export interface OnAirDetailsSnapshot {
  schemaVersion: 'onair-details-v1';
  channels: Record<string, OnAirDetailsItem[]>;
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  const token = getSessionToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init?.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(path, {
    headers,
    ...init,
  });
  const text = await res.text();
  const body = text ? safeJson(text) : null;
  if (!res.ok) {
    const msg = errorMessageFromBody(body, `${res.status} ${res.statusText}`);
    throw new ApiError(res.status, msg, body);
  }
  return body as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessageFromBody(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  if (!('error' in body)) return fallback;
  const err = (body as { error: unknown }).error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  return fallback;
}

export const api = {
  auth: {
    login: (username: string, password: string) =>
      req<{ token: string; expiresAt: string; user: AuthUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      }),
    logout: () => req<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
    me: () => req<{ user: AuthUser; tenantId: string; role: UserRole }>('/api/auth/me'),
    listUsers: () => req<AuthUser[]>('/api/auth/users'),
    createUser: (body: { username: string; password: string; role?: UserRole }) =>
      req<AuthUser>('/api/auth/users', { method: 'POST', body: JSON.stringify(body) }),
  },
  billing: {
    entitlements: () => req<Entitlements>('/api/billing/entitlements'),
  },
  audit: {
    events: (params?: { limit?: number; eventType?: string }) => {
      const query = new URLSearchParams();
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.eventType) query.set('eventType', params.eventType);
      const suffix = query.toString();
      return req<AuditEvent[]>(`/api/audit/events${suffix ? `?${suffix}` : ''}`);
    },
  },
  templates: {
    list: () => req<TemplateSummary[]>('/api/templates'),
    get: (id: string) => req<TemplateRecord>(`/api/templates/${id}`),
    create: (name: string, data: Template) =>
      req<TemplateRecord>('/api/templates', { method: 'POST', body: JSON.stringify({ name, data }) }),
    update: (id: string, patch: { name?: string; data?: Template }) =>
      req<TemplateRecord>(`/api/templates/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
    remove: (id: string) => req<{ ok: true }>(`/api/templates/${id}`, { method: 'DELETE' }),
    validate: (data: Template) =>
      req<{ valid: boolean; errors: ValidationError[] }>('/api/templates/validate', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    prepare: (body: {
      template?: Template;
      templateId?: string;
      trigger?: 'take' | 'load' | 'update' | 'refresh';
      variables?: Record<string, string | number>;
    }) =>
      req<{
        ok: boolean;
        blocked: boolean;
        overrides: Record<string, string | number>;
        errors: Array<{ code?: string; message: string }>;
        template: Template | null;
      }>('/api/templates/prepare', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },
  media: {
    list: (params?: { q?: string; tag?: string }) => {
      const query = new URLSearchParams();
      if (params?.q) query.set('q', params.q);
      if (params?.tag) query.set('tag', params.tag);
      const suffix = query.toString();
      return req<Array<{ id: string; title: string; token: string; url: string | null; tags: string[] }>>(
        `/api/media${suffix ? `?${suffix}` : ''}`,
      );
    },
  },
  templateFolders: {
    list: () => req<Array<{ id: string; name: string; hide_in_control: number }>>('/api/template-folders'),
    create: (name: string) => req<{ id: string; name: string }>('/api/template-folders', { method: 'POST', body: JSON.stringify({ name }) }),
    assign: (folderId: string, templateId: string) =>
      req<{ ok: true }>(`/api/template-folders/${folderId}/assign`, { method: 'POST', body: JSON.stringify({ templateId }) }),
    unfile: (templateId: string) =>
      req<{ ok: true }>('/api/template-folders/unfile', { method: 'POST', body: JSON.stringify({ templateId }) }),
  },
  dataElements: {
    list: () => req<Array<{ id: string; name: string; templateId: string; payload: Record<string, unknown> }>>('/api/data-elements'),
    create: (body: { name: string; templateId: string; payload?: Record<string, unknown> }) =>
      req('/api/data-elements', { method: 'POST', body: JSON.stringify(body) }),
  },
  templateLocks: {
    acquire: (id: string) => req<{ lock: { username: string } }>(`/api/templates/${id}/lock`, { method: 'POST' }),
    heartbeat: (id: string) => req<{ lock: { username: string } }>(`/api/templates/${id}/heartbeat`, { method: 'POST' }),
    release: (id: string) => req<{ ok: true }>(`/api/templates/${id}/unlock`, { method: 'POST' }),
  },
  files: {
    list: () => req<Array<{ id: string; original_name: string; stored_name: string; mime: string; size_bytes: number }>>('/api/files'),
    read: (path: string) =>
      req<{ text: string; lines: string[] }>('/api/files/read', {
        method: 'POST',
        body: JSON.stringify({ path }),
      }),
    upload: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return req<{ id: string; name: string; path: string; size: number; mime: string }>('/api/files', {
        method: 'POST',
        body: fd,
      });
    },
  },
  channels: {
    list: () => req<Channel[]>('/api/channels'),
    get: (id: string) => req<Channel>(`/api/channels/${id}`),
    create: (body: Partial<Channel> & { name: string }) =>
      req<Channel>('/api/channels', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, patch: Partial<Channel>) =>
      req<Channel>(`/api/channels/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
    remove: (id: string) => req<{ ok: true }>(`/api/channels/${id}`, { method: 'DELETE' }),
  },
  rundowns: {
    list: () => req<Rundown[]>('/api/rundowns'),
    get: (id: string) => req<Rundown>(`/api/rundowns/${id}`),
    create: (body: { name?: string; channel_id?: string | null; channelId?: string | null; slots?: RundownSlot[] }) =>
      req<Rundown>('/api/rundowns', { method: 'POST', body: JSON.stringify(body) }),
    update: (
      id: string,
      patch: Partial<Pick<Rundown, 'name' | 'channel_id' | 'slots'>> & { channelId?: string | null },
    ) =>
      req<Rundown>(`/api/rundowns/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
    remove: (id: string) => req<{ ok: true }>(`/api/rundowns/${id}`, { method: 'DELETE' }),
    reorder: (ids: string[]) =>
      req<Rundown[]>('/api/rundowns/reorder', { method: 'POST', body: JSON.stringify({ ids }) }),
  },
  settings: {
    get: () => req<Record<string, string>>('/api/settings'),
    put: (obj: Record<string, string>) =>
      req<Record<string, string>>('/api/settings', { method: 'PUT', body: JSON.stringify(obj) }),
  },
  uploads: {
    upload: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return req<{
        jobId: string;
        status: UploadJob['status'];
        url: string;
        posterUrl: string;
        type: UploadJob['type'];
        profile: string | null;
        hasAlpha: boolean;
        error: UploadJob['error'];
      }>(
        '/api/uploads',
        { method: 'POST', body: fd },
      );
    },
    job: (id: string) => req<UploadJob>(`/api/uploads/jobs/${id}`),
  },
  onair: {
    get: () => req<OnAirSnapshot>('/api/onair'),
    details: () => req<OnAirDetailsSnapshot>('/api/onair/details'),
  },
  license: {
    get: () => req<LicenseState>('/api/license'),
    activate: (body: { licenseKey: string; holder?: string; plan?: string }) =>
      req<LicenseState>('/api/license/activate', { method: 'POST', body: JSON.stringify(body) }),
    deactivate: () => req<LicenseState>('/api/license/deactivate', { method: 'POST' }),
    check: (body: { status?: LicenseState['status']; lastError?: string }) =>
      req<LicenseState>('/api/license/check', { method: 'POST', body: JSON.stringify(body) }),
  },
  health: () => req<{ ok: boolean; service: string }>('/api/health'),
};
