// runtime/src/channelClient.ts
//
// class ChannelClient — WebSocket client for the engine / browser renderer page
// (DEVELOPMENT_PROMPT §6.4, §7.4).
//
// Connects to the backend's /ws/renderer?channel=<id>, receives take/update/clear
// commands, and manages one TemplateRenderer per on-air template. The backend
// replays all current take commands on connect (§7.4 state recovery) so a
// reconnecting engine restores the picture without operator intervention.
//
// Stack semantics (§6.4): multiple templates coexist in #stage with absolute
// positioning; take adds, clear removes (with out-animation), update mutates
// variables live.
//
// Two playback modes are passed through to TemplateRenderer:
//   - engine mode   : playbackMode 'fixed', fixedTickRate = channel fps
//   - browser mode  : playbackMode 'raf'
// The engine host calls ChannelClient.tick() each fixed-step frame; the browser
// page just lets the rAF loop run.

import type { Template } from './schema.js';
import { TemplateRenderer, type TemplateRendererOptions, type OnFrameFn } from './domRenderer.js';
import { classifyRenderGraph } from './layerPromote.js';
import { isGraphPublishingEnabled, publishTemplateGraph } from './graphPublisher.js';
import {
  selectPacingIdentity,
  type PacingIdentity,
} from './pacingProtocol.js';
import { diffWaitingContinue } from './waitingContinueReport.js';
export type WsStatus = 'connecting' | 'connected' | 'disconnected';

/** A take/update/clear message on /ws/renderer (mirrors §7.4). */
export interface ChannelMessage {
  type: 'take' | 'update' | 'clear' | 'continue';
  templateId: string;
  template?: Template;      // present on 'take'
  variables?: Record<string, string | number>;
  channelId?: string;
}

export interface ChannelClientOptions {
  stage: HTMLElement;
  channelId?: string;                          // default 'default'
  /** Backend base, e.g. 'localhost:3001'. */
  backend?: string;
  /** ws/wss scheme; defaults inferred from page protocol. */
  wsScheme?: 'ws' | 'wss';
  playbackMode?: 'fixed' | 'raf';
  fixedTickRate?: number;
  /** Auto-reconnect delay (ms). 0 disables auto-reconnect. */
  reconnectDelayMs?: number;
  onStatus?: (s: WsStatus) => void;
  /** Active on-air template count changed. */
  onActiveCount?: (n: number) => void;
  /**
   * Per-frame renderer callback forwarded to every active TemplateRenderer
   * (Phase 9.1). Used by the channel.html `hud=1` overlay and bench harness to
   * surface RenderStats. Only fires for the most recently ticked renderer.
   */
  onFrame?: OnFrameFn;
}

interface ActiveTemplate {
  renderer: TemplateRenderer;
  template: Template;
  analysis: ReturnType<typeof classifyRenderGraph>;
  graphRevision: number;
  stateRevision: number;
  dynamicGraph: boolean;
}

const DEFAULT_RECONNECT_MS = 3000;

export class ChannelClient {
  private opts: ChannelClientOptions;
  private ws: WebSocket | null = null;
  private status: WsStatus = 'disconnected';
  private active = new Map<string, ActiveTemplate>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private nextGraphRevision = 1;
  private lastWaitingContinue = new Map<string, boolean>();

