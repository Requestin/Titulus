import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Copy,
  LayoutGrid,
  LayoutTemplate,
  List,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { createDefaultTemplate } from '@runtime';
import { api, type TemplateSummary } from '@/core/api';
import { createId } from '@/core/id';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/form';
import { toast } from '@/core/toast';
import { cn } from '@/lib/cn';
import {
  readAllowedStringPreference,
  readBooleanPreference,
  type StorageLike,
  writeAllowedStringPreference,
  writeBooleanPreference,
} from '@/ui/chromePrefs';
import {
  nextTemplateName,
  sortTemplates,
  TEMPLATE_SORT_BY,
  type TemplateSortBy,
} from '@/ui/templateLibrary';

const GRID_VIEW_KEY = 'titulus.templates.gridView';
const SORT_BY_KEY = 'titulus.templates.sortBy';

function safeStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readGridView(): boolean {
  const storage = safeStorage();
  return storage ? readBooleanPreference(storage, GRID_VIEW_KEY, true) : true;
}

function readSortBy(): TemplateSortBy {
  const storage = safeStorage();
  return storage
    ? readAllowedStringPreference(storage, SORT_BY_KEY, TEMPLATE_SORT_BY, 'modified')
    : 'modified';
}

export function TemplatesPage() {
  const nav = useNavigate();
  const [items, setItems] = useState<TemplateSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TemplateSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [gridView, setGridView] = useState(readGridView);
  const [sortBy, setSortBy] = useState<TemplateSortBy>(readSortBy);
  const deleteTriggerRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api.templates.list());
    } catch (e) {
      toast.error(`Failed to load templates: ${(e as Error).message}`);
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleItems = useMemo(
    () => (items ? sortTemplates(items, sortBy) : []),
    [items, sortBy],
  );

  function persistGridView(next: boolean) {
    setGridView(next);
    const storage = safeStorage();
    if (storage) writeBooleanPreference(storage, GRID_VIEW_KEY, next);
  }

  function persistSortBy(next: TemplateSortBy) {
    setSortBy(next);
    const storage = safeStorage();
    if (storage) writeAllowedStringPreference(storage, SORT_BY_KEY, TEMPLATE_SORT_BY, next);
  }

  async function create() {
    setCreating(true);
    try {
      const rec = await api.templates.create('Untitled template', createDefaultTemplate());
      nav(`/editor/${rec.id}`);
    } catch (e) {
      toast.error(`Create failed: ${(e as Error).message}`);
    } finally {
      setCreating(false);
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
      const created = await api.templates.create(copyName, data);
      setItems((cur) => [...(cur ?? []), created]);
      toast.success(`Copied as "${copyName}"`);
    } catch (e) {
      toast.error(`Copy failed: ${(e as Error).message}`);
    } finally {
      setDuplicatingId(null);
    }
  }

  function requestDelete(template: TemplateSummary, trigger: HTMLElement) {
    deleteTriggerRef.current = trigger;
    setRenamingId(null);
    setPendingDelete(template);
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.templates.remove(pendingDelete.id);
      setItems((cur) => (cur ?? []).filter((t) => t.id !== pendingDelete.id));
      toast.success('Template deleted');
      setPendingDelete(null);
    } catch (e) {
      toast.error(`Delete failed: ${(e as Error).message}`);
    } finally {
      setDeleting(false);
    }
  }

  function beginRename(template: TemplateSummary) {
    setPendingDelete(null);
    setRenamingId(template.id);
    setRenameDraft(template.name);
  }

  function cancelRename() {
    setRenamingId(null);
    setRenameDraft('');
  }

  async function commitRename(template: TemplateSummary) {
    const next = nextTemplateName(template.name, renameDraft);
    if (!next) {
      cancelRename();
      return;
    }
    try {
      const updated = await api.templates.update(template.id, { name: next });
      setItems((cur) =>
        (cur ?? []).map((item) => (item.id === template.id
          ? { ...item, name: updated.name, updated_at: updated.updated_at }
          : item)),
      );
      toast.success('Template renamed');
      cancelRename();
    } catch (e) {
      toast.error(`Rename failed: ${(e as Error).message}`);
    }
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Templates</h2>
          <p className="text-[13px] text-ink-muted">
            Design title graphics. The editor preview is the on-air render.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-[12px] text-ink-muted">
            <span>Sort</span>
            <Select
              aria-label="Sort templates"
              value={sortBy}
              onChange={(e) => persistSortBy(e.target.value as TemplateSortBy)}
              className="w-[10.5rem]"
            >
              <option value="modified">Date modified</option>
              <option value="name">Name</option>
            </Select>
          </label>
          <div
            className="flex rounded-md border border-border bg-surface-2 p-0.5"
            role="group"
            aria-label="Template view"
          >
            <button
              type="button"
              aria-pressed={gridView}
              aria-label="Show thumbnail view"
              title="Thumbnails"
              onClick={() => persistGridView(true)}
              className={cn(
                'grid h-8 w-8 place-items-center rounded-[5px] text-ink-muted transition-colors',
                gridView ? 'bg-surface text-ink' : 'hover:text-ink',
              )}
            >
              <LayoutGrid className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-pressed={!gridView}
              aria-label="Show list view"
              title="List"
              onClick={() => persistGridView(false)}
              className={cn(
                'grid h-8 w-8 place-items-center rounded-[5px] text-ink-muted transition-colors',
                !gridView ? 'bg-surface text-ink' : 'hover:text-ink',
              )}
            >
              <List className="h-4 w-4" aria-hidden />
            </button>
          </div>
          <Button variant="primary" onClick={create} disabled={creating}>
            {creating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
            New template
          </Button>
        </div>
      </div>

      {items === null ? (
        <div className={gridView
          ? 'grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3'
          : 'space-y-2'}
        >
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className={cn(
                'animate-pulse rounded-lg border border-border bg-surface',
                gridView ? 'h-[164px]' : 'h-14',
              )}
            />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-surface/40 px-6 py-16 text-center">
          <LayoutTemplate className="h-8 w-8 text-ink-faint" aria-hidden />
          <div>
            <p className="text-sm font-medium">No templates yet</p>
            <p className="text-[13px] text-ink-muted">Create your first title graphic to start.</p>
          </div>
          <Button variant="primary" onClick={create} disabled={creating}>
            <Plus className="h-4 w-4" aria-hidden />
            New template
          </Button>
        </div>
      ) : gridView ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {visibleItems.map((t) => (
            <TemplateCard
              key={t.id}
              template={t}
              duplicating={duplicatingId === t.id}
              renaming={renamingId === t.id}
              renameDraft={renameDraft}
              onOpen={() => nav(`/editor/${t.id}`)}
              onDuplicate={() => duplicate(t.id, t.name)}
              onRename={() => beginRename(t)}
              onRenameDraft={setRenameDraft}
              onRenameCommit={() => { void commitRename(t); }}
              onRenameCancel={cancelRename}
              onDelete={(trigger) => requestDelete(t, trigger)}
            />
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          {visibleItems.map((t) => (
            <TemplateRow
              key={t.id}
              template={t}
              duplicating={duplicatingId === t.id}
              renaming={renamingId === t.id}
              renameDraft={renameDraft}
              onOpen={() => nav(`/editor/${t.id}`)}
              onDuplicate={() => duplicate(t.id, t.name)}
              onRename={() => beginRename(t)}
              onRenameDraft={setRenameDraft}
              onRenameCommit={() => { void commitRename(t); }}
              onRenameCancel={cancelRename}
              onDelete={(trigger) => requestDelete(t, trigger)}
            />
          ))}
        </div>
      )}

      {pendingDelete && (
        <DeleteTemplateDialog
          name={pendingDelete.name}
          deleting={deleting}
          restoreFocusTo={deleteTriggerRef.current}
          onConfirm={() => { void confirmDelete(); }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

function TemplateCard({
  template,
  duplicating,
  renaming,
  renameDraft,
  onOpen,
  onDuplicate,
  onRename,
  onRenameDraft,
  onRenameCommit,
  onRenameCancel,
  onDelete,
}: TemplateItemProps) {
  return (
    <div className="group flex flex-col overflow-hidden rounded-lg border border-border bg-surface transition-colors hover:border-ink-faint">
      <button
        type="button"
        onClick={onOpen}
        className="grid aspect-video place-items-center bg-surface-2 text-ink-faint"
        aria-label={`Open ${template.name}`}
      >
        <LayoutTemplate className="h-7 w-7" aria-hidden />
      </button>
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <TemplateIdentity
          template={template}
          renaming={renaming}
          renameDraft={renameDraft}
          onOpen={onOpen}
          onRenameDraft={onRenameDraft}
          onRenameCommit={onRenameCommit}
          onRenameCancel={onRenameCancel}
        />
        <TemplateActions
          name={template.name}
          duplicating={duplicating}
          onDuplicate={onDuplicate}
          onRename={onRename}
          onDelete={onDelete}
          revealOnHover
        />
      </div>
    </div>
  );
}

function TemplateRow({
  template,
  duplicating,
  renaming,
  renameDraft,
  onOpen,
  onDuplicate,
  onRename,
  onRenameDraft,
  onRenameCommit,
  onRenameCancel,
  onDelete,
}: TemplateItemProps) {
  return (
    <div className="group flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0 hover:bg-surface-2/60">
      <button
        type="button"
        onClick={onOpen}
        className="grid h-10 w-14 shrink-0 place-items-center rounded-md bg-surface-2 text-ink-faint"
        aria-label={`Open ${template.name}`}
      >
        <LayoutTemplate className="h-4 w-4" aria-hidden />
      </button>
      <TemplateIdentity
        template={template}
        renaming={renaming}
        renameDraft={renameDraft}
        onOpen={onOpen}
        onRenameDraft={onRenameDraft}
        onRenameCommit={onRenameCommit}
        onRenameCancel={onRenameCancel}
      />
      <TemplateActions
        name={template.name}
        duplicating={duplicating}
        onDuplicate={onDuplicate}
        onRename={onRename}
        onDelete={onDelete}
      />
    </div>
  );
}

function TemplateIdentity({
  template,
  renaming,
  renameDraft,
  onOpen,
  onRenameDraft,
  onRenameCommit,
  onRenameCancel,
}: {
  template: TemplateSummary;
  renaming: boolean;
  renameDraft: string;
  onOpen: () => void;
  onRenameDraft: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
}) {
  const inputId = useId();
  const skipBlurCommit = useRef(false);

  if (renaming) {
    return (
      <div className="min-w-0 flex-1">
        <Input
          id={inputId}
          value={renameDraft}
          aria-label={`Rename ${template.name}`}
          autoFocus
          onChange={(e) => onRenameDraft(e.target.value)}
          onBlur={() => {
            if (skipBlurCommit.current) {
              skipBlurCommit.current = false;
              return;
            }
            onRenameCommit();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onRenameCommit();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              skipBlurCommit.current = true;
              onRenameCancel();
            }
          }}
        />
      </div>
    );
  }

  return (
    <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
      <div className="truncate text-sm font-medium">{template.name}</div>
      <div className="truncate text-xs text-ink-faint">Updated {template.updated_at}</div>
    </button>
  );
}

function TemplateActions({
  name,
  duplicating,
  onDuplicate,
  onRename,
  onDelete,
  revealOnHover = false,
}: {
  name: string;
  duplicating: boolean;
  onDuplicate: () => void;
  onRename: () => void;
  onDelete: (trigger: HTMLElement) => void;
  revealOnHover?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-1 transition-opacity',
        revealOnHover && 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
      )}
    >
      <IconAction
        label={`Rename ${name}`}
        title="Rename template"
        onClick={onRename}
      >
        <Pencil className="h-4 w-4" aria-hidden />
      </IconAction>
      <IconAction
        label={`Duplicate ${name}`}
        title="Duplicate template"
        disabled={duplicating}
        onClick={onDuplicate}
      >
        {duplicating
          ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          : <Copy className="h-4 w-4" aria-hidden />}
      </IconAction>
      <IconAction
        label={`Delete ${name}`}
        title="Delete template"
        danger
        onClick={(event) => onDelete(event.currentTarget)}
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </IconAction>
    </div>
  );
}

function IconAction({
  label,
  title,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  title: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title}
      className={cn(
        'grid h-7 w-7 place-items-center rounded text-ink-faint hover:bg-surface-2 hover:text-ink disabled:opacity-40',
        danger && 'hover:text-danger',
      )}
    >
      {children}
    </button>
  );
}

interface TemplateItemProps {
  template: TemplateSummary;
  duplicating: boolean;
  renaming: boolean;
  renameDraft: string;
  onOpen: () => void;
  onDuplicate: () => void;
  onRename: () => void;
  onRenameDraft: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onDelete: (trigger: HTMLElement) => void;
}

function DeleteTemplateDialog({
  name,
  deleting,
  restoreFocusTo,
  onConfirm,
  onCancel,
}: {
  name: string;
  deleting: boolean;
  restoreFocusTo: HTMLElement | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled])',
      )];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      restoreFocusTo?.focus();
    };
  }, [onCancel, restoreFocusTo]);

  return (
    <div className="fixed inset-0 z-modal grid place-items-center bg-bg/70 px-4 backdrop-blur-sm" role="presentation">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-template-title"
        className="w-full max-w-md rounded-xl border border-border bg-surface p-5 shadow-2xl"
      >
        <h2 id="delete-template-title" className="text-base font-semibold text-ink">
          Delete “{name}”?
        </h2>
        <p className="mt-2 text-[13px] text-ink-muted">
          This cannot be undone.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="danger" onClick={onConfirm} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
          <Button ref={cancelRef} variant="neutral" onClick={onCancel} disabled={deleting}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
