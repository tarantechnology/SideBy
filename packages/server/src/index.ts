/** Sideby room server: HTTP health + WebSocket room protocol. */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomService } from './RoomService.js';
import { MemoryRoomStore } from './RoomStore.js';
import { attachRoomProtocol } from './ws.js';

const PORT = Number(process.env.PORT ?? 8787);
const ICE_SERVERS = process.env.ICE_SERVERS_JSON
  ? (JSON.parse(process.env.ICE_SERVERS_JSON) as { urls: string | string[]; username?: string; credential?: string }[])
  : [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

const store = new MemoryRoomStore();
const service = new RoomService(store, () => Date.now(), ICE_SERVERS);

const here = dirname(fileURLToPath(import.meta.url));
const MOCK_PAGE = join(here, '../../../dev/mock-player/index.html');
/** Invite links from a room without a title, and the lobby: /join or /join/<roomId>. */
const JOIN_PAGE = join(here, '../static/join.html');

const server = createServer((req, res) => {
  if (req.url === '/join' || req.url?.startsWith('/join/')) {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(readFileSync(JOIN_PAGE));
    return;
  }
  if (req.url?.startsWith('/mock')) {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(readFileSync(MOCK_PAGE));
    return;
  }
  if (req.url === '/health') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, now: Date.now(), rooms: [...store.all()].length }));
    return;
  }
  res.statusCode = 404;
  res.end();
});

const wss = new WebSocketServer({ server, path: '/ws' });
attachRoomProtocol(wss, service);
setInterval(() => service.sweep(), 30_000).unref();

server.listen(PORT, () => console.log(`[sideby] room server on http://localhost:${PORT} (ws at /ws)`));
