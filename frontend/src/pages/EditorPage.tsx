// frontend/src/pages/EditorPage.tsx
//
// Template editor (DEVELOPMENT_PROMPT §8.3): toolbar + Layers | Canvas | (Props /
// Variables) + timeline strip. Loads/saves via REST, validated on save.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '@/core/api';
import {
  extractTemplateValidationErrors,
  formatTemplateValidationError,
} from '@/core/templateValidation';
import { toast } from '@/core/toast';
import { cn } from '@/lib/cn';
import {
  nextSize,
  readBoundedNumberPreference,
  writeBoundedNumberPreference,
} from '@/ui/chromePrefs';
import { Button } from '@/components/ui/Button';
import { useEditor, undo, redo } from '@/editor/store';
import { Toolbar } from '@/editor/Toolbar';
import { CanvasArea } from '@/editor/CanvasArea';
import { LayersPanel } from '@/editor/panels/LayersPanel';
import { PropertiesPanel } from '@/editor/panels/PropertiesPanel';
import { VariablesPanel } from '@/editor/panels/VariablesPanel';
import { DataPanel } from '@/editor/panels/DataPanel';
import { TimelinePanel } from '@/editor/panels/TimelinePanel';
import { effectiveTransform } from '@/editor/effectiveValues';
import { ancestorMatrix, canvasDeltaToParent } from '@/editor/transformMath';

const TREE_WIDTH = {
  key: 'titulus.editor.treeWidth',
  defaultValue: 240,
  min: 180,
  max: 360,
} as const;

const INSPECTOR_WIDTH = {
  key: 'titulus.editor.inspectorWidth',
  defaultValue: 320,
  min: 320,
  max: 480,
} as const;

type PanelWidthPreference = typeof TREE_WIDTH | typeof INSPECTOR_WIDTH;
type PanelResize = { startX: number; startWidth: number; nextWidth: number };

function readPanelWidth(preference: PanelWidthPreference): number {
  if (typeof window === 'undefined') return preference.defaultValue;
  try {
    return readBoundedNumberPreference(
      window.localStorage,
      preference.key,
      preference.defaultValue,
      preference.min,
      preference.max,
    );
  } catch {
    return preference.defaultValue;
  }
}

function persistPanelWidth(preference: PanelWidthPreference, width: number): void {
  if (typeof window === 'undefined') return;
  try {
    writeBoundedNumberPreference(
      window.localStorage,
      preference.key,
      width,
      preference.min,
      preference.max,
    );
  } catch {
    // Accessing localStorage itself can fail under browser privacy policies.
  }
}

