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
import { applyTransform, blendModeCss, opacityCss, transformHas3D, type AppliedTransform } from './transform.js';
import { computeStackOrder, groupMap } from './stackOrder.js';
import { computeMaskScopes, maskClipStyle, type MaskScope } from './maskScopes.js';
import {
  maskNeedsProjection, projectMaskQuad, projectedMaskClip, maskGeometryKey,
} from './maskGeometry.js';
import type { RootStackEntry } from './schema.js';
import { normalizeTimeline, sampleAt, actionsCrossed, type NormalizedTimeline, type TimelineSample } from './timeline.js';
import { formatClock } from './clock.js';
import { ensureFonts, collectFonts } from './fonts.js';
import { type RenderStats, emptyRenderStats, snapshotStats } from './stats.js';

export interface TemplateRendererOptions {
  /** fixed: caller drives tick(fixedTickRate); raf: internal rAF loop. */
  playbackMode?: 'fixed' | 'raf';
  /** tick rate when mode='fixed' (channel fps). */
  fixedTickRate?: number;
}

/** Per-frame callback during timeline playback (e.g. for stats). */
export type OnFrameFn = (info: { frame: number; fps: number; stats?: RenderStats }) => void;

interface LayerNode {
  el: HTMLElement;
  /** child element for text/clock content (so we can update text without re-layout). */
  contentEl?: HTMLElement;
  layer: Layer;
  /** Cache of last-written property strings so we can skip identical writes. */
  cache: Record<string, string>;
}

interface GroupNode {
  el: HTMLElement;
  cache: Record<string, string>;
}

/** DOM nodes for a stack-scoped mask (маска.txt). */
interface MaskScopeNode {
  scopeEl: HTMLElement;
  clipHost: HTMLElement;
  maskLayerId: string;
  /** Parent mask when nested; clipHost position is relative to parent clip. */
  parentMaskId: string | null;
  containerId: string | null;
  cache: Record<string, string>;
  /** bounds = axis-aligned clipHost at mask rect; projected = full container + polygon */
  clipMode: 'bounds' | 'projected';
}

const NO_VARS: Record<string, string | number> = {};

export class TemplateRenderer {
  private stage: HTMLElement;
  private root: HTMLElement;          // the canvas-sized container inside stage
  private template: Template | null = null;
  private variables: Record<string, string | number> = NO_VARS;

  // DOM bookkeeping
  private layerEls = new Map<string, LayerNode>();
  private groupEls = new Map<string, GroupNode>();
  private maskScopeEls = new Map<string, MaskScopeNode>();
  /** entry id -> innermost mask layer id (for position offset inside clipHost). */
  private entryMaskOrigin = new Map<string, string>();
  private maskScopes: MaskScope[] = [];
  private norm: NormalizedTimeline | null = null;
  private rootCache: Record<string, string> = {};

  // Render stats accumulator: reset per applyState call, snapshotted into onFrame.
  private stats: RenderStats = emptyRenderStats();

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
   * Seek to an absolute frame and apply state, without playing (editor scrub /
   * preview). Does not fire cue actions (scrubbing is not a linear playthrough).
   */
  seek(frame: number): void {
    this.frame = Math.max(0, Math.round(frame));
    this.lastFrameSampled = null;
    this.applyState(this.frame);
  }

  /** Current playhead frame. */
  getFrame(): number {
    return this.frame;
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
    this.maskScopeEls.clear();
    this.entryMaskOrigin.clear();
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
  }

  /** The template currently rendered, or null. (Used by ChannelClient for live updates.) */
  getTemplate(): Template | null { return this.template; }

  /** The variable map currently applied. */
  getVariables(): Record<string, string | number> { return this.variables; }

  // -----------------------------------------------------------------------
  // DOM construction
  // -----------------------------------------------------------------------

