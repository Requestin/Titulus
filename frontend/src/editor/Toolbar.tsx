import { Link } from 'react-router-dom';
import {
  ChevronLeft, Undo2, Redo2, ZoomIn, ZoomOut, Grid3x3, Save, Loader2, Copy, Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { useEditor, useCanUndo, useCanRedo, undo, redo } from './store';

export function Toolbar({ onSave, saving, readOnly = false, lockOwner }: { onSave: () => void; saving: boolean; readOnly?: boolean; lockOwner?: string | null }) {
  const name = useEditor((s) => s.template?.name ?? '');
  const dirty = useEditor((s) => s.dirty);
  const zoom = useEditor((s) => s.zoom);
  const gridSnap = useEditor((s) => s.gridSnap);
  const selection = useEditor((s) => s.selection);
  const setName = useEditor((s) => s.setName);
  const setZoom = useEditor((s) => s.setZoom);
  const toggleGridSnap = useEditor((s) => s.toggleGridSnap);
  const duplicateSelected = useEditor((s) => s.duplicateSelected);
  const deleteSelected = useEditor((s) => s.deleteSelected);
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-surface-2 px-3">
      <Link
        to="/templates"
        className="grid h-8 w-8 place-items-center rounded-md text-ink-muted hover:bg-surface hover:text-ink"
        title="Back to templates"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
      </Link>

      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-56 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-medium text-ink hover:border-border focus-visible:border-ring focus-visible:outline-none"
        aria-label="Template name"
      />

      <div className="mx-1 h-6 w-px bg-border" />

      <IconBtn onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)"><Undo2 className="h-4 w-4" /></IconBtn>
      <IconBtn onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)"><Redo2 className="h-4 w-4" /></IconBtn>

      <div className="mx-1 h-6 w-px bg-border" />

      <IconBtn onClick={duplicateSelected} disabled={!selection} title="Duplicate (Ctrl+D)"><Copy className="h-4 w-4" /></IconBtn>
      <IconBtn onClick={deleteSelected} disabled={!selection} title="Delete (Del)"><Trash2 className="h-4 w-4" /></IconBtn>

      <div className="mx-1 h-6 w-px bg-border" />

      <IconBtn onClick={() => setZoom(zoom - 0.1)} title="Zoom out"><ZoomOut className="h-4 w-4" /></IconBtn>
      <button
        onClick={() => setZoom(0.45)}
        className="w-12 rounded-md py-1 text-center text-[12px] tabular-nums text-ink-muted hover:bg-surface hover:text-ink"
        title="Reset zoom"
      >
        {Math.round(zoom * 100)}%
      </button>
      <IconBtn onClick={() => setZoom(zoom + 0.1)} title="Zoom in"><ZoomIn className="h-4 w-4" /></IconBtn>
      <IconBtn onClick={toggleGridSnap} active={gridSnap} title="Grid snap"><Grid3x3 className="h-4 w-4" /></IconBtn>

      <div className="ml-auto flex items-center gap-2">
        {readOnly && <span className="text-[12px] text-warning">Read-only{lockOwner ? ` · locked by ${lockOwner}` : ''}</span>}
        {dirty && !readOnly && <span className="text-[12px] text-ink-faint">Unsaved</span>}
        <Button variant="primary" size="sm" onClick={onSave} disabled={saving || readOnly}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
          Save
        </Button>
      </div>
    </div>
  );
}

function IconBtn({
  children, onClick, disabled, title, active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title: string;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'grid h-8 w-8 place-items-center rounded-md transition-colors disabled:opacity-40',
        active ? 'bg-primary/20 text-ink' : 'text-ink-muted hover:bg-surface hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}
