// backend/src/onair.js
//
// On-air state manager (DEVELOPMENT_PROMPT §7.4, NFR-1).
//
// Holds the in-memory on-air state, persists every take/clear to SQLite (so a
// backend restart can replay the picture), and fans commands out to the
// renderer WebSockets registered per channel.
//
// Two WS hubs (§7.4):
//   /ws/control   <- control panel sends take/clear/update
//   /ws/renderer  <- engine registers by ?channel=<id>; on connect the manager
//                    replays all current takes for that channel (state recovery)
//
// The manager is engine-agnostic: it just routes JSON messages.

import { onAirDao, settingsDao } from './db.js';
import { validateTemplateForAir } from './templateValidation.js';
import { hasUpdateDirectorTracks, sourceTemplateId } from './updateDirector.js';

function airValidationError(validation) {
  const reason = validation.errors
    .map((error) => `${error.path || '/'}: ${error.message || error.code || 'invalid template'}`)
    .join('; ');
  const error = new Error(
    `TEMPLATE_UNSUPPORTED_FOR_AIR: unsupported template capability: ${reason}`,
  );
  error.code = 'TEMPLATE_UNSUPPORTED_FOR_AIR';
  error.details = validation.errors;
  return error;
}

function isPersistedTakeSupportedForAir(cmd) {
  return cmd?.type === 'take' && validateTemplateForAir(cmd.template).valid;
}

function resolveLayerId(template) {
  const value = Number(template?.layerId);
  if (!Number.isInteger(value)) return 50;
  return Math.min(99, Math.max(1, value));
}

function layerIdPlayoutEnabled(db) {
  return settingsDao(db).all().layerIdPlayout !== 'off';
}