  private buildDom(): void {
    if (!this.template) return;
    const t = this.template;
    const seen = new Set<string>();
    const seenMasks = new Set<string>();

    groupMap(t.groups);
    const order = computeStackOrder(t);
    const zById = new Map(order.map((e) => [e.id, e.z]));

    this.maskScopes = computeMaskScopes(t);
    this.entryMaskOrigin.clear();

    // Groups first (they are positioning contexts for their children).
    for (const g of t.groups) {
      seen.add(g.id);
      let node = this.groupEls.get(g.id);
      if (!node) {
        const el = document.createElement('div');
        el.className = 'titulus-group';
        el.dataset.groupId = g.id;
        Object.assign(el.style, {
          position: 'absolute', left: '0', top: '0', transformOrigin: '0 0',
        } as Partial<CSSStyleDeclaration>);
        node = { el, cache: {} };
        this.groupEls.set(g.id, node);
      }
      node.el.style.display = g.visible ? 'block' : 'none';
    }

    // Layers.
    for (const layer of t.layers) {
      seen.add(layer.id);
      this.ensureLayerNode(layer);
    }

    // Mount stack trees with mask scope wrappers (root + per-group).
    this.mountStack(this.root, null, t.rootStack, zById, seenMasks, null);

    for (const g of t.groups) {
      const node = this.groupEls.get(g.id);
      if (node) {
        const entries = t.groupStacks[g.id];
        node.el.style.zIndex = String(zById.get(g.id) ?? 1);
        this.parentForGroup(g.id).appendChild(node.el);
        this.mountStack(node.el, g.id, entries, zById, seenMasks, null);
      }
    }

    // Remove stale elements.
    for (const [id, node] of this.layerEls) {
      if (!seen.has(id)) { node.el.remove(); this.layerEls.delete(id); }
    }
    for (const [id, node] of this.groupEls) {
      if (!seen.has(id)) { node.el.remove(); this.groupEls.delete(id); }
    }
    for (const [id, node] of this.maskScopeEls) {
      if (!seenMasks.has(id)) { node.scopeEl.remove(); this.maskScopeEls.delete(id); }
    }
  }

  /**
   * Walk a stack container in order. When a mask layer is hit, mount it and put
   * all subsequent siblings into a mask scope clipHost (recursive for nested masks).
   */
  private mountStack(
    containerEl: HTMLElement,
    containerId: string | null,
    entries: RootStackEntry[] | undefined,
    zById: Map<string, number>,
    seenMasks: Set<string>,
    parentMaskId: string | null,
  ): void {
    if (!entries || !this.template) return;
    this.mountStackRange(containerEl, containerId, entries, 0, entries.length, zById, seenMasks, parentMaskId);
  }

  /** Mount a stack slice, splitting at the frontmost mask so only lower siblings are clipped. */
  private mountStackRange(
    containerEl: HTMLElement,
    containerId: string | null,
    entries: RootStackEntry[],
    start: number,
    end: number,
    zById: Map<string, number>,
    seenMasks: Set<string>,
    parentMaskId: string | null,
  ): void {
    if (!this.template) return;
    const layerById = new Map(this.template.layers.map((l) => [l.id, l]));

    let maskIndex = -1;
    for (let i = end - 1; i >= start; i--) {
      const e = entries[i];
      const layer = e.kind === 'layer' ? layerById.get(e.id) : undefined;
      if (e.kind === 'layer' && layer?.type === 'mask') {
        maskIndex = i;
        break;
      }
    }

    if (maskIndex < 0) {
      for (let i = start; i < end; i++) {
        const e = entries[i];
        if (parentMaskId) this.entryMaskOrigin.set(e.id, parentMaskId);
        this.mountEntry(e, containerEl, zById);
      }
      return;
    }

    const maskEntry = entries[maskIndex];
    const maskLayer = maskEntry.kind === 'layer' ? layerById.get(maskEntry.id) : undefined;
    if (!maskLayer || maskLayer.type !== 'mask') return;

    if (start < maskIndex) {
      const scope = this.ensureMaskScope(maskLayer.id, containerEl, containerId, parentMaskId, seenMasks);
      this.mountStackRange(scope.clipHost, containerId, entries, start, maskIndex, zById, seenMasks, maskLayer.id);
    }

    if (parentMaskId) this.entryMaskOrigin.set(maskEntry.id, parentMaskId);
    this.mountEntry(maskEntry, containerEl, zById);

    if (maskIndex + 1 < end) {
      this.mountStackRange(containerEl, containerId, entries, maskIndex + 1, end, zById, seenMasks, parentMaskId);
    }
  }

