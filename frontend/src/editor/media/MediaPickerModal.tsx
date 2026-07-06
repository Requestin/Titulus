// frontend/src/editor/media/MediaPickerModal.tsx

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight, Lock, Pencil, RefreshCw, Search, Trash2, X,
} from 'lucide-react';
import { api, type MediaAsset, type MediaTag } from '@/core/api';
import { toast } from '@/core/toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/form';
import { cn } from '@/lib/cn';

function ConfirmDialog({
  title,
  confirmLabel,
  cancelLabel = 'No',
  onConfirm,
  onCancel,
}: {
  title: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-bg/70 px-4 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-2xl">
        <p className="text-sm text-ink">{title}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="danger" onClick={onConfirm}>{confirmLabel}</Button>
          <Button variant="neutral" onClick={onCancel}>{cancelLabel}</Button>
        </div>
      </div>
    </div>
  );
}

function TagManagerModal({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const [tags, setTags] = useState<MediaTag[]>([]);
  const [newName, setNewName] = useState('');
  const [pendingDelete, setPendingDelete] = useState<MediaTag | null>(null);

  const load = useCallback(async () => {
    setTags(await api.media.listTags());
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function addTag() {
    const name = newName.trim();
    if (!name) return;
    await api.media.createTag(name);
    setNewName('');
    await load();
    onChanged();
  }

  async function deleteTag() {
    if (!pendingDelete) return;
    await api.media.deleteTag(pendingDelete.id);
    setPendingDelete(null);
    await load();
    onChanged();
  }

  return (
    <div className="fixed inset-0 z-[55] grid place-items-center bg-bg/70 px-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-xl border border-border bg-surface p-4 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink">Add tag</h3>
          <button type="button" onClick={onClose} className="text-ink-faint hover:text-ink"><X className="h-4 w-4" /></button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex gap-2">
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New tag" className="flex-1" />
            <Button variant="primary" onClick={() => { void addTag(); }} aria-label="Add tag">
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
          <div className="max-h-48 overflow-auto rounded border border-border">
            {tags.map((t) => (
              <div key={t.id} className="group flex items-center justify-between px-2 py-1.5 text-sm hover:bg-surface-2">
                <span>{t.name}</span>
                <button
                  type="button"
                  className="opacity-0 group-hover:opacity-100 text-ink-faint hover:text-live"
                  onClick={() => setPendingDelete(t)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
      {pendingDelete && (
        <ConfirmDialog
          title={`You want to delete tag ${pendingDelete.name}?`}
          confirmLabel="Delete"
          onConfirm={() => { void deleteTag(); }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

function AssetEditModal({
  asset,
  tags,
  onClose,
  onSaved,
}: {
  asset: MediaAsset;
  tags: MediaTag[];
  onClose: () => void;
  onSaved: (a: MediaAsset) => void;
}) {
  const [displayName, setDisplayName] = useState(asset.displayName);
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set(asset.tagIds));
  const [tagSearch, setTagSearch] = useState('');
  const [showTagManager, setShowTagManager] = useState(false);
  const [allTags, setAllTags] = useState(tags);

  const filteredTags = allTags.filter((t) =>
    t.name.toLowerCase().includes(tagSearch.trim().toLowerCase()),
  );

  async function save() {
    const updated = await api.media.update(asset.id, {
      displayName: displayName.trim() || asset.displayName,
      tagIds: [...selectedTags],
    });
    onSaved(updated);
    onClose();
  }

  return (
    <>
      <div className="fixed inset-0 z-[55] grid place-items-center bg-bg/70 px-4 backdrop-blur-sm">
        <div className="w-full max-w-2xl rounded-xl border border-border bg-surface p-4 shadow-2xl">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink">Edit media</h3>
            <button type="button" onClick={onClose} className="text-ink-faint hover:text-ink"><X className="h-4 w-4" /></button>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-3">
              <label className="block text-[11px] font-medium text-ink-faint">File name</label>
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <label className="text-[11px] font-medium text-ink-faint">Tags</label>
                  <Button size="sm" variant="ghost" onClick={() => setShowTagManager(true)}>Add tag</Button>
                </div>
                <Input value={tagSearch} onChange={(e) => setTagSearch(e.target.value)} placeholder="Search tags" className="mb-2" />
                <div className="max-h-40 overflow-auto rounded border border-border p-1">
                  {filteredTags.map((t) => {
                    const on = selectedTags.has(t.id);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => {
                          const next = new Set(selectedTags);
                          if (on) next.delete(t.id); else next.add(t.id);
                          setSelectedTags(next);
                        }}
                        className={cn(
                          'mb-1 mr-1 inline-block rounded px-2 py-0.5 text-xs',
                          on ? 'bg-primary/25 text-ink' : 'bg-surface-2 text-ink-muted hover:text-ink',
                        )}
                      >
                        {t.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <AssetInfoPanel asset={asset} tags={allTags} />
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="primary" onClick={() => { void save(); }}>OK</Button>
            <Button variant="neutral" onClick={onClose}>Cancel</Button>
          </div>
        </div>
      </div>
      {showTagManager && (
        <TagManagerModal
          onClose={() => setShowTagManager(false)}
          onChanged={async () => setAllTags(await api.media.listTags())}
        />
      )}
    </>
  );
}

export function AssetInfoPanel({ asset, tags = [] }: { asset: MediaAsset; tags?: MediaTag[] }) {
  const assetTags = tags.filter((t) => asset.tagIds.includes(t.id));

  return (
    <div className="space-y-1.5 rounded border border-border bg-surface-2/50 p-3 text-[12px] text-ink-muted">
      <div className="font-medium text-ink">{asset.displayName}</div>
      {asset.status === 'processing' && (
        <div className="text-warning">Converting…</div>
      )}
      {asset.status === 'error' && (
        <div className="text-live">Conversion failed</div>
      )}
      {asset.status === 'ready' && (
        <>
          <div>Format: {asset.format || '—'}</div>
          <div>Resolution: {asset.width}×{asset.height}</div>
          <div>Alpha: {asset.hasAlpha ? 'Yes' : 'No'}</div>
          {asset.type === 'video' && (
            <>
              <div>Duration: {asset.durationSec != null ? `${asset.durationSec.toFixed(2)} sec` : '—'}</div>
              <div>Frames: {asset.durationFrames ?? '—'}</div>
              <div>FPS: {asset.fps != null ? asset.fps.toFixed(2) : '—'}</div>
            </>
          )}
        </>
      )}
      <div>
        Tags:
        {assetTags.length > 0 ? (
          <div className="mt-1 space-y-0.5">
            {assetTags.map((t) => (
              <div key={t.id} className="text-ink">{t.name}</div>
            ))}
          </div>
        ) : (
          <span className="ml-1">—</span>
        )}
      </div>
    </div>
  );
}

export function MediaPickerModal({
  type,
  open,
  onClose,
  onSelect,
}: {
  type: 'image' | 'video';
  open: boolean;
  onClose: () => void;
  onSelect: (asset: MediaAsset) => void;
}) {
  const [tags, setTags] = useState<MediaTag[]>([]);
  const [tagSearch, setTagSearch] = useState('');
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [fileSearch, setFileSearch] = useState('');
  const [files, setFiles] = useState<MediaAsset[]>([]);
  const [selected, setSelected] = useState<MediaAsset | null>(null);
  const [showTagManager, setShowTagManager] = useState(false);
  const [editAsset, setEditAsset] = useState<MediaAsset | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MediaAsset | null>(null);
  const [importEdit, setImportEdit] = useState<MediaAsset | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const loadTags = useCallback(async () => {
    setTags(await api.media.listTags(tagSearch));
  }, [tagSearch]);

  const loadFiles = useCallback(async () => {
    const list = await api.media.list({
      type,
      q: fileSearch,
      tags: [...selectedTagIds],
    });
    setFiles(list);
    setSelected((prev) => {
      if (!prev) return null;
      const updated = list.find((f) => f.id === prev.id);
      return updated ?? null;
    });
  }, [type, fileSearch, selectedTagIds]);

  useEffect(() => {
    if (!open) return;
    void loadTags();
  }, [open, loadTags]);

  useEffect(() => {
    if (!open) return;
    void loadFiles();
  }, [open, loadFiles]);

  const hasProcessing = files.some((f) => f.status === 'processing');

  useEffect(() => {
    if (!open || !hasProcessing) return;
    const timer = setInterval(() => { void loadFiles(); }, 2000);
    return () => clearInterval(timer);
  }, [open, hasProcessing, loadFiles]);

  function toggleTag(id: string) {
    const next = new Set(selectedTagIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedTagIds(next);
  }

  async function handleRefresh() {
    const res = await api.media.refresh(type);
    toast.success(`Imported ${res.count} file(s)`);
    await loadFiles();
  }

  async function handleImport(file: File) {
    try {
      const res = await api.media.import(file);
      if (res.job && res.job.status !== 'ready' && !res.asset) {
        toast.info('Transcoding video…');
        let job = res.job;
        for (let i = 0; i < 180; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          job = await api.uploads.job(job.id);
          if (job.status === 'ready') break;
          if (job.status === 'error') {
            toast.error(job.error || 'Transcode failed');
            return;
          }
        }
        const fin = await api.media.finalizeJob(job.id);
        setImportEdit(fin.asset);
        await loadFiles();
        return;
      }
      if (res.asset) {
        setImportEdit(res.asset);
        await loadFiles();
      }
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function deleteAsset() {
    if (!pendingDelete) return;
    try {
      await api.media.remove(pendingDelete.id);
      if (selected?.id === pendingDelete.id) setSelected(null);
      setPendingDelete(null);
      await loadFiles();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function toggleLock(asset: MediaAsset) {
    const updated = await api.media.update(asset.id, { locked: !asset.locked });
    await loadFiles();
    if (selected?.id === asset.id) setSelected(updated);
  }

  function confirmSelect(asset: MediaAsset) {
    if (asset.status !== 'ready') return;
    onSelect(asset);
    onClose();
  }

  function isSelectable(asset: MediaAsset) {
    return asset.status === 'ready';
  }

  if (!open) return null;

  const filteredTags = tags.filter((t) =>
    t.name.toLowerCase().includes(tagSearch.trim().toLowerCase()),
  );

  return (
    <>
      <div className="fixed inset-0 z-modal grid place-items-center bg-bg/70 px-3 backdrop-blur-sm">
        <div
          role="dialog"
          aria-modal="true"
          className="flex h-[min(80vh,640px)] w-full max-w-5xl flex-col rounded-xl border border-border bg-surface shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold text-ink">Choose {type}</h2>
            <button type="button" onClick={onClose} className="text-ink-faint hover:text-ink"><X className="h-4 w-4" /></button>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-[180px_1fr_220px] gap-0 divide-x divide-border">
            {/* Tags */}
            <div className="flex flex-col p-3">
              <div className="mb-2 text-[11px] font-semibold text-ink-faint">Tags</div>
              <div className="mb-2 flex gap-1">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-faint" />
                  <Input value={tagSearch} onChange={(e) => setTagSearch(e.target.value)} className="pl-7 text-xs" placeholder="Search" />
                </div>
                <Button size="sm" variant="ghost" onClick={() => setShowTagManager(true)}>Add tag</Button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {filteredTags.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => toggleTag(t.id)}
                    className={cn(
                      'mb-1 block w-full rounded px-2 py-1 text-left text-xs',
                      selectedTagIds.has(t.id) ? 'bg-primary/20 text-ink' : 'text-ink-muted hover:bg-surface-2',
                    )}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="mt-2 w-full shrink-0"
                disabled={selectedTagIds.size === 0}
                onClick={() => setSelectedTagIds(new Set())}
              >
                Unselect
              </Button>
            </div>

            {/* Files */}
            <div className="flex min-h-0 flex-col p-3">
              <div className="mb-2 text-[11px] font-semibold text-ink-faint">Files</div>
              <Input
                value={fileSearch}
                onChange={(e) => setFileSearch(e.target.value)}
                placeholder="Search files"
                className="mb-2 text-xs"
              />
              <div className="min-h-0 flex-1 overflow-auto rounded border border-border">
                {files.map((f) => (
                  <div
                    key={f.id}
                    role="button"
                    tabIndex={0}
                    onDoubleClick={() => { if (isSelectable(f)) confirmSelect(f); }}
                    onClick={() => setSelected(f)}
                    onKeyDown={(e) => { if (e.key === 'Enter') setSelected(f); }}
                    className={cn(
                      'group relative flex cursor-pointer items-center gap-2 border-b border-border/50 px-2 py-2 text-xs last:border-0',
                      selected?.id === f.id ? 'bg-primary/15' : 'hover:bg-surface-2',
                      f.status === 'processing' && 'opacity-80',
                    )}
                  >
                    {f.status === 'processing' ? (
                      <div className="flex h-10 w-14 shrink-0 items-center justify-center rounded bg-surface-2 text-[10px] text-warning">
                        …
                      </div>
                    ) : f.posterUrl || f.type === 'image' ? (
                      <img
                        src={f.posterUrl || f.url}
                        alt=""
                        className="h-10 w-14 shrink-0 rounded object-cover bg-surface-2"
                      />
                    ) : (
                      <div className="h-10 w-14 shrink-0 rounded bg-surface-2" />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {f.displayName}
                      {f.status === 'processing' && (
                        <span className="ml-1 text-warning">(converting)</span>
                      )}
                    </span>
                    <div className="flex shrink-0 gap-1 opacity-0 group-hover:opacity-100">
                      <button
                        type="button"
                        disabled={f.status === 'processing'}
                        className="p-1 text-ink-faint hover:text-ink disabled:opacity-30"
                        onClick={(e) => { e.stopPropagation(); setEditAsset(f); }}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        disabled={f.status === 'processing'}
                        className="p-1 text-ink-faint hover:text-ink disabled:opacity-30"
                        onClick={(e) => { e.stopPropagation(); void toggleLock(f); }}
                      >
                        <Lock className={cn('h-3 w-3', f.locked && 'text-warning')} />
                      </button>
                      <button
                        type="button"
                        disabled={f.locked}
                        className="p-1 text-ink-faint hover:text-live disabled:opacity-30"
                        onClick={(e) => { e.stopPropagation(); if (!f.locked) setPendingDelete(f); }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                ))}
                {files.length === 0 && (
                  <p className="p-4 text-center text-xs text-ink-faint">No files</p>
                )}
              </div>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!selected || !isSelectable(selected)}
                  onClick={() => selected && confirmSelect(selected)}
                >
                  OK
                </Button>
                <Button size="sm" variant="neutral" onClick={onClose}>Cancel</Button>
                <Button size="sm" variant="neutral" onClick={() => importRef.current?.click()}>Import</Button>
                <Button size="sm" variant="ghost" onClick={() => { void handleRefresh(); }}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  Refresh
                </Button>
              </div>
              <input
                ref={importRef}
                type="file"
                accept={type === 'image' ? 'image/*' : 'video/*'}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleImport(f);
                  e.target.value = '';
                }}
              />
            </div>

            {/* Info */}
            <div className="p-3">
              <div className="mb-2 text-[11px] font-semibold text-ink-faint">Info</div>
              {selected ? <AssetInfoPanel asset={selected} tags={tags} /> : (
                <p className="text-xs text-ink-faint">Select a file</p>
              )}
            </div>
          </div>
        </div>
      </div>

      {showTagManager && (
        <TagManagerModal
          onClose={() => setShowTagManager(false)}
          onChanged={() => { void loadTags(); void loadFiles(); }}
        />
      )}
      {editAsset && (
        <AssetEditModal
          asset={editAsset}
          tags={tags}
          onClose={() => setEditAsset(null)}
          onSaved={() => { void loadFiles(); setEditAsset(null); }}
        />
      )}
      {importEdit && (
        <AssetEditModal
          asset={importEdit}
          tags={tags}
          onClose={() => setImportEdit(null)}
          onSaved={(a) => { setImportEdit(null); setSelected(a); void loadFiles(); }}
        />
      )}
      {pendingDelete && (
        <ConfirmDialog
          title={`Delete file "${pendingDelete.displayName}"?`}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          onConfirm={() => { void deleteAsset(); }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </>
  );
}
