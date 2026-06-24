// runtime/src/domRenderer.ts
//
// class TemplateRenderer — renders one Template into a DOM \`#stage\` container and
// drives its timeline (DEVELOPMENT_PROMPT §6.3).
//
// This is the single implementation of template rendering, used by:
//   - the engine channel page (bg_engine CEF OSR host)
//   - the editor canvas preview (WYSIWYG = air output)
//   - thumbnails
//
// Two playback modes (DEVELOPMENT_PROMPT §6.3):
//   - 'fixed' : the channel ticks us at a fixed rate (engine fps, 50 Hz). We
//               advance the playhead by exactly one frame per tick — deterministic,
//               independent of wall-clock rAF rate. Used by the engine.
//   - 'raf'   : requestAnimationFrame drives the playhead, mapping wall-clock to
//               frames. Used by the editor preview / browser output.
//
// Masks (§6.5): clip-path on a single compositing layer per mask wrapper, no
// filter chains / backdrop-filter. Alpha: native CSS opacity + transparent canvas.

import type {
  Template, Layer, LayerGroup, AnimatableValues,
} from './schema.js';
import { resolveBinding } from './schema.js';
import { applyTransform, blendModeCss, opacityCss, type AppliedTransform } from './transform.js';
import { computeStackOrder, groupMap, type FlatEntry } from './stackOrder.js';
import { normalizeTimeline, sampleAt, actionsCrossed, type NormalizedTimeline, type TimelineSample } from './timeline.js';
import { formatClock } from './clock.js';
import { ensureFonts, collectFonts } from './fonts.js';

export interface TemplateRendererOptions {
  /** fixed: caller drives tick(fixedTickRate); raf: internal rAF loop. */
  playbackMode?: 'fixed' | 'raf';
  /** tick rate when mode='fixed' (channel fps). */
  fixedTickRate?: number;
}

/** Per-frame callback during timeline playback (e.g. for stats). */
export type OnFrameFn = (info: { frame: number; fps: number }) => void;

interface LayerNode {
  el: HTMLElement;
  /** child element for text/clock content (so we can update text without re-layout). */
  contentEl?: HTMLElement;
  layer: Layer;
}

const NO_VARS: Record<string, string | number> = {};

export class TemplateRenderer {
  private stage: HTMLElement;
  private root: HTMLElement;          // the canvas-sized container inside stage
  private template: Template | null = null;
  private variables: Record<string, string | number> = NO_VARS;

  // DOM bookkeeping
  private layerEls = new Map<string, LayerNode>();
  private groupEls = new Map<string, HTMLElement>();
  private norm: NormalizedTimeline | null = null;

  // Playback state
  private mode: 'fixed' | 'raf';
  private fixedTickRate: number;
  private playing = false;
  private frame = 0;                  // global playhead (frames)
  private lastFrameSampled: number | null = null;
  private rafId: number | null = null;
  private rafLastWall: number | null = null;
  private onFrame: OnFrameFn | null = null;
  private clockTimer: number | null = null;

  constructor(stage: HTMLElement, opts: TemplateRendererOptions = {}) {
    this.stage = stage;
    this.mode = opts.playbackMode ?? 'raf';
    this.fixedTickRate = opts.fixedTickRate ?? 50;

    // Canvas-sized container; the stage may be larger (letterboxed) so we center.
    this.root = document.createElement('div');
    this.root.className = 'titulus-root';
    Object.assign(this.root.style, {
      position: 'absolute', left: '0', top: '0', transformOrigin: '0 0',
    } as Partial<CSSStyleDeclaration>);
    this.stage.appendChild(this.root);
  }

  /**
   * Sync the renderer to a template + variable values. Diffs the DOM: creates,
   * updates, or removes layer/group elements to match. Rebuilds the timeline
   * normalization. Safe to call repeatedly (live take/update).
   */
  syncTemplate(template: Template, variables: Record<string, string | number> = NO_VARS): void {
    this.template = template;
    this.variables = variables;
    this.norm = normalizeTimeline(template.timeline);

    // Size the canvas container.
    this.root.style.width = `${template.canvas.width}px`;
    this.root.style.height = `${template.canvas.height}px`;
    this.root.style.background =
      template.canvas.background === 'transparent' ? 'transparent' : template.canvas.background;

    this.buildDom();
    this.applyState(this.frame);

    // Re-trigger font load for any new text/clock layers, then re-sync so text
    // measures with the real font.
    const fonts = collectFonts(template.layers);
    if (fonts.length) {
      ensureFonts(fonts).then(() => this.applyState(this.frame)).catch(() => {});
    }
  }

