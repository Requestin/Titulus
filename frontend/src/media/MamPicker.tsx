import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Image, LayoutGrid, List, Lock, Pencil, RefreshCw, Search, Trash2, Unlock, Upload } from 'lucide-react';
import { api, type MediaAsset, type MediaTag } from '@/core/api';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/form';
import { toast } from '@/core/toast';
import { cn } from '@/lib/cn';
import { rememberMediaUrl } from '@/editor/mediaResolve';

type MediaKind = 'image' | 'video';
type FilesView = 'list' | 'grid';

function displayName(asset: MediaAsset): string {
  return asset.title || asset.originalName || asset.token;
}

function thumbSrc(asset: MediaAsset): string | null {
  return asset.posterUrl || asset.url || null;
}

function formatAlpha(hasAlpha?: boolean): string {
  if (hasAlpha == null) return '—';
  return hasAlpha ? 'Yes' : 'No';
}

function Thumb({
  asset,
  className,
}: {
  asset: MediaAsset;
  className?: string;
}) {
  const src = thumbSrc(asset);
  if (!src) {
    return (
      <div className={cn('grid place-items-center bg-surface-2 text-ink-faint', className)}>
        <Image className="h-5 w-5" aria-hidden />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      className={cn('object-cover bg-surface-2', className)}
      loading="lazy"
      draggable={false}
    />
  );
}

function AssetInfoBlock({ asset }: { asset: MediaAsset | null }) {
  if (!asset) {
    return <p className="text-[12px] text-ink-faint">Select a file to see details.</p>;
  }
  const probe = asset.probe ?? {};
  const converting = asset.status === 'pending' || asset.status === 'processing';
  return (
    <div className="space-y-3 text-[12px]">
      <Thumb asset={asset} className="aspect-video w-full rounded-md border border-border" />
      <div>
        <div className="font-semibold text-ink">{displayName(asset)}</div>
        <div className="text-ink-faint">{asset.originalName}</div>
      </div>
      {converting && (
        <div className="rounded-md border border-border bg-surface-2 px-2 py-1 text-ink-muted">
          Converting…
        </div>
      )}
      {asset.type === 'video' ? (
        <dl className="space-y-1">
          <InfoRow label="Duration (sec)" value={probe.durationSec ? probe.durationSec.toFixed(2) : '—'} />
          <InfoRow label="Duration (frames)" value={probe.durationFrames || '—'} />
          <InfoRow label="Resolution" value={probe.width && probe.height ? `${probe.width}×${probe.height}` : '—'} />
          <InfoRow label="Frames per second" value={probe.fps || '—'} />
          <InfoRow label="Alpha" value={formatAlpha(asset.hasAlpha)} />
        </dl>
      ) : (
        <dl className="space-y-1">
          <InfoRow label="Resolution" value={probe.width && probe.height ? `${probe.width}×${probe.height}` : '—'} />
          <InfoRow label="Format" value={(asset.originalName || '').split('.').pop()?.toUpperCase() || '—'} />
          <InfoRow label="Alpha" value={formatAlpha(asset.hasAlpha)} />
        </dl>
      )}
      <div>
        <div className="mb-1 font-semibold text-ink-muted">Tags</div>
        {asset.tags.length === 0 ? (
          <div className="text-ink-faint">No tags</div>
        ) : (
          <div className="flex flex-wrap gap-1">
            {asset.tags.map((tag) => (
              <span key={tag} className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px]">{tag}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="tabular-nums text-ink">{value}</dd>
    </div>
  );
}

function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'No',
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4" role="dialog" aria-label={title}>
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-4 shadow-lg">
        <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
        <p className="mt-2 text-[13px] text-ink-muted">{message}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="neutral" onClick={onCancel}>{cancelLabel}</Button>
          <Button size="sm" variant="danger" onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}

function TagManagerDialog({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState('');
  const [tags, setTags] = useState<MediaTag[]>([]);
  const [pendingDelete, setPendingDelete] = useState<MediaTag | null>(null);

  const load = useCallback(async () => {
    try {
      setTags(await api.media.listTags());
    } catch (error) {
      toast.error(`Tags failed: ${(error as Error).message}`);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function addTag() {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await api.media.createTag(trimmed);
      setName('');
      await load();
      onChanged();
    } catch (error) {
      toast.error(`Add tag failed: ${(error as Error).message}`);
    }
  }

  async function removeTag(tag: MediaTag) {
    try {
      await api.media.deleteTag(tag.id);
      setPendingDelete(null);
      await load();
      onChanged();
    } catch (error) {
      toast.error(`Delete tag failed: ${(error as Error).message}`);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4" role="dialog" aria-label="Add tag">
      <div className="flex h-[min(70vh,520px)] w-full max-w-2xl flex-col rounded-lg border border-border bg-surface shadow-lg">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <h3 className="text-[13px] font-semibold">Add tag</h3>
          <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-0">
          <div className="flex flex-col gap-2 border-r border-border p-3">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="New tag name"
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void addTag();
                }
              }}
            />
            <Button size="sm" variant="primary" onClick={() => void addTag()} disabled={!name.trim()}>
              → Save tag
            </Button>
          </div>
          <div className="min-h-0 overflow-auto p-2">
            {tags.map((tag) => (
              <div
                key={tag.id}
                className="group flex items-center justify-between rounded-md px-2 py-1.5 text-[13px] hover:bg-surface-2"
              >
                <span>{tag.name}</span>
                <button
                  type="button"
                  className="opacity-0 group-hover:opacity-100"
                  title={`Delete ${tag.name}`}
                  onClick={() => setPendingDelete(tag)}
                >
                  <Trash2 className="h-3.5 w-3.5 text-live" aria-hidden />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
      {pendingDelete && (
        <ConfirmDialog
          title="Delete tag"
          message={`You want to delete tag ${pendingDelete.name}.`}
          confirmLabel="Delete"
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void removeTag(pendingDelete)}
        />
      )}
    </div>
  );
}

function TagPickList({
  tags,
  selected,
  onToggle,
  search,
  onSearch,
  onAddTag,
  onUnselect,
}: {
  tags: MediaTag[];
  selected: string[];
  onToggle: (name: string) => void;
  search: string;
  onSearch: (value: string) => void;
  onAddTag: () => void;
  onUnselect?: () => void;
}) {
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tags;
    return tags.filter((tag) => tag.name.toLowerCase().includes(q));
  }, [tags, search]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border p-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
        <Input
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search tags"
          className="h-7 flex-1 text-[12px]"
        />
      </div>
      <div className="flex gap-1 border-b border-border p-2">
        <Button size="sm" variant="neutral" className="flex-1" onClick={onAddTag}>Add tag</Button>
        {onUnselect && (
          <Button size="sm" variant="ghost" onClick={onUnselect}>Unselect</Button>
        )}
      </div>
      <ul className="min-h-0 flex-1 overflow-auto p-1">
        {filtered.map((tag) => {
          const active = selected.includes(tag.name);
          return (
            <li key={tag.id}>
              <button
                type="button"
                className={cn(
                  'w-full rounded-md px-2 py-1.5 text-left text-[12px]',
                  active ? 'bg-primary/15 text-ink font-medium' : 'hover:bg-surface-2 text-ink-muted',
                )}
                onClick={() => onToggle(tag.name)}
              >
                {tag.name}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AssetEditDialog({
  asset,
  kind,
  onSave,
  onCancel,
}: {
  asset: MediaAsset;
  kind: MediaKind;
  onSave: (next: MediaAsset) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(asset.title || asset.originalName || '');
  const [selectedTags, setSelectedTags] = useState<string[]>(asset.tags);
  const [tags, setTags] = useState<MediaTag[]>([]);
  const [tagSearch, setTagSearch] = useState('');
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [live, setLive] = useState(asset);
  const [busy, setBusy] = useState(false);

  const loadTags = useCallback(async () => {
    try {
      setTags(await api.media.listTags());
    } catch (error) {
      toast.error(`Tags failed: ${(error as Error).message}`);
    }
  }, []);

  useEffect(() => { void loadTags(); }, [loadTags]);

  useEffect(() => {
    if (live.status === 'ready' || live.status === 'error') return;
    const timer = window.setInterval(() => {
      void api.media.get(asset.id).then((next) => setLive(next)).catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [asset.id, live.status]);

  async function save() {
    setBusy(true);
    try {
      const next = await api.media.update(asset.id, {
        title: title.trim() || displayName(asset),
        tags: selectedTags,
      });
      onSave(next);
    } catch (error) {
      toast.error(`Save failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4" role="dialog" aria-label="Edit media">
      <div className="flex h-[min(80vh,560px)] w-full max-w-3xl flex-col rounded-lg border border-border bg-surface shadow-lg">
        <div className="border-b border-border px-3 py-2 text-[13px] font-semibold">
          {kind === 'image' ? 'Image info' : 'Video info'}
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-2">
          <div className="flex min-h-0 flex-col border-r border-border p-3">
            <label className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Name</label>
            <Input value={title} onChange={(event) => setTitle(event.target.value)} className="mb-3" />
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Tags</div>
            <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border">
              <TagPickList
                tags={tags}
                selected={selectedTags}
                onToggle={(name) => setSelectedTags((prev) => (
                  prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name]
                ))}
                search={tagSearch}
                onSearch={setTagSearch}
                onAddTag={() => setTagManagerOpen(true)}
                onUnselect={() => setSelectedTags([])}
              />
            </div>
          </div>
          <div className="overflow-auto p-3">
            <AssetInfoBlock asset={{ ...live, title, tags: selectedTags }} />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border p-3">
          <Button size="sm" variant="neutral" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button size="sm" variant="primary" onClick={() => void save()} disabled={busy}>Ok</Button>
        </div>
      </div>
      {tagManagerOpen && (
        <TagManagerDialog
          onClose={() => setTagManagerOpen(false)}
          onChanged={() => void loadTags()}
        />
      )}
    </div>
  );
}

export function MamPicker({
  onPick,
  accept = 'image/*,video/*',
  kind,
}: {
  onPick: (token: string) => void;
  accept?: string;
  kind?: MediaKind;
}) {
  const inferredKind: MediaKind = kind
    ?? (accept.includes('video') && !accept.includes('image') ? 'video' : 'image');

  const [open, setOpen] = useState(false);
  const [fileQuery, setFileQuery] = useState('');
  const [tagQuery, setTagQuery] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tags, setTags] = useState<MediaTag[]>([]);
  const [items, setItems] = useState<MediaAsset[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [editing, setEditing] = useState<MediaAsset | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MediaAsset | null>(null);
  const [importEdit, setImportEdit] = useState<MediaAsset | null>(null);
  const [filesView, setFilesView] = useState<FilesView>('list');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selected = items.find((item) => item.id === selectedId) ?? null;

  const loadTags = useCallback(async () => {
    try {
      setTags(await api.media.listTags());
    } catch (error) {
      toast.error(`Tags failed: ${(error as Error).message}`);
    }
  }, []);

  const loadFiles = useCallback(async () => {
    try {
      const list = await api.media.list({
        q: fileQuery.trim() || undefined,
        tags: selectedTags,
        type: inferredKind,
      });
      for (const item of list) rememberMediaUrl(item.token, item.url || item.posterUrl);
      setItems(list);
      setSelectedId((current) => (current && list.some((item) => item.id === current) ? current : null));
    } catch (error) {
      toast.error(`MAM list failed: ${(error as Error).message}`);
    }
  }, [fileQuery, selectedTags, inferredKind]);

  useEffect(() => {
    if (!open) return;
    void loadTags();
    void loadFiles();
  }, [open, loadTags, loadFiles]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => { void loadFiles(); }, 150);
    return () => window.clearTimeout(timer);
  }, [fileQuery, selectedTags, open, loadFiles]);

  function close() {
    setOpen(false);
    setSelectedId(null);
    setFileQuery('');
    setTagQuery('');
    setSelectedTags([]);
  }

  function confirmPick(asset: MediaAsset) {
    if (asset.status && asset.status !== 'ready') {
      toast.error('File is still converting');
      return;
    }
    rememberMediaUrl(asset.token, asset.url || asset.posterUrl);
    onPick(asset.token);
    close();
  }

  async function refreshFolder() {
    setBusy(true);
    try {
      const result = await api.media.refresh(inferredKind);
      setItems(result.items);
      if (result.errors.length) {
        toast.error(result.errors.slice(0, 2).join('; '));
      } else if (result.imported.length || result.converting.length) {
        toast.success(`Imported ${result.imported.length} file(s)`);
      }
      await loadTags();
    } catch (error) {
      toast.error(`Refresh failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function importFile(file: File) {
    setBusy(true);
    try {
      const result = await api.media.import(file);
      setImportEdit(result.catalog);
      await loadFiles();
    } catch (error) {
      toast.error(`Import failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function toggleLock(asset: MediaAsset) {
    try {
      const next = await api.media.update(asset.id, { locked: !asset.locked });
      setItems((prev) => prev.map((item) => (item.id === next.id ? next : item)));
    } catch (error) {
      toast.error(`Lock failed: ${(error as Error).message}`);
    }
  }

  async function deleteAsset(asset: MediaAsset) {
    try {
      await api.media.remove(asset.id);
      setPendingDelete(null);
      if (selectedId === asset.id) setSelectedId(null);
      await loadFiles();
      toast.success('Deleted');
    } catch (error) {
      toast.error(`Delete failed: ${(error as Error).message}`);
    }
  }

  return (
    <>
      <Button size="sm" variant="neutral" className="w-full" onClick={() => setOpen(true)}>
        <Image className="h-4 w-4" aria-hidden />
        Choose file from MAM
      </Button>
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" role="dialog" aria-label="Media library">
          <div className="flex h-[min(85vh,640px)] w-full max-w-5xl flex-col rounded-lg border border-border bg-surface shadow-xl">
            <div className="border-b border-border px-3 py-2 text-[13px] font-semibold">
              {inferredKind === 'image' ? 'Choose image' : 'Choose video'}
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-[160px_minmax(0,1fr)_260px]">
              <section className="flex min-h-0 flex-col border-r border-border">
                <header className="border-b border-border px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                  Tags
                </header>
                <TagPickList
                  tags={tags}
                  selected={selectedTags}
                  onToggle={(name) => setSelectedTags((prev) => (
                    prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name]
                  ))}
                  search={tagQuery}
                  onSearch={setTagQuery}
                  onAddTag={() => setTagManagerOpen(true)}
                  onUnselect={() => setSelectedTags([])}
                />
              </section>

              <section className="flex min-h-0 flex-col border-r border-border">
                <header className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Files</span>
                  <div className="flex gap-0.5">
                    <button
                      type="button"
                      title="List view"
                      className={cn('rounded p-1', filesView === 'list' ? 'bg-surface-2 text-ink' : 'text-ink-faint hover:text-ink')}
                      onClick={() => setFilesView('list')}
                    >
                      <List className="h-3.5 w-3.5" aria-hidden />
                    </button>
                    <button
                      type="button"
                      title="Grid view"
                      className={cn('rounded p-1', filesView === 'grid' ? 'bg-surface-2 text-ink' : 'text-ink-faint hover:text-ink')}
                      onClick={() => setFilesView('grid')}
                    >
                      <LayoutGrid className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </div>
                </header>
                <div className="flex items-center gap-2 border-b border-border p-2">
                  <Search className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
                  <Input
                    value={fileQuery}
                    onChange={(event) => setFileQuery(event.target.value)}
                    placeholder="Search files"
                    className="h-7 flex-1 text-[12px]"
                  />
                </div>
                {items.length === 0 ? (
                  <div className="p-6 text-center text-[13px] text-ink-faint">No media yet.</div>
                ) : filesView === 'list' ? (
                  <ul className="min-h-0 flex-1 overflow-auto p-1">
                    {items.map((item) => {
                      const active = item.id === selectedId;
                      const converting = item.status === 'pending' || item.status === 'processing';
                      return (
                        <li key={item.id}>
                          <div
                            className={cn(
                              'group flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px]',
                              active ? 'bg-primary/15' : 'hover:bg-surface-2',
                            )}
                            onClick={() => setSelectedId(item.id)}
                            onDoubleClick={() => confirmPick(item)}
                          >
                            <Thumb asset={item} className="h-10 w-14 shrink-0 rounded border border-border" />
                            <button type="button" className="min-w-0 flex-1 truncate text-left">
                              {displayName(item)}
                              {converting && <span className="ml-2 text-[11px] text-ink-faint">converting…</span>}
                            </button>
                            <div className="flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100">
                              <button
                                type="button"
                                title="Edit"
                                className="rounded p-1 hover:bg-surface"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setEditing(item);
                                }}
                              >
                                <Pencil className="h-3.5 w-3.5" aria-hidden />
                              </button>
                              <button
                                type="button"
                                title={item.locked ? 'Unlock' : 'Lock'}
                                className="rounded p-1 hover:bg-surface"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void toggleLock(item);
                                }}
                              >
                                {item.locked
                                  ? <Lock className="h-3.5 w-3.5" aria-hidden />
                                  : <Unlock className="h-3.5 w-3.5" aria-hidden />}
                              </button>
                              <button
                                type="button"
                                title="Delete"
                                disabled={Boolean(item.locked)}
                                className="rounded p-1 hover:bg-surface disabled:opacity-30"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  if (!item.locked) setPendingDelete(item);
                                }}
                              >
                                <Trash2 className="h-3.5 w-3.5 text-live" aria-hidden />
                              </button>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <div className="min-h-0 flex-1 overflow-auto p-2">
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {items.map((item) => {
                        const active = item.id === selectedId;
                        const converting = item.status === 'pending' || item.status === 'processing';
                        return (
                          <div
                            key={item.id}
                            className={cn(
                              'group relative overflow-hidden rounded-md border text-left',
                              active ? 'border-primary ring-1 ring-primary/40' : 'border-border hover:border-ink-faint',
                            )}
                            onClick={() => setSelectedId(item.id)}
                            onDoubleClick={() => confirmPick(item)}
                          >
                            <Thumb asset={item} className="aspect-video w-full" />
                            <div className="truncate px-1.5 py-1 text-[11px]">
                              {displayName(item)}
                              {converting && <span className="text-ink-faint"> · converting…</span>}
                            </div>
                            <div className="absolute right-1 top-1 flex gap-0.5 rounded bg-black/50 p-0.5 opacity-0 group-hover:opacity-100">
                              <button
                                type="button"
                                title="Edit"
                                className="rounded p-1 text-white hover:bg-white/20"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setEditing(item);
                                }}
                              >
                                <Pencil className="h-3.5 w-3.5" aria-hidden />
                              </button>
                              <button
                                type="button"
                                title={item.locked ? 'Unlock' : 'Lock'}
                                className="rounded p-1 text-white hover:bg-white/20"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void toggleLock(item);
                                }}
                              >
                                {item.locked
                                  ? <Lock className="h-3.5 w-3.5" aria-hidden />
                                  : <Unlock className="h-3.5 w-3.5" aria-hidden />}
                              </button>
                              <button
                                type="button"
                                title="Delete"
                                disabled={Boolean(item.locked)}
                                className="rounded p-1 text-white hover:bg-white/20 disabled:opacity-30"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  if (!item.locked) setPendingDelete(item);
                                }}
                              >
                                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                <div className="flex flex-wrap gap-2 border-t border-border p-2">
                  <Button size="sm" variant="primary" disabled={!selected || busy} onClick={() => selected && confirmPick(selected)}>
                    Ok
                  </Button>
                  <Button size="sm" variant="neutral" onClick={close}>Cancel</Button>
                  <label className="inline-flex">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept={accept}
                      className="hidden"
                      disabled={busy}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void importFile(file);
                        event.target.value = '';
                      }}
                    />
                    <Button
                      size="sm"
                      variant="neutral"
                      disabled={busy}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload className="h-3.5 w-3.5" aria-hidden />
                      Import
                    </Button>
                  </label>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refreshFolder()}>
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                    Refresh
                  </Button>
                </div>
              </section>

              <section className="flex min-h-0 flex-col">
                <header className="border-b border-border px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                  Info
                </header>
                <div className="min-h-0 flex-1 overflow-auto p-3">
                  <AssetInfoBlock asset={selected} />
                </div>
              </section>
            </div>
          </div>
        </div>
      )}

      {tagManagerOpen && (
        <TagManagerDialog
          onClose={() => setTagManagerOpen(false)}
          onChanged={() => { void loadTags(); void loadFiles(); }}
        />
      )}
      {editing && (
        <AssetEditDialog
          asset={editing}
          kind={inferredKind}
          onCancel={() => setEditing(null)}
          onSave={(next) => {
            setEditing(null);
            setItems((prev) => prev.map((item) => (item.id === next.id ? next : item)));
            void loadTags();
          }}
        />
      )}
      {importEdit && (
        <AssetEditDialog
          asset={importEdit}
          kind={inferredKind}
          onCancel={() => {
            setImportEdit(null);
            void loadFiles();
          }}
          onSave={(next) => {
            setImportEdit(null);
            void loadFiles();
            confirmPick(next);
          }}
        />
      )}
      {pendingDelete && (
        <ConfirmDialog
          title="Delete file"
          message={`You want to delete file ${displayName(pendingDelete)}.`}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void deleteAsset(pendingDelete)}
        />
      )}
    </>
  );
}

/** Compact metadata under the source field in Properties. */
export function SelectedMediaInfo({ src }: { src: string }) {
  const [asset, setAsset] = useState<MediaAsset | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!src || typeof src !== 'string') {
      setAsset(null);
      return;
    }
    if (!src.startsWith('asset:') && !src.startsWith('/uploads/')) {
      setAsset(null);
      return;
    }
    void (async () => {
      try {
        if (src.startsWith('asset:')) {
          const next = await api.media.resolve(src);
          if (!cancelled) setAsset(next);
          return;
        }
        const list = await api.media.list({});
        const match = list.find((item) => item.url === src || item.posterUrl === src);
        if (!cancelled) setAsset(match ?? null);
      } catch {
        if (!cancelled) setAsset(null);
      }
    })();
    return () => { cancelled = true; };
  }, [src]);

  if (!asset) return null;
  const probe = asset.probe ?? {};
  if (asset.type === 'video') {
    return (
      <div className="rounded-md border border-border bg-surface-2 px-2 py-1.5 text-[11px] text-ink-muted">
        <div>{probe.durationSec ? `${probe.durationSec.toFixed(2)}s` : '—'} · {probe.durationFrames || '—'} frames</div>
        <div>{probe.width && probe.height ? `${probe.width}×${probe.height}` : '—'} · {probe.fps || '—'} fps · Alpha: {formatAlpha(asset.hasAlpha)}</div>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border bg-surface-2 px-2 py-1.5 text-[11px] text-ink-muted">
      {probe.width && probe.height ? `${probe.width}×${probe.height}` : '—'} · Alpha: {formatAlpha(asset.hasAlpha)}
    </div>
  );
}