  constructor(opts: ChannelClientOptions) {
    this.opts = opts;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.disposed = false;
    const url = this.buildUrl();
    this.setStatus('connecting');
    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      this.handleDisconnect(String(err));
      return;
    }
    this.ws.onopen = () => this.setStatus('connected');
    this.ws.onclose = () => this.handleDisconnect('closed');
    this.ws.onerror = () => { /* close handler will fire */ };
    this.ws.onmessage = (ev) => this.onMessage(ev.data);
  }

  disconnect(): void {
    this.disposed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.setStatus('disconnected');
  }

  /**
   * Advance every active template by one frame. Engine 'fixed' mode only — the
   * host calls this from its channel-fps tick loop. No-op in 'raf' mode.
   */
  tick(): void {
    if (this.opts.playbackMode !== 'fixed') return;
    for (const a of this.active.values()) a.renderer.tick();
    this.reportWaitingContinue();
  }

  /** Current on-air template count (for the control-panel status badge). */
  activeCount(): number { return this.active.size; }

  /**
   * P20.1: provenance snapshot for one rAF heartbeat. Multiple on-air
   * templates deliberately remain ambiguous; no arbitrary template is chosen.
   */
  getPacingIdentity(): PacingIdentity {
    return selectPacingIdentity(
      [...this.active.entries()].map(([templateId, active]) => ({
        templateId,
        logicalFrame: active.renderer.getFrame(),
        graphRevision: active.graphRevision,
        stateRevision: active.stateRevision,
      })),
    );
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private buildUrl(): string {
    const channelId = encodeURIComponent(this.opts.channelId ?? 'default');
    // Default to the page's origin so the engine page and editor both work
    // without configuration. Allow override via opts.backend.
    let host: string;
    let scheme: string;
    if (this.opts.backend) {
      host = this.opts.backend;
      scheme = this.opts.wsScheme ?? (location.protocol === 'https:' ? 'wss' : 'ws');
    } else if (typeof location !== 'undefined') {
      host = location.host;
      scheme = this.opts.wsScheme ?? (location.protocol === 'https:' ? 'wss' : 'ws');
    } else {
      host = 'localhost:3001';
      scheme = 'ws';
    }
    return `${scheme}://${host}/ws/renderer?channel=${channelId}`;
  }

  private setStatus(s: WsStatus): void {
    this.status = s;
    this.opts.onStatus?.(s);
  }

  private handleDisconnect(reason: string): void {
    if (this.ws) { this.ws = null; }
    this.setStatus('disconnected');
    if (this.disposed) return;
    const delay = this.opts.reconnectDelayMs ?? DEFAULT_RECONNECT_MS;
    if (delay > 0) {
      // DEVELOPMENT_PROMPT §7.4: auto-reconnect every 3s on disconnect.
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    }
    void reason;
  }

  private onMessage(raw: string): void {
    let msg: ChannelMessage;
    try {
      msg = JSON.parse(raw) as ChannelMessage;
    } catch {
      return; // ignore malformed
    }
    switch (msg.type) {
      case 'take':  this.onTake(msg); break;
      case 'update':this.onUpdate(msg); break;
      case 'clear': this.onClear(msg); break;
      case 'continue': this.onContinue(msg); break;
    }
  }

  private reportWaitingContinue(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const { changed, snapshot } = diffWaitingContinue(
      this.lastWaitingContinue,
      [...this.active.entries()].map(([templateId, active]) => (
        [templateId, active.renderer.waitingContinue()] as const
      )),
    );
    this.lastWaitingContinue = snapshot;
    for (const report of changed) {
      this.ws.send(JSON.stringify({
        type: 'waitingContinue',
        templateId: report.templateId,
        waiting: report.waiting,
      }));
    }
  }

  private onContinue(msg: ChannelMessage): void {
    const active = this.active.get(msg.templateId);
    if (!active) return;
    active.renderer.continueDirectors();
    this.reportWaitingContinue();
  }

  private rendererOpts(): TemplateRendererOptions {
    return {
      playbackMode: this.opts.playbackMode ?? 'raf',
      fixedTickRate: this.opts.fixedTickRate,
    };
  }

  private onTake(msg: ChannelMessage): void {
    if (!msg.template) return;
    const id = msg.templateId;
    // Replace if already on air (re-take = update template structure + restart).
    const prev = this.active.get(id);
    if (prev) { prev.renderer.destroy(); this.active.delete(id); }
    const renderer = new TemplateRenderer(this.opts.stage, this.rendererOpts());
    const analysis = classifyRenderGraph(msg.template);
    const active: ActiveTemplate = {
      renderer,
      template: msg.template,
      analysis,
      graphRevision: this.nextGraphRevision++,
      stateRevision: 0,
      dynamicGraph: Object.values(analysis.layers).some(
        (node) => node.dirtyDomains.includes('props_dirty')
          || node.dirtyDomains.includes('mask_dirty'),
      ),
    };
    this.active.set(id, active);
    renderer.playTimeline(msg.template, msg.variables ?? {},
      {
        onFrame: (info) => {
          this.opts.onFrame?.(info);
          this.publishGraphFrame(id);
          this.reportWaitingContinue();
        },
      });
    this.opts.onActiveCount?.(this.active.size);
    this.publishCurrentGraph();
    this.reportWaitingContinue();
  }

  private emitGraphLine(line: string | null): void {
    if (!line) return;
    // eslint-disable-next-line no-console
    console.log(line);
  }

  private emitFallbackGraph(graphRevision: number): void {
    this.emitGraphLine(
      `BGGRAPH v1 {"type":"snapshot","graph_rev":${graphRevision},`
      + '"state_rev":0,"layers":[]}',
    );
  }

  private publishCurrentGraph(): void {
    if (!isGraphPublishingEnabled(globalThis)) return;
    if (this.active.size !== 1) {
      this.emitFallbackGraph(this.nextGraphRevision++);
      return;
    }
    const active = this.active.values().next().value as ActiveTemplate;
    active.graphRevision = this.nextGraphRevision++;
    active.stateRevision = 0;
    if (!active.analysis.supported) {
      this.emitFallbackGraph(active.graphRevision);
      return;
    }
    const layouts = active.renderer.getProtocolFrameLayouts(active.analysis);
    const line = publishTemplateGraph(
      active.template,
      active.graphRevision,
      active.stateRevision,
      active.analysis,
      layouts ? (layerId) => layouts[layerId] ?? null : undefined,
    );
    if (line) this.emitGraphLine(line);
    else this.emitFallbackGraph(active.graphRevision);
  }

  private publishGraphFrame(templateId: string): void {
    if (!isGraphPublishingEnabled(globalThis) || this.active.size !== 1) return;
    const active = this.active.get(templateId);
    if (!active || !active.dynamicGraph || !active.analysis.supported) return;
    const layouts = active.renderer.getProtocolFrameLayouts(active.analysis);
    if (!layouts) return;
    active.stateRevision += 1;
    const line = publishTemplateGraph(
      active.template,
      active.graphRevision,
      active.stateRevision,
      active.analysis,
      (layerId) => layouts[layerId] ?? null,
    );
    if (line) {
      this.emitGraphLine(line);
    } else {
      active.dynamicGraph = false;
      active.graphRevision = this.nextGraphRevision++;
      this.emitFallbackGraph(active.graphRevision);
    }
  }

  private publishContentUpdate(active: ActiveTemplate): void {
    if (!isGraphPublishingEnabled(globalThis) || this.active.size !== 1
        || !active.analysis.supported) return;
    const layouts = active.renderer.getProtocolFrameLayouts(active.analysis);
    if (!layouts) return;
    const invalidated = Object.entries(active.analysis.layers)
      .filter(([, node]) => node.nodeKind === 'cached_bitmap'
        && node.dirtyDomains.includes('content_dirty'))
      .map(([id]) => id);
    active.stateRevision += 1;
    const line = publishTemplateGraph(
      active.template,
      active.graphRevision,
      active.stateRevision,
      active.analysis,
      (layerId) => layouts[layerId] ?? null,
      invalidated,
    );
    if (line) this.emitGraphLine(line);
    else {
      active.graphRevision = this.nextGraphRevision++;
      this.emitFallbackGraph(active.graphRevision);
    }
  }

  private onUpdate(msg: ChannelMessage): void {
    const a = this.active.get(msg.templateId);
    if (!a) return;
    // Live variable change: re-sync the same template with new variables without
    // restarting the timeline (keeps the current playhead).
    const tpl = a.renderer.getTemplate();
    if (tpl) {
      a.renderer.syncTemplate(tpl, msg.variables ?? {});
      this.publishContentUpdate(a);
    }
  }

  private onClear(msg: ChannelMessage): void {
    const a = this.active.get(msg.templateId);
    if (!a) return;
    // MVP: clear immediately. (Out-animation would play a 'clear' director first
    // — left to a future enhancement once directors carry clear semantics.)
    a.renderer.destroy();
    this.active.delete(msg.templateId);
    this.lastWaitingContinue.delete(msg.templateId);
    this.opts.onActiveCount?.(this.active.size);
    this.publishCurrentGraph();
    this.reportWaitingContinue();
  }

  /** Expose current status for the page UI. */
  getStatus(): WsStatus { return this.status; }

  /**
   * Doc02 PR5: per-layer visibility filter pass-through. The engine calls this
   * through `__titulus.setLayerVisibilityFilter` while capturing per-layer
   * snapshots. Pass `null` for `visibleIds` to clear the filter. Pass `"*"`
   * (or empty string) for `templateId` to apply to every active template —
   * the engine does not know the authoring UUID a priori.
   */
  setLayerVisibilityFilter(templateId: string, visibleIds: string[] | null): void {
    const apply = (a: ActiveTemplate) => {
      a.renderer.setLayerVisibilityFilter(visibleIds ? new Set(visibleIds) : null);
    };
    if (!templateId || templateId === '*') {
      for (const a of this.active.values()) apply(a);
      return;
    }
    const a = this.active.get(templateId);
    if (!a) return;
    apply(a);
  }

  /** Isolate one source in a tight origin-aligned capture host. */
  async setLayerCaptureMode(
    templateId: string,
    layerId: string | null,
    padding = 32,
    captureSeq = 0,
  ): Promise<void> {
    const apply = (active: ActiveTemplate) =>
      active.renderer.setLayerCaptureMode(layerId, padding, captureSeq);
    if (!templateId || templateId === '*') {
      await Promise.all([...this.active.values()].map(apply));
      return;
    }
    const active = this.active.get(templateId);
    if (active) await apply(active);
  }
}
