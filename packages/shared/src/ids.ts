const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o/1/l/i ambiguity

export function randomId(length = 12): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** Short human-shareable room code, e.g. "k7mq-3xwp". */
export function roomCode(): string {
  return `${randomId(4)}-${randomId(4)}`;
}

/** Unique per-message id: monotonic prefix keeps sort order useful in logs. */
export function messageId(): string {
  return `${Date.now().toString(36)}-${randomId(6)}`;
}
