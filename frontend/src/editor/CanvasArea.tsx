// frontend/src/editor/CanvasArea.tsx
//
// WYSIWYG canvas. Renders the editable template with the SAME @runtime
// TemplateRenderer that drives air output, then overlays selection + drag/resize
// handles. Live drag uses TemplateRenderer's temporary preview path and commits
// one undoable transform on pointer-up (so a drag is a single history step).

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { TemplateRenderer, resolveVariableMap, applyTransform, projectMaskOutline, type Transform } from '@runtime';
import { useEditor } from './store';
import { effectiveTransform } from './effectiveValues';
import { clearGesturePreview, scheduleGesturePreview } from './gesturePreview';
import { derivedGroupBox } from './groupBounds';
import {
  ancestorMatrix, canvasDeltaToParent, dragTransform, type AffineMatrix, type DragMode,
} from './transformMath';

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

type SelectionOverlay =
  | { kind: 'box'; box: Box }
  | { kind: 'polygon'; box: Box; points: Array<{ x: number; y: number }> };

interface DragState {
  id: string;
  kind: 'layer' | 'group';
  mode: DragMode;
  startPX: number;
  startPY: number;
  start: Transform;
  parentMatrix: AffineMatrix;
  preview: Transform;
  moved: boolean;
}

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const HANDLE_CURSOR: Record<Handle, string> = {
  n: 'cursor-ns-resize', s: 'cursor-ns-resize',
  e: 'cursor-ew-resize', w: 'cursor-ew-resize',
  ne: 'cursor-nesw-resize', sw: 'cursor-nesw-resize',
  nw: 'cursor-nwse-resize', se: 'cursor-nwse-resize',
};

const HANDLE_POS: Record<Handle, string> = {
  nw: 'left-0 top-0 -translate-x-1/2 -translate-y-1/2',
  n: 'left-1/2 top-0 -translate-x-1/2 -translate-y-1/2',
  ne: 'right-0 top-0 translate-x-1/2 -translate-y-1/2',
  e: 'right-0 top-1/2 translate-x-1/2 -translate-y-1/2',
  se: 'right-0 bottom-0 translate-x-1/2 translate-y-1/2',
  s: 'left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2',
  sw: 'left-0 bottom-0 -translate-x-1/2 translate-y-1/2',
  w: 'left-0 top-1/2 -translate-x-1/2 -translate-y-1/2',
};