  private mountEntry(e: RootStackEntry, parent: HTMLElement, zById: Map<string, number>): void {
    if (e.kind === 'layer') {
      const node = this.layerEls.get(e.id);
      if (node) {
        node.el.style.zIndex = String(zById.get(e.id) ?? 1);
        parent.appendChild(node.el);
      }
    } else {
      const node = this.groupEls.get(e.id);
      if (node) {
        node.el.style.zIndex = String(zById.get(e.id) ?? 1);
        parent.appendChild(node.el);
      }
    }
  }

  private ensureMaskScope(
    maskLayerId: string,
    parentEl: HTMLElement,
    containerId: string | null,
    parentMaskId: string | null,
    seenMasks: Set<string>,
  ): MaskScopeNode {
    seenMasks.add(maskLayerId);
    let node = this.maskScopeEls.get(maskLayerId);
    if (!node) {
      const scopeEl = document.createElement('div');
      scopeEl.className = 'titulus-mask-scope';
      scopeEl.dataset.maskScope = maskLayerId;
      const clipHost = document.createElement('div');
      clipHost.className = 'titulus-mask-clip';
      clipHost.dataset.maskClip = maskLayerId;
      scopeEl.appendChild(clipHost);
      node = { scopeEl, clipHost, maskLayerId, parentMaskId, containerId, cache: {}, clipMode: 'bounds' };
      this.maskScopeEls.set(maskLayerId, node);
    } else {
      node.parentMaskId = parentMaskId;
      node.containerId = containerId;
    }
    Object.assign(node.scopeEl.style, {
      position: 'absolute', left: '0', top: '0', width: '100%', height: '100%',
      overflow: 'visible', pointerEvents: 'none',
    } as Partial<CSSStyleDeclaration>);
    Object.assign(node.clipHost.style, {
      position: 'absolute', left: '0', top: '0', boxSizing: 'border-box',
      pointerEvents: 'auto',
    } as Partial<CSSStyleDeclaration>);
    parentEl.appendChild(node.scopeEl);
    return node;
  }

  private parentForGroup(gid: string): HTMLElement {
    const t = this.template;
    if (!t) return this.root;
    for (const [containerId, entries] of Object.entries({ root: t.rootStack, ...t.groupStacks })) {
      const idx = entries?.findIndex((e) => e.kind === 'group' && e.id === gid) ?? -1;
      if (idx < 0) continue;
      // Stack arrays are back-to-front. A group is below a mask if a mask is
      // after it in the same container.
      for (let i = idx + 1; i < entries!.length; i++) {
        const e = entries![i];
        if (e.kind === 'layer') {
          const layer = t.layers.find((l) => l.id === e.id);
          if (layer?.type === 'mask') {
            return this.maskScopeEls.get(layer.id)?.clipHost ?? this.root;
          }
        }
      }
      if (containerId === 'root') return this.root;
      return this.groupEls.get(containerId)?.el ?? this.root;
    }
    return this.root;
  }

