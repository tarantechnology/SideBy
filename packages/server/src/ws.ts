import { ClientMessageSchema, type ServerMessage } from '@sideby/shared';
import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { Connection, RoomService } from './RoomService.js';

const MAX_MESSAGE_BYTES = 16 * 1024;
const IDLE_PING_MS = 25_000;

/** Attaches the room protocol to a WebSocketServer. */
export function attachRoomProtocol(wss: WebSocketServer, service: RoomService, now: () => number = () => Date.now()): void {
  let nextId = 1;

  wss.on('connection', (socket: WebSocket, _req: IncomingMessage) => {
    const conn: Connection = {
      id: nextId++,
      send(msg: ServerMessage) {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
      },
    };
    let alive = true;
    socket.on('pong', () => { alive = true; });
    const pinger = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, IDLE_PING_MS);

    socket.on('message', (raw, isBinary) => {
      if (isBinary || raw.toString().length > MAX_MESSAGE_BYTES) return socket.terminate();
      let parsed: unknown;
      try { parsed = JSON.parse(raw.toString()); } catch { return conn.send({ type: 'error', code: 'bad_json', message: 'Malformed message.' }); }
      const result = ClientMessageSchema.safeParse(parsed);
      if (!result.success) return conn.send({ type: 'error', code: 'bad_message', message: result.error.issues[0]?.message ?? 'Invalid message.' });
      const msg = result.data;
      switch (msg.type) {
        case 'clock': return conn.send({ type: 'clock', t0: msg.t0, serverMs: now() });
        case 'ping': return conn.send({ type: 'pong', serverMs: now() });
        case 'join': return service.join(conn, msg.roomId, msg.memberId, msg.memberToken, msg.contentId, msg.name);
        case 'leave': return service.leave(conn, false);
        case 'intent': return service.intent(conn, msg.env);
        case 'readiness': return service.readiness(conn, msg.readiness);
        case 'rtc': return service.relayRtc(conn, msg.to, msg.payload);
      }
    });

    socket.on('close', () => {
      clearInterval(pinger);
      service.leave(conn, true);
    });
    socket.on('error', () => socket.terminate());
  });
}
