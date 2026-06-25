// frontend/src/pages/EditorPage.tsx
//
// Template editor (DEVELOPMENT_PROMPT §8.3): toolbar + Layers | Canvas | (Props /
// Variables) + timeline strip. Loads/saves via REST, validated on save.

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '@/core/api';
import { toast } from '@/core/toast';
import { cn } from '@/lib/cn';
import { useEditor, undo, redo } from '@/editor/store';
import { Toolbar } from '@/editor/Toolbar';
import { CanvasArea } from '@/editor/CanvasArea';
import { LayersPanel } from '@/editor/panels/LayersPanel';
import { PropertiesPanel } from '@/editor/panels/PropertiesPanel';
import { VariablesPanel } from '@/editor/panels/VariablesPanel';

export function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const load = useEditor((s) => s.load);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'properties' | 'variables'>('properties');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    (async () => {
      try {
        const rec = await api.templates.get(id!);
        if (!cancelled) {
          load(rec.data);
          setStatus('ready');
        }
      } catch (e) {
        if (!cancelled) {
          toast.error(`Failed to load template: ${(e as Error).message}`);
          setStatus('error');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [id, load]);

  const save = useCallback(async () => {
    const t = useEditor.getState().template;
    if (!t || !id) return;
    setSaving(true);
    try {
      const res = await api.templates.validate(t);
      if (!res.valid) {
        toast.error(`Validation failed: ${res.errors[0]?.message ?? 'invalid template'}`);
        return;
      }
      await api.templates.update(id, { name: t.name, data: t });
      useEditor.getState().markSaved();
      toast.success('Saved');
    } catch (e) {
      toast.error(`Save failed: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [id]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); return; }
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); useEditor.getState().duplicateSelected(); return; }
      if (typing) return;
      const sel = useEditor.getState().selection;
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); useEditor.getState().deleteSelected(); return; }
      if (sel?.kind === 'layer') {
        const t = useEditor.getState().template;
        const l = t?.layers.find((x) => x.id === sel.id);
        if (!l) return;
        const step = e.shiftKey ? 10 : 1;
        const move = (dx: number, dy: number) => {
          e.preventDefault();
          useEditor.getState().updateTransform(sel.id, { x: l.transform.x + dx, y: l.transform.y + dy });
        };
        if (e.key === 'ArrowLeft') move(-step, 0);
        else if (e.key === 'ArrowRight') move(step, 0);
        else if (e.key === 'ArrowUp') move(0, -step);
        else if (e.key === 'ArrowDown') move(0, step);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  if (status === 'loading') {
    return <div className="grid h-full place-items-center text-sm text-ink-muted">Loading editor…</div>;
  }
  if (status === 'error') {
    return <div className="grid h-full place-items-center text-sm text-danger">Could not load this template.</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <Toolbar onSave={save} saving={saving} />
      <div className="flex min-h-0 flex-1">
        <aside className="w-60 shrink-0 border-r border-border bg-surface">
          <LayersPanel />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <CanvasArea />
          </div>
          <div className="flex h-9 shrink-0 items-center border-t border-border bg-surface px-3 text-[12px] text-ink-faint">
            Timeline
          </div>
        </div>

        <aside className="flex w-72 shrink-0 flex-col border-l border-border bg-surface">
          <div className="flex shrink-0 border-b border-border">
            {(['properties', 'variables'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  'flex-1 py-2 text-[13px] capitalize transition-colors',
                  tab === t ? 'border-b-2 border-primary text-ink' : 'text-ink-muted hover:text-ink',
                )}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {tab === 'properties' ? <PropertiesPanel /> : <VariablesPanel />}
          </div>
        </aside>
      </div>
    </div>
  );
}
