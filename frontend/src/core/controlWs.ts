// frontend/src/core/controlWs.ts
//
// Control-panel WebSocket (DEVELOPMENT_PROMPT §7.4). The operator sends
// take/update/clear commands to /ws/control; the backend OnAirManager persists
// + fans them out to renderers. Auto-reconnects every 3s. Vite proxies /ws.

import { create } from 'zustand';

export type WsStatus = 'disconnected' | 'connecting' | 'connected';

export interface ControlCommand {
  type: 'take' | 'update' | 'clear';
  channelId: string;
  templateId?: string;
  template?: unknown;
  variables?: Record<string, string | number>;
}

interface ControlWsState {
  status: WsStatus;
  ws: WebSocket | null;
  connect: () => void;
  disconnect: () => void;
  send: (cmd: ControlCommand) => boolean;
}

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws/control`;
}

export const useControlWs = create<ControlWsState>((set, get) => ({
  status: 'disconnected',
  ws: null,
  connect: () => {
    const cur = get().ws;
    if (cur && (cur.readyState === WebSocket.OPEN || cur.readyState === WebSocket.CONNECTING)) return;
    set({ status: 'connecting' });
    const ws = new WebSocket(wsUrl());
    ws.onopen = () => set({ status: 'connected' });
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
}));
