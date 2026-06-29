// backend/src/routes/ws.js
//
// WebSocket hubs + on-air REST (DEVELOPMENT_PROMPT §7.4).
//
//   /ws/control    control panel -> backend: {type:'take'|'update'|'clear', ...}
//                  forwarded to OnAirManager (state + persist + fan-out).
//   /ws/renderer   engine registers by ?channel=<id>; on connect the manager
//                  replays all current takes for that channel (state recovery).
//   GET /api/onair -> { channelId: [templateId,...] }

import { Router } from 'express';

export function wsRouter(db, onAir) {
  const router = Router();

  // Control panel -> backend. Multiple control clients may connect; all are
  // pure senders (we don't push anything back here — status comes via REST).
  router.ws('/control', (ws, req) => {
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // ignore malformed
      }
      try {
        onAir.handleControlCommand(msg);
      } catch (err) {
        // Keep WS hub alive on command processing errors; never crash backend
        // from a single malformed or failing control payload.
        const reason = err instanceof Error ? err.message : 'on-air command failed';
        try {
          ws.send(JSON.stringify({ type: 'error', error: reason }));
        } catch {
          // no-op
        }
      }
    });
  });

  // Engine / browser renderer -> backend. Registered by ?channel=<id>.
  router.ws('/renderer', (ws, req) => {
    const channelId = (req.query.channel || 'default').toString();
    onAir.registerRenderer(channelId, ws);
    // The runtime auto-reconnects on its own; we only clean up bookkeeping.
    ws.on('close', () => onAir.unregisterRenderer(channelId, ws));
    ws.on('error', () => onAir.unregisterRenderer(channelId, ws));
  });

  return router;
}
