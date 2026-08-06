// frontend/src/core/api.ts
//
// Typed REST client for the Titulus control plane (DEVELOPMENT_PROMPT §7.3).
// All paths are relative and proxied to the backend by Vite (§8.5).

import type { Template } from '@runtime';
import { clearSessionToken, getSessionToken } from '@/core/session';

export interface TemplateSummary {
  id: string;
  name: string;
  folderId?: string | null;
  folder_id?: string | null;
  created_at: string;
  updated_at: string;
  thumbnailUrl?: string | null;
}

export interface TemplateRecord extends TemplateSummary {
  data: Template;
}

export interface TemplateFolder {
  id: string;
  name: string;
  sortOrder: number;
  /** When true, folder and all its templates are hidden from Control pickers. */
  hiddenInControl?: boolean;
  hidden_in_control?: boolean;
  created_at: string;
  updated_at: string;
}

export type OutputMode = 'browser' | 'obs_vmix' | 'decklink' | 'stream';
export type KeyerMode = 'external' | 'internal' | 'fill_only';
export type RenderBackend = 'html' | 'unreal';

export interface UnrealAction {
  id: string;
  label: string;
  sortOrder?: number;
  rcObjectPath?: string;
  rcFunctionName?: string;
  rcParameters?: Record<string, unknown>;
  rcPropertyPath?: string;
  rcPropertyValue?: unknown;
}

export interface Channel {
  id: string;
  name: string;
  output_mode: OutputMode;
  device_index: number;
  display_mode: string;
  keyer_mode: KeyerMode;
  stream_url: string;
  render_backend: RenderBackend;
  unreal_endpoint: string;
  unreal_ndi_source: string;
  vs_input_device: number;
  vs_bg_file: string;
  vs_cam_file: string;
  unreal_pad: UnrealAction[];
  created_at: string;
}

export interface RundownSlot {
  slotId: string;
  templateId: string;
  /** html = Titulus HTML template; ue = Unreal Blueprint template */
  kind?: 'html' | 'ue';
  name: string;
  vars: Record<string, string | number>;
  /** Optional link to a DataElement this slot was created from. */
  dataElementId?: string | null;
  // legacy aliases for older persisted data (normalized on backend read).
  id?: string;
  label?: string;
  variables?: Record<string, string | number>;
}

export interface UeTemplateAction {
  id: string;
  label: string;
  rcFunctionName?: string;
  rcParameters?: Record<string, unknown>;
}

export interface UeTemplateData {
  schemaVersion?: number;
  description?: string;
  rcObjectPath: string;
  takeIn?: { functionName: string; parameters?: Record<string, unknown> } | null;
  takeOut?: { functionName: string; parameters?: Record<string, unknown> } | null;
  actions?: UeTemplateAction[];
  variables?: Array<{ id: string; name: string; defaultValue?: string | number }>;
}

