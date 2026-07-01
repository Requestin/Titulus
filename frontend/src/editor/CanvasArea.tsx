// frontend/src/editor/CanvasArea.tsx
//
// WYSIWYG canvas. Renders the editable template with the SAME @runtime
// TemplateRenderer that drives air output, then overlays selection + drag/resize
// handles. Live drag manipulates the DOM directly and commits one undoable
// transform on pointer-up (so a drag is a single history step).

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { TemplateRenderer, resolveVariableMap, applyTransform, projectMaskOutline, type Transform } from '@runtime';
import { useEditor } from './store';
import { effectiveTransform } from './effectiveValues';

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
type DragMode = 'move' | Handle;

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
  mode: DragMode;
  startPX: number;
  startPY: number;
  start: Pick<Transform, 'x' | 'y' | 'width' | 'height'>;
  el: HTMLElement | null;
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

function computeDrag(
  mode: DragMode,
  start: DragState['start'],
  dx: number,
  dy: number,
): Pick<Transform, 'x' | 'y' | 'width' | 'height'> {
  let { x, y, width, height } = start;
  if (mode === 'move') {
    return { x: x + dx, y: y + dy, width, height };
  }
  if (mode.includes('e')) width = start.width + dx;
  if (mode.includes('s')) height = start.height + dy;
  if (mode.includes('w')) { x = start.x + dx; width = start.width - dx; }
  if (mode.includes('n')) { y = start.y + dy; height = start.height - dy; }
  width = Math.max(8, width);
  height = Math.max(8, height);
  return { x, y, width, height };
}

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
    };
  }, []);

  const cw = template?.canvas.width ?? 1920;
  const ch = template?.canvas.height ?? 1080;

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
    recomputeBox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template, zoom, cw, ch]);

  useLayoutEffect(() => {
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
    if (!template) return;
    const target = e.target as HTMLElement;
    const sel = useEditor.getState().selection;

    let id: string | null = null;
    let mode: DragMode = 'move';

    const handleEl = target.closest('[data-handle]') as HTMLElement | null;
    if (handleEl && sel?.kind === 'layer') {
      mode = handleEl.dataset.handle as Handle;
      id = sel.id;
    } else if (target.closest('[data-overlay-move]') && sel?.kind === 'layer') {
      id = sel.id;
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

    const layer = template.layers.find((l) => l.id === id);
    if (!layer || layer.locked) return;

    dragRef.current = {
      id,
      mode,
      startPX: e.clientX,
      startPY: e.clientY,
      start: {
        x: layer.transform.x,
        y: layer.transform.y,
        width: layer.transform.width,
        height: layer.transform.height,
      },
      el: stageRef.current?.querySelector(`[data-layer-id="${id}"]`) as HTMLElement | null,
      moved: false,
    };
    wrapRef.current?.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    // Ignore sub-pixel jitter so a select-click never moves the layer.
    if (!d.moved && Math.hypot(e.clientX - d.startPX, e.clientY - d.startPY) < 3) return;
    d.moved = true;
    const dx = (e.clientX - d.startPX) / zoom;
    const dy = (e.clientY - d.startPY) / zoom;
    const layer = template?.layers.find((l) => l.id === d.id);
    const partial = computeDrag(d.mode, d.start, dx, dy);
    if (d.el && layer) {
      const at = applyTransform({ ...layer.transform, ...partial }, undefined);
      d.el.style.left = `${at.left}px`;
      d.el.style.top = `${at.top}px`;
      d.el.style.width = `${at.width}px`;
      d.el.style.height = `${at.height}px`;
      const next = overlayForTransform(layer.id, { ...layer.transform, ...partial });
      if (next) setOverlay(next);
    }
  }

  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    wrapRef.current?.releasePointerCapture(e.pointerId);
    if (!d.moved) return; // pure select-click: no transform commit
    const dx = (e.clientX - d.startPX) / zoom;
    const dy = (e.clientY - d.startPY) / zoom;
    let t = computeDrag(d.mode, d.start, dx, dy);
    if (gridSnap) {
      const snap = (n: number) => Math.round(n / gridSize) * gridSize;
      t = { x: snap(t.x), y: snap(t.y), width: snap(t.width), height: snap(t.height) };
    }
    updateTransform(d.id, t);
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