  /**
   * Play the timeline from the current frame. In 'fixed' mode the caller must
   * drive tick(); in 'raf' mode we start a requestAnimationFrame loop that maps
   * wall-clock -> frames at the template fps.
   */
  playTimeline(
    template: Template,
    variables: Record<string, string | number> = NO_VARS,
    opts: { onFrame?: OnFrameFn } = {},
  ): void {
    this.syncTemplate(template, variables);
    this.onFrame = opts.onFrame ?? null;
    this.playing = true;
    this.lastFrameSampled = null;
    if (this.mode === 'raf') this.startRaf();
    this.startClockTicker();
  }

  /** Stop timeline playback (freeze at the current frame). */
  stopTimeline(): void {
    this.playing = false;
    this.stopRaf();
    this.stopClockTicker();
  }

  /**
   * Advance exactly one frame. Engine mode ('fixed') only. Called by the host
   * at the channel fps (DEVELOPMENT_PROMPT §6.3 fixed-step tick).
   */
  tick(): void {
    if (!this.playing || this.mode !== 'fixed') return;
    this.frame += 1;
    this.applyState(this.frame, this.fixedTickRate);
  }

  /** Resize the canvas (editor zoom / output size). Re-applies the root transform. */
  resize(width: number, height: number): void {
    // Letterbox/scale the canvas-sized root to fit the stage.
    const sx = width / (this.template?.canvas.width || width);
    const sy = height / (this.template?.canvas.height || height);
    this.root.style.transform = `scale(${sx}, ${sy})`;
  }

  destroy(): void {
    this.stopTimeline();
    this.layerEls.clear();
    this.groupEls.clear();
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
  }

  // -----------------------------------------------------------------------
  // DOM construction
  // -----------------------------------------------------------------------

  private buildDom(): void {
    if (!this.template) return;
    const t = this.template;
    const seen = new Set<string>();

    const groups = groupMap(t.groups);
    const order = computeStackOrder(t);

    // Groups first (they are positioning contexts for their children).
    for (const g of t.groups) {
      seen.add(g.id);
      let el = this.groupEls.get(g.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'titulus-group';
        el.dataset.groupId = g.id;
        Object.assign(el.style, {
          position: 'absolute', left: '0', top: '0', transformOrigin: '0 0',
        } as Partial<CSSStyleDeclaration>);
        this.groupEls.set(g.id, el);
      }
      el.style.display = g.visible ? 'block' : 'none';
      this.root.appendChild(el); // appendChild reorders to end if already present
    }

    // Layers.
    for (const layer of t.layers) {
      seen.add(layer.id);
      this.ensureLayerNode(layer);
    }

    // Assign z-index + parent according to the flattened stack order.
    for (const e of order) {
      if (e.kind === 'layer') {
        const node = this.layerEls.get(e.id);
        if (node) {
          node.el.style.zIndex = String(e.z);
          this.parentFor(e).appendChild(node.el);
        }
      } else {
        const el = this.groupEls.get(e.id);
        if (el) {
          el.style.zIndex = String(e.z);
          this.parentFor({ ...e, kind: 'group' } as FlatEntry).appendChild(el);
        }
      }
    }

    // Remove stale elements (layers/groups no longer in the template).
    for (const [id, node] of this.layerEls) {
      if (!seen.has(id)) { node.el.remove(); this.layerEls.delete(id); }
    }
    for (const [id, el] of this.groupEls) {
      if (!seen.has(id)) { el.remove(); this.groupEls.delete(id); }
    }
    void groups;
  }

  /** Resolve which container a stack entry renders into (root or its group parent). */
  private parentFor(e: FlatEntry): HTMLElement {
    if (e.ancestorGroups.length === 0) return this.root;
    const gid = e.ancestorGroups[e.ancestorGroups.length - 1];
    return this.groupEls.get(gid) ?? this.root;
  }

  private ensureLayerNode(layer: Layer): LayerNode {
    let node = this.layerEls.get(layer.id);
    if (!node) {
      const built = this.createLayerElement(layer);
      node = { el: built.el, contentEl: built.contentEl, layer };
      this.layerEls.set(layer.id, node);
    } else {
      // Type change? Recreate the element.
      if (node.layer.type !== layer.type) {
        node.el.remove();
        const built = this.createLayerElement(layer);
        node = { el: built.el, contentEl: built.contentEl, layer };
        this.layerEls.set(layer.id, node);
      } else {
        node.layer = layer;
      }
    }
    return node;
  }

