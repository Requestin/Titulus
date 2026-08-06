// frontend/src/pages/TemplatesPage.tsx
//
// Templates hub: EDITOR (library + open editor) | PLAY (operator TAKE/UPDATE/CLEAR
// for templates — formerly Control → Templates tab).

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Plus, Trash2, Loader2, LayoutTemplate, Copy, Radio, X, Pencil, Folder, List, LayoutGrid,
  ArrowDownAZ, ArrowUpAZ, ArrowDownNarrowWide, ArrowUpNarrowWide, Eye, EyeOff,
} from 'lucide-react';
import { createDefaultTemplate, isUpdateDirectorArmed } from '@runtime';
import {
  api,
  type Channel,
  type TemplateSummary,
  type TemplateRecord,
  type TemplateFolder,
  type OnAirSnapshot,
} from '@/core/api';
import { createId } from '@/core/id';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/form';
import { toast } from '@/core/toast';
import { useControlWs } from '@/core/controlWs';
import { crawlFileErrorMessage } from '@/core/crawlFile';
import { prepareTemplateForAir, templateDataErrorMessage } from '@/core/prepareTemplateData';
import { cn } from '@/lib/cn';
import { ProgramMonitor } from '@/control/ProgramMonitor';
import { TemplatesTab } from '@/control/TemplatesTab';
import { BrowserSourceUrl, WsBadge } from '@/control/controlShared';

type TemplatesMode = 'editor' | 'play';
type LibraryView = 'icons' | 'list';
type LibrarySortBy = 'modified' | 'name';
type LibrarySortDir = 'asc' | 'desc';
const ALL_FOLDER = '__all__';
const UNASSIGNED_FOLDER = '__none__';
const ALL_HIDDEN_KEY = 'allFolderHiddenInControl';
const UNASSIGNED_HIDDEN_KEY = 'unassignedHiddenInControl';
const VIEW_KEY = 'titulus.templates.view';
const SORT_BY_KEY = 'titulus.templates.sortBy';
const SORT_DIR_KEY = 'titulus.templates.sortDir';
const FOLDER_WIDTH_KEY = 'titulus.templates.folderWidth';
const FOLDER_WIDTH_DEFAULT = 224;
const FOLDER_WIDTH_MIN = 160;
const FOLDER_WIDTH_MAX = 480;

function readFolderWidth(): number {
  try {
    const n = Number(localStorage.getItem(FOLDER_WIDTH_KEY));
    if (Number.isFinite(n)) return Math.min(FOLDER_WIDTH_MAX, Math.max(FOLDER_WIDTH_MIN, n));
  } catch { /* ignore */ }
  return FOLDER_WIDTH_DEFAULT;
}

function templateFolderId(t: TemplateSummary): string | null {
  return t.folderId ?? t.folder_id ?? null;
}

function isFolderHiddenInControl(f: TemplateFolder): boolean {
  return Boolean(f.hiddenInControl ?? f.hidden_in_control);
}

function readSortBy(): LibrarySortBy {
  try {
    return localStorage.getItem(SORT_BY_KEY) === 'name' ? 'name' : 'modified';
  } catch {
    return 'modified';
  }
}

function readSortDir(): LibrarySortDir {
  try {
    return localStorage.getItem(SORT_DIR_KEY) === 'asc' ? 'asc' : 'desc';
  } catch {
    return 'desc';
  }
}

export function TemplatesPage() {
  const [mode, setMode] = useState<TemplatesMode>('editor');

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 justify-center border-b border-border px-5 py-3">
        <ModeToggle mode={mode} onChange={setMode} />
      </div>
      <div className="min-h-0 flex-1">
        {mode === 'editor' ? <EditorLibrary /> : <PlayTemplates />}
      </div>
    </div>
  );
}