export class OnAirManager {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db, options = {}) {
    this.db = db;
    this.prepare = options.prepare || null;
    this.dao = onAirDao(db);
    // channelId -> Set<WebSocket>  (renderer clients)
    this.renderers = new Map();
    // In-memory mirror of on_air for /api/onair without a DB hit per request.
    // Unsupported persisted takes are quarantined from active state and replay,
    // but their DB rows remain intact for explicit operator recovery or clear.
    this.state = {};
    this.quarantined = {};
    this.waitingContinue = new Map();
    for (const [channelId, commands] of Object.entries(this.dao.all())) {
      const active = [];
      const quarantined = [];
      for (const command of commands) {
        (isPersistedTakeSupportedForAir(command) ? active : quarantined).push(command);
      }
      if (active.length > 0) this.state[channelId] = active;
      if (quarantined.length > 0) this.quarantined[channelId] = quarantined;
    }
  }

  // -------------------------------------------------------------------------
  // Renderer registration
  // -------------------------------------------------------------------------

  /** Register a renderer WS for a channel; replay current on-air takes to it. */
  registerRenderer(channelId, ws) {
    if (!this.renderers.has(channelId)) this.renderers.set(channelId, new Set());
    this.renderers.get(channelId).add(ws);
    // Clear quarantined IDs first so a renderer cannot retain an unsupported
    // picture from before the backend restart, then replay validated active takes.
    for (const cmd of this.quarantined[channelId] || []) {
      this.safeSend(ws, { type: 'clear', channelId, templateId: cmd.templateId });
    }
    for (const cmd of this.state[channelId] || []) {
      this.safeSend(ws, cmd);
    }
  }

  unregisterRenderer(channelId, ws) {
    const set = this.renderers.get(channelId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this.renderers.delete(channelId);
  }

  // -------------------------------------------------------------------------
  // Control commands (from /ws/control)
  // -------------------------------------------------------------------------

  /** Apply a take/clear/update command: mutate state, persist, fan out. */
  handleControlCommand(cmd) {
    if (!cmd || !cmd.type || !cmd.channelId) return;
    if (cmd.type === 'take') {
      if (!cmd.templateId || !cmd.template) return;
      const validation = validateTemplateForAir(cmd.template);
      if (!validation.valid) throw airValidationError(validation);
    }
    switch (cmd.type) {
      case 'take':   return this.applyTake(cmd);
      case 'update': return this.applyUpdate(cmd);
      case 'clear':  return this.applyClear(cmd);
      case 'continue': return this.applyContinue(cmd);
      default:       return;
    }
  }

  async applyTake(cmd) {
    if (!cmd.templateId || !cmd.template) return;
    if (this.prepare) {
      const prepared = await this.prepare(cmd.template, { trigger: 'take', variables: cmd.variables });
      if (prepared.blocked) {
        const error = new Error(prepared.errors?.[0]?.message || 'data pipeline blocked take');
        error.code = 'DATA_BLOCKED';
        error.details = prepared.errors;
        throw error;
      }
      cmd = {
        ...cmd,
        template: prepared.template,
        variables: { ...(cmd.variables || {}), ...prepared.overrides },
      };
    }
    const layerId = resolveLayerId(cmd.template);
    cmd = { ...cmd, layerId, slotId: cmd.slotId || cmd.templateId };
    const existing = (this.state[cmd.channelId] || []).find((c) => c.templateId === cmd.templateId);
    if (existing && hasUpdateDirectorTracks(existing.template?.timeline)) {
      return this.applyUpdate({
        type: 'update',
        channelId: cmd.channelId,
        templateId: existing.templateId,
        variables: cmd.variables,
        slotId: cmd.slotId,
      });
    }
    if (layerIdPlayoutEnabled(this.db)) {
      const occupants = this.state[cmd.channelId] || [];
      for (const occupant of occupants) {
        if (occupant.templateId === cmd.templateId) continue;
        if ((occupant.layerId ?? resolveLayerId(occupant.template)) !== layerId) continue;
        if (
          sourceTemplateId(occupant) === sourceTemplateId(cmd)
          && hasUpdateDirectorTracks(occupant.template?.timeline)
        ) {
          return this.applyUpdate({
            type: 'update',
            channelId: cmd.channelId,
            templateId: occupant.templateId,
            variables: cmd.variables,
            slotId: cmd.slotId,
          });
        }
        this.applyClear({ type: 'clear', channelId: cmd.channelId, templateId: occupant.templateId });
      }
    }
    this.dao.set(cmd, { bringToFront: true }); // persist with z-order bump
    if (this.quarantined[cmd.channelId]) {
      this.quarantined[cmd.channelId] = this.quarantined[cmd.channelId]
        .filter((command) => command.templateId !== cmd.templateId);
      if (this.quarantined[cmd.channelId].length === 0) delete this.quarantined[cmd.channelId];
    }
    if (!this.state[cmd.channelId]) this.state[cmd.channelId] = [];
    // Replace any existing take of the same templateId.
    this.state[cmd.channelId] = this.state[cmd.channelId].filter((c) => c.templateId !== cmd.templateId);
    this.state[cmd.channelId].push(cmd);
    this.fanout(cmd.channelId, cmd);
  }

  async applyUpdate(cmd) {
    if (!cmd.templateId) return;
    // Active in-memory state is authoritative: a persisted but quarantined take
    // must not be resurrected by an update.
    const arr = this.state[cmd.channelId];
    const idx = arr?.findIndex((c) => c.templateId === cmd.templateId) ?? -1;
    if (idx < 0) return; // update for something not actively on air -> ignore
    // Update mutates variables live: persist only the variables delta is not
    // enough — re-stitch the active take command and persist it in place.
    const stored = arr[idx];
    let incoming = cmd.variables || {};
    if (this.prepare && stored.template) {
      const prepared = await this.prepare(stored.template, { trigger: 'update', variables: { ...(stored.variables || {}), ...incoming } });
      if (prepared.blocked) {
        const error = new Error(prepared.errors?.[0]?.message || 'data pipeline blocked update');
        error.code = 'DATA_BLOCKED';
        error.details = prepared.errors;
        throw error;
      }
      incoming = { ...incoming, ...prepared.overrides };
      stored.template = prepared.template;
    }
    const next = {
      ...stored,
      variables: { ...(stored.variables || {}), ...incoming },
      slotId: cmd.slotId || stored.slotId || stored.templateId,
    };
    this.dao.set(next, { bringToFront: false });
    arr[idx] = next;
    this.state[cmd.channelId] = arr;
    // Fan out the resolved update. Runtime onUpdate merges live variables.
    this.fanout(cmd.channelId, { ...cmd, variables: incoming });
  }

  applyClear(cmd) {
    if (!cmd.templateId) {
      // CLEAR ALL for the channel: snapshot quarantined and active IDs first,
      // then purge memory + persistence and fan out one clear per template so every
      // renderer tears each one down (the runtime clears by templateId).
      const quarantined = (this.quarantined[cmd.channelId] || []).map((c) => c.templateId);
      const active = (this.state[cmd.channelId] || []).map((c) => c.templateId);
      this.dao.clearChannel(cmd.channelId);
      delete this.quarantined[cmd.channelId];
      delete this.state[cmd.channelId];
      for (const templateId of [...quarantined, ...active]) {
        this.fanout(cmd.channelId, { type: 'clear', templateId, channelId: cmd.channelId });
      }
      return;
    }
    this.dao.remove(cmd.channelId, cmd.templateId);
    this.setWaitingContinue(cmd.channelId, cmd.templateId, false);
    if (this.quarantined[cmd.channelId]) {
      this.quarantined[cmd.channelId] = this.quarantined[cmd.channelId]
        .filter((c) => c.templateId !== cmd.templateId);
      if (this.quarantined[cmd.channelId].length === 0) delete this.quarantined[cmd.channelId];
    }
    if (this.state[cmd.channelId]) {
      this.state[cmd.channelId] = this.state[cmd.channelId].filter((c) => c.templateId !== cmd.templateId);
      if (this.state[cmd.channelId].length === 0) delete this.state[cmd.channelId];
    }
    this.fanout(cmd.channelId, cmd);
  }

  applyContinue(cmd) {
    if (!cmd.templateId) return;
    this.setWaitingContinue(cmd.channelId, cmd.templateId, false);
    this.fanout(cmd.channelId, {
      type: 'continue',
      channelId: cmd.channelId,
      templateId: cmd.templateId,
    });
  }

  waitingKey(channelId, templateId) {
    return `${channelId}\0${templateId}`;
  }

  setWaitingContinue(channelId, templateId, waiting) {
    const key = this.waitingKey(channelId, templateId);
    if (waiting) this.waitingContinue.set(key, true);
    else this.waitingContinue.delete(key);
  }

  isWaitingContinue(channelId, templateId) {
    return this.waitingContinue.get(this.waitingKey(channelId, templateId)) === true;
  }

  /** Public snapshot for /api/onair: { channelId: [templateId,...] }. */
  onAirTemplateIds() {
    const out = {};
    for (const [ch, cmds] of Object.entries(this.state)) {
      out[ch] = cmds.map((c) => c.templateId);
    }
    return out;
  }

  /** Versioned sibling of /api/onair. Never replace the string[] snapshot. */
  onAirDetails() {
    const channels = {};
    for (const [ch, cmds] of Object.entries(this.state)) {
      channels[ch] = cmds.map((c) => ({
        templateId: c.templateId,
        slotId: c.slotId || c.templateId,
        sourceTemplateId: c.template?.id || c.templateId,
        layerId: c.layerId ?? resolveLayerId(c.template),
        waitingContinue: this.isWaitingContinue(ch, c.templateId),
      }));
    }
    return { schemaVersion: 'onair-details-v1', channels };
  }

  // -------------------------------------------------------------------------
  // Fan-out
  // -------------------------------------------------------------------------

  fanout(channelId, msg) {
    const set = this.renderers.get(channelId);
    if (!set || set.size === 0) return;
    const payload = JSON.stringify(msg);
    for (const ws of set) this.safeSendRaw(ws, payload);
  }

  safeSend(ws, obj) {
    this.safeSendRaw(ws, JSON.stringify(obj));
  }

  safeSendRaw(ws, payload) {
    if (ws.readyState !== 1 /* OPEN */) return; // WebSocket.OPEN
    try { ws.send(payload); } catch { /* client gone */ }
  }
}
