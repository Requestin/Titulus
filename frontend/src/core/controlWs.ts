// frontend/src/core/controlWs.ts
//
// Control-panel WebSocket (DEVELOPMENT_PROMPT §7.4). The operator sends
// take/update/clear commands to /ws/control; the backend OnAirManager persists
// + fans them out to renderers. Auto-reconnects every 3s. Vite proxies /ws.
// Backend also pushes { type: 'onAir', onAir } so Control UI needs no HTTP poll.

import { create } from 'zustand';
import { getSessionToken } from '@/core/session';
import type { OnAirSnapshot } from '@/core/api';

export type WsStatus = 'disconnected' | 'connecting' | 'connected';

export interface ControlCommand {
  type: 'take' | 'update' | 'clear' | 'continue';
  channelId: string;
  templateId?: string;
  template?: unknown;
  variables?: Record<string, string | number>;
  slotId?: string;
}

type OnAirListener = (onAir: OnAirSnapshot) => void;

interface ControlWsState {
  status: WsStatus;
  ws: WebSocket | null;
  onAir: OnAirSnapshot;
  connect: () => void;
  disconnect: () => void;
  send: (cmd: ControlCommand) => boolean;
  /** Subscribe to on-air snapshot pushes; returns unsubscribe. */
  subscribeOnAir: (listener: OnAirListener) => () => void;
}

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const token = getSessionToken();
  const suffix = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${proto}://${location.host}/ws/control${suffix}`;
}

const onAirListeners = new Set<OnAirListener>();

function emitOnAir(onAir: OnAirSnapshot) {
  for (const fn of onAirListeners) {
    try {
      fn(onAir);
    } catch {
      // ignore listener errors
    }
  }
}

export const useControlWs = create<ControlWsState>((set, get) => ({
  status: 'disconnected',
  ws: null,
  onAir: {},
  connect: () => {
    const cur = get().ws;
    if (cur && (cur.readyState === WebSocket.OPEN || cur.readyState === WebSocket.CONNECTING)) return;
    set({ status: 'connecting' });
    const ws = new WebSocket(wsUrl());
    ws.onopen = () => set({ status: 'connected' });
    ws.onmessage = (ev) => {
      let msg: { type?: string; onAir?: OnAirSnapshot };
      try {
        msg = JSON.parse(String(ev.data)) as { type?: string; onAir?: OnAirSnapshot };
      } catch {
        return;
      }
      if (msg.type === 'onAir' && msg.onAir && typeof msg.onAir === 'object') {
        set({ onAir: msg.onAir });
        emitOnAir(msg.onAir);
      }
    };
    ws.onclose = () => {
      set({ status: 'disconnected', ws: null });
      window.setTimeout(() => get().connect(), 3000);
    };
    ws.onerror = () => ws.close();
    set({ ws });
  },
  disconnect: () => {
    const ws = get().ws;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    set({ ws: null, status: 'disconnected' });
  },
  send: (cmd) => {
    const ws = get().ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(cmd));
      return true;
    }
    return false;
  },
  subscribeOnAir: (listener) => {
    onAirListeners.add(listener);
    const cur = get().onAir;
    if (Object.keys(cur).length > 0) listener(cur);
    return () => {
      onAirListeners.delete(listener);
    };
  },
}));
