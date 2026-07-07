import WebSocket from 'ws';
const wsUrl = process.argv[2];
const ws = new WebSocket(wsUrl);
let id = 1;
ws.on('open', () => {
  ws.send(JSON.stringify({ id: id++, method: 'Log.enable' }));
  ws.send(JSON.stringify({ id: id++, method: 'Runtime.enable' }));
  ws.send(JSON.stringify({ id: id++, method: 'Runtime.evaluate', params: { expression: 'typeof BG, typeof BG && Object.keys(BG)' } }));
});
ws.on('message', (m) => {
  const msg = JSON.parse(m.toString());
  if (msg.method === 'Log.entryAdded') {
    console.log('[LOG]', JSON.stringify(msg.params.entry));
  } else if (msg.method === 'Runtime.consoleAPICalled') {
    console.log('[CONSOLE]', msg.params.type, msg.params.args.map((a) => a.value ?? a.description).join(' '));
  } else if (msg.method === 'Runtime.exceptionThrown') {
    console.log('[EXCEPTION]', JSON.stringify(msg.params.exceptionDetails));
  } else if (msg.id) {
    console.log('[RESULT]', JSON.stringify(msg));
  }
});
setTimeout(() => { ws.close(); process.exit(0); }, 6000);
