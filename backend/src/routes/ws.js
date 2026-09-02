// backend/src/routes/ws.js
//
// WebSocket hubs + on-air REST (DEVELOPMENT_PROMPT §7.4).
//
//   /ws/control    control panel -> backend: {type:'take'|'update'|'clear'|'continue', ...}
//                  forwarded to OnAirManager (state + persist + fan-out).
//   /ws/renderer   engine registers by ?channel=<id>; on connect the manager
//                  replays all current takes for that channel (state recovery).
//   GET /api/onair -> { channelId: [templateId,...] }

import { Router } from 'express';
import { validateTemplateForAir } from '../templateValidation.js';

const MAX_WS_CONTROL_BYTES = 256 * 1024; // 256 KB safety cap
const SAFE_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;

function wsSendError(ws, code, message) {
  try {
    ws.send(JSON.stringify({ type: 'error', error: { code, message } }));
  } catch {
    // ignore socket send failures
  }
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function normalizeRendererMessage(msg) {
  if (!isPlainObject(msg)) {
    return { ok: false, code: 'INVALID_PAYLOAD', message: 'payload must be an object' };
  }
  if (msg.type !== 'waitingContinue' && msg.type !== 'endScene') {
    return { ok: false, code: 'UNKNOWN_TYPE', message: 'unsupported renderer message' };
  }
  if (typeof msg.templateId !== 'string' || !SAFE_ID_RE.test(msg.templateId)) {
    return { ok: false, code: 'INVALID_TEMPLATE_ID', message: 'templateId is required' };
  }
  if (msg.type === 'waitingContinue') {
    if (typeof msg.waiting !== 'boolean') {
      return { ok: false, code: 'INVALID_WAITING', message: 'waiting must be a boolean' };
    }
    return {
      ok: true,
      value: {
        type: 'waitingContinue',
        templateId: msg.templateId,
        waiting: msg.waiting,
      },
    };
  }
  if (msg.ended !== true) {
    return { ok: false, code: 'INVALID_ENDED', message: 'ended must be true' };
  }
  return {
    ok: true,
    value: {
      type: 'endScene',
      templateId: msg.templateId,
      ended: true,
    },
  };
}

export function applyRendererMessage(onAir, channelId, msg) {
  const normalized = normalizeRendererMessage(msg);
  if (!normalized.ok) return normalized;
  if (normalized.value.type === 'waitingContinue') {
    onAir.setWaitingContinue(channelId, normalized.value.templateId, normalized.value.waiting);
  } else {
    onAir.applyClear({ type: 'clear', channelId, templateId: normalized.value.templateId });
    onAir.setWaitingContinue(channelId, normalized.value.templateId, false);
  }
  return normalized;
}

export function normalizeControlMessage(msg) {
  if (!isPlainObject(msg)) {
    return { ok: false, code: 'INVALID_PAYLOAD', message: 'payload must be an object' };
  }
  const { type, channelId, templateId, template, variables, slotId } = msg;
  if (typeof type !== 'string') {
    return { ok: false, code: 'TYPE_REQUIRED', message: 'type is required' };
  }
  if (!['take', 'update', 'clear', 'continue'].includes(type)) {
    return { ok: false, code: 'UNKNOWN_TYPE', message: `unsupported command type: ${type}` };
  }
  if (typeof channelId !== 'string' || !SAFE_ID_RE.test(channelId)) {
    return { ok: false, code: 'INVALID_CHANNEL_ID', message: 'channelId must match [a-zA-Z0-9._:-]{1,128}' };
  }
  if (type === 'take') {
    if (typeof templateId !== 'string' || !SAFE_ID_RE.test(templateId)) {
      return { ok: false, code: 'INVALID_TEMPLATE_ID', message: 'templateId is required for take' };
    }
    if (!isPlainObject(template)) {
      return { ok: false, code: 'INVALID_TEMPLATE', message: 'template object is required for take' };
    }
    const validation = validateTemplateForAir(template);
    if (!validation.valid) {
      const reason = validation.errors
        .map((error) => `${error.path || '/'}: ${error.message || error.code || 'invalid template'}`)
        .join('; ');
      return {
        ok: false,
        code: 'TEMPLATE_UNSUPPORTED_FOR_AIR',
        message: `template is unsupported for air: ${reason}`,
      };
    }
  }
  if (type === 'update') {
    if (typeof templateId !== 'string' || !SAFE_ID_RE.test(templateId)) {
      return { ok: false, code: 'INVALID_TEMPLATE_ID', message: 'templateId is required for update' };
    }
    if (variables !== undefined && !isPlainObject(variables)) {
      return { ok: false, code: 'INVALID_VARIABLES', message: 'variables must be an object' };
    }
  }
  if (type === 'continue') {
    if (typeof templateId !== 'string' || !SAFE_ID_RE.test(templateId)) {
      return { ok: false, code: 'INVALID_TEMPLATE_ID', message: 'templateId is required for continue' };
    }
  }
  if (type === 'clear' && templateId !== undefined) {
    if (typeof templateId !== 'string' || !SAFE_ID_RE.test(templateId)) {
      return { ok: false, code: 'INVALID_TEMPLATE_ID', message: 'templateId must match [a-zA-Z0-9._:-]{1,128}' };
    }
  }
  return {
    ok: true,
    value: {
      type,
      channelId,
      templateId,
      template,
      variables,
      slotId: typeof slotId === 'string' && SAFE_ID_RE.test(slotId) ? slotId : undefined,
    },
  };
}

function parseControlToken(req) {
  const q = typeof req.query?.token === 'string' ? req.query.token.trim() : '';
  if (q) return q;
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? match[1].trim() : '';
}

export function wsRouter(onAir, auth) {
  const router = Router();

  // Control panel -> backend. Multiple control clients may connect; all are
  // pure senders (we don't push anything back here — status comes via REST).
  router.ws('/control', (ws, req) => {
    const token = parseControlToken(req);
    const session = auth?.authenticateToken ? auth.authenticateToken(token) : null;
    if (!session) {
      wsSendError(ws, 'AUTH_INVALID', 'valid auth token required');
      try {
        ws.close(4401, 'unauthorized');
      } catch {
        // ignore close errors
      }
      return;
    }
    const canControl = session.role === 'admin' || session.role === 'operator';
    if (!canControl) {
      wsSendError(ws, 'FORBIDDEN', 'insufficient role');
      try {
        ws.close(4403, 'forbidden');
      } catch {
        // ignore close errors
      }
      return;
    }

    ws.on('message', async (raw) => {
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '');
      if (Buffer.byteLength(text, 'utf8') > MAX_WS_CONTROL_BYTES) {
        wsSendError(ws, 'MESSAGE_TOO_LARGE', 'control payload exceeds 256 KB');
        try {
          ws.close(1009, 'message too large');
        } catch {
          // ignore close errors
        }
        return;
      }

      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        wsSendError(ws, 'INVALID_JSON', 'malformed JSON payload');
        return;
      }

      const normalized = normalizeControlMessage(msg);
      if (!normalized.ok) {
        wsSendError(ws, normalized.code, normalized.message);
        return;
      }

      try {
        await onAir.handleControlCommand(normalized.value);
        ws.send(JSON.stringify({
          type: 'ack',
          command: normalized.value.type,
          channelId: normalized.value.channelId,
          templateId: normalized.value.templateId,
        }));
      } catch (err) {
        // Keep WS hub alive on command processing errors; never crash backend
        // from a single malformed or failing control payload.
        const reason = err instanceof Error ? err.message : 'on-air command failed';
        wsSendError(ws, 'COMMAND_FAILED', reason);
      }
    });
  });

  // Engine / browser renderer -> backend. Registered by ?channel=<id>.
  router.ws('/renderer', (ws, req) => {
    const requested = (req.query.channel || 'default').toString();
    const channelId = SAFE_ID_RE.test(requested) ? requested : 'default';
    onAir.registerRenderer(channelId, ws);
    // The runtime auto-reconnects on its own; we only clean up bookkeeping.
    ws.on('close', () => onAir.unregisterRenderer(channelId, ws));
    ws.on('error', () => onAir.unregisterRenderer(channelId, ws));
    ws.on('message', async (raw) => {
      let parsed;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      applyRendererMessage(onAir, channelId, parsed);
    });
  });

  return router;
}