  private ensureLayerNode(layer: Layer): LayerNode {
    let node = this.layerEls.get(layer.id);
    if (!node) {
      const built = this.createLayerElement(layer);
      node = { el: built.el, contentEl: built.contentEl, layer, cache: {} };
      this.layerEls.set(layer.id, node);
    } else {
      // Type change? Recreate the element (and reset the cache).
      if (node.layer.type !== layer.type) {
        node.el.remove();
        const built = this.createLayerElement(layer);
        node = { el: built.el, contentEl: built.contentEl, layer, cache: {} };
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
    const startWall = typeof performance !== 'undefined' ? performance.now() : Date.now();

    // Reset per-frame stats counters (the snapshot handed to onFrame is taken
    // from these after all writes complete).
    this.stats.styleWrites = 0;
    this.stats.skippedWrites = 0;
    this.stats.frameTimeMs = 0;

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

    this.applyMaskScopes(sample);

    const any3d = this.templateHas3D();
    this.setStyle(this.root, this.rootCache, 'transformStyle', any3d ? 'preserve-3d' : 'flat');

    this.stats.frameTimeMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startWall;

    if (this.onFrame) {
      this.onFrame({
        frame,
        fps: tickFps ?? this.template.timeline.fps,
        stats: snapshotStats(this.stats),
      });
    }
  }

  /**
   * Write `el.style[prop] = value` only when the new value differs from the
   * last value we wrote to this element under the same key. Updates the cache
   * and the running stats counters. Keys live in the per-node `cache` map so
   * that separate concerns (e.g. transform vs transformOrigin) don't collide.
   */
  private setStyle(
    el: HTMLElement,
    cache: Record<string, string>,
    prop: string,
    value: string,
  ): void {
    if (cache[prop] === value) {
      this.stats.skippedWrites += 1;
      return;
    }
    // Reflect into the CSSOM and record what we wrote so subsequent identical
    // values skip. Cast because some style keys (e.g. mixBlendMode) have
    // narrower setter types than `string`.
    (el.style as unknown as Record<string, string>)[prop] = value;
    cache[prop] = value;
    this.stats.styleWrites += 1;
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

  private applyLayerState(
    layer: Layer,
    anim: AnimatableValues | undefined,
  ): void {
    const node = this.layerEls.get(layer.id);
    if (!node) return;
    const el = node.el;
    const cache = node.cache;
    const isMask = layer.type === 'mask';

    this.setStyle(el, cache, 'display', layer.visible ? 'block' : 'none');
    if (isMask) {
      this.setStyle(el, cache, 'opacity', '1');
      this.setStyle(el, cache, 'mixBlendMode', 'normal');
    } else {
      this.setStyle(el, cache, 'opacity', opacityCss(anim?.opacity ?? layer.opacity));
      this.setStyle(el, cache, 'mixBlendMode', blendModeCss(layer.blendMode));
    }

    const at: AppliedTransform = applyTransform(
      layer.transform,
      anim as Partial<import('./schema.js').Transform> | undefined,
      { skipPerspective: this.parentPerspective(layer) > 0 },
    );
    this.setStyle(el, cache, 'left', `${at.left}px`);
    this.setStyle(el, cache, 'top', `${at.top}px`);
    this.setStyle(el, cache, 'width', `${at.width}px`);
    this.setStyle(el, cache, 'height', `${at.height}px`);
    this.setStyle(el, cache, 'transformOrigin', `${at.originX}px ${at.originY}px`);
    this.setStyle(el, cache, 'transform', at.transform);
    const layerT = anim ? { ...layer.transform, ...anim } : layer.transform;
    if (transformHas3D(layerT)) {
      this.setStyle(el, cache, 'transformStyle', 'preserve-3d');
    } else {
      this.setStyle(el, cache, 'transformStyle', 'flat');
    }

    this.paintLayerContent(layer, node);
  }

  /** Update mask clip hosts from each mask layer's animated geometry (§6.5). */
  private applyMaskScopes(sample: TimelineSample): void {
    if (!this.template) return;
    const t = this.template;
    const cw = t.canvas.width;
    const ch = t.canvas.height;

    for (const scope of this.maskScopes) {
      const node = this.maskScopeEls.get(scope.maskLayerId);
      const layer = t.layers.find((l) => l.id === scope.maskLayerId);
      if (!node || !layer || layer.type !== 'mask') continue;

      const anim = sample.layers[layer.id];
      const mergedT = anim
        ? { ...layer.transform, ...anim as Partial<import('./schema.js').Transform> }
        : layer.transform;
      const at = applyTransform(
        layer.transform,
        anim as Partial<import('./schema.js').Transform> | undefined,
      );
      const cache = node.cache;

      let containerW = cw;
      let containerH = ch;
      let clipAt = at;

      if (node.parentMaskId) {
        const parent = t.layers.find((l) => l.id === node.parentMaskId);
        if (parent?.type === 'mask') {
          const pAnim = sample.layers[parent.id];
          const pat = applyTransform(
            parent.transform,
            pAnim as Partial<import('./schema.js').Transform> | undefined,
          );
          containerW = pat.width;
          containerH = pat.height;
          clipAt = { ...at, left: at.left - pat.left, top: at.top - pat.top };
        }
      }

      const projected = maskNeedsProjection(mergedT);

      if (projected) {
        node.clipMode = 'projected';
        const quad = projectMaskQuad(mergedT, clipAt);
        const geoKey = maskGeometryKey(quad);
        const proj = projectedMaskClip(layer, quad, containerW, containerH);
        this.setStyle(node.clipHost, cache, 'left', '0');
        this.setStyle(node.clipHost, cache, 'top', '0');
        this.setStyle(node.clipHost, cache, 'width', `${containerW}px`);
        this.setStyle(node.clipHost, cache, 'height', `${containerH}px`);
        this.setStyle(node.clipHost, cache, 'overflow', proj.overflow);
        if (cache.clipGeoKey !== geoKey) {
          cache.clipGeoKey = geoKey;
        }
        this.setStyle(node.clipHost, cache, 'clipPath', proj.clipPath);
        this.setStyle(node.clipHost, cache, 'borderRadius', '0');
      } else {
        node.clipMode = 'bounds';
        delete cache.clipGeoKey;
        const clip = maskClipStyle(layer, clipAt, containerW, containerH);

        this.setStyle(node.clipHost, cache, 'left', '0');
        this.setStyle(node.clipHost, cache, 'top', '0');
        this.setStyle(node.clipHost, cache, 'width', `${containerW}px`);
        this.setStyle(node.clipHost, cache, 'height', `${containerH}px`);
        this.setStyle(node.clipHost, cache, 'overflow', clip.overflow);
        this.setStyle(node.clipHost, cache, 'clipPath', clip.clipPath);
        this.setStyle(node.clipHost, cache, 'borderRadius', clip.borderRadius);
      }
    }
  }

  private applyGroupState(group: LayerGroup, anim: AnimatableValues | undefined): void {
    const node = this.groupEls.get(group.id);
    if (!node) return;
    const el = node.el;
    const cache = node.cache;
    this.setStyle(el, cache, 'display', group.visible ? 'block' : 'none');
    const gt = anim ? { ...group.transform, ...anim } : group.transform;
    const at = applyTransform(
      group.transform,
      anim as Partial<import('./schema.js').Transform> | undefined,
      { skipPerspective: this.parentPerspectiveForGroup(group.parentId) > 0 },
    );
    this.setStyle(el, cache, 'transformOrigin', `${at.originX}px ${at.originY}px`);
    this.setStyle(el, cache, 'transform', at.transform);
    this.setStyle(el, cache, 'perspective', gt.perspective > 0 ? `${gt.perspective}px` : 'none');
    const needs3d = transformHas3D(gt) || this.groupSubtreeHas3D(group.id);
    this.setStyle(el, cache, 'transformStyle', needs3d ? 'preserve-3d' : 'flat');
  }

  /** Nearest ancestor group perspective (for inheritance). */
  private parentPerspective(layer: Layer): number {
    return this.parentPerspectiveForGroup(layer.groupId);
  }

  private parentPerspectiveForGroup(groupId: string | null): number {
    if (!this.template || !groupId) return 0;
    for (const gid of this.ancestorGroupIds(groupId)) {
      const g = this.template.groups.find((x) => x.id === gid);
      if (g && g.transform.perspective > 0) return g.transform.perspective;
    }
    return 0;
  }

  private ancestorGroupIds(startId: string): string[] {
    const ids: string[] = [];
    let gid: string | null = startId;
    while (gid && this.template) {
      ids.push(gid);
      const g = this.template.groups.find((x) => x.id === gid);
      gid = g?.parentId ?? null;
    }
    return ids;
  }

  private templateHas3D(): boolean {
    if (!this.template) return false;
    if (this.template.groups.some((g) => transformHas3D(g.transform))) return true;
    return this.template.layers.some((l) => transformHas3D(l.transform));
  }

  /** True if this group or any descendant layer/group uses 3D transforms. */
  private groupSubtreeHas3D(gid: string): boolean {
    if (!this.template) return false;
    const entries = this.template.groupStacks[gid];
    if (!entries) return false;
    for (const e of entries) {
      if (e.kind === 'layer') {
        const l = this.template.layers.find((x) => x.id === e.id);
        if (l && transformHas3D(l.transform)) return true;
      } else {
        const g = this.template.groups.find((x) => x.id === e.id);
        if (g && (transformHas3D(g.transform) || this.groupSubtreeHas3D(e.id))) return true;
      }
    }
    return false;
  }

  /** Paint the type-specific content (text/media/fill/mask) for a layer. */
  private paintLayerContent(layer: Layer, node: LayerNode): void {
    const el = node.el;
    const v = this.variables;
    const cache = node.cache;
    switch (layer.type) {
      case 'rect': {
        const fill = String(resolveBinding(layer.fill, v));
        this.setStyle(el, cache, 'background', fill);
        this.setStyle(el, cache, 'borderRadius', `${layer.cornerRadius}px`);
        const border = layer.borderWidth > 0
          ? `${layer.borderWidth}px solid ${layer.borderColor}`
          : 'none';
        this.setStyle(el, cache, 'border', border);
        break;
      }
      case 'mask': {
        // Mask geometry drives clipHost in applyMaskScopes; the mask layer itself
        // is invisible on air (editor selection overlay shows bounds).
        this.setStyle(el, cache, 'background', 'transparent');
        this.setStyle(el, cache, 'border', 'none');
        this.setStyle(el, cache, 'borderRadius', '0');
        this.setStyle(el, cache, 'clipPath', 'none');
        this.setStyle(el, cache, 'pointerEvents', 'none');
        break;
      }
      case 'text':
      case 'clock': {
        const content = node.contentEl as HTMLElement;
        const s = layer.style;
        this.setStyle(content, cache, 'fontFamily', `"${s.fontFamily}", system-ui, sans-serif`);
        this.setStyle(content, cache, 'fontSize', `${s.fontSize}px`);
        this.setStyle(content, cache, 'fontWeight', s.fontWeight);
        this.setStyle(content, cache, 'color', String(resolveBinding(s.fill, v)));
        this.setStyle(content, cache, 'textAlign', s.align);
        this.setStyle(content, cache, 'justifyContent',
          s.align === 'left' ? 'flex-start' : s.align === 'right' ? 'flex-end' : 'center');
        this.setStyle(content, cache, 'alignItems', 'center');
        this.setStyle(content, cache, 'lineHeight', String(s.lineHeight));
        this.setStyle(content, cache, 'letterSpacing', `${s.letterSpacing}px`);
        this.setStyle(content, cache, 'whiteSpace', 'pre');
        this.setStyle(content, cache, 'webkitTextStroke',
          s.strokeWidth > 0 ? `${s.strokeWidth}px ${s.strokeColor}` : '');
        this.setStyle(content, cache, 'textShadow',
          s.dropShadow
            ? `${0}px ${s.dropShadowDistance}px ${s.dropShadowBlur}px ${s.dropShadowColor}`
            : '');
        if (layer.type === 'text') {
          this.setText(content, cache, 'textContent', String(resolveBinding(layer.content, v)));
        } else {
          // clock content is refreshed by the clock ticker; set an initial value.
          this.setText(content, cache, 'textContent', formatClock(layer.format, layer.mode, Date.now(),
            { startTime: layer.startTime, targetTime: layer.targetTime }));
        }
        break;
      }
      case 'image': {
        const img = node.contentEl as HTMLImageElement;
        const src = String(resolveBinding(layer.src, v));
        this.setText(img, cache, 'src', src);
        this.setStyle(img, cache, 'borderRadius', `${layer.cornerRadius}px`);
        this.setStyle(img, cache, 'objectFit', layer.fit);
        break;
      }
      case 'video': {
        const vid = node.contentEl as HTMLVideoElement;
        const src = String(resolveBinding(layer.src, v));
        const changed = this.setText(vid, cache, 'src', src);
        if (changed) {
          vid.loop = layer.loop;
          if (layer.loop) vid.play().catch(() => {});
        }
        this.setStyle(vid, cache, 'objectFit', layer.fit);
        break;
      }
    }
  }

  /**
   * Like {@link setStyle} but for non-CSS values (img.src, video.src,
   * textContent). Returns true if the value was actually applied (changed),
   * false if it was skipped. Reuses the same per-node cache.
   */
  private setText(
    el: HTMLElement,
    cache: Record<string, string>,
    key: string,
    value: string,
  ): boolean {
    if (cache[key] === value) {
      this.stats.skippedWrites += 1;
      return false;
    }
    if (key === 'textContent') {
      (el as HTMLElement).textContent = value;
    } else {
      // img.src / video.src live on the element, not on .style
      (el as unknown as Record<string, string>)[key] = value;
    }
    cache[key] = value;
    this.stats.styleWrites += 1;
    return true;
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
