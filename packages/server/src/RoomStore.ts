import { RoomEngine, type Readiness } from '@sideby/shared';

export interface Member {
  memberId: string;
  memberToken: string;
  name?: string;
  connected: boolean;
  readiness: Readiness;
  lastSeenMs: number;
}

export interface Room {
  roomId: string;
  engine: RoomEngine;
  members: Map<string, Member>;
  createdAtMs: number;
  emptySinceMs: number | null;
}

/**
 * Room persistence boundary. In-memory now; a Redis-backed implementation
 * can replace it without touching the WebSocket layer.
 */
export interface RoomStore {
  get(roomId: string): Room | undefined;
  getOrCreate(roomId: string, contentId: string | null, nowMs: number): Room;
  delete(roomId: string): void;
  all(): Iterable<Room>;
}

export class MemoryRoomStore implements RoomStore {
  private rooms = new Map<string, Room>();

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  getOrCreate(roomId: string, contentId: string | null, nowMs: number): Room {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { roomId, engine: new RoomEngine(contentId, nowMs), members: new Map(), createdAtMs: nowMs, emptySinceMs: nowMs };
      this.rooms.set(roomId, room);
    }
    return room;
  }

  delete(roomId: string): void {
    this.rooms.delete(roomId);
  }

  all(): Iterable<Room> {
    return this.rooms.values();
  }
}