function ModeToggle({ mode, onChange }: { mode: TemplatesMode; onChange: (m: TemplatesMode) => void }) {
  return (
    <div
      role="tablist"
      aria-label="Templates mode"
      className="inline-flex rounded-md border border-border bg-surface p-0.5"
    >
      {([
        { id: 'editor', label: 'EDITOR' },
        { id: 'play', label: 'PLAY' },
      ] as const).map((item) => {
        const selected = mode === item.id;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(item.id)}
            className={cn(
              'min-w-[6.5rem] rounded-[5px] px-4 py-1.5 text-[12px] font-semibold tracking-wide transition-colors',
              selected
                ? 'bg-primary text-primary-ink shadow-sm'
                : 'text-ink-muted hover:text-ink',
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

function EditorLibrary() {
  const nav = useNavigate();
  const [items, setItems] = useState<TemplateSummary[] | null>(null);
  const [folders, setFolders] = useState<TemplateFolder[]>([]);
  const [folderFilter, setFolderFilter] = useState<string>(ALL_FOLDER);
  const [view, setView] = useState<LibraryView>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'icons';
    } catch {
      return 'icons';
    }
  });
  const [sortBy, setSortBy] = useState<LibrarySortBy>(readSortBy);
  const [sortDir, setSortDir] = useState<LibrarySortDir>(readSortDir);
  const [creating, setCreating] = useState(false);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [folderModal, setFolderModal] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [folderRenameVal, setFolderRenameVal] = useState('');
  const [pendingFolderDelete, setPendingFolderDelete] = useState<TemplateFolder | null>(null);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const [allHidden, setAllHidden] = useState(false);
  const [unassignedHidden, setUnassignedHidden] = useState(false);
  const [folderWidth, setFolderWidth] = useState(readFolderWidth);
  const folderResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const [tpls, flds, settings] = await Promise.all([
        api.templates.list(),
        api.templateFolders.list(),
        api.settings.get().catch(() => ({} as Record<string, string>)),
      ]);
      setItems(tpls);
      setFolders(flds);
      setAllHidden(settings[ALL_HIDDEN_KEY] === '1' || settings[ALL_HIDDEN_KEY] === 'true');
      setUnassignedHidden(settings[UNASSIGNED_HIDDEN_KEY] === '1' || settings[UNASSIGNED_HIDDEN_KEY] === 'true');
    } catch (e) {
      toast.error(`Failed to load templates: ${(e as Error).message}`);
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    if (!items) return [];
    const filtered = folderFilter === ALL_FOLDER
      ? [...items]
      : folderFilter === UNASSIGNED_FOLDER
        ? items.filter((t) => templateFolderId(t) === null)
        : items.filter((t) => templateFolderId(t) === folderFilter);
    const dir = sortDir === 'asc' ? 1 : -1;
    filtered.sort((a, b) => {
      if (sortBy === 'name') {
        const cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        return cmp * dir;
      }
      const ta = Date.parse(a.updated_at) || 0;
      const tb = Date.parse(b.updated_at) || 0;
      if (ta !== tb) return (ta - tb) * dir;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) * dir;
    });
    return filtered;
  }, [items, folderFilter, sortBy, sortDir]);

  function setViewMode(next: LibraryView) {
    setView(next);
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* ignore */ }
  }

  function setSortByMode(next: LibrarySortBy) {
    setSortBy(next);
    try { localStorage.setItem(SORT_BY_KEY, next); } catch { /* ignore */ }
  }

  function toggleSortDir() {
    setSortDir((prev) => {
      const next: LibrarySortDir = prev === 'asc' ? 'desc' : 'asc';
      try { localStorage.setItem(SORT_DIR_KEY, next); } catch { /* ignore */ }
      return next;
    });
  }

  const sortDirTitle = sortBy === 'name'
    ? (sortDir === 'asc' ? 'Name A → Z' : 'Name Z → A')
    : (sortDir === 'asc' ? 'Oldest first' : 'Newest first');

  const SortDirIcon = sortBy === 'name'
    ? (sortDir === 'asc' ? ArrowDownAZ : ArrowUpAZ)
    : (sortDir === 'asc' ? ArrowUpNarrowWide : ArrowDownNarrowWide);

  async function create() {
    setCreating(true);
    try {
      const folderId = (folderFilter !== ALL_FOLDER && folderFilter !== UNASSIGNED_FOLDER)
        ? folderFilter
        : null;
      const rec = await api.templates.create('Untitled template', createDefaultTemplate(), folderId);
      nav(`/editor/${rec.id}`);
    } catch (e) {
      toast.error(`Create failed: ${(e as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  async function toggleFolderHidden(folderId: string) {
    const f = folders.find((x) => x.id === folderId);
    if (!f) return;
    const next = !isFolderHiddenInControl(f);
    try {
      const updated = await api.templateFolders.update(folderId, { hiddenInControl: next });
      setFolders((cur) => cur.map((x) => (x.id === folderId ? { ...x, ...updated, hiddenInControl: next, hidden_in_control: next } : x)));
    } catch (e) {
      toast.error(`Visibility update failed: ${(e as Error).message}`);
    }
  }

  async function toggleAllHidden() {
    const next = !allHidden;
    try {
      const cur = await api.settings.get().catch(() => ({} as Record<string, string>));
      await api.settings.put({ ...cur, [ALL_HIDDEN_KEY]: next ? '1' : '0' });
      setAllHidden(next);
    } catch (e) {
      toast.error(`Visibility update failed: ${(e as Error).message}`);
    }
  }

  async function toggleUnassignedHidden() {
    const next = !unassignedHidden;
    try {
      const cur = await api.settings.get().catch(() => ({} as Record<string, string>));
      await api.settings.put({ ...cur, [UNASSIGNED_HIDDEN_KEY]: next ? '1' : '0' });
      setUnassignedHidden(next);
    } catch (e) {
      toast.error(`Visibility update failed: ${(e as Error).message}`);
    }
  }

  async function duplicate(id: string, name: string) {
    setDuplicatingId(id);
    try {
      const rec = await api.templates.get(id);
      const copyName = `${name}(copy)`;
      const data = structuredClone(rec.data);
      data.id = createId();
      data.name = copyName;
      const created = await api.templates.create(copyName, data, templateFolderId(rec));
      setItems((cur) => [...(cur ?? []), created]);
      toast.success(`Copied as "${copyName}"`);
    } catch (e) {
      toast.error(`Copy failed: ${(e as Error).message}`);
    } finally {
      setDuplicatingId(null);
    }
  }

  async function confirmRemove() {
    if (!pendingDelete) return;
    const { id } = pendingDelete;
    setPendingDelete(null);
    try {
      await api.templates.remove(id);
      setItems((cur) => (cur ?? []).filter((t) => t.id !== id));
      toast.success('Template deleted');
    } catch (e) {
      toast.error(`Delete failed: ${(e as Error).message}`);
    }
  }

  async function createFolder() {
    const name = folderName.trim();
    if (!name) return;
    try {
      const f = await api.templateFolders.create(name);
      setFolders((cur) => [...cur, f]);
      setFolderModal(false);
      setFolderName('');
      setFolderFilter(f.id);
      toast.success(`Folder "${f.name}" created`);
    } catch (e) {
      toast.error(`Create folder failed: ${(e as Error).message}`);
    }
  }

  async function moveToFolder(templateId: string, folderId: string | null) {
    try {
      const updated = await api.templates.update(templateId, { folderId });
      setItems((cur) => (cur ?? []).map((t) => (t.id === templateId ? { ...t, ...updated } : t)));
    } catch (e) {
      toast.error(`Move failed: ${(e as Error).message}`);
    }
  }

  async function commitRename(id: string) {
    const name = renameVal.trim();
    setRenamingId(null);
    if (!name) return;
    const cur = items?.find((t) => t.id === id);
    if (!cur || cur.name === name) return;
    try {
      const updated = await api.templates.update(id, { name });
      setItems((list) => (list ?? []).map((t) => (t.id === id ? { ...t, name: updated.name, updated_at: updated.updated_at } : t)));
      toast.success('Renamed');
    } catch (e) {
      toast.error(`Rename failed: ${(e as Error).message}`);
    }
  }

  async function commitFolderRename(id: string) {
    const name = folderRenameVal.trim();
    setRenamingFolderId(null);
    if (!name) return;
    const cur = folders.find((f) => f.id === id);
    if (!cur || cur.name === name) return;
    try {
      const updated = await api.templateFolders.update(id, { name });
      setFolders((list) => list.map((f) => (f.id === id ? { ...f, ...updated } : f)));
      toast.success('Folder renamed');
    } catch (e) {
      toast.error(`Rename folder failed: ${(e as Error).message}`);
    }
  }

  async function deleteFolder(mode: 'folder' | 'folderAndTemplates') {
    if (!pendingFolderDelete) return;
    const folder = pendingFolderDelete;
    setPendingFolderDelete(null);
    try {
      await api.templateFolders.remove(folder.id, { deleteTemplates: mode === 'folderAndTemplates' });
      setFolders((list) => list.filter((f) => f.id !== folder.id));
      if (mode === 'folderAndTemplates') {
        setItems((list) => (list ?? []).filter((t) => templateFolderId(t) !== folder.id));
      } else {
        setItems((list) => (list ?? []).map((t) => (
          templateFolderId(t) === folder.id
            ? { ...t, folderId: null, folder_id: null }
            : t
        )));
      }
      if (folderFilter === folder.id) setFolderFilter(ALL_FOLDER);
      toast.success(mode === 'folderAndTemplates' ? 'Folder and templates deleted' : 'Folder deleted');
    } catch (e) {
      toast.error(`Delete folder failed: ${(e as Error).message}`);
    }
  }

  function beginFolderResize(e: ReactPointerEvent<HTMLDivElement>) {
    folderResizeRef.current = { startX: e.clientX, startWidth: folderWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function resizeFolder(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = folderResizeRef.current;
    if (!drag) return;
    const next = drag.startWidth + (e.clientX - drag.startX);
    setFolderWidth(Math.min(FOLDER_WIDTH_MAX, Math.max(FOLDER_WIDTH_MIN, next)));
  }

  function endFolderResize(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = folderResizeRef.current;
    if (!drag) return;
    const next = Math.min(
      FOLDER_WIDTH_MAX,
      Math.max(FOLDER_WIDTH_MIN, drag.startWidth + (e.clientX - drag.startX)),
    );
    setFolderWidth(next);
    folderResizeRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    try {
      localStorage.setItem(FOLDER_WIDTH_KEY, String(Math.round(next)));
    } catch { /* ignore */ }
  }

  return (
    <div className="flex h-full min-h-0">
      {/* Folders column */}
      <aside
        className="relative flex shrink-0 flex-col border-r border-border bg-surface"
        style={{ width: folderWidth }}
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-[12px] font-semibold text-ink-muted">Folders</span>
          <button
            type="button"
            title="Create new folder"
            aria-label="Create new folder"
            className="grid h-7 w-7 place-items-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink"
            onClick={() => { setFolderModal(true); setFolderName(''); }}
          >
            <Plus className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1.5">
          <FolderRow
            label="<All>"
            active={folderFilter === ALL_FOLDER}
            hidden={allHidden}
            onToggleHidden={() => { void toggleAllHidden(); }}
            onSelect={() => setFolderFilter(ALL_FOLDER)}
            droppable
            highlight={dragOverFolder === ALL_FOLDER}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOverFolder(ALL_FOLDER);
            }}
            onDragLeave={() => setDragOverFolder((cur) => (cur === ALL_FOLDER ? null : cur))}
            onDrop={(e) => {
              e.preventDefault();
              setDragOverFolder(null);
              const id = e.dataTransfer.getData('text/template-id');
              if (id) void moveToFolder(id, null);
            }}
          />
          <FolderRow
            label="<unassigned>"
            active={folderFilter === UNASSIGNED_FOLDER}
            hidden={unassignedHidden}
            onToggleHidden={() => { void toggleUnassignedHidden(); }}
            onSelect={() => setFolderFilter(UNASSIGNED_FOLDER)}
            droppable
            highlight={dragOverFolder === UNASSIGNED_FOLDER}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOverFolder(UNASSIGNED_FOLDER);
            }}
            onDragLeave={() => setDragOverFolder((cur) => (cur === UNASSIGNED_FOLDER ? null : cur))}
            onDrop={(e) => {
              e.preventDefault();
              setDragOverFolder(null);
              const id = e.dataTransfer.getData('text/template-id');
              if (id) void moveToFolder(id, null);
            }}
          />
          {folders.map((f) => (
            <FolderRow
              key={f.id}
              label={f.name}
              active={folderFilter === f.id}
              hidden={isFolderHiddenInControl(f)}
              onToggleHidden={() => { void toggleFolderHidden(f.id); }}
              highlight={dragOverFolder === f.id}
              renaming={renamingFolderId === f.id}
              renameVal={folderRenameVal}
              onSelect={() => setFolderFilter(f.id)}
              onRenameStart={() => { setRenamingFolderId(f.id); setFolderRenameVal(f.name); }}
              onRenameChange={setFolderRenameVal}
              onRenameCommit={() => { void commitFolderRename(f.id); }}
              onRenameCancel={() => setRenamingFolderId(null)}
              onDelete={() => setPendingFolderDelete(f)}
              droppable
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverFolder(f.id);
              }}
              onDragLeave={() => setDragOverFolder((cur) => (cur === f.id ? null : cur))}
              onDrop={(e) => {
                e.preventDefault();
                setDragOverFolder(null);
                const id = e.dataTransfer.getData('text/template-id');
                if (id) void moveToFolder(id, f.id);
              }}
            />
          ))}
        </div>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize folders panel"
          className="absolute -right-1 top-0 bottom-0 z-10 w-2 cursor-col-resize transition-colors hover:bg-primary/30"
          onPointerDown={beginFolderResize}
          onPointerMove={resizeFolder}
          onPointerUp={endFolderResize}
          onPointerCancel={endFolderResize}
        />
      </aside>

      {/* Templates */}
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mb-5 flex items-end justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">Templates</h2>
            <p className="text-[13px] text-ink-muted">
              Design title graphics. The editor preview is the on-air render.
            </p>
            <div className="mt-3 flex items-center gap-1.5">
              <Select
                value={sortBy}
                onChange={(e) => setSortByMode(e.target.value as LibrarySortBy)}
                className="h-9 w-[140px]"
                aria-label="Sort templates by"
              >
                <option value="modified">Modified</option>
                <option value="name">Name</option>
              </Select>
              <button
                type="button"
                title={sortDirTitle}
                aria-label={`Sort direction: ${sortDirTitle}`}
                className="grid h-9 w-9 place-items-center rounded-md border border-border text-ink-muted hover:bg-surface-2 hover:text-ink"
                onClick={toggleSortDir}
              >
                <SortDirIcon className="h-4 w-4" aria-hidden />
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              title={view === 'icons' ? 'List view' : 'Icons view'}
              aria-label={view === 'icons' ? 'Switch to list view' : 'Switch to icons view'}
              className="grid h-9 w-9 place-items-center rounded-md border border-border text-ink-muted hover:bg-surface-2 hover:text-ink"
              onClick={() => setViewMode(view === 'icons' ? 'list' : 'icons')}
            >
              {view === 'icons'
                ? <List className="h-4 w-4" aria-hidden />
                : <LayoutGrid className="h-4 w-4" aria-hidden />}
            </button>
            <Button variant="primary" onClick={create} disabled={creating}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
              New template
            </Button>
          </div>
        </div>

        {items === null ? (
          <div className={cn(view === 'icons' ? 'grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3' : 'space-y-2')}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className={cn('animate-pulse rounded-lg border border-border bg-surface', view === 'icons' ? 'h-[164px]' : 'h-12')} />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-surface/40 px-6 py-16 text-center">
            <LayoutTemplate className="h-8 w-8 text-ink-faint" aria-hidden />
            <div>
              <p className="text-sm font-medium">No templates here</p>
              <p className="text-[13px] text-ink-muted">
                {folderFilter === ALL_FOLDER ? 'Create your first title graphic to start.' : 'Drop a template into this folder or create a new one.'}
              </p>
            </div>
            <Button variant="primary" onClick={create} disabled={creating}>
              <Plus className="h-4 w-4" aria-hidden />
              New template
            </Button>
          </div>
        ) : view === 'icons' ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
            {visible.map((t) => (
              <TemplateCard
                key={t.id}
                t={t}
                renaming={renamingId === t.id}
                renameVal={renameVal}
                duplicating={duplicatingId === t.id}
                onOpen={() => nav(`/editor/${t.id}`)}
                onRenameStart={() => { setRenamingId(t.id); setRenameVal(t.name); }}
                onRenameChange={setRenameVal}
                onRenameCommit={() => { void commitRename(t.id); }}
                onRenameCancel={() => setRenamingId(null)}
                onDuplicate={() => void duplicate(t.id, t.name)}
                onDelete={() => setPendingDelete({ id: t.id, name: t.name })}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-1">
            {visible.map((t) => (
              <TemplateListRow
                key={t.id}
                t={t}
                renaming={renamingId === t.id}
                renameVal={renameVal}
                duplicating={duplicatingId === t.id}
                onOpen={() => nav(`/editor/${t.id}`)}
                onRenameStart={() => { setRenamingId(t.id); setRenameVal(t.name); }}
                onRenameChange={setRenameVal}
                onRenameCommit={() => { void commitRename(t.id); }}
                onRenameCancel={() => setRenamingId(null)}
                onDuplicate={() => void duplicate(t.id, t.name)}
                onDelete={() => setPendingDelete({ id: t.id, name: t.name })}
              />
            ))}
          </div>
        )}
      </div>

      {pendingDelete && (
        <div className="fixed inset-0 z-modal grid place-items-center bg-bg/70 px-4 backdrop-blur-sm">
          <div role="dialog" aria-modal="true" className="w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-2xl">
            <p className="text-sm text-ink">{`Delete "${pendingDelete.name}"? This cannot be undone.`}</p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="danger" onClick={() => { void confirmRemove(); }}>Delete</Button>
              <Button variant="neutral" onClick={() => setPendingDelete(null)}>Cancel</Button>
            </div>
          </div>
        </div>
      )}

      {pendingFolderDelete && (
        <div className="fixed inset-0 z-modal grid place-items-center bg-bg/70 px-4 backdrop-blur-sm">
          <div role="dialog" aria-modal="true" className="w-full max-w-md rounded-xl border border-border bg-surface p-5 shadow-2xl">
            <h3 className="mb-2 text-sm font-semibold text-ink">Delete folder</h3>
            <p className="text-sm text-ink">
              Folder will delete, do you want to delete templates which attached to this folder?
            </p>
            <p className="mt-1 text-[12px] text-ink-muted">
              Folder: <span className="text-ink">{pendingFolderDelete.name}</span>
            </p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button
                variant="danger"
                onClick={() => { void deleteFolder('folder'); }}
              >
                Delete folder
              </Button>
              <Button
                variant="neutral"
                className="border-danger/40 text-danger hover:border-danger"
                onClick={() => { void deleteFolder('folderAndTemplates'); }}
              >
                Delete folder and templates
              </Button>
              <Button variant="neutral" onClick={() => setPendingFolderDelete(null)}>Cancel</Button>
            </div>
          </div>
        </div>
      )}

      {folderModal && (
        <div className="fixed inset-0 z-modal grid place-items-center bg-bg/70 px-4 backdrop-blur-sm">
          <div role="dialog" aria-modal="true" className="w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-2xl">
            <h3 className="mb-3 text-sm font-semibold text-ink">Create new folder</h3>
            <Input
              autoFocus
              value={folderName}
              placeholder="Folder name"
              onChange={(e) => setFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createFolder();
                if (e.key === 'Escape') setFolderModal(false);
              }}
            />
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="primary" onClick={() => { void createFolder(); }} disabled={!folderName.trim()}>Create</Button>
              <Button variant="neutral" onClick={() => setFolderModal(false)}>Cancel</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FolderRow({
  label, active, highlight, hidden, onToggleHidden, onSelect, droppable, onDragOver, onDragLeave, onDrop,
  renaming, renameVal, onRenameStart, onRenameChange, onRenameCommit, onRenameCancel, onDelete,
}: {
  label: string;
  active: boolean;
  highlight?: boolean;
  /** Folder hidden from Control (and all templates inside). */
  hidden?: boolean;
  onToggleHidden?: () => void;
  onSelect: () => void;
  droppable: boolean;
  onDragOver?: (e: DragEvent) => void;
  onDragLeave?: () => void;
  onDrop?: (e: DragEvent) => void;
  renaming?: boolean;
  renameVal?: string;
  onRenameStart?: () => void;
  onRenameChange?: (v: string) => void;
  onRenameCommit?: () => void;
  onRenameCancel?: () => void;
  onDelete?: () => void;
}) {
  const editable = Boolean(onRenameStart && onDelete);

  return (
    <div
      onDragOver={droppable ? onDragOver : undefined}
      onDragLeave={droppable ? onDragLeave : undefined}
      onDrop={droppable ? onDrop : undefined}
      className={cn(
        'group mb-0.5 flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-[13px] transition-colors',
        active ? 'bg-primary/15 text-primary' : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
        highlight && 'ring-1 ring-primary',
        hidden && 'opacity-70',
      )}
    >
      <Folder className="ml-1 h-3.5 w-3.5 shrink-0" aria-hidden />
      {renaming ? (
        <Input
          autoFocus
          value={renameVal ?? ''}
          className="h-7 min-w-0 flex-1 px-1.5 text-[12px]"
          onChange={(e) => onRenameChange?.(e.target.value)}
          onBlur={() => onRenameCommit?.()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRenameCommit?.();
            if (e.key === 'Escape') onRenameCancel?.();
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <button
          type="button"
          onClick={onSelect}
          className="min-w-0 flex-1 truncate px-1 py-0.5 text-left"
        >
          {label}
        </button>
      )}
      {onToggleHidden && (
        <button
          type="button"
          title={hidden ? 'Hidden from Control — click to show' : 'Visible in Control — click to hide'}
          aria-label={hidden ? `Show folder ${label} in Control` : `Hide folder ${label} from Control`}
          aria-pressed={Boolean(hidden)}
          className={cn(
            'grid h-6 w-6 shrink-0 place-items-center rounded hover:bg-surface',
            hidden ? 'text-ink-muted' : 'text-ink-faint hover:text-ink',
          )}
          onClick={(e) => { e.stopPropagation(); onToggleHidden(); }}
        >
          {hidden
            ? <EyeOff className="h-3.5 w-3.5" aria-hidden />
            : <Eye className="h-3.5 w-3.5" aria-hidden />}
        </button>
      )}
      {editable && !renaming && (
        <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            title="Rename folder"
            aria-label={`Rename folder ${label}`}
            className="grid h-6 w-6 place-items-center rounded text-ink-faint hover:bg-surface hover:text-ink"
            onClick={(e) => { e.stopPropagation(); onRenameStart?.(); }}
          >
            <Pencil className="h-3 w-3" aria-hidden />
          </button>
          <button
            type="button"
            title="Delete folder"
            aria-label={`Delete folder ${label}`}
            className="grid h-6 w-6 place-items-center rounded text-ink-faint hover:bg-surface hover:text-danger"
            onClick={(e) => { e.stopPropagation(); onDelete?.(); }}
          >
            <Trash2 className="h-3 w-3" aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}

function TemplateActions({
  name, duplicating, onRenameStart, onDuplicate, onDelete,
}: {
  name: string;
  duplicating: boolean;
  onRenameStart: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onRenameStart(); }}
        aria-label={`Rename ${name}`}
        title="Rename"
        className="grid h-7 w-7 place-items-center rounded text-ink-faint hover:bg-surface-2 hover:text-ink"
      >
        <Pencil className="h-4 w-4" aria-hidden />
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDuplicate(); }}
        disabled={duplicating}
        aria-label={`Duplicate ${name}`}
        title="Duplicate template"
        className="grid h-7 w-7 place-items-center rounded text-ink-faint hover:bg-surface-2 hover:text-ink disabled:opacity-40"
      >
        {duplicating
          ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          : <Copy className="h-4 w-4" aria-hidden />}
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        aria-label={`Delete ${name}`}
        title="Delete template"
        className="grid h-7 w-7 place-items-center rounded text-ink-faint hover:bg-surface-2 hover:text-danger"
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

function TemplateCard({
  t, renaming, renameVal, duplicating, onOpen, onRenameStart, onRenameChange, onRenameCommit, onRenameCancel, onDuplicate, onDelete,
}: {
  t: TemplateSummary;
  renaming: boolean;
  renameVal: string;
  duplicating: boolean;
  onOpen: () => void;
  onRenameStart: () => void;
  onRenameChange: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      draggable={!renaming}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/template-id', t.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      className="group flex flex-col overflow-hidden rounded-lg border border-border bg-surface transition-colors hover:border-ink-faint"
    >
      <button
        type="button"
        onClick={onOpen}
        className="relative grid aspect-video place-items-center overflow-hidden bg-surface-2 text-ink-faint"
        aria-label={`Open ${t.name}`}
      >
        {t.thumbnailUrl ? (
          <img
            src={t.thumbnailUrl}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <LayoutTemplate className="h-7 w-7" aria-hidden />
        )}
      </button>
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        {renaming ? (
          <Input
            autoFocus
            value={renameVal}
            className="h-8 flex-1"
            onChange={(e) => onRenameChange(e.target.value)}
            onBlur={onRenameCommit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onRenameCommit();
              if (e.key === 'Escape') onRenameCancel();
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
            <div className="truncate text-sm font-medium">{t.name}</div>
            <div className="truncate text-xs text-ink-faint">Updated {t.updated_at}</div>
          </button>
        )}
        <TemplateActions
          name={t.name}
          duplicating={duplicating}
          onRenameStart={onRenameStart}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
        />
      </div>
    </div>
  );
}

function TemplateListRow({
  t, renaming, renameVal, duplicating, onOpen, onRenameStart, onRenameChange, onRenameCommit, onRenameCancel, onDuplicate, onDelete,
}: {
  t: TemplateSummary;
  renaming: boolean;
  renameVal: string;
  duplicating: boolean;
  onOpen: () => void;
  onRenameStart: () => void;
  onRenameChange: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      draggable={!renaming}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/template-id', t.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      className="group flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 hover:border-ink-faint"
    >
      <LayoutTemplate className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
      {renaming ? (
        <Input
          autoFocus
          value={renameVal}
          className="h-8 flex-1"
          onChange={(e) => onRenameChange(e.target.value)}
          onBlur={onRenameCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRenameCommit();
            if (e.key === 'Escape') onRenameCancel();
          }}
        />
      ) : (
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
          <div className="truncate text-sm font-medium">{t.name}</div>
        </button>
      )}
      <span className="hidden shrink-0 text-[11px] text-ink-faint sm:inline">{t.updated_at}</span>
      <TemplateActions
        name={t.name}
        duplicating={duplicating}
        onRenameStart={onRenameStart}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
      />
    </div>
  );
}

function PlayTemplates() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState<string>('');
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [onAir, setOnAir] = useState<OnAirSnapshot>({});
  const [loaded, setLoaded] = useState(false);

  const status = useControlWs((s) => s.status);
  const connect = useControlWs((s) => s.connect);
  const send = useControlWs((s) => s.send);

  useEffect(() => { connect(); }, [connect]);

  useEffect(() => {
    (async () => {
      try {
        const [ch, tpl, air] = await Promise.all([
          api.channels.list(), api.templates.list(), api.onair.get(),
        ]);
        setChannels(ch);
        setTemplates(tpl);
        setOnAir(air);
        if (ch.length) setChannelId((cur) => cur || ch[0].id);
      } catch (e) {
        toast.error(`Failed to load play data: ${(e as Error).message}`);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const liveEntries = onAir[channelId] ?? [];
  const liveIds = liveEntries.map((e) => e.templateId);
  const monitorChannelId = channelId || 'default';
  const browserSourceUrl = channelId ? `${location.origin}/channel.html?channel=${channelId}` : '';

  async function take(rec: TemplateRecord, values: Record<string, string | number>) {
    if (!channelId) { toast.error('Select a channel first'); return; }
    let template = rec.data;
    let variables = values;
    try {
      const prepared = await prepareTemplateForAir(rec.data, values, 'take');
      template = prepared.template;
      variables = prepared.variables;
    } catch (err) {
      toast.error(templateDataErrorMessage(err) || crawlFileErrorMessage(err));
      return;
    }
    const alreadyLive = liveIds.includes(rec.id);
    if (alreadyLive) {
      if (isUpdateDirectorArmed(template.timeline)) {
        const ok = send({ type: 'update', channelId, templateId: rec.id, template, variables });
        if (!ok) toast.error('Control WebSocket not connected');
        return;
      }
      send({ type: 'clear', channelId, templateId: rec.id });
    }
    const ok = send({ type: 'take', channelId, templateId: rec.id, template, variables });
    if (!ok) { toast.error('Control WebSocket not connected'); return; }
    setOnAir((prev) => {
      const cur = (prev[channelId] ?? []).filter((e) => e.templateId !== rec.id);
      return { ...prev, [channelId]: [...cur, { templateId: rec.id }] };
    });
  }
  async function update(templateId: string, values: Record<string, string | number>) {
    if (!channelId) return;
    try {
      const rec = await api.templates.get(templateId);
      const prepared = await prepareTemplateForAir(rec.data, values, 'update');
      send({
        type: 'update',
        channelId,
        templateId,
        template: prepared.template,
        variables: prepared.variables,
      });
    } catch (err) {
      toast.error(templateDataErrorMessage(err));
      send({ type: 'update', channelId, templateId, variables: values });
    }
  }
  function clear(templateId: string) {
    if (!channelId) return;
    send({ type: 'clear', channelId, templateId });
    setOnAir((prev) => ({
      ...prev,
      [channelId]: (prev[channelId] ?? []).filter((x) => x.templateId !== templateId),
    }));
  }
  function clearAll() {
    if (!channelId) return;
    send({ type: 'clear', channelId });
    setOnAir((prev) => ({ ...prev, [channelId]: [] }));
  }

  if (loaded && channels.length === 0) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="space-y-2">
          <Radio className="mx-auto h-8 w-8 text-ink-faint" aria-hidden />
          <p className="text-sm font-medium">No channels yet</p>
          <p className="text-[13px] text-ink-muted">Create a channel to put graphics on air.</p>
          <Link to="/settings" className="inline-block text-primary hover:underline">Go to Settings</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
        <Select value={channelId} onChange={(e) => setChannelId(e.target.value)} className="w-48" disabled={!channels.length}>
          {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <WsBadge status={status} />
        <div className="ml-auto flex items-center gap-2">
          <BrowserSourceUrl url={browserSourceUrl} />
          <Button variant="danger" size="sm" onClick={clearAll} disabled={liveIds.length === 0}>
            <Trash2 className="h-4 w-4" aria-hidden /> Clear all
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_380px]">
        <div className="min-w-0 border-r border-border">
          <TemplatesTab templates={templates} live={liveIds} onTake={take} onUpdate={update} onClear={clear} />
        </div>
        <div className="flex min-h-0 flex-col gap-4 overflow-auto p-4">
          {monitorChannelId && <ProgramMonitor channelId={monitorChannelId} />}
          <div>
            <h3 className="mb-2 text-[12px] font-semibold text-ink-muted">On air ({liveIds.length})</h3>
            {liveIds.length === 0 ? (
              <p className="text-[12px] text-ink-faint">Nothing on air.</p>
            ) : (
              <ul className="space-y-1">
                {liveIds.map((tid) => (
                  <li key={tid} className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-[13px]">
                      {templates.find((t) => t.id === tid)?.name ?? tid}
                    </span>
                    <button onClick={() => clear(tid)} className="text-ink-faint hover:text-danger" aria-label="Clear">
                      <X className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
