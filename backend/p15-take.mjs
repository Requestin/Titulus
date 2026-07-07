// Phase 15 P0 helper: send a "take" command over /ws/control to put a
// template on-air for a given channelId on the isolated dev backend
// (port 3003), so a headless bg_engine pointed at channel.html?channel=<id>
// picks it up on connect (OnAirManager replays the take to new renderers).
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';

const [, , channelId, templateJsonPath, token] = process.argv;
if (!channelId || !templateJsonPath || !token) {
  console.error('Usage: node p15-take.mjs <channelId> <templateJsonPath> <token>');
  process.exit(1);
}

let template = JSON.parse(readFileSync(templateJsonPath, 'utf8'));
// Accept either a raw Template object or the {name, data} wrapper the
// /api/templates POST body uses.
if (template.data && template.id === undefined) template = template.data;
const ws = new WebSocket(`ws://localhost:3003/ws/control?token=${token}`);

ws.on('open', () => {
  ws.send(
    JSON.stringify({
      type: 'take',
      channelId,
      templateId: template.id,
      template,
      variables: {},
    }),
  );
  setTimeout(() => {
    ws.close();
    console.log(`[take] sent take for channel=${channelId} templateId=${template.id}`);
  }, 500);
});
ws.on('error', (e) => {
  console.error('[take] ws error', e);
  process.exit(1);
});
ws.on('message', (m) => console.log('[take] recv', m.toString()));
