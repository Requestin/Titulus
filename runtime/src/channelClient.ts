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

export type WsStatus = 'connecting' | 'connected' | 'disconnected';

/** A take/update/clear message on /ws/renderer (mirrors §7.4). */
export interface ChannelMessage {
  type: 'take' | 'update' | 'clear' | 'continue';
  templateId: string;
  template?: Template;      // present on 'take'
  variables?: Record<string, string | number>;
  channelId?: string;
  slotId?: string;
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
  /** Template reached Tag End scene — host should clear + mark Pending. */
  onEndScene?: (templateId: string) => void;
  /** Tag Update data — apply pending variables (Update-flow). */
  onUpdateData?: (templateId: string) => void;
}

interface ActiveTemplate {
  renderer: TemplateRenderer;
}

const DEFAULT_RECONNECT_MS = 3000;

export class ChannelClient {
  private opts: ChannelClientOptions;
  private ws: WebSocket | null = null;
  private status: WsStatus = 'disconnected';
  private active = new Map<string, ActiveTemplate>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

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
  }

  /** Current on-air template count (for the control-panel status badge). */
  activeCount(): number { return this.active.size; }

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
    this.active.set(id, { renderer });
    renderer.playTimeline(msg.template, msg.variables ?? {}, {
      ...(this.opts.onFrame ? { onFrame: this.opts.onFrame } : {}),
      onAction: (info) => {
        if (info.item.command !== 'tag') return;
        if (info.item.parameterTag === 'endScene') {
          this.onClear({ type: 'clear', templateId: id });
          this.opts.onEndScene?.(id);
          try {
            this.ws?.send(JSON.stringify({ type: 'endScene', templateId: id, channelId: this.opts.channelId }));
          } catch {
            // ignore
          }
        } else if (info.item.parameterTag === 'updateData') {
          const pending = renderer.takePendingUpdateVariables();
          if (pending) {
            const tpl = renderer.getTemplate();
            if (tpl) renderer.syncTemplate(tpl, pending);
          }
          this.opts.onUpdateData?.(id);
        }
      },
      onWaitingChange: (waiting) => {
        try {
          this.ws?.send(JSON.stringify({
            type: 'waitingContinue',
            templateId: id,
            channelId: this.opts.channelId,
            waiting,
          }));
        } catch {
          // ignore
        }
      },
    });
    this.opts.onActiveCount?.(this.active.size);
  }

  private onUpdate(msg: ChannelMessage): void {
    const a = this.active.get(msg.templateId);
    if (!a) return;
    // Update-flow: start Update director; variables apply at Update data tag (replace-all).
    a.renderer.startUpdateFlow(msg.variables ?? {});
  }

  private onContinue(msg: ChannelMessage): void {
    const a = this.active.get(msg.templateId);
    if (!a) return;
    a.renderer.continueWaitingDirectors();
  }

  private onClear(msg: ChannelMessage): void {
    const a = this.active.get(msg.templateId);
    if (!a) return;
    // MVP: clear immediately. (Out-animation would play a 'clear' director first
    // — left to a future enhancement once directors carry clear semantics.)
    a.renderer.destroy();
    this.active.delete(msg.templateId);
    this.opts.onActiveCount?.(this.active.size);
  }

  /** Expose current status for the page UI. */
  getStatus(): WsStatus { return this.status; }
}
