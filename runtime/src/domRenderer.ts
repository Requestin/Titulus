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
import { applyTextTransform, resolveBinding, isUpdateDirectorName, timelineNeedsDirectorRuntime } from './schema.js';
import {
  applyTextStyleToEl,
  crawlAlignActive,
  crawlDirectorLocalFrame,
  crawlLinesFromContent,
  formatCrawlLine,
  sampleCrawlMotion,
} from './crawl.js';
import { applyTransform, blendModeCss, opacityCss, transformHas3D, type AppliedTransform } from './transform.js';
import { applyGroupTransform, computeGroupBbox } from './groupBounds.js';
import { computeStackOrder, groupMap } from './stackOrder.js';
import { computeMaskScopes, maskClipStyle, type MaskScope } from './maskScopes.js';
import {
  maskNeedsProjection, projectMaskOutline, projectedMaskClip, maskGeometryKey,
} from './maskGeometry.js';
import type { RootStackEntry } from './schema.js';
import {
  directorLocalFrame,
  getLayerPropTrackRange,
  normalizeTimeline,
  sampleAt,
  sampleAtDirectorLocals,
  type NormalizedTimeline,
  type TimelineSample,
} from './timeline.js';
import { formatClock } from './clock.js';
import { parseTimeExpression } from './timeExpr.js';
import { ensureFonts, collectFonts } from './fonts.js';
import { type RenderStats, emptyRenderStats, snapshotStats } from './stats.js';
import {
  initDirectorRuntimes,
  advanceDirectorLocal,
  tickPause,
  localFramesMap,
  collectFiredItems,
  type DirectorRuntime,
  type DirectorPlayState,
  type FiredAction,
} from './directorRuntime.js';
import type { TimelineActionCue, TimelineActionItem } from './schema.js';

export interface TemplateRendererOptions {
  /** fixed: caller drives tick(fixedTickRate); raf: internal rAF loop. */
  playbackMode?: 'fixed' | 'raf';
  /** tick rate when mode='fixed' (channel fps). */
  fixedTickRate?: number;
}

/** Per-frame callback during timeline playback (e.g. for stats). */
export type OnFrameFn = (info: { frame: number; fps: number; stats?: RenderStats }) => void;

/** Fired when a timeline action item executes (tags / host signals). */
export type OnActionFn = (info: {
  cue: TimelineActionCue;
  item: TimelineActionItem;
  directorId: string;
  localFrame: number;
}) => void;

/** Fired when stopAndWaitContinue presence changes (Control Continue enablement). */
export type OnWaitingChangeFn = (waiting: boolean) => void;

interface LayerNode {
  el: HTMLElement;
  /** child element for text/clock content (so we can update text without re-layout). */
  contentEl?: HTMLElement;
  /** Inner scrolling track for crawl layers. */
  crawlTrackEl?: HTMLElement;
  layer: Layer;
  /** Cache of last-written property strings so we can skip identical writes. */
  cache: Record<string, string>;
  /** Cached crawl lines (after fetch/parse). */
  crawlLines?: string[];
  crawlFetchKey?: string;
  /** Tracks last Content string used to build crawlLines (Parse invalidation). */
  crawlContentKey?: string;
  crawlLoopEpoch?: number;
  /** Last director-local frame used for video transport sync. */
  videoLastLocal?: number;
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
  /** When set, editor preview uses independent per-director local frames. */
  private directorLocalFrames: Record<string, number> | null = null;
  private lastFrameSampled: number | null = null;
  private rafId: number | null = null;
  private rafLastWall: number | null = null;
  private onFrame: OnFrameFn | null = null;
  private onAction: OnActionFn | null = null;
  private onWaitingChange: OnWaitingChangeFn | null = null;
  private lastWaitingReported: boolean | null = null;
  private clockTimer: number | null = null;
  /** Air playback: per-director Action runtime (start/stop/pause/continue). */
  private directorRuntimes: Record<string, DirectorRuntime> | null = null;
  private useDirectorRuntime = false;
  /** Variables to apply at the next Update data tag (replace-all). */
  private pendingUpdateVariables: Record<string, string | number> | null = null;

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
    this.applyCurrentState();

