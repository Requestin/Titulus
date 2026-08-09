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
const ws = new WebSocket(`ws://localhost:3003/ws/control?token=${token}`);
let takeSent = false;

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'clear', channelId }));
  setTimeout(() => {
    ws.send(JSON.stringify({
      type: 'take',
      channelId,
      templateId: template.id,
      template,
      variables: {},
    }));
    takeSent = true;
  }, 100);
  setTimeout(() => {
    ws.close();
    console.log(`[p20-take] cleared and took channel=${channelId} templateId=${template.id}`);
  }, 700);
});
ws.on('error', (error) => {
  console.error('[p20-take] ws error', error);
  process.exit(1);
});
ws.on('close', () => {
  if (!takeSent) process.exitCode = 1;
});