  /** Build the layer wrapper element + optional content child. Does NOT touch the map. */
  private createLayerElement(layer: Layer): { el: HTMLElement; contentEl?: HTMLElement } {
    const el = document.createElement('div');
    el.className = `titulus-layer titulus-${layer.type}`;
    el.dataset.layerId = layer.id;
    Object.assign(el.style, {
      position: 'absolute', left: '0', top: '0', boxSizing: 'border-box',
    } as Partial<CSSStyleDeclaration>);

    // Per-type inner content. For text/clock we keep a content child so we can
    // update text without touching the transform wrapper.
    let contentEl: HTMLElement | undefined;
    switch (layer.type) {
      case 'text':
      case 'clock': {
        contentEl = document.createElement('div');
        contentEl.className = 'titulus-text-content';
        contentEl.style.width = '100%';
        contentEl.style.height = '100%';
        contentEl.style.display = 'flex';
        el.appendChild(contentEl);
        break;
      }
      case 'image':
      case 'video': {
        const media = document.createElement(layer.type === 'image' ? 'img' : 'video');
        media.style.width = '100%';
        media.style.height = '100%';
        media.style.display = 'block';
        if (layer.type === 'video') {
          (media as HTMLVideoElement).muted = true;
          (media as HTMLVideoElement).playsInline = true;
          // autoplay/loop handled in applyLayerState when src resolves
        }
        contentEl = media as HTMLElement;
        el.appendChild(media);
        break;
      }
      case 'rect':
      case 'mask':
        // No child; styling applied directly.
        break;
    }
    return { el, contentEl };
  }

  // -----------------------------------------------------------------------
  // Per-frame state application
  // -----------------------------------------------------------------------

  private applyState(frame: number, tickFps?: number): void {
    if (!this.template || !this.norm) return;
    const sample: TimelineSample = sampleAt(this.norm, frame);

    // Fire actions crossed since the last sampled frame (cue points).
    if (this.lastFrameSampled !== null && frame > this.lastFrameSampled) {
      for (const d of this.norm.directorList) {
        const acts = actionsCrossed(this.norm, d.id, this.lastFrameSampled, frame);
        this.runActions(acts);
      }
    }
    this.lastFrameSampled = frame;

    // Apply animated overrides per layer/group.
    for (const layer of this.template.layers) {
      const anim = sample.layers[layer.id];
      this.applyLayerState(layer, anim);
    }
    for (const g of this.template.groups) {
      const anim = sample.groups[g.id];
      this.applyGroupState(g, anim);
    }

    if (this.onFrame) {
      this.onFrame({ frame, fps: tickFps ?? this.template.timeline.fps });
    }
  }

  private runActions(acts: import('./schema.js').TimelineAction[]): void {
    // Actions (startDirector/stopDirector/setTag) are runtime signals to the
    // host (e.g. 'End scene' -> clear). For the renderer itself, startDirector/
    // stopDirector would toggle a director's active window — out of scope for the
    // MVP renderer loop (directors are time-windowed by offset/duration), so we
    // expose them via an optional hook (onFrame host can inspect). setTag 'Stop'
    // could halt playback; left to the host for now.
    void acts;
  }

  private applyLayerState(layer: Layer, anim: AnimatableValues | undefined): void {
    const node = this.layerEls.get(layer.id);
    if (!node) return;
    const el = node.el;

    el.style.display = layer.visible ? 'block' : 'none';
    el.style.opacity = opacityCss(anim?.opacity ?? layer.opacity);
    el.style.mixBlendMode = blendModeCss(layer.blendMode) as CSSStyleDeclaration['mixBlendMode'];

    const at: AppliedTransform = applyTransform(layer.transform, anim as Partial<import('./schema.js').Transform> | undefined);
    el.style.left = `${at.left}px`;
    el.style.top = `${at.top}px`;
    el.style.width = `${at.width}px`;
    el.style.height = `${at.height}px`;
    el.style.transformOrigin = `${at.originX}px ${at.originY}px`;
    el.style.transform = at.transform;

    this.paintLayerContent(layer, node);
  }

  private applyGroupState(group: LayerGroup, anim: AnimatableValues | undefined): void {
    const el = this.groupEls.get(group.id);
    if (!el) return;
    el.style.display = group.visible ? 'block' : 'none';
    const at = applyTransform(group.transform, anim as Partial<import('./schema.js').Transform> | undefined);
    el.style.transformOrigin = `${at.originX}px ${at.originY}px`;
    el.style.transform = at.transform;
  }