    // Re-trigger font load for any new text/clock layers, then re-sync so text
    // measures with the real font.
    const fonts = collectFonts(template.layers);
    if (fonts.length) {
      ensureFonts(fonts).then(() => this.applyCurrentState()).catch(() => {});
    }
  }

  /** Apply either per-director local frames (editor) or global frame (engine). */
  private applyCurrentState(tickFps?: number): void {
    if (this.directorLocalFrames) {
      this.applyStateFromLocals(tickFps);
    } else {
      this.applyState(this.frame, tickFps);
    }
  }

  /**
   * Play the timeline from the current frame. In 'fixed' mode the caller must
   * drive tick(); in 'raf' mode we start a requestAnimationFrame loop that maps
   * wall-clock -> frames at the template fps.
   *
   * Uses classic global-frame playback unless the timeline actually needs the
   * Action director state machine (start/stop/wait/endScene/armed Update).
   * Dormant Update alone does not enable Action runtime.
   */
  playTimeline(
    template: Template,
    variables: Record<string, string | number> = NO_VARS,
    opts: { onFrame?: OnFrameFn; onAction?: OnActionFn; onWaitingChange?: OnWaitingChangeFn } = {},
  ): void {
    this.syncTemplate(template, variables);
    this.onFrame = opts.onFrame ?? null;
    this.onAction = opts.onAction ?? null;
    this.onWaitingChange = opts.onWaitingChange ?? null;
    this.lastWaitingReported = null;
    this.playing = true;
    this.lastFrameSampled = null;
    this.frame = 0;

    if (timelineNeedsDirectorRuntime(template.timeline)) {
      this.useDirectorRuntime = true;
      this.directorRuntimes = initDirectorRuntimes(template.timeline);
      this.directorLocalFrames = localFramesMap(this.directorRuntimes);
      this.applyStateFromLocals(this.fixedTickRate);
      this.emitWaitingChange();
    } else {
      this.useDirectorRuntime = false;
      this.directorRuntimes = null;
      this.directorLocalFrames = null;
      this.applyState(0, this.fixedTickRate);
    }

    if (this.mode === 'raf') this.startRaf();
    this.startClockTicker();
  }

  /**
   * Editor preview: arm Action runtime from current scrub without syncTemplate / rAF.
   * Host drives advanceEditorPlayback() from its own rAF loop.
   * No-op (returns false) when the timeline does not need Action runtime — host
   * should use classic seekDirectorLocals playback instead.
   */
  beginEditorPlayback(
    localFrames: Record<string, number> = {},
    opts: { onWaitingChange?: OnWaitingChangeFn } = {},
  ): boolean {
    if (!this.template) return false;
    // Arm transport for both Action and classic host loops (video free-run).
    this.playing = true;

    if (!timelineNeedsDirectorRuntime(this.template.timeline)) {
      this.onWaitingChange = opts.onWaitingChange ?? null;
      this.lastWaitingReported = null;
      this.useDirectorRuntime = false;
      this.directorRuntimes = null;
      this.directorLocalFrames = { ...localFrames };
      this.applyStateFromLocals(this.fixedTickRate);
      return false;
    }

    this.onFrame = null;
    this.onAction = null; // editor ignores endScene / updateData tags
    this.onWaitingChange = opts.onWaitingChange ?? null;
    this.lastWaitingReported = null;
    this.useDirectorRuntime = true;
    this.directorRuntimes = initDirectorRuntimes(this.template.timeline);
    for (const d of this.template.timeline.directors) {
      const rt = this.directorRuntimes[d.id];
      if (!rt) continue;
      const local = Math.max(0, Math.min(d.durationFrames, Math.round(localFrames[d.id] ?? 0)));
      rt.localFrame = local;
      rt.lastLocalForActions = local;
      rt.pauseRemaining = 0;
      rt.direction = 1;
    }
    this.directorLocalFrames = localFramesMap(this.directorRuntimes);
    this.applyStateFromLocals(this.fixedTickRate);
    this.emitWaitingChange();
    return true;
  }

  /** Advance Action runtime N frames; caller may defer paint for interpolation. */
  advanceEditorPlayback(steps: number, paint = true): void {
    if (!this.playing || !this.useDirectorRuntime || !this.directorRuntimes) return;
    this.advanceDirectorRuntimes(Math.max(0, Math.round(steps)));
    this.directorLocalFrames = localFramesMap(this.directorRuntimes);
    if (paint) this.applyStateFromLocals(this.fixedTickRate);
  }

  /**
   * Paint a fractional frame between discrete Action ticks for smooth browser
   * preview. Runtime state and cue crossing remain integer/frame-accurate.
   */
  renderDirectorPlaybackFraction(fraction: number): Record<string, number> {
    if (!this.template || !this.directorRuntimes) return this.getDirectorLocals();
    const amount = Math.max(0, Math.min(0.999, fraction));
    const visualFrames: Record<string, number> = {};
    for (const d of this.template.timeline.directors) {
      const rt = this.directorRuntimes[d.id];
      if (!rt) continue;
      const visual = rt.state === 'play'
        ? rt.localFrame + rt.direction * amount
        : rt.localFrame;
      visualFrames[d.id] = Math.max(0, Math.min(d.durationFrames, visual));
    }
    const canonicalFrames = this.directorLocalFrames;
    this.directorLocalFrames = visualFrames;
    this.applyStateFromLocals(this.fixedTickRate);
    this.directorLocalFrames = canonicalFrames;
    return visualFrames;
  }

  /**
   * End editor Action playback without re-painting (DOM already shows last frame).
   * Preserves directorLocalFrames for the next scrub/seek.
   */
  endEditorPlayback(): Record<string, number> {
    const locals = this.getDirectorLocals();
    this.playing = false;
    this.useDirectorRuntime = false;
    this.directorRuntimes = null;
    this.onWaitingChange = null;
    this.lastWaitingReported = null;
    this.directorLocalFrames = { ...locals };
    // Stop HTML media free-run; keep current decoded frame on screen.
    for (const node of this.layerEls.values()) {
      if (node.layer.type !== 'video' || !node.contentEl) continue;
      const vid = node.contentEl as HTMLVideoElement;
      if (!vid.paused) vid.pause();
    }
    return locals;
  }

  /** Snapshot of per-director local frames (editor playhead sync). */
  getDirectorLocals(): Record<string, number> {
    if (this.directorRuntimes) return localFramesMap(this.directorRuntimes);
    return { ...(this.directorLocalFrames ?? {}) };
  }

  /** Stop timeline playback (freeze at the current frame). */
  stopTimeline(): void {
    this.playing = false;
    this.stopRaf();
    this.stopClockTicker();
  }

  /** Resume all directors in `stopAndWaitContinue` (Control Continue). */
  continueWaitingDirectors(opts: { resumeRaf?: boolean } = {}): void {
    if (!this.directorRuntimes) return;
    for (const rt of Object.values(this.directorRuntimes)) {
      if (rt.state === 'stopAndWaitContinue') rt.state = 'play';
    }
    this.emitWaitingChange();
    const resumeRaf = opts.resumeRaf !== false;
    if (resumeRaf && !this.playing) {
      this.playing = true;
      if (this.mode === 'raf') this.startRaf();
    }
  }

  /**
   * Control Update-flow: queue replace-all variables for the Update data tag,
   * then start the protected Update director from frame 0.
   * Escalates classic playback to Action runtime when needed.
   */
  startUpdateFlow(variables: Record<string, string | number> = NO_VARS): void {
    if (!this.template) return;
    if (!this.directorRuntimes) {
      this.ensureDirectorRuntimeFromClassic();
    }
    if (!this.directorRuntimes) return;
    this.pendingUpdateVariables = { ...variables };
    const update = this.template.timeline.directors.find((d) => isUpdateDirectorName(d.name));
    if (!update) return;
    const rt = this.directorRuntimes[update.id];
    if (!rt) return;
    rt.state = 'play';
    rt.localFrame = 0;
    rt.direction = 1;
    rt.pauseRemaining = 0;
    rt.lastLocalForActions = null;
    if (!this.playing) {
      this.playing = true;
      if (this.mode === 'raf') this.startRaf();
    }
    // Control may have cleared waitingContinue on Update; if another director is
    // still in stopAndWaitContinue, re-emit so Continue stays/reactives for the new slot.
    this.lastWaitingReported = null;
    this.emitWaitingChange();
  }

  /** Promote classic global-frame play to Action director runtime (Update-flow / Continue). */
  private ensureDirectorRuntimeFromClassic(): void {
    if (!this.template || this.directorRuntimes) return;
    this.useDirectorRuntime = true;
    this.directorRuntimes = initDirectorRuntimes(this.template.timeline);
    const global = this.frame;
    for (const d of this.template.timeline.directors) {
      const rt = this.directorRuntimes[d.id];
      if (!rt) continue;
      if (rt.state === 'play') {
        const local = Math.max(0, Math.min(d.durationFrames, global - d.offsetFrames));
        rt.localFrame = local;
        rt.lastLocalForActions = local;
      }
    }
    this.directorLocalFrames = localFramesMap(this.directorRuntimes);
  }

  /** Consume pending Update variables (replace-all) at the Update data tag. */
  takePendingUpdateVariables(): Record<string, string | number> | null {
    const v = this.pendingUpdateVariables;
    this.pendingUpdateVariables = null;
    return v;
  }

  hasWaitingDirectors(): boolean {
    if (!this.directorRuntimes) return false;
    return Object.values(this.directorRuntimes).some((rt) => rt.state === 'stopAndWaitContinue');
  }

  /** True while any director is playing, pausing, or waiting for Continue. */
  isDirectorPlaybackActive(): boolean {
    if (!this.directorRuntimes) return false;
    return Object.values(this.directorRuntimes).some(
      (rt) => rt.state === 'play' || rt.state === 'pause' || rt.state === 'stopAndWaitContinue',
    );
  }

  /**
   * Seek to an absolute frame and apply state, without playing (editor scrub /
   * preview). Does not fire cue actions (scrubbing is not a linear playthrough).
   */
  seek(frame: number): void {
    this.frame = Math.max(0, Math.round(frame));
    this.directorLocalFrames = null;
    this.lastFrameSampled = null;
    this.useDirectorRuntime = false;
    this.directorRuntimes = null;
    this.applyState(this.frame);
  }

  /**
   * Editor preview: each director has its own local playhead (loop/swing applied
   * externally before calling). Clears global-frame mode.
   */
  seekDirectorLocals(localFrames: Record<string, number>): void {
    this.directorLocalFrames = { ...localFrames };
    this.lastFrameSampled = null;
    this.useDirectorRuntime = false;
    this.directorRuntimes = null;
    this.applyStateFromLocals();
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
    if (this.useDirectorRuntime && this.directorRuntimes) {
      this.advanceDirectorRuntimes(1);
      this.directorLocalFrames = localFramesMap(this.directorRuntimes);
      this.applyStateFromLocals(this.fixedTickRate);
    } else {
      this.frame += 1;
      this.applyState(this.frame, this.fixedTickRate);
    }
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
      node = {
        el: built.el,
        contentEl: built.contentEl,
        crawlTrackEl: built.crawlTrackEl,
        layer,
        cache: {},
      };
      this.layerEls.set(layer.id, node);
    } else {
      // Type change? Recreate the element (and reset the cache).
      if (node.layer.type !== layer.type) {
        node.el.remove();
        const built = this.createLayerElement(layer);
        node = {
          el: built.el,
          contentEl: built.contentEl,
          crawlTrackEl: built.crawlTrackEl,
          layer,
          cache: {},
        };
        this.layerEls.set(layer.id, node);
      } else {
        node.layer = layer;
      }
    }
    return node;
  }

  /** Build the layer wrapper element + optional content child. Does NOT touch the map. */
  private createLayerElement(layer: Layer): {
    el: HTMLElement;
    contentEl?: HTMLElement;
    crawlTrackEl?: HTMLElement;
  } {
    const el = document.createElement('div');
    el.className = `titulus-layer titulus-${layer.type}`;
    el.dataset.layerId = layer.id;
    Object.assign(el.style, {
      position: 'absolute', left: '0', top: '0', boxSizing: 'border-box',
    } as Partial<CSSStyleDeclaration>);

    // Per-type inner content. For text/clock we keep a content child so we can
    // update text without touching the transform wrapper.
    let contentEl: HTMLElement | undefined;
    let crawlTrackEl: HTMLElement | undefined;
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
      case 'crawl': {
        el.style.overflow = 'hidden';
        contentEl = document.createElement('div');
        contentEl.className = 'titulus-crawl-viewport';
        contentEl.style.width = '100%';
        contentEl.style.height = '100%';
        contentEl.style.overflow = 'hidden';
        contentEl.style.position = 'relative';
        crawlTrackEl = document.createElement('div');
        crawlTrackEl.className = 'titulus-crawl-track';
        crawlTrackEl.style.position = 'absolute';
        crawlTrackEl.style.left = '0';
        crawlTrackEl.style.top = '0';
        crawlTrackEl.style.display = 'flex';
        crawlTrackEl.style.willChange = 'transform';
        contentEl.appendChild(crawlTrackEl);
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
        }
        contentEl = media as HTMLElement;
        el.appendChild(media);
        break;
      }
      case 'rect':
      case 'mask':
        break;
    }
    return { el, contentEl, crawlTrackEl };
  }

  // -----------------------------------------------------------------------
  // Per-frame state application
  // -----------------------------------------------------------------------

  private applyState(frame: number, tickFps?: number): void {
    if (!this.template || !this.norm) return;
    const startWall = typeof performance !== 'undefined' ? performance.now() : Date.now();

    this.stats.styleWrites = 0;
    this.stats.skippedWrites = 0;
    this.stats.frameTimeMs = 0;

    const sample: TimelineSample = sampleAt(this.norm, frame);

    if (this.lastFrameSampled !== null && frame > this.lastFrameSampled) {
      for (const d of this.norm.directorList) {
        const cues = this.norm.actions[d.id] ?? [];
        if (cues.length === 0) continue;
        const currentLocal = directorLocalFrame(d, frame);
        if (currentLocal === null) continue;
        const previousLocal = directorLocalFrame(d, this.lastFrameSampled);
        const fired = collectFiredItems(cues, previousLocal, currentLocal, 1);
        if (fired.length > 0) this.runFiredActions(fired);
      }
    }
    this.lastFrameSampled = frame;

    this.applySample(sample, frame, tickFps, startWall);
  }

  private applyStateFromLocals(tickFps?: number): void {
    if (!this.template || !this.norm || !this.directorLocalFrames) return;
    const startWall = typeof performance !== 'undefined' ? performance.now() : Date.now();

    this.stats.styleWrites = 0;
    this.stats.skippedWrites = 0;
    this.stats.frameTimeMs = 0;

    const sample = sampleAtDirectorLocals(this.norm, this.directorLocalFrames);
    this.applySample(sample, this.frame, tickFps, startWall);
  }

  private applySample(sample: TimelineSample, frame: number, tickFps: number | undefined, startWall: number): void {
    if (!this.template) return;
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

  private advanceDirectorRuntimes(steps: number): void {
    if (!this.template || !this.directorRuntimes || !this.norm) return;
    for (let s = 0; s < steps; s++) {
      this.frame += 1;
      for (const d of this.template.timeline.directors) {
        const rt = this.directorRuntimes[d.id];
        if (!rt) continue;
        tickPause(rt);
        if (rt.state !== 'play') continue;
        const prev = rt.localFrame;
        const moving = rt.direction;
        advanceDirectorLocal(d, rt);
        const stateAfter = rt.state as DirectorPlayState;
        const cues = this.norm.actions[d.id] ?? [];
        const fired = collectFiredItems(cues, rt.lastLocalForActions ?? prev, rt.localFrame, moving);
        rt.lastLocalForActions = rt.localFrame;
        if (fired.length > 0) this.runFiredActions(fired);
        if (isUpdateDirectorName(d.name) && stateAfter === 'stop') {
          // TZ: after Update finishes, park playhead at start of Update.
          rt.localFrame = 0;
          rt.direction = 1;
          rt.lastLocalForActions = null;
        }
      }
    }
  }

  private emitWaitingChange(): void {
    const waiting = this.hasWaitingDirectors();
    if (this.lastWaitingReported === waiting) return;
    this.lastWaitingReported = waiting;
    this.onWaitingChange?.(waiting);
  }

  private runFiredActions(fired: FiredAction[]): void {
    if (!this.directorRuntimes) {
      for (const f of fired) this.onAction?.(f);
      return;
    }
    let waitingMayHaveChanged = false;
    for (const f of fired) {
      const { item } = f;
      const cmd = item.command;
      if (!cmd) continue;

      // Parameter defaults to the cue's host director (intuitive for stop/pause/wait).
      const targetId = item.parameterDirectorId ?? f.directorId;

      if (cmd === 'startDirector') {
        const trt = this.directorRuntimes[targetId];
        if (trt && (trt.state === 'stop' || trt.state === 'stopAndWaitContinue')) {
          // Resume from current localFrame (kept on stop); never-started stays at 0.
          waitingMayHaveChanged ||= trt.state === 'stopAndWaitContinue';
          trt.state = 'play';
          trt.lastLocalForActions = null;
        }
        continue;
      }
      if (cmd === 'stopDirector') {
        const trt = this.directorRuntimes[targetId];
        if (trt) {
          waitingMayHaveChanged ||= trt.state === 'stopAndWaitContinue';
          trt.state = 'stop';
        }
        continue;
      }
      if (cmd === 'stopDirectorAndWaitContinue') {
        const trt = this.directorRuntimes[targetId];
        if (trt) {
          waitingMayHaveChanged = true;
          trt.state = 'stopAndWaitContinue';
        }
        continue;
      }
      if (cmd === 'pauseDirector') {
        const trt = this.directorRuntimes[targetId];
        if (trt) {
          waitingMayHaveChanged ||= trt.state === 'stopAndWaitContinue';
          trt.state = 'pause';
          trt.pauseRemaining = Math.max(0, item.lengthFrames);
          if (trt.pauseRemaining === 0) trt.state = 'play';
        }
        continue;
      }
      if (cmd === 'tag') {
        this.onAction?.(f);
      }
    }
    if (waitingMayHaveChanged) this.emitWaitingChange();
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

    this.paintLayerContent(layer, node, anim);
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
        const maskSpec = {
          maskMode: layer.maskMode,
          shape: layer.shape,
          cornerRadius: layer.cornerRadius,
        };
        const outline = projectMaskOutline(maskSpec, mergedT, clipAt);
        const geoKey = `${maskGeometryKey(outline)}|${layer.shape}|${layer.cornerRadius}|${layer.maskMode}`;
        const proj = projectedMaskClip(maskSpec, outline, containerW, containerH);
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
        this.setStyle(node.clipHost, cache, 'maskImage', 'none');
        this.setStyle(node.clipHost, cache, 'WebkitMaskImage', 'none');
        this.setStyle(node.clipHost, cache, 'maskMode', 'match-source');
        this.setStyle(node.clipHost, cache, 'WebkitMaskMode', 'match-source');
        this.setStyle(node.clipHost, cache, 'maskSize', 'auto');
        this.setStyle(node.clipHost, cache, 'WebkitMaskSize', 'auto');
        this.setStyle(node.clipHost, cache, 'maskRepeat', 'repeat');
        this.setStyle(node.clipHost, cache, 'WebkitMaskRepeat', 'repeat');
        this.setStyle(node.clipHost, cache, 'maskPosition', '0 0');
        this.setStyle(node.clipHost, cache, 'WebkitMaskPosition', '0 0');
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
        this.setStyle(node.clipHost, cache, 'maskImage', clip.maskImage);
        this.setStyle(node.clipHost, cache, 'WebkitMaskImage', clip.maskImage);
        this.setStyle(node.clipHost, cache, 'maskMode', clip.maskMode);
        this.setStyle(node.clipHost, cache, 'WebkitMaskMode', clip.maskMode);
        this.setStyle(node.clipHost, cache, 'maskSize', clip.maskSize);
        this.setStyle(node.clipHost, cache, 'WebkitMaskSize', clip.maskSize);
        this.setStyle(node.clipHost, cache, 'maskRepeat', clip.maskRepeat);
        this.setStyle(node.clipHost, cache, 'WebkitMaskRepeat', clip.maskRepeat);
        this.setStyle(node.clipHost, cache, 'maskPosition', clip.maskPosition);
        this.setStyle(node.clipHost, cache, 'WebkitMaskPosition', clip.maskPosition);
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
    const bbox = this.template ? computeGroupBbox(this.template, group.id) : null;
    const at = applyGroupTransform(
      group.transform,
      bbox,
      anim as Partial<import('./schema.js').Transform> | undefined,
      { skipPerspective: this.parentPerspectiveForGroup(group.parentId) > 0 },
    );
    this.setStyle(el, cache, 'left', `${at.left}px`);
    this.setStyle(el, cache, 'top', `${at.top}px`);
    this.setStyle(el, cache, 'width', `${at.width}px`);
    this.setStyle(el, cache, 'height', `${at.height}px`);
    this.setStyle(el, cache, 'transformOrigin', `${at.originX}px ${at.originY}px`);
    this.setStyle(el, cache, 'transform', at.transform);
    // CSS perspective only when this group (or subtree) actually tilts — default
    // perspective:1000 must not create a 3D context that breaks 2D scale on CEF.
    const needs3d = transformHas3D(gt) || this.groupSubtreeHas3D(group.id);
    const persp = needs3d && gt.perspective > 0 ? `${gt.perspective}px` : 'none';
    this.setStyle(el, cache, 'perspective', persp);
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
      if (!g) continue;
      // Only inherit when the ancestor actually establishes a 3D context.
      if ((transformHas3D(g.transform) || this.groupSubtreeHas3D(gid)) && g.transform.perspective > 0) {
        return g.transform.perspective;
      }
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
  private paintLayerContent(
    layer: Layer,
    node: LayerNode,
    anim?: AnimatableValues,
  ): void {
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
        const shadowX = typeof s.dropShadowOffsetX === 'number'
          ? s.dropShadowOffsetX
          : 0;
        const shadowY = typeof s.dropShadowOffsetY === 'number'
          ? s.dropShadowOffsetY
          : (typeof s.dropShadowDistance === 'number' ? s.dropShadowDistance : 1);
        this.setStyle(content, cache, 'textShadow',
          s.dropShadow
            ? `${shadowX}px ${shadowY}px ${s.dropShadowBlur}px ${s.dropShadowColor}`
            : '');
        if (layer.type === 'text') {
          const raw = String(resolveBinding(layer.content, v));
          this.setText(content, cache, 'textContent', applyTextTransform(raw, s.textTransform));
        } else {
          // clock content is refreshed by the clock ticker; set an initial value.
          const now = Date.now();
          this.setText(content, cache, 'textContent', formatClock(layer.format, layer.mode, now,
            this.resolveClockOpts(layer, v, now)));
        }
        break;
      }
      case 'crawl': {
        this.paintCrawl(layer, node, v, anim);
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
        this.setStyle(vid, cache, 'objectFit', layer.fit);
        this.syncVideoClipPlayback(layer, node, vid, cache, changed);
        break;
      }
    }
  }

  /**
   * Drive HTMLVideoElement from the videoProgress clip window.
   *
   * Perf-critical: do NOT seek every paint frame (kills CEF/browser to ~1–2fps).
   * - Scrub / paused: pause + seek to playhead frame
   * - Transport playing: native play() free-run, resync only on jump / large drift
   */
  private syncVideoClipPlayback(
    layer: Extract<Layer, { type: 'video' }>,
    node: LayerNode,
    vid: HTMLVideoElement,
    cache: Record<string, string>,
    srcChanged: boolean,
  ): void {
    const fps = this.template?.timeline.fps || this.fixedTickRate || 50;
    const endBehavior = layer.endBehavior === 'empty' ? 'empty' : 'lastFrame';
    const range = this.norm
      ? getLayerPropTrackRange(this.norm, layer.id, 'videoProgress')
      : null;
    /** Resync only when HTML clock drifts this far from timeline (seconds). */
    const DRIFT_SEC = 0.15;
    /** Treat playhead move larger than this as a scrub jump (frames). */
    const JUMP_FRAMES = 2.5;

    const show = (visible: boolean) => {
      this.setStyle(vid, cache, 'visibility', visible ? 'visible' : 'hidden');
    };

    const seekSec = (sec: number, force = false) => {
      if (vid.readyState < 1) {
        if (!vid.dataset.titulusSeekHook) {
          vid.dataset.titulusSeekHook = '1';
          vid.addEventListener('loadeddata', () => {
            delete vid.dataset.titulusSeekHook;
            this.applyCurrentState();
          }, { once: true });
        }
        return;
      }
      const mediaDur = Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : undefined;
      const t = mediaDur !== undefined
        ? Math.max(0, Math.min(sec, Math.max(0, mediaDur - 0.001)))
        : Math.max(0, sec);
      if (!Number.isFinite(t)) return;
      if (force || Math.abs((vid.currentTime || 0) - t) > 0.04) {
        try { vid.currentTime = t; } catch { /* ignore seek races */ }
      }
    };

    const targetFromElapsed = (elapsedSec: number, mediaDurSec: number, loop: boolean): number => {
      if (loop) return mediaDurSec > 0 ? elapsedSec % mediaDurSec : 0;
      return Math.min(Math.max(0, elapsedSec), Math.max(0, mediaDurSec - 0.001));
    };

    if (srcChanged) {
      node.videoLastLocal = undefined;
      if (!vid.paused) vid.pause();
    }

    // Legacy / no clip track
    if (!range) {
      vid.loop = layer.loop;
      if (this.playing && layer.loop) {
        show(true);
        if (vid.paused) vid.play().catch(() => {});
      } else {
        if (!vid.paused) vid.pause();
        seekSec(0);
        show(Boolean(String(resolveBinding(layer.src, this.variables))));
      }
      return;
    }

    let local: number;
    if (this.directorLocalFrames && range.directorId in this.directorLocalFrames) {
      local = this.directorLocalFrames[range.directorId] ?? 0;
    } else if (this.norm) {
      const dir = this.norm.directorList.find((d) => d.id === range.directorId);
      local = dir ? (directorLocalFrame(dir, this.frame) ?? 0) : 0;
    } else {
      local = this.frame;
    }

    const clipDurFrames = Math.max(1, range.end - range.start);
    const mediaDurSec = (layer.durationFrames && layer.durationFrames > 0)
      ? layer.durationFrames / fps
      : (Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : clipDurFrames / fps);

    const prev = node.videoLastLocal;
    const jumped = prev === undefined || Math.abs(local - prev) > JUMP_FRAMES;
    node.videoLastLocal = local;

    if (local < range.start) {
      if (!vid.paused) vid.pause();
      vid.loop = false;
      if (jumped || srcChanged) seekSec(0);
      show(false);
      return;
    }

    const elapsedSec = (local - range.start) / fps;
    const inClipWindow = local <= range.end;

    if (inClipWindow || layer.loop) {
      const target = targetFromElapsed(elapsedSec, mediaDurSec, layer.loop);
      show(true);
      vid.loop = layer.loop;

      if (!this.playing) {
        // Scrub / paused preview: freeze on the playhead frame.
        if (!vid.paused) vid.pause();
        seekSec(target);
        return;
      }

      // Transport playing: let the decoder free-run; resync only when needed.
      const drift = Math.abs((vid.currentTime || 0) - target);
      const needResync = jumped || srcChanged || vid.paused || drift > DRIFT_SEC;
      if (needResync) {
        seekSec(target, jumped || srcChanged);
        if (vid.paused) vid.play().catch(() => {});
      }
      return;
    }

    // After clip, non-loop
    if (!vid.paused) vid.pause();
    vid.loop = false;
    if (endBehavior === 'empty') {
      show(false);
      return;
    }
    seekSec(Math.max(0, mediaDurSec - 0.001));
    show(true);
  }

  private paintCrawl(
    layer: Extract<Layer, { type: 'crawl' }>,
    node: LayerNode,
    vars: Record<string, string | number>,
    _anim?: AnimatableValues,
  ): void {
    const track = node.crawlTrackEl
      ?? (node.contentEl?.querySelector('.titulus-crawl-track') as HTMLElement | null)
      ?? undefined;
    if (!track || !this.template) return;
    node.crawlTrackEl = track;

    const rawResolved = String(resolveBinding(layer.content, vars, ''));
    const maxEnabled = layer.crawl.maxTextLengthEnabled;
    const maxLen = layer.crawl.maxTextLength;
    const contentKey = `${rawResolved}\0${maxEnabled}\0${maxLen}`;

    // Always refresh lines when Content changes (fixes Parse while Use File is on).
    if (node.crawlContentKey !== contentKey) {
      node.crawlContentKey = contentKey;
      node.crawlLines = crawlLinesFromContent(rawResolved, layer.crawl);
    }

    const dir = this.template.timeline.directors.find((d) => d.id === layer.crawlDirectorId);
    const dur = Math.max(1, dir?.durationFrames ?? 1);
    const offset = dir?.offsetFrames ?? 0;
    const loop = layer.crawl.animationType === 'continuous' || Boolean(dir?.loop);
    let local: number;
    if (this.directorLocalFrames && layer.crawlDirectorId in this.directorLocalFrames) {
      local = this.directorLocalFrames[layer.crawlDirectorId] ?? 0;
    } else {
      local = crawlDirectorLocalFrame(this.frame, offset, dur, loop);
    }

    const epoch = Math.floor(local / dur);
    if (loop && node.crawlLoopEpoch !== undefined && epoch > node.crawlLoopEpoch) {
      // Force re-fetch from Use File path at end of each Continuous cycle.
      node.crawlFetchKey = undefined;
    }
    node.crawlLoopEpoch = epoch;

    // Use File / URL: (re)fetch when path key is new or was invalidated on loop.
    if (layer.crawl.useFile && layer.crawl.filePath) {
      const pathKey = `path:${layer.crawl.filePath}`;
      if (node.crawlFetchKey !== pathKey) {
        node.crawlFetchKey = pathKey;
        const path = layer.crawl.filePath;
        const token = (typeof location !== 'undefined'
          && new URLSearchParams(location.search).get('token')) || '';
        void fetch('/api/files/read', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ path }),
        })
          .then(async (r) => {
            if (!r.ok) throw new Error('read failed');
            return r.json() as Promise<{ text: string }>;
          })
          .then((data) => {
            if (node.crawlFetchKey !== pathKey) return;
            node.crawlLines = crawlLinesFromContent(data.text, layer.crawl);
            node.crawlContentKey = `${data.text}\0${maxEnabled}\0${maxLen}`;
            if (this.template) {
              const live = this.template.layers.find((l) => l.id === layer.id);
              if (live && live.type === 'crawl' && live.crawl.useFile) {
                live.content = data.text;
              }
            }
            this.applyCurrentState();
          })
          .catch(() => {});
      }
    } else if (/\.txt(\?|$)/i.test(rawResolved) || rawResolved.startsWith('/uploads/')) {
      const urlKey = `url:${rawResolved}`;
      if (node.crawlFetchKey !== urlKey) {
        node.crawlFetchKey = urlKey;
        void fetch(rawResolved)
          .then((r) => (r.ok ? r.text() : Promise.reject(new Error('missing'))))
          .then((text) => {
            if (node.crawlFetchKey !== urlKey) return;
            node.crawlLines = crawlLinesFromContent(text, layer.crawl);
            node.crawlContentKey = `${text}\0${maxEnabled}\0${maxLen}`;
            this.applyCurrentState();
          })
          .catch(() => {});
      }
    } else {
      node.crawlFetchKey = undefined;
    }

    const lines = node.crawlLines ?? crawlLinesFromContent(rawResolved, layer.crawl);
    const fill = String(resolveBinding(layer.style.fill, vars));
    const horizontal = layer.crawl.type === 'ticker';
    const fps = this.template.timeline.fps || 50;
    const align = layer.style.align ?? 'left';
    const useAlign = crawlAlignActive(layer.crawl);
    track.style.flexDirection = horizontal ? 'row' : 'column';
    if (!horizontal) {
      // Carousel: Align positions each line across the box width.
      track.style.width = '100%';
      track.style.alignItems = useAlign
        ? (align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start')
        : 'flex-start';
    } else {
      track.style.width = '';
      track.style.alignItems = 'center';
    }
    track.style.gap = layer.crawl.separatorMode === 'none' ? '0px' : '16px';

    const probe = sampleCrawlMotion({
      localFrame: local,
      lines,
      crawl: layer.crawl,
      boxW: layer.transform.width,
      boxH: layer.transform.height,
      fontSize: layer.style.fontSize,
      fps,
      measuredSpan: 1,
      align,
    });

    const renderLines = probe.activeLineIndex !== null
      ? [lines[probe.activeLineIndex] ?? '']
      : lines;
    const duplicate = probe.duplicateStrip;
    const transformMode = layer.style.textTransform ?? 'none';
    const sig = [
      renderLines.join('\u0001'),
      duplicate ? 'dup' : 'once',
      layer.crawl.separatorMode,
      layer.crawl.separatorText,
      layer.crawl.separatorImage,
      fill,
      String(layer.style.fontSize),
      transformMode,
      probe.activeLineIndex === null ? 'strip' : `line:${probe.activeLineIndex}`,
    ].join('|');

    if (node.cache.crawlSig !== sig) {
      node.cache.crawlSig = sig;
      track.replaceChildren();
      const appendSep = () => {
        if (layer.crawl.separatorMode === 'text') {
          const sep = document.createElement('span');
          applyTextStyleToEl(sep, layer.style, fill, { applyAlign: useAlign });
          sep.textContent = layer.crawl.separatorText;
          track.appendChild(sep);
        } else if (layer.crawl.separatorMode === 'image' && layer.crawl.separatorImage) {
          const img = document.createElement('img');
          img.src = layer.crawl.separatorImage;
          img.style.height = `${Math.max(16, layer.style.fontSize)}px`;
          img.style.width = 'auto';
          img.style.objectFit = 'contain';
          track.appendChild(img);
        }
      };
      const appendCopy = (copyLines: string[]) => {
        copyLines.forEach((line, i) => {
          if (i > 0) appendSep();
          const span = document.createElement('span');
          applyTextStyleToEl(span, layer.style, fill, { applyAlign: useAlign });
          span.textContent = formatCrawlLine(line, transformMode);
          track.appendChild(span);
        });
      };
      appendCopy(renderLines);
      if (duplicate && renderLines.length > 0) {
        if (layer.crawl.separatorMode !== 'none') appendSep();
        appendCopy(renderLines);
      }
    } else {
      // Style-only changes (shadow/align/weight…) must apply without waiting for text edits.
      for (const child of Array.from(track.children)) {
        if (child instanceof HTMLElement && child.tagName === 'SPAN') {
          applyTextStyleToEl(child, layer.style, fill, { applyAlign: useAlign });
        }
      }
    }

    const measuredSpan = Math.max(1, horizontal ? track.scrollWidth : track.scrollHeight);
    const measuredPeriod = duplicate ? Math.max(1, measuredSpan / 2) : measuredSpan;
    const motion = sampleCrawlMotion({
      localFrame: local,
      lines,
      crawl: layer.crawl,
      boxW: layer.transform.width,
      boxH: layer.transform.height,
      fontSize: layer.style.fontSize,
      fps,
      measuredSpan,
      measuredPeriod,
      align,
    });
    track.style.transform = `translate3d(${motion.x}px, ${motion.y}px, 0)`;
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
      const now = Date.now();
      const vars = this.variables;
      for (const layer of this.template.layers) {
        if (layer.type !== 'clock') continue;
        const node = this.layerEls.get(layer.id);
        if (node?.contentEl) {
          node.contentEl.textContent = formatClock(layer.format, layer.mode, now,
            this.resolveClockOpts(layer, vars, now));
        }
      }
    }, 1000) as unknown as number;
  }

  /** Resolve clock start/target — literal epoch or `time` variable expression. */
  private resolveClockOpts(
    layer: Extract<Layer, { type: 'clock' }>,
    vars: Record<string, string | number>,
    now: number,
  ): { startTime?: number; targetTime?: number } {
    const resolveField = (field: number | { type: 'variable'; variableId: string } | undefined): number | undefined => {
      if (field === undefined) return undefined;
      if (typeof field === 'object') {
        return parseTimeExpression(vars[field.variableId], now);
      }
      return field;
    };
    const startTime = resolveField(layer.startTime);
    const targetTime = resolveField(layer.targetTime);
    return {
      ...(startTime !== undefined ? { startTime } : {}),
      ...(targetTime !== undefined ? { targetTime } : {}),
    };
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
    let frameCarry = 0;
    const loop = (wall: number) => {
      if (!this.playing) return;
      if (this.rafLastWall !== null && this.template) {
        const fps = this.template.timeline.fps;
        const dt = wall - this.rafLastWall; // ms
        // Actions advance on exact integer frames; visual sampling follows the
        // display rAF with a fractional carry (smooth on 60/120 Hz monitors).
        frameCarry += Math.min(8, (dt / 1000) * fps);
        const frames = Math.floor(frameCarry);
        if (frames > 0) {
          frameCarry -= frames;
          if (this.useDirectorRuntime && this.directorRuntimes) {
            this.advanceDirectorRuntimes(frames);
            this.directorLocalFrames = localFramesMap(this.directorRuntimes);
          } else {
            this.frame += frames;
          }
        }
        if (this.useDirectorRuntime && this.directorRuntimes) {
          this.renderDirectorPlaybackFraction(frameCarry);
        } else {
          this.applyState(this.frame + frameCarry);
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