export function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const load = useEditor((s) => s.load);
  const dirty = useEditor((s) => s.dirty);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'properties' | 'variables' | 'data'>('properties');
  const [timelineHeight, setTimelineHeight] = useState(256);
  const [treeWidth, setTreeWidth] = useState(() => readPanelWidth(TREE_WIDTH));
  const [inspectorWidth, setInspectorWidth] = useState(() => readPanelWidth(INSPECTOR_WIDTH));
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const allowNavigationRef = useRef(false);
  const timelineResizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const treeResizeRef = useRef<PanelResize | null>(null);
  const inspectorResizeRef = useRef<PanelResize | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    (async () => {
      try {
        const rec = await api.templates.get(id!);
        if (!cancelled) {
          load(rec.data);
          setStatus('ready');
          void api.templateLocks.acquire(id!).catch(() => toast.error('Template is locked by another user'));
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

  useEffect(() => {
    if (!id) return undefined;
    const timer = window.setInterval(() => {
      void api.templateLocks.heartbeat(id).catch(() => undefined);
    }, 30000);
    return () => {
      window.clearInterval(timer);
      void api.templateLocks.release(id).catch(() => undefined);
    };
  }, [id]);

  const save = useCallback(async (): Promise<boolean> => {
    const t = useEditor.getState().template;
    if (!t || !id) return false;
    setSaving(true);
    try {
      const res = await api.templates.validate(t);
      if (!res.valid) {
        toast.error(`Validation failed: ${formatTemplateValidationError(res.errors)}`);
        return false;
      }
      await api.templates.update(id, { name: t.name, data: t });
      useEditor.getState().markSaved();
      toast.success('Saved');
      return true;
    } catch (e) {
      const validationErrors = extractTemplateValidationErrors(e);
      if (validationErrors.length > 0) {
        toast.error(`Validation failed: ${formatTemplateValidationError(validationErrors)}`);
      } else {
        toast.error(`Save failed: ${(e as Error).message}`);
      }
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
      const interactiveTarget = e.target instanceof Element
        ? e.target.closest('button, a, [role="separator"], [data-chrome-control]')
        : null;
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); return; }
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (typing || interactiveTarget) return;
      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); useEditor.getState().duplicateSelected(); return; }
      const sel = useEditor.getState().selection;
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); useEditor.getState().deleteSelected(); return; }
      if (sel) {
        const t = useEditor.getState().template;
        const entity = sel.kind === 'layer'
          ? t?.layers.find((item) => item.id === sel.id)
          : t?.groups.find((item) => item.id === sel.id);
        if (!t || !entity || entity.locked) return;
        const parentId = sel.kind === 'layer'
          ? (entity as import('@runtime').Layer).groupId
          : (entity as import('@runtime').LayerGroup).parentId;
        const step = e.shiftKey ? 10 : 1;
        const move = (dx: number, dy: number) => {
          e.preventDefault();
          const state = useEditor.getState();
          const effective = effectiveTransform(t, entity.transform, sel, state.playhead, state.activeDirectorId);
          const parentMatrix = ancestorMatrix(
            t,
            parentId,
            (group) => effectiveTransform(
              t,
              group.transform,
              { kind: 'group', id: group.id },
              state.playhead,
              state.activeDirectorId,
            ),
          );
          const localDelta = canvasDeltaToParent(parentMatrix, { x: dx, y: dy });
          state.updateTransform(
            sel.id,
            { x: effective.x + localDelta.x, y: effective.y + localDelta.y },
            sel.kind,
          );
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

  function beginTreeResize(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    treeResizeRef.current = { startX: e.clientX, startWidth: treeWidth, nextWidth: treeWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function resizeTree(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    const drag = treeResizeRef.current;
    if (!drag) return;
    const width = nextSize(drag.startWidth, e.clientX - drag.startX, TREE_WIDTH);
    drag.nextWidth = width;
    setTreeWidth(width);
  }

  function endTreeResize(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    const drag = treeResizeRef.current;
    if (!drag) return;
    treeResizeRef.current = null;
    persistPanelWidth(TREE_WIDTH, drag.nextWidth);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  function cancelTreeResize(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    const drag = treeResizeRef.current;
    treeResizeRef.current = null;
    if (drag) setTreeWidth(drag.startWidth);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  function beginInspectorResize(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    inspectorResizeRef.current = {
      startX: e.clientX,
      startWidth: inspectorWidth,
      nextWidth: inspectorWidth,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function resizeInspector(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    const drag = inspectorResizeRef.current;
    if (!drag) return;
    const width = nextSize(drag.startWidth, drag.startX - e.clientX, INSPECTOR_WIDTH);
    drag.nextWidth = width;
    setInspectorWidth(width);
  }

  function endInspectorResize(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    const drag = inspectorResizeRef.current;
    if (!drag) return;
    inspectorResizeRef.current = null;
    persistPanelWidth(INSPECTOR_WIDTH, drag.nextWidth);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  function cancelInspectorResize(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    const drag = inspectorResizeRef.current;
    inspectorResizeRef.current = null;
    if (drag) setInspectorWidth(drag.startWidth);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  function resizePanelFromKeyboard(
    e: ReactKeyboardEvent<HTMLDivElement>,
    width: number,
    setWidth: (value: number) => void,
    preference: PanelWidthPreference,
    reverseArrows = false,
  ) {
    const step = e.shiftKey ? 40 : 10;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') {
      next = nextSize(width, reverseArrows ? step : -step, preference);
    } else if (e.key === 'ArrowRight') {
      next = nextSize(width, reverseArrows ? -step : step, preference);
    } else if (e.key === 'Home') {
      next = preference.min;
    } else if (e.key === 'End') {
      next = preference.max;
    }
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    setWidth(next);
    persistPanelWidth(preference, next);
  }

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
          className="shrink-0 border-r border-border bg-surface"
          style={{ width: treeWidth, flexBasis: treeWidth }}
        >
          <LayersPanel />
        </aside>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize Tree panel"
          aria-valuemin={TREE_WIDTH.min}
          aria-valuemax={TREE_WIDTH.max}
          aria-valuenow={treeWidth}
          tabIndex={0}
          data-chrome-control
          className="relative z-sticky -mx-1 w-2 shrink-0 touch-none cursor-col-resize transition-colors hover:bg-primary/30 focus-visible:bg-primary/30 focus-visible:outline-none"
          onPointerDown={beginTreeResize}
          onPointerMove={resizeTree}
          onPointerUp={endTreeResize}
          onPointerCancel={cancelTreeResize}
          onKeyDown={(e) => resizePanelFromKeyboard(e, treeWidth, setTreeWidth, TREE_WIDTH)}
        />

        <div className="flex min-w-[200px] flex-1 flex-col">
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

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize inspector panel"
          aria-valuemin={INSPECTOR_WIDTH.min}
          aria-valuemax={INSPECTOR_WIDTH.max}
          aria-valuenow={inspectorWidth}
          tabIndex={0}
          data-chrome-control
          className="relative z-sticky -mx-1 w-2 shrink-0 touch-none cursor-col-resize transition-colors hover:bg-primary/30 focus-visible:bg-primary/30 focus-visible:outline-none"
          onPointerDown={beginInspectorResize}
          onPointerMove={resizeInspector}
          onPointerUp={endInspectorResize}
          onPointerCancel={cancelInspectorResize}
          onKeyDown={(e) => {
            resizePanelFromKeyboard(e, inspectorWidth, setInspectorWidth, INSPECTOR_WIDTH, true);
          }}
        />

        <aside
          className="flex shrink-0 flex-col border-l border-border bg-surface"
          style={{ width: inspectorWidth, flexBasis: inspectorWidth }}
        >
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
            {tab === 'properties' ? <PropertiesPanel /> : tab === 'data' ? <DataPanel /> : <VariablesPanel />}
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