  /** Paint the type-specific content (text/media/fill/mask) for a layer. */
  private paintLayerContent(layer: Layer, node: LayerNode): void {
    const el = node.el;
    const v = this.variables;
    switch (layer.type) {
      case 'rect':
      case 'mask': {
        const fill = String(resolveBinding(layer.fill, v));
        el.style.background = fill;
        el.style.borderRadius = `${layer.cornerRadius}px`;
        if (layer.borderWidth > 0) {
          el.style.border = `${layer.borderWidth}px solid ${layer.borderColor}`;
        } else {
          el.style.border = 'none';
        }
        if (layer.type === 'mask') {
          // §6.5: clip-path on this layer's box. For 'rect' shape use inset();
          // for 'ellipse' use ellipse(). Inverted mask = clip everything outside.
          const inset = `0 0 0 0 round ${layer.cornerRadius}px`;
          if (layer.shape === 'ellipse') {
            el.style.clipPath = layer.maskMode === 'inverted'
              ? `polygon(0 0, 100% 0, 100% 100%, 0 100%)` // inverted ellipse approximated by excluding center — kept simple for MVP
              : `ellipse(50% 50% at 50% 50%)`;
          } else {
            // rect: clip via overflow:hidden wrapper semantics; for MVP a mask
            // layer of shape rect uses inset(0). Inverted rect = outside is shown.
            el.style.clipPath = layer.maskMode === 'inverted' ? 'none' : `inset(${inset})`;
          }
          el.style.background = layer.maskMode === 'inverted' ? 'transparent' : fill;
        }
        break;
      }
      case 'text':
      case 'clock': {
        const content = node.contentEl as HTMLElement;
        const s = layer.style;
        content.style.fontFamily = `"${s.fontFamily}", system-ui, sans-serif`;
        content.style.fontSize = `${s.fontSize}px`;
        content.style.fontWeight = s.fontWeight;
        content.style.color = String(resolveBinding(s.fill, v));
        content.style.textAlign = s.align;
        content.style.justifyContent =
          s.align === 'left' ? 'flex-start' : s.align === 'right' ? 'flex-end' : 'center';
        content.style.alignItems = 'center';
        content.style.lineHeight = String(s.lineHeight);
        content.style.letterSpacing = `${s.letterSpacing}px`;
        content.style.whiteSpace = 'pre';
        if (s.strokeWidth > 0) {
          const stroke = s.strokeColor;
          content.style.webkitTextStroke = `${s.strokeWidth}px ${stroke}`;
        } else {
          content.style.webkitTextStroke = '';
        }
        content.style.textShadow = s.dropShadow
          ? `${0}px ${s.dropShadowDistance}px ${s.dropShadowBlur}px ${s.dropShadowColor}`
          : '';
        if (layer.type === 'text') {
          content.textContent = String(resolveBinding(layer.content, v));
        } else {
          // clock content is refreshed by the clock ticker; set an initial value.
          content.textContent = formatClock(layer.format, layer.mode, Date.now(),
            { startTime: layer.startTime, targetTime: layer.targetTime });
        }
        break;
      }
      case 'image': {
        const img = node.contentEl as HTMLImageElement;
        const src = String(resolveBinding(layer.src, v));
        if (img.src !== src) img.src = src;
        img.style.borderRadius = `${layer.cornerRadius}px`;
        img.style.objectFit = layer.fit;
        break;
      }
      case 'video': {
        const vid = node.contentEl as HTMLVideoElement;
        const src = String(resolveBinding(layer.src, v));
        if (vid.src !== src) {
          vid.src = src;
          vid.loop = layer.loop;
          if (layer.loop) vid.play().catch(() => {});
        }
        vid.style.objectFit = layer.fit;
        break;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Clock ticker (updates clock layers every second independent of timeline)
  // -----------------------------------------------------------------------

  private startClockTicker(): void {
    this.stopClockTicker();
    if (typeof window === 'undefined') return;
    this.clockTimer = window.setInterval(() => {
      if (!this.template) return;
      const hasClock = this.template.layers.some((l) => l.type === 'clock');
      if (!hasClock) return;
      for (const layer of this.template.layers) {
        if (layer.type !== 'clock') continue;
        const node = this.layerEls.get(layer.id);
        if (node?.contentEl) {
          node.contentEl.textContent = formatClock(layer.format, layer.mode, Date.now(),
            { startTime: layer.startTime, targetTime: layer.targetTime });
        }
      }
    }, 1000) as unknown as number;
  }

  private stopClockTicker(): void {
    if (this.clockTimer !== null && typeof window !== 'undefined') {
      window.clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // rAF loop (editor / browser preview mode)
  // -----------------------------------------------------------------------

  private startRaf(): void {
    this.stopRaf();
    this.rafLastWall = null;
    const loop = (wall: number) => {
      if (!this.playing) return;
      if (this.rafLastWall !== null && this.template) {
        const fps = this.template.timeline.fps;
        const dt = wall - this.rafLastWall; // ms
        const frames = Math.round((dt / 1000) * fps);
        if (frames > 0) {
          this.frame += frames;
          this.applyState(this.frame);
        }
      }
      this.rafLastWall = wall;
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private stopRaf(): void {
    if (this.rafId !== null && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}
