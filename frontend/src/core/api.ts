// frontend/src/core/api.ts
//
// Typed REST client for the Titulus control plane (DEVELOPMENT_PROMPT §7.3).
// All paths are relative and proxied to the backend by Vite (§8.5).

import type { Template } from '@runtime';

export interface TemplateSummary {
  id: string;
  name: string;
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
  id: string;
  templateId: string;
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
  error: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ValidationError {
  path: string;
  message: string;
  params?: unknown;
}

/** On-air snapshot: channelId -> templateIds currently on air. */
export type OnAirSnapshot = Record<string, string[]>;

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
  const res = await fetch(path, {
    headers: init?.body && !(init.body instanceof FormData)
      ? { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }
      : init?.headers,
    ...init,
  });
  const text = await res.text();
  const body = text ? safeJson(text) : null;
  if (!res.ok) {
    const msg = (body && typeof body === 'object' && 'error' in body
      ? String((body as { error: unknown }).error)
      : `${res.status} ${res.statusText}`);
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

export const api = {
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
    create: (body: { name: string; channel_id?: string | null; slots?: RundownSlot[] }) =>
      req<Rundown>('/api/rundowns', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, patch: Partial<Pick<Rundown, 'name' | 'channel_id' | 'slots'>>) =>
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
      return req<{ jobId: string; status: UploadJob['status']; url: string; posterUrl: string; type: UploadJob['type'] }>(
        '/api/uploads',
        { method: 'POST', body: fd },
      );
    },
    job: (id: string) => req<UploadJob>(`/api/uploads/jobs/${id}`),
  },
  onair: {
    get: () => req<OnAirSnapshot>('/api/onair'),
  },
  health: () => req<{ ok: boolean; service: string }>('/api/health'),
};
