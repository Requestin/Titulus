// P20 evidence helper: clear all existing layers on one channel, then TAKE the
// single measured template so BGPACING identity cannot be ambiguous.
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';

const [, , channelId, templateJsonPath, token] = process.argv;
if (!channelId || !templateJsonPath || !token) {
  console.error('Usage: node p20-take.mjs <channelId> <templateJsonPath> <token>');
  process.exit(1);
}

let template = JSON.parse(readFileSync(templateJsonPath, 'utf8'));
if (template.data && template.id === undefined) template = template.data;
const controlUrl = process.env.P20_CONTROL_URL ?? 'ws://localhost:3003/ws/control';
const timeoutMs = Number(process.env.P20_TAKE_TIMEOUT_MS ?? 5_000);
const take = {
  type: 'take',
  channelId,
  templateId: template.id,
  template,
  variables: {},
};
const takeBytes = Buffer.byteLength(JSON.stringify(take), 'utf8');
const maxControlPayloadBytes = 256 * 1024;
if (takeBytes > maxControlPayloadBytes) {
  console.error(
    `[p20-take] TAKE is ${takeBytes} bytes; control WebSocket limit is ${maxControlPayloadBytes} bytes`,
  );
  process.exit(1);
}

const ws = new WebSocket(`${controlUrl}?token=${encodeURIComponent(token)}`);
let state = 'connecting';
let settled = false;
const timeout = setTimeout(() => {
  fail(`timed out waiting for backend acknowledgement during ${state}`);
}, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5_000);

function fail(message) {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  console.error(`[p20-take] ${message}`);
  ws.close();
  process.exitCode = 1;
}

function succeed() {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  ws.close();
  console.log(`[p20-take] cleared and took channel=${channelId} templateId=${template.id}`);
}

ws.on('open', () => {
  state = 'clear';
  ws.send(JSON.stringify({ type: 'clear', channelId }));
});

ws.on('message', (raw) => {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    fail('backend sent malformed acknowledgement');
    return;
  }
  if (message.type === 'error') {
    fail(`${message.error?.code ?? 'CONTROL_ERROR'}: ${message.error?.message ?? 'backend rejected command'}`);
    return;
  }
  if (message.type !== 'ack' || message.command !== state) return;
  if (state === 'clear') {
    state = 'take';
    ws.send(JSON.stringify(take));
    return;
  }
  succeed();
});

ws.on('error', (error) => fail(`ws error: ${error.message}`));
ws.on('close', () => {
  if (!settled) fail(`control socket closed before ${state} acknowledgement`);
});