export interface UeTemplateSummary {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface UeTemplateRecord extends UeTemplateSummary {
  data: UeTemplateData;
}

export interface DataElement {
  id: string;
  templateId: string;
  name: string;
  vars: Record<string, string | number>;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
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
  type: 'image' | 'video' | 'text';
  status: 'pending' | 'processing' | 'ready' | 'error';
  originalName?: string;
  src?: string;
  url: string;
  posterUrl: string;
  error: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface MediaTag {
  id: string;
  name: string;
  createdAt: string;
}

export interface MediaAsset {
  id: string;
  type: 'image' | 'video';
  displayName: string;
  filename: string;
  relativePath: string;
  url: string;
  posterPath: string | null;
  posterUrl: string | null;
  format: string;
  width: number;
  height: number;
  hasAlpha: boolean;
  durationSec: number | null;
  durationFrames: number | null;
  fps: number | null;
  locked: boolean;
  status: 'ready' | 'processing' | 'error';
  sourceRelativePath: string | null;
  tagIds: string[];
  createdAt: string;
  updatedAt: string;
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

export type Permission = 'template_editor' | 'template_ue_editor' | 'control' | 'settings';

export const ALL_PERMISSIONS: Permission[] = [
  'template_editor',
  'template_ue_editor',
  'control',
  'settings',
];

export const PERMISSION_LABELS: Record<Permission, string> = {
  template_editor: 'Templates',
  template_ue_editor: 'UE Templates',
  control: 'Control',
  settings: 'Settings',
};

export interface AuthUser {
  id: string;
  tenantId: string;
  username: string;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  groupId?: string | null;
  groupName?: string | null;
  permissions?: Permission[];
}

export interface AuthGroup {
  id: string;
  name: string;
  isSystem?: boolean;
  permissions: Permission[];
  createdAt?: string;
  updatedAt?: string;
}

export interface TemplateLock {
  templateId: string;
  userId: string;
  username: string;
  lockedAt: string;
  heartbeatAt: string;
}

/** True if user has the given permission (admin with empty perms = all). */
export function hasPermission(user: AuthUser | null | undefined, perm: Permission): boolean {
  if (!user) return false;
  const perms = user.permissions;
  if ((!perms || perms.length === 0) && user.role === 'admin') return true;
  return (perms ?? []).includes(perm);
}

const ROUTE_PERMISSIONS: { path: string; perm: Permission }[] = [
  { path: '/templates', perm: 'template_editor' },
  { path: '/ue-templates', perm: 'template_ue_editor' },
  { path: '/control', perm: 'control' },
  { path: '/settings', perm: 'settings' },
];

/** First nav path the user may open, or null if none. */
export function firstAllowedPath(user: AuthUser | null | undefined): string | null {
  if (!user) return null;
  for (const { path, perm } of ROUTE_PERMISSIONS) {
    if (hasPermission(user, perm)) return path;
  }
  return null;
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
}

/** On-air snapshot: channelId -> templateIds currently on air. */
export type OnAirEntry = { templateId: string; slotId?: string; waitingContinue?: boolean };
export type OnAirSnapshot = Record<string, OnAirEntry[]>;

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
    if (res.status === 401 && path !== '/api/auth/login') {
      clearSessionToken();
      if (typeof window !== 'undefined') {
        window.location.assign('/login');
      }
    }
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
    if (typeof msg === 'string' && msg.trim()) {
      // Prefer server summary; if it's still the bare default, append details.
      const details = (err as { details?: { errors?: ValidationError[] } }).details;
      const list = details?.errors;
      if (Array.isArray(list) && list.length > 0 && !msg.includes(' — ')) {
        return formatTemplateValidationErrors(list);
      }
      return msg;
    }
  }
  return fallback;
}

/** Format AJV validation errors for toasts (path + message). */
export function formatTemplateValidationErrors(errors: ValidationError[], limit = 3): string {
  if (!errors.length) return 'template validation failed';
  const parts = errors.slice(0, limit).map((e) => {
    const path = e.path && e.path !== '/' ? e.path : '(root)';
    return `${path}: ${e.message || 'invalid'}`;
  });
  const more = errors.length > limit ? ` (+${errors.length - limit} more)` : '';
  return `template validation failed — ${parts.join('; ')}${more}`;
}

export const api = {
  auth: {
    login: (username: string, password: string) =>
      req<{ token: string; expiresAt: string; user: AuthUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      }),
    logout: () => req<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
    me: () =>
      req<{
        user: AuthUser;
        tenantId: string;
        role: UserRole;
        permissions?: Permission[];
      }>('/api/auth/me'),
    listUsers: () => req<AuthUser[]>('/api/auth/users'),
    createUser: (body: {
      username: string;
      password: string;
      role?: UserRole;
      groupId?: string | null;
      isActive?: boolean;
    }) =>
      req<AuthUser>('/api/auth/users', { method: 'POST', body: JSON.stringify(body) }),
    updateUser: (
      id: string,
      body: {
        username?: string;
        password?: string;
        role?: UserRole;
        groupId?: string | null;
        isActive?: boolean;
      },
    ) =>
      req<AuthUser>(`/api/auth/users/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    listGroups: () => req<AuthGroup[]>('/api/auth/groups'),
    createGroup: (body: { name: string; permissions?: Permission[] }) =>
      req<AuthGroup>('/api/auth/groups', { method: 'POST', body: JSON.stringify(body) }),
    updateGroup: (id: string, body: { name?: string; permissions?: Permission[] }) =>
      req<AuthGroup>(`/api/auth/groups/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    deleteGroup: (id: string) =>
      req<{ ok: true }>(`/api/auth/groups/${id}`, { method: 'DELETE' }),
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
    list: (params?: { folderId?: string }) => {
      const query = new URLSearchParams();
      if (params?.folderId) query.set('folderId', params.folderId);
      const suffix = query.toString();
      return req<TemplateSummary[]>(`/api/templates${suffix ? `?${suffix}` : ''}`);
    },
    get: (id: string) => req<TemplateRecord>(`/api/templates/${id}`),
    create: (name: string, data: Template, folderId?: string | null) =>
      req<TemplateRecord>('/api/templates', {
        method: 'POST',
        body: JSON.stringify({ name, data, ...(folderId ? { folderId } : {}) }),
      }),
    update: (id: string, patch: {
      name?: string;
      data?: Template;
      folderId?: string | null;
    }) =>
      req<TemplateRecord>(`/api/templates/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
    uploadThumbnail: (id: string, dataUrl: string) =>
      req<{ ok: true; thumbnailUrl: string }>(`/api/templates/${id}/thumbnail`, {
        method: 'PUT',
        body: JSON.stringify({ dataUrl }),
      }),
    regenerateThumbnail: (id: string) =>
      req<{ ok: true; thumbnailUrl: string }>(`/api/templates/${id}/regenerate-thumbnail`, {
        method: 'POST',
      }),
    remove: (id: string) => req<{ ok: true }>(`/api/templates/${id}`, { method: 'DELETE' }),
    validate: (data: Template) =>
      req<{ valid: boolean; errors: ValidationError[] }>('/api/templates/validate', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    lock: (id: string) =>
      req<TemplateLock>(`/api/templates/${id}/lock`, { method: 'POST' }),
    heartbeat: (id: string) =>
      req<TemplateLock>(`/api/templates/${id}/lock/heartbeat`, { method: 'POST' }),
    unlock: (id: string) =>
      req<{ ok: true }>(`/api/templates/${id}/lock`, { method: 'DELETE' }),
    getLock: (id: string) =>
      req<TemplateLock | null>(`/api/templates/${id}/lock`),
  },
  templateFolders: {
    list: () => req<TemplateFolder[]>('/api/template-folders'),
    create: (name: string) =>
      req<TemplateFolder>('/api/template-folders', { method: 'POST', body: JSON.stringify({ name }) }),
    update: (id: string, patch: { name?: string; sortOrder?: number; hiddenInControl?: boolean }) =>
      req<TemplateFolder>(`/api/template-folders/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
    remove: (id: string, opts?: { deleteTemplates?: boolean }) => {
      const q = opts?.deleteTemplates ? '?deleteTemplates=1' : '';
      return req<{ ok: true; deletedTemplates?: boolean }>(`/api/template-folders/${id}${q}`, {
        method: 'DELETE',
      });
    },
  },
  ueTemplates: {
    list: () => req<UeTemplateSummary[]>('/api/ue-templates'),
    get: (id: string) => req<UeTemplateRecord>(`/api/ue-templates/${id}`),
    create: (body: { name: string; data?: UeTemplateData }) =>
      req<UeTemplateRecord>('/api/ue-templates', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, patch: { name?: string; data?: UeTemplateData }) =>
      req<UeTemplateRecord>(`/api/ue-templates/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
    remove: (id: string) => req<{ ok: true }>(`/api/ue-templates/${id}`, { method: 'DELETE' }),
    play: (
      id: string,
      body: { channelId: string; mode?: 'takeIn' | 'takeOut' | 'action'; actionId?: string; dryRun?: boolean },
    ) =>
      req<{ ok: boolean; dryRun?: boolean; mode?: string; result?: unknown }>(
        `/api/ue-templates/${id}/play${body.dryRun ? '?dryRun=1' : ''}`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
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
    list: (params?: { channelId?: string }) => {
      const query = new URLSearchParams();
      if (params?.channelId) query.set('channelId', params.channelId);
      const suffix = query.toString();
      return req<Rundown[]>(`/api/rundowns${suffix ? `?${suffix}` : ''}`);
    },
    get: (id: string) => req<Rundown>(`/api/rundowns/${id}`),
    create: (body: { name?: string; channel_id?: string | null; channelId?: string | null; slots?: RundownSlot[] }) =>
      req<Rundown>('/api/rundowns', { method: 'POST', body: JSON.stringify(body) }),
    update: (
      id: string,
      patch: Partial<Pick<Rundown, 'name' | 'channel_id' | 'slots'>> & { channelId?: string | null },
    ) =>
      req<Rundown>(`/api/rundowns/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
    remove: (id: string) => req<{ ok: true }>(`/api/rundowns/${id}`, { method: 'DELETE' }),
    reorder: (ids: string[], channelId?: string) =>
      req<Rundown[]>('/api/rundowns/reorder', {
        method: 'POST',
        body: JSON.stringify({ ids, ...(channelId ? { channelId } : {}) }),
      }),
  },
  dataElements: {
    list: (params?: { sort?: 'updated' | 'name'; templateId?: string }) => {
      const query = new URLSearchParams();
      if (params?.sort) query.set('sort', params.sort);
      if (params?.templateId) query.set('templateId', params.templateId);
      const suffix = query.toString();
      return req<DataElement[]>(`/api/data-elements${suffix ? `?${suffix}` : ''}`);
    },
    get: (id: string) => req<DataElement>(`/api/data-elements/${id}`),
    create: (body: { templateId: string; name: string; vars?: Record<string, string | number> }) =>
      req<DataElement>('/api/data-elements', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, patch: { name?: string; vars?: Record<string, string | number> }) =>
      req<DataElement>(`/api/data-elements/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
    remove: (id: string) => req<{ ok: true }>(`/api/data-elements/${id}`, { method: 'DELETE' }),
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
  files: {
    read: (path: string) =>
      req<{ text: string; lines: string[] }>('/api/files/read', {
        method: 'POST',
        body: JSON.stringify({ path }),
      }),
  },
  media: {
    listTags: (q = '') => req<MediaTag[]>(`/api/media/tags${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    createTag: (name: string) =>
      req<MediaTag>('/api/media/tags', { method: 'POST', body: JSON.stringify({ name }) }),
    deleteTag: (id: string) =>
      req<{ ok: true; id: string; name: string }>(`/api/media/tags/${id}`, { method: 'DELETE' }),
    list: (opts: { type: 'image' | 'video'; q?: string; tags?: string[] }) => {
      const p = new URLSearchParams({ type: opts.type });
      if (opts.q) p.set('q', opts.q);
      if (opts.tags?.length) p.set('tags', opts.tags.join(','));
      return req<MediaAsset[]>(`/api/media?${p}`);
    },
    get: (id: string) => req<MediaAsset>(`/api/media/${id}`),
    lookup: (url: string) => req<MediaAsset>(`/api/media/lookup?url=${encodeURIComponent(url)}`),
    update: (id: string, patch: { displayName?: string; locked?: boolean; tagIds?: string[] }) =>
      req<MediaAsset>(`/api/media/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    remove: (id: string) => req<{ ok: true }>(`/api/media/${id}`, { method: 'DELETE' }),
    refresh: (type: 'image' | 'video') =>
      req<{ imported: MediaAsset[]; count: number; repaired?: number }>(`/api/media/refresh?type=${type}`, { method: 'POST' }),
    regeneratePoster: (id: string) =>
      req<MediaAsset>(`/api/media/${id}/regenerate-poster`, { method: 'POST' }),
    import: (file: File, opts?: { displayName?: string; tagIds?: string[] }) => {
      const fd = new FormData();
      fd.append('file', file);
      if (opts?.displayName) fd.append('displayName', opts.displayName);
      if (opts?.tagIds?.length) fd.append('tagIds', JSON.stringify(opts.tagIds));
      return req<{ asset: MediaAsset | null; job: UploadJob | null }>('/api/media/import', { method: 'POST', body: fd });
    },
    finalizeJob: (jobId: string, opts?: { displayName?: string; tagIds?: string[] }) =>
      req<{ asset: MediaAsset; job: UploadJob | null }>('/api/media/finalize-job', {
        method: 'POST',
        body: JSON.stringify({ jobId, ...opts }),
      }),
  },
  onair: {
    get: () => req<OnAirSnapshot>('/api/onair'),
  },
  unreal: {
    actions: (channelId: string) =>
      req<{ channelId: string; render_backend: RenderBackend; unreal_endpoint: string; actions: UnrealAction[] }>(
        `/api/unreal/${channelId}/actions`,
      ),
    putActions: (channelId: string, actions: UnrealAction[]) =>
      req<{ channelId: string; actions: UnrealAction[] }>(`/api/unreal/${channelId}/actions`, {
        method: 'PUT',
        body: JSON.stringify({ actions }),
      }),
    invoke: (channelId: string, actionId: string, opts?: { dryRun?: boolean }) =>
      req<{ ok: boolean; label?: string; dryRun?: boolean; result?: unknown }>(
        `/api/unreal/${channelId}/actions/${actionId}/invoke${opts?.dryRun ? '?dryRun=1' : ''}`,
        { method: 'POST', body: JSON.stringify({}) },
      ),
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