export function CanvasArea() {
  const template = useEditor((s) => s.template);
  const selection = useEditor((s) => s.selection);
  const zoom = useEditor((s) => s.zoom);
  const gridSnap = useEditor((s) => s.gridSnap);
  const gridSize = useEditor((s) => s.gridSize);
  const playhead = useEditor((s) => s.playhead);
  const playing = useEditor((s) => s.playing);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const setPlaying = useEditor((s) => s.setPlaying);
  const select = useEditor((s) => s.select);
  const updateTransform = useEditor((s) => s.updateTransform);

  function globalFrame(local: number): number {
    const st = useEditor.getState();
    const d = st.template?.timeline.directors.find((x) => x.id === st.activeDirectorId);
    return (d?.offsetFrames ?? 0) + local;
  }

  const stageRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<TemplateRenderer | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [overlay, setOverlay] = useState<SelectionOverlay | null>(null);

  // Renderer lifecycle (static preview: syncTemplate only, no timeline rAF).
  // useLayoutEffect (not useEffect) so the renderer exists before the sync
  // layout effect below runs on first mount.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const r = new TemplateRenderer(stage, { playbackMode: 'raf' });
    rendererRef.current = r;
    return () => {
      r.destroy();
      rendererRef.current = null;
      clearGesturePreview();
    };
  }, []);

  const cw = template?.canvas.width ?? 1920;
  const ch = template?.canvas.height ?? 1080;


  function resolveLiveTransform(kind: 'layer' | 'group', id: string, preview?: Transform): Transform | null {
    const st = useEditor.getState();
    const tpl = st.template;
    if (!tpl) return null;
    if (preview && id === (dragRef.current?.id) && dragRef.current?.kind === kind) return preview;
    if (kind === 'layer') {
      const layer = tpl.layers.find((item) => item.id === id);
      if (!layer) return null;
      return effectiveTransform(tpl, layer.transform, { kind: 'layer', id }, st.playhead, st.activeDirectorId);
    }
    const group = tpl.groups.find((item) => item.id === id);
    if (!group) return null;
    return effectiveTransform(tpl, group.transform, { kind: 'group', id }, st.playhead, st.activeDirectorId);
  }

  function overlayForGroup(groupId: string, preview?: Transform): SelectionOverlay | null {
    const tpl = useEditor.getState().template;
    if (!tpl) return null;
    const box = derivedGroupBox(
      tpl,
      groupId,
      (id) => resolveLiveTransform('layer', id) ?? tpl.layers.find((item) => item.id === id)!.transform,
      (id) => (preview && id === groupId
        ? preview
        : (resolveLiveTransform('group', id) ?? tpl.groups.find((item) => item.id === id)!.transform)),
    );
    if (!box) return null;
    return {
      kind: 'box',
      box: { left: box.x * zoom, top: box.y * zoom, width: box.width * zoom, height: box.height * zoom },
    };
  }

  function overlayForTransform(layerId: string, transform: Transform): SelectionOverlay | null {
    const tpl = useEditor.getState().template;
    if (!tpl) return null;
    const layer = tpl.layers.find((l) => l.id === layerId);
    if (!layer) return null;

    if (layer.type === 'mask') {
      const at = applyTransform(transform, undefined);
      const outline = projectMaskOutline(
        { maskMode: layer.maskMode, shape: layer.shape, cornerRadius: layer.cornerRadius },
        transform,
        at,
      );
      const scaled = outline.map((p) => ({ x: p.x * zoom, y: p.y * zoom }));
      const xs = scaled.map((p) => p.x);
      const ys = scaled.map((p) => p.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const maxX = Math.max(...xs);
      const maxY = Math.max(...ys);
      return {
        kind: 'polygon',
        box: { left: minX, top: minY, width: maxX - minX, height: maxY - minY },
        points: scaled,
      };
    }

    const at = applyTransform(transform, undefined);
    return {
      kind: 'box',
      box: { left: at.left * zoom, top: at.top * zoom, width: at.width * zoom, height: at.height * zoom },
    };
  }

  function recomputeBox() {
    const stage = stageRef.current;
    const st = useEditor.getState();
    const sel = st.selection;
    const tpl = st.template;
    if (!stage || !sel || !tpl) {
      setOverlay(null);
      return;
    }

    if (sel.kind === 'group') {
      setOverlay(overlayForGroup(sel.id));
      return;
    }

    if (sel.kind === 'layer') {
      const layer = tpl.layers.find((l) => l.id === sel.id);
      if (layer?.type === 'mask') {
        const t = effectiveTransform(
          tpl,
          layer.transform,
          { kind: 'layer', id: layer.id },
          st.playhead,
          st.activeDirectorId,
        );
        setOverlay(overlayForTransform(layer.id, t));
        return;
      }
    }

    const el = stage.querySelector(`[data-${sel.kind}-id="${sel.id}"]`) as HTMLElement | null;
    if (!el) {
      setOverlay(null);
      return;
    }
    const r = el.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    setOverlay({
      kind: 'box',
      box: { left: r.left - sr.left, top: r.top - sr.top, width: r.width, height: r.height },
    });
  }

  useLayoutEffect(() => {
    const r = rendererRef.current;
    if (!r || !template) return;
    r.syncTemplate(template, resolveVariableMap(template));
    r.resize(cw * zoom, ch * zoom);
    r.seek(globalFrame(useEditor.getState().playhead));
    clearGesturePreview();
    recomputeBox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template, zoom, cw, ch]);

  useLayoutEffect(() => {
    clearGesturePreview();
    recomputeBox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);

  // Scrub: seek when the playhead changes and we're not actively playing.
  useLayoutEffect(() => {
    const r = rendererRef.current;
    if (!r || playing) return;
    r.seek(globalFrame(playhead));
    recomputeBox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playhead, playing]);

  // Playback: advance the playhead at fps, seek each frame (WYSIWYG preview).
  useEffect(() => {
    if (!playing) return;
    const r = rendererRef.current;
    const t = useEditor.getState().template;
    if (!r || !t) return;
    const dir = t.timeline.directors.find((d) => d.id === useEditor.getState().activeDirectorId);
    const fps = t.timeline.fps || 50;
    const dur = dir?.durationFrames ?? t.timeline.durationFrames;
    const offset = dir?.offsetFrames ?? 0;
    let local = useEditor.getState().playhead;
    let last = performance.now();
    let raf = 0;
    const loop = (now: number) => {
      local += ((now - last) / 1000) * fps;
      last = now;
      if (local >= dur) {
        if (dir?.loop) {
          local %= dur;
        } else {
          r.seek(offset + dur);
          setPlayhead(dur);
          setPlaying(false);
          return;
        }
      }
      r.seek(offset + local);
      setPlayhead(local);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, setPlayhead, setPlaying]);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    const currentTemplate = useEditor.getState().template;
    if (!currentTemplate) return;
    const target = e.target as HTMLElement;
    const sel = useEditor.getState().selection;

    let id: string | null = null;
    let mode: DragMode = 'move';

    const handleEl = target.closest('[data-handle]') as HTMLElement | null;
    let kind: 'layer' | 'group' = 'layer';
    if (handleEl && sel?.kind === 'layer') {
      mode = handleEl.dataset.handle as Handle;
      id = sel.id;
    } else if (target.closest('[data-overlay-move]') && sel) {
      id = sel.id;
      kind = sel.kind;
      if (kind === 'group') mode = 'move';
    } else {
      const layerEl = target.closest('[data-layer-id]') as HTMLElement | null;
      if (layerEl) {
        id = layerEl.dataset.layerId ?? null;
        if (id) select({ kind: 'layer', id });
      } else {
        select(null);
        return;
      }
    }
    if (!id) return;

    const { playhead: currentPlayhead, activeDirectorId } = useEditor.getState();
    const entity = kind === 'layer'
      ? currentTemplate.layers.find((item) => item.id === id)
      : currentTemplate.groups.find((item) => item.id === id);
    if (!entity || entity.locked) return;
    const start = effectiveTransform(
      currentTemplate,
      entity.transform,
      { kind, id },
      currentPlayhead,
      activeDirectorId,
    );
    const parentId = kind === 'layer'
      ? currentTemplate.layers.find((item) => item.id === id)?.groupId ?? null
      : currentTemplate.groups.find((item) => item.id === id)?.parentId ?? null;
    const parentMatrix = ancestorMatrix(
      currentTemplate,
      parentId,
      (group) => effectiveTransform(
        currentTemplate,
        group.transform,
        { kind: 'group', id: group.id },
        currentPlayhead,
        activeDirectorId,
      ),
    );

    dragRef.current = {
      id,
      kind,
      mode,
      startPX: e.clientX,
      startPY: e.clientY,
      start,
      parentMatrix,
      preview: start,
      moved: false,
    };
    clearGesturePreview();
    wrapRef.current?.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function previewForPointer(drag: DragState, e: ReactPointerEvent<HTMLDivElement>) {
    const canvasDelta = {
      x: (e.clientX - drag.startPX) / zoom,
      y: (e.clientY - drag.startPY) / zoom,
    };
    const parentDelta = canvasDeltaToParent(drag.parentMatrix, canvasDelta);
    let partial = dragTransform(drag.mode, drag.start, parentDelta);
    if (gridSnap) {
      const snap = (value: number) => Math.round(value / gridSize) * gridSize;
      partial = {
        x: snap(partial.x),
        y: snap(partial.y),
        width: snap(partial.width),
        height: snap(partial.height),
      };
    }
    return partial;
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    // Ignore sub-pixel jitter so a select-click never moves the layer.
    if (!drag.moved && Math.hypot(e.clientX - drag.startPX, e.clientY - drag.startPY) < 3) return;
    drag.moved = true;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const partial = previewForPointer(drag, e);
    drag.preview = { ...drag.start, ...partial };
    renderer.previewLayerTransform(drag.id, drag.preview);
    scheduleGesturePreview({ id: drag.id, kind: drag.kind, transform: drag.preview });
    if (drag.kind === 'group') {
      const next = overlayForGroup(drag.id, drag.preview);
      if (next) setOverlay(next);
      return;
    }
    const layer = useEditor.getState().template?.layers.find((item) => item.id === drag.id);
    if (layer?.type === 'mask') {
      const next = overlayForTransform(drag.id, drag.preview);
      if (next) setOverlay(next);
    } else {
      recomputeBox();
    }
  }

  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    wrapRef.current?.releasePointerCapture(e.pointerId);
    if (drag.moved) updateTransform(drag.id, previewForPointer(drag, e), drag.kind);
    rendererRef.current?.clearEditorTransformPreview();
    clearGesturePreview();
  }

  function cancelDrag() {
    if (!dragRef.current) return;
    dragRef.current = null;
    rendererRef.current?.clearEditorTransformPreview();
    clearGesturePreview();
    recomputeBox();
  }

  if (!template) {
    return <div className="grid h-full place-items-center text-sm text-ink-muted">Loading…</div>;
  }

  const transparent = template.canvas.background === 'transparent';

  return (
    <div className="relative h-full w-full overflow-auto bg-bg">
      <div className="grid min-h-full w-full place-items-center p-10">
        <div
          ref={wrapRef}
          className="relative shadow-2xl"
          style={{ width: cw * zoom, height: ch * zoom }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={cancelDrag}
          onLostPointerCapture={cancelDrag}
        >
          {/* Transparency checkerboard (only when canvas bg is transparent). */}
          {transparent && (
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                backgroundColor: 'oklch(0.26 0.01 274)',
                backgroundImage:
                  'linear-gradient(45deg, oklch(0.21 0.01 274) 25%, transparent 25%), linear-gradient(-45deg, oklch(0.21 0.01 274) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, oklch(0.21 0.01 274) 75%), linear-gradient(-45deg, transparent 75%, oklch(0.21 0.01 274) 75%)',
                backgroundSize: '20px 20px',
                backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0',
              }}
            />
          )}

          {/* TemplateRenderer mounts its canvas-sized root here (scaled to zoom). */}
          <div ref={stageRef} className="absolute inset-0 overflow-hidden" />

          {/* Grid overlay (snap aid). */}
          {gridSnap && (
            <div
              className="pointer-events-none absolute inset-0 opacity-40"
              style={{
                backgroundImage:
                  'linear-gradient(to right, oklch(var(--border)) 1px, transparent 1px), linear-gradient(to bottom, oklch(var(--border)) 1px, transparent 1px)',
                backgroundSize: `${gridSize * zoom}px ${gridSize * zoom}px`,
              }}
            />
          )}

          {/* Selection overlay. */}
          {overlay && (
            <div
              className="pointer-events-none absolute"
              style={{ left: overlay.box.left, top: overlay.box.top, width: overlay.box.width, height: overlay.box.height }}
            >
              {overlay.kind === 'polygon' ? (
                <svg
                  className="pointer-events-none absolute overflow-visible"
                  width={overlay.box.width}
                  height={overlay.box.height}
                  viewBox={`0 0 ${overlay.box.width} ${overlay.box.height}`}
                >
                  <polygon
                    points={overlay.points
                      .map((p) => `${p.x - overlay.box.left},${p.y - overlay.box.top}`)
                      .join(' ')}
                    fill="none"
                    stroke="oklch(var(--primary))"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              ) : (
                <div className="absolute inset-0 border border-primary" />
              )}
              <div data-overlay-move className="pointer-events-auto absolute inset-0 cursor-move" />
              {selection?.kind === 'layer' &&
                HANDLES.map((h) => (
                  <div
                    key={h}
                    data-handle={h}
                    className={`pointer-events-auto absolute h-2.5 w-2.5 rounded-sm border border-primary bg-surface ${HANDLE_POS[h]} ${HANDLE_CURSOR[h]}`}
                  />
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
