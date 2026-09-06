/**
 * Sideby room server. Phase 0: health endpoint only. Phase 2 adds the
 * WebSocket room protocol.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8787);

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, now: Date.now() }));
    return;
  }
  res.statusCode = 404;
  res.end();
});

server.listen(PORT, () => console.log(`[sideby] server listening on :${PORT}`));
