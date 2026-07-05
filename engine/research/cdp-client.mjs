#!/usr/bin/env node
/**
 * Minimal Chrome DevTools Protocol client (WebSocket JSON-RPC).
 * Uses ws from backend/node_modules (express-ws dependency).
 */
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const WebSocket = require('ws');

export class CdpSession {
  /** @param {string} wsUrl */
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    /** @type {WebSocket | null} */
    this.ws = null;
    this.nextId = 1;
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this.pending = new Map();
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(JSON.stringify(msg.error)));
          else res(msg.result);
          return;
        }
        if (msg.method) {
          const set = this.listeners.get(msg.method);
          if (set) for (const fn of set) fn(msg.params);
        }
      });
    });
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
    return () => this.listeners.get(method)?.delete(fn);
  }

  /** @param {string} method @param {Record<string, unknown>} [params] */
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  evaluate(expression, awaitPromise = true) {
    return this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
  }
}

/** @param {number} port */
export async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`CDP /json/list HTTP ${res.status}`);
  return /** @type {Array<{id:string,type:string,title:string,url:string,webSocketDebuggerUrl:string}>} */ (
    await res.json()
  );
}

/** Pick the channel.html renderer target. */
export function pickRendererTarget(targets) {
  const page = targets.find(
    (t) => t.type === 'page' && t.url.includes('channel.html') && t.webSocketDebuggerUrl,
  );
  if (!page) {
    const any = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!any) throw new Error('No CDP page target found');
    return any;
  }
  return page;
}

/** @param {CdpSession} session @param {number} ms */
export async function waitMs(session, ms) {
  await session.send('Runtime.evaluate', { expression: '0' });
  await sleep(ms);
}

export { sleep };
