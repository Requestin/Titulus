import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import WebSocket from 'ws';

const helper = new URL('../p20-take.mjs', import.meta.url);
const { Server: WebSocketServer } = WebSocket;

function writeTemplate() {
  const directory = mkdtempSync(join(tmpdir(), 'titulus-p20-take-'));
  const path = join(directory, 'template.json');
  writeFileSync(path, JSON.stringify({ id: 'p20-take-test', layers: [] }));
  return path;
}

async function startControlServer(onCommand) {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  server.on('connection', (socket) => {
    socket.on('message', (raw) => onCommand(socket, JSON.parse(raw.toString())));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `ws://127.0.0.1:${address.port}`,
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

async function runTake(url, templatePath) {
  const child = spawn(process.execPath, [
    helper.pathname,
    'channel-p20-test',
    templatePath,
    'test-token',
  ], {
    env: {
      ...process.env,
      P20_CONTROL_URL: url,
      P20_TAKE_TIMEOUT_MS: '500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}

test('p20 TAKE succeeds only after backend acknowledges clear and take', async () => {
  const server = await startControlServer((socket, command) => {
    socket.send(JSON.stringify({
      type: 'ack',
      command: command.type,
      channelId: command.channelId,
      templateId: command.templateId,
    }));
  });
  try {
    const result = await runTake(server.url, writeTemplate());
    assert.equal(result.code, 0);
    assert.match(result.stdout, /cleared and took/);
  } finally {
    await server.close();
  }
});

test('p20 TAKE fails visibly when backend rejects the template', async () => {
  const server = await startControlServer((socket, command) => {
    if (command.type === 'clear') {
      socket.send(JSON.stringify({ type: 'ack', command: 'clear' }));
      return;
    }
    socket.send(JSON.stringify({
      type: 'error',
      error: { code: 'MESSAGE_TOO_LARGE', message: 'control payload exceeds 256 KB' },
    }));
  });
  try {
    const result = await runTake(server.url, writeTemplate());
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stdout, /cleared and took/);
    assert.match(result.stderr, /MESSAGE_TOO_LARGE/);
  } finally {
    await server.close();
  }
});
