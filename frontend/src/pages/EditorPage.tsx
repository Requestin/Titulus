// frontend/src/pages/EditorPage.tsx
//
// Template editor (DEVELOPMENT_PROMPT §8.3): toolbar + Layers | Canvas | (Props /
// Variables) + timeline strip. Loads/saves via REST, validated on save.

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, formatTemplateValidationErrors } from '@/core/api';
import { toast } from '@/core/toast';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { useEditor, undo, redo } from '@/editor/store';
import { Toolbar } from '@/editor/Toolbar';
import { CanvasArea } from '@/editor/CanvasArea';
import { LayersPanel } from '@/editor/panels/LayersPanel';
import { PropertiesPanel } from '@/editor/panels/PropertiesPanel';
import { VariablesPanel } from '@/editor/panels/VariablesPanel';
import { DataPanel } from '@/editor/panels/DataPanel';
import { TimelinePanel } from '@/editor/panels/TimelinePanel';

export function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const load = useEditor((s) => s.load);
  const dirty = useEditor((s) => s.dirty);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'properties' | 'variables' | 'data'>('properties');
  const [timelineHeight, setTimelineHeight] = useState(256);
  const [layersWidth, setLayersWidth] = useState(240);
  const [inspectorWidth, setInspectorWidth] = useState(320);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const allowNavigationRef = useRef(false);
  const timelineResizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const layersResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const inspectorResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

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

  const save = useCallback(async (): Promise<boolean> => {
    const t = useEditor.getState().template;
    if (!t || !id) return false;
    setSaving(true);
    try {
      const res = await api.templates.validate(t);
      if (!res.valid) {
        toast.error(formatTemplateValidationErrors(res.errors ?? []));
        console.warn('[template validation]', res.errors);
        return false;
      }
      await api.templates.update(id, { name: t.name, data: t });
      useEditor.getState().markSaved();
      toast.success('Saved');
      // Mid-timeline thumbnail — best-effort, don't block the save UX.
      void api.templates.regenerateThumbnail(id).catch((err) => {
        console.warn('[thumbnail] regenerate failed', err);
      });
      return true;
    } catch (e) {
      toast.error(`Save failed: ${(e as Error).message}`);
      console.warn('[template save]', e);
      return false;
    } finally {
      setSaving(false);
    }
  }, [id]);

  const continueTo = useCallback((path: string) => {
    allowNavigationRef.current = true;
    setPendingPath(null);
    navigate(path);
  }, [navigate]);

  const saveAndExit = useCallback(async () => {
    if (!pendingPath) return;
    const ok = await save();
    if (ok) continueTo(pendingPath);
  }, [continueTo, pendingPath, save]);

  const discardAndExit = useCallback(() => {
    if (!pendingPath) return;
    useEditor.getState().markSaved();
    continueTo(pendingPath);
  }, [continueTo, pendingPath]);

  const cancelExit = useCallback(() => {
    setPendingPath(null);
  }, []);

  useEffect(() => {
    if (!pendingPath) return undefined;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') cancelExit();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cancelExit, pendingPath]);

  useEffect(() => {
    if (dirty) return undefined;
    setPendingPath(null);
    return undefined;
  }, [dirty]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (allowNavigationRef.current || !useEditor.getState().dirty) return;
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target instanceof Element ? e.target.closest('a[href]') : null;
      if (!(target instanceof HTMLAnchorElement)) return;
      if (target.target && target.target !== '_self') return;
      const url = new URL(target.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      setPendingPath(`${url.pathname}${url.search}${url.hash}`);
    }
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  useEffect(() => {
    if (!dirty) return undefined;
    function beforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

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

  function beginTimelineResize(e: ReactPointerEvent<HTMLDivElement>) {
    timelineResizeRef.current = { startY: e.clientY, startHeight: timelineHeight };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function resizeTimeline(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = timelineResizeRef.current;
    if (!drag) return;
    const next = drag.startHeight + (drag.startY - e.clientY);
    setTimelineHeight(Math.min(520, Math.max(160, next)));
  }

  function endTimelineResize(e: ReactPointerEvent<HTMLDivElement>) {
    if (!timelineResizeRef.current) return;
    timelineResizeRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  function beginLayersResize(e: ReactPointerEvent<HTMLDivElement>) {
    layersResizeRef.current = { startX: e.clientX, startWidth: layersWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function resizeLayers(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = layersResizeRef.current;
    if (!drag) return;
    // Dragging the right edge: move right → wider panel.
    const next = drag.startWidth + (e.clientX - drag.startX);
    setLayersWidth(Math.min(480, Math.max(180, next)));
  }

  function endLayersResize(e: ReactPointerEvent<HTMLDivElement>) {
    if (!layersResizeRef.current) return;
    layersResizeRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  function beginInspectorResize(e: ReactPointerEvent<HTMLDivElement>) {
    inspectorResizeRef.current = { startX: e.clientX, startWidth: inspectorWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function resizeInspector(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = inspectorResizeRef.current;
    if (!drag) return;
    // Dragging the left edge: move left → wider panel.
    const next = drag.startWidth + (drag.startX - e.clientX);
    setInspectorWidth(Math.min(640, Math.max(260, next)));
  }

  function endInspectorResize(e: ReactPointerEvent<HTMLDivElement>) {
    if (!inspectorResizeRef.current) return;
    inspectorResizeRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  if (status === 'loading') {
    return <div className="grid h-full place-items-center text-sm text-ink-muted">Loading editor…</div>;
  }
  if (status === 'error') {
    return <div className="grid h-full place-items-center text-sm text-danger">Could not load this template.</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <Toolbar onSave={() => { void save(); }} saving={saving} />
      <div className="flex min-h-0 flex-1">
        <aside
          className="relative flex shrink-0 flex-col border-r border-border bg-surface"
          style={{ width: layersWidth }}
        >
          <LayersPanel />
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize layers panel"
            className="absolute -right-1 top-0 bottom-0 z-sticky w-2 cursor-col-resize transition-colors hover:bg-primary/30"
            onPointerDown={beginLayersResize}
            onPointerMove={resizeLayers}
            onPointerUp={endLayersResize}
            onPointerCancel={endLayersResize}
          />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <CanvasArea />
          </div>
          <div
            className="relative shrink-0 border-t border-border"
            style={{ height: timelineHeight }}
          >
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize timeline"
              className="absolute -top-1 left-0 right-0 z-sticky h-2 cursor-row-resize transition-colors hover:bg-primary/30"
              onPointerDown={beginTimelineResize}
              onPointerMove={resizeTimeline}
              onPointerUp={endTimelineResize}
              onPointerCancel={endTimelineResize}
            />
            <TimelinePanel />
          </div>
        </div>

        <aside
          className="relative flex shrink-0 flex-col border-l border-border bg-surface"
          style={{ width: inspectorWidth }}
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize inspector"
            className="absolute -left-1 top-0 bottom-0 z-sticky w-2 cursor-col-resize transition-colors hover:bg-primary/30"
            onPointerDown={beginInspectorResize}
            onPointerMove={resizeInspector}
            onPointerUp={endInspectorResize}
            onPointerCancel={endInspectorResize}
          />
          <div className="flex shrink-0 border-b border-border">
            {(['properties', 'variables', 'data'] as const).map((t) => (
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
            {tab === 'properties' ? <PropertiesPanel /> : tab === 'variables' ? <VariablesPanel /> : <DataPanel />}
          </div>
        </aside>
      </div>
      {pendingPath && (
        <UnsavedChangesDialog
          saving={saving}
          onSaveAndExit={() => { void saveAndExit(); }}
          onDiscardAndExit={discardAndExit}
          onCancel={cancelExit}
        />
      )}
    </div>
  );
}

function UnsavedChangesDialog({
  saving,
  onSaveAndExit,
  onDiscardAndExit,
  onCancel,
}: {
  saving: boolean;
  onSaveAndExit: () => void;
  onDiscardAndExit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-modal grid place-items-center bg-bg/70 px-4 backdrop-blur-sm" role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="unsaved-changes-title"
        className="w-full max-w-md rounded-xl border border-border bg-surface p-5 shadow-2xl"
      >
        <h2 id="unsaved-changes-title" className="text-base font-semibold text-ink">
          You have unsaved changes
        </h2>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="danger" onClick={onSaveAndExit} disabled={saving}>
            {saving ? 'Saving...' : 'Save and exit'}
          </Button>
          <Button variant="neutral" onClick={onDiscardAndExit} disabled={saving}>
            Discard and exit
          </Button>
          <Button variant="neutral" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
