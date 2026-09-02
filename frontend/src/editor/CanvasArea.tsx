// frontend/src/editor/CanvasArea.tsx
//
// WYSIWYG canvas. Renders the editable template with the SAME @runtime
// TemplateRenderer that drives air output, then overlays selection + drag/resize
// handles. Live drag uses TemplateRenderer's temporary preview path and commits
// one undoable transform on pointer-up (so a drag is a single history step).

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { TemplateRenderer, resolveVariableMap, applyTransform, projectMaskOutline, type Transform } from '@runtime';
import { useStore } from 'zustand';
import { useEditor } from './store';
import { effectiveTransform } from './effectiveValues';
import {
  bindPlaybackControls,
  playheadStore,
  resolveSeekLocals,
  setLivePlaying,
  setWaitingContinue,
  tickPlayhead,
  usePlayhead,
} from './playheadStore';
import { clearGesturePreview, gesturePreviewStore, scheduleGesturePreview } from './gesturePreview';
import { derivedGroupBox, layerBoxInCanvas } from './groupBounds';
import {
  ancestorMatrix, canvasDeltaToParent, dragTransform, transformPoint, type AffineMatrix, type DragMode,
} from './transformMath';

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

type SelectionOverlay =
  | { kind: 'box'; box: Box; pivot: { x: number; y: number } }
  | { kind: 'polygon'; box: Box; points: Array<{ x: number; y: number }>; pivot: { x: number; y: number } };

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
  const playhead = usePlayhead((s) => s.playhead);
  const globalPlayhead = usePlayhead((s) => s.globalPlayhead);
  const localPlayheads = usePlayhead((s) => s.localPlayheads);
  const detachedLocals = usePlayhead((s) => s.detachedLocals);
  const playing = usePlayhead((s) => s.playing);
  const playSessionId = usePlayhead((s) => s.playSessionId);
  const continueRequestId = usePlayhead((s) => s.continueRequestId);
  const setPlaying = useEditor((s) => s.setPlaying);
  const select = useEditor((s) => s.select);
  const updateTransform = useEditor((s) => s.updateTransform);

  const stageRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<TemplateRenderer | null>(null);
  const playbackStopRef = useRef<(() => void) | null>(null);
  const setPlayingRef = useRef(setPlaying);
  setPlayingRef.current = setPlaying;
  const dragRef = useRef<DragState | null>(null);
  const [overlay, setOverlay] = useState<SelectionOverlay | null>(null);
  const gesturePreview = useStore(gesturePreviewStore, (s) => s.preview);

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
    const gp = gesturePreviewStore.getState().preview;
    if (gp && gp.id === id && gp.kind === kind) return gp.transform;
    if (kind === 'layer') {
      const layer = tpl.layers.find((item) => item.id === id);
      if (!layer) return null;
      return effectiveTransform(tpl, layer.transform, { kind: 'layer', id }, playheadStore.getState().playhead, st.activeDirectorId);
    }
    const group = tpl.groups.find((item) => item.id === id);
    if (!group) return null;
    return effectiveTransform(tpl, group.transform, { kind: 'group', id }, playheadStore.getState().playhead, st.activeDirectorId);
  }

  function overlayForGroup(groupId: string, preview?: Transform): SelectionOverlay | null {
    const tpl = useEditor.getState().template;
    if (!tpl) return null;
    const pivot = preview
      ?? resolveLiveTransform('group', groupId)
      ?? tpl.groups.find((item) => item.id === groupId)?.transform;
    if (!pivot) return null;
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
      pivot: {
        x: (box.x + box.width * pivot.anchorX) * zoom,
        y: (box.y + box.height * pivot.anchorY) * zoom,
      },
    };
  }

  function overlayForTransform(layerId: string, transform: Transform): SelectionOverlay | null {
    const tpl = useEditor.getState().template;
    if (!tpl) return null;
    const layer = tpl.layers.find((l) => l.id === layerId);
    if (!layer) return null;
    const parent = ancestorMatrix(
      tpl,
      layer.groupId,
      (group) => resolveLiveTransform('group', group.id) ?? group.transform,
    );
    const origin = transformPoint(parent, { x: transform.x, y: transform.y });
    const pivot = { x: origin.x * zoom, y: origin.y * zoom };

    if (layer.type === 'mask') {
      const at = applyTransform(transform, undefined);
      const outline = projectMaskOutline(
        { maskMode: layer.maskMode, shape: layer.shape, cornerRadius: layer.cornerRadius },
        transform,
        at,
      );
      const scaled = outline.map((p) => {
        const world = transformPoint(parent, p);
        return { x: world.x * zoom, y: world.y * zoom };
      });
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
        pivot,
      };
    }

    const box = layerBoxInCanvas(transform, parent);
    return {
      kind: 'box',
      box: { left: box.x * zoom, top: box.y * zoom, width: box.width * zoom, height: box.height * zoom },
      pivot,
    };
  }

  function recomputeBox(previewTransform?: Transform) {
    const stage = stageRef.current;
    const st = useEditor.getState();
    const sel = st.selection;
    const tpl = st.template;
    if (!stage || !sel || !tpl) {
      setOverlay(null);
      return;
    }

    if (sel.kind === 'group') {
      setOverlay(overlayForGroup(sel.id, previewTransform));
      return;
    }

    if (sel.kind === 'layer') {
      const layer = tpl.layers.find((l) => l.id === sel.id);
      if (!layer) {
        setOverlay(null);
        return;
      }
      const t = previewTransform ?? effectiveTransform(
        tpl,
        layer.transform,
        { kind: 'layer', id: layer.id },
        playheadStore.getState().playhead,
        st.activeDirectorId,
      );
      // Prefer transform-derived overlay so Axis center / NumberInput preview
      // update the box and pivot without waiting on a DOM layout pass.
      setOverlay(overlayForTransform(layer.id, t));
      return;
    }

    setOverlay(null);
  }

  useLayoutEffect(() => {
    const r = rendererRef.current;
    if (!r || !template) return;
    r.syncTemplate(template, resolveVariableMap(template));
    r.resize(cw * zoom, ch * zoom);
    const st = playheadStore.getState();
    if (!st.playing) {
      const locals = resolveSeekLocals(
        template.timeline.directors,
        st.globalPlayhead,
        st.localPlayheads,
        st.detachedLocals,
      );
      if (Object.keys(st.detachedLocals).length > 0) r.seekLocals(locals);
      else r.seek(st.globalPlayhead);
    }
    clearGesturePreview();
    recomputeBox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template, zoom, cw, ch]);

  useLayoutEffect(() => {
    clearGesturePreview();
    recomputeBox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);

  // NumberInput drag preview: push into the renderer and refresh the overlay/pivot.
  useLayoutEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (gesturePreview) {
      renderer.previewLayerTransform(gesturePreview.id, gesturePreview.transform);
      recomputeBox(gesturePreview.transform);
      return;
    }
    if (!dragRef.current) {
      renderer.clearEditorTransformPreview();
      recomputeBox();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gesturePreview]);

  // Scrub: seek when playheads change and we're not actively playing.
  useLayoutEffect(() => {
    const r = rendererRef.current;
    const t = useEditor.getState().template;
    if (!r || !t || playing) return;
    const st = playheadStore.getState();
    const locals = resolveSeekLocals(
      t.timeline.directors,
      st.globalPlayhead,
      st.localPlayheads,
      st.detachedLocals,
    );
    const hasDetach = Object.keys(st.detachedLocals).length > 0;
    if (hasDetach) r.seekLocals(locals);
    else r.seek(st.globalPlayhead);
    recomputeBox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playhead, globalPlayhead, localPlayheads, detachedLocals, playing]);

  useEffect(() => {
    if (continueRequestId === 0) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.continueDirectors();
    setWaitingContinue(renderer.waitingContinue());
  }, [continueRequestId]);

  function stopPlaybackLoop() {
    playbackStopRef.current?.();
    playbackStopRef.current = null;
  }

  function startPlaybackLoop() {
    stopPlaybackLoop();
    const sessionId = playheadStore.getState().playSessionId;
    let cancelled = false;
    let raf = 0;
    let last = 0;
    let global = playheadStore.getState().globalPlayhead;

    const stop = () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    playbackStopRef.current = stop;

    rendererRef.current?.beginLivePlayback();

    const tick = (now: number, advance: boolean) => {
      if (cancelled) return;
      const live = playheadStore.getState();
      if (!live.playing || live.playSessionId !== sessionId) return;

      const renderer = rendererRef.current;
      const currentTemplate = useEditor.getState().template;
      if (!renderer || !currentTemplate) {
        raf = requestAnimationFrame((time) => tick(time, false));
        return;
      }

      const directors = currentTemplate.timeline.directors;
      const activeId = useEditor.getState().activeDirectorId;
      const director = directors.find((item) => item.id === activeId);
      const fps = currentTemplate.timeline.fps || 50;
      const offset = director?.offsetFrames ?? 0;
      const duration = Math.max(
        1,
        director?.durationFrames ?? currentTemplate.timeline.durationFrames,
      );

      if (advance && last !== 0) {
        const waiting = renderer.waitingContinue();
        const paused = renderer.hasPausedDirector();
        if (!waiting || paused) {
          global += (Math.min(now - last, 100) / 1000) * fps;
        }
      }
      last = now;
      if (global < offset) global = offset;

      if (director && !director.loop && !director.swing && global - offset >= duration) {
        if (renderer.hasDirectorRuntime()) renderer.advancePlayback(offset + duration);
        else renderer.seek(offset + duration);
        tickPlayhead(offset + duration, directors, activeId);
        setWaitingContinue(renderer.waitingContinue());
        stop();
        setLivePlaying(false);
        setPlayingRef.current(false);
        return;
      }

      if (renderer.hasDirectorRuntime()) {
        renderer.advancePlayback(Math.round(global));
        const locals: Record<string, number> = {};
        for (const item of directors) {
          locals[item.id] = renderer.localFrame(item.id) ?? 0;
        }
        playheadStore.setState({
          globalPlayhead: global,
          localPlayheads: locals,
          playhead: locals[activeId] ?? 0,
        });
      } else {
        renderer.seek(global);
        tickPlayhead(global, directors, activeId);
      }
      setWaitingContinue(renderer.waitingContinue());
      raf = requestAnimationFrame((time) => tick(time, true));
    };

    tick(performance.now(), false);
  }

  const startPlaybackLoopRef = useRef(startPlaybackLoop);
  startPlaybackLoopRef.current = startPlaybackLoop;

  useLayoutEffect(() => {
    return bindPlaybackControls({
      start: () => startPlaybackLoopRef.current(),
      stop: stopPlaybackLoop,
    });
  }, []);

  // Resume if Play won the race before Canvas bound, or after a remount.
  useLayoutEffect(() => {
    if (playing) startPlaybackLoopRef.current();
    else stopPlaybackLoop();
  }, [playing, playSessionId]);

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

    const currentPlayhead = playheadStore.getState().playhead;
    const { activeDirectorId } = useEditor.getState();
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
    const next = overlayForTransform(drag.id, drag.preview);
    if (next) setOverlay(next);
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
          {/* Axis-center crosshair at the transform pivot (x/y). */}
          {overlay && (
            <div
              className="pointer-events-none absolute z-10"
              style={{ left: overlay.pivot.x, top: overlay.pivot.y }}
              aria-hidden
            >
              <div className="absolute left-1/2 top-1/2 h-px w-2.5 -translate-x-1/2 -translate-y-1/2 bg-primary" />
              <div className="absolute left-1/2 top-1/2 h-2.5 w-px -translate-x-1/2 -translate-y-1/2 bg-primary" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
