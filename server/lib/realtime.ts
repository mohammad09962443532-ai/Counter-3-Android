/**
 * PLATFORM-MANAGED FILE — DO NOT EDIT OR DELETE.
 * The platform overwrites this file on every run; local changes are lost.
 *
 * Realtime room sync (server half). Mount it FIRST, before your own routes:
 *
 *   // plain node:http
 *   if (await handleRealtimeRequest(req, res)) return;
 *
 *   // express
 *   app.use(async (req, res, next) => {
 *     if (!(await handleRealtimeRequest(req, res))) next();
 *   });
 *
 * It answers only /api/_realtime/* and returns false for everything else.
 * The client half is src/lib/realtime.ts — generated code talks to that,
 * never to these routes directly.
 *
 * Rooms are in-memory and EPHEMERAL: they reset when the server restarts or
 * redeploys. Persist anything durable (final scores, leaderboards) in SQLite
 * via your own /api routes instead.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomInt } from 'node:crypto';

interface RoomEvent {
  i: number;
  type: string;
  payload: unknown;
  at: number;
}

interface Room {
  version: number;
  state: Record<string, unknown>;
  events: RoomEvent[];
  eventSeq: number;
  lastTouched: number;
}

/** Always joinable — auto-created on first touch. For demos and checks. */
export const DEMO_ROOM_CODE = '000000';

const MAX_ROOMS = 500;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_EVENTS = 200;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;

const rooms = new Map<string, Room>();

function freshRoom(initial?: Record<string, unknown>): Room {
  return {
    version: 1,
    state: initial && typeof initial === 'object' ? { ...initial } : {},
    events: [],
    eventSeq: 0,
    lastTouched: Date.now(),
  };
}

function sweepIdle(): void {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [code, room] of rooms) {
    if (room.lastTouched < cutoff && code !== DEMO_ROOM_CODE) rooms.delete(code);
  }
}

function getRoom(code: string): Room | undefined {
  if (code === DEMO_ROOM_CODE && !rooms.has(code)) rooms.set(code, freshRoom());
  const room = rooms.get(code);
  if (room) room.lastTouched = Date.now();
  return room;
}

function newRoomCode(): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    if (code !== DEMO_ROOM_CODE && !rooms.has(code)) return code;
  }
  throw new Error('room codes exhausted');
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

function stateWithinCap(state: Record<string, unknown>): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(state), 'utf8') <= MAX_STATE_BYTES;
  } catch {
    return false;
  }
}

/**
 * Handle one request if it targets /api/_realtime/*. Returns true when the
 * response was written (stop routing), false when the request is not ours.
 */
export async function handleRealtimeRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const rawUrl = req.url ?? '';
  if (!rawUrl.startsWith('/api/_realtime/')) return false;
  sweepIdle();

  const url = new URL(rawUrl, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // ['api','_realtime',...]
  const method = (req.method ?? 'GET').toUpperCase();

  try {
    // POST /api/_realtime/rooms  → { code }
    if (parts.length === 3 && parts[2] === 'rooms' && method === 'POST') {
      if (rooms.size >= MAX_ROOMS) return send(res, 503, { error: 'room limit reached' }), true;
      const body = await readBody(req);
      if (body === null) return send(res, 400, { error: 'invalid body' }), true;
      const initial = body.initial;
      const room = freshRoom(
        initial && typeof initial === 'object' && !Array.isArray(initial)
          ? (initial as Record<string, unknown>)
          : undefined,
      );
      if (!stateWithinCap(room.state)) return send(res, 413, { error: 'state too large' }), true;
      const code = newRoomCode();
      rooms.set(code, room);
      return send(res, 200, { code }), true;
    }

    if (parts.length < 4 || parts[2] !== 'rooms') return send(res, 404, { error: 'not found' }), true;
    const code = parts[3];

    // POST /api/_realtime/rooms/:code/join  → { ok, version }
    if (parts.length === 5 && parts[4] === 'join' && method === 'POST') {
      const room = getRoom(code);
      if (!room) return send(res, 404, { error: 'room not found' }), true;
      return send(res, 200, { ok: true, version: room.version }), true;
    }

    // GET /api/_realtime/rooms/:code?since=N&after=M  → delta
    if (parts.length === 4 && method === 'GET') {
      const room = getRoom(code);
      if (!room) return send(res, 404, { error: 'room not found' }), true;
      const since = Number(url.searchParams.get('since') ?? '0');
      const after = Number(url.searchParams.get('after') ?? '0');
      if (Number.isFinite(since) && since >= room.version) {
        return send(res, 200, { version: room.version, changed: false }), true;
      }
      const events = room.events.filter((e) => e.i > (Number.isFinite(after) ? after : 0));
      return send(res, 200, {
        version: room.version,
        changed: true,
        state: room.state,
        events,
        lastEvent: room.eventSeq,
      }), true;
    }

    // POST /api/_realtime/rooms/:code/state  { key, value }  → { version }
    if (parts.length === 5 && parts[4] === 'state' && method === 'POST') {
      const room = getRoom(code);
      if (!room) return send(res, 404, { error: 'room not found' }), true;
      const body = await readBody(req);
      if (body === null || typeof body.key !== 'string' || body.key.length === 0) {
        return send(res, 400, { error: 'invalid body' }), true;
      }
      const next = { ...room.state, [body.key]: body.value };
      if (!stateWithinCap(next)) return send(res, 413, { error: 'state too large' }), true;
      room.state = next; // last write wins, per key
      room.version++;
      return send(res, 200, { version: room.version }), true;
    }

    // POST /api/_realtime/rooms/:code/events  { type, payload? }  → { version }
    if (parts.length === 5 && parts[4] === 'events' && method === 'POST') {
      const room = getRoom(code);
      if (!room) return send(res, 404, { error: 'room not found' }), true;
      const body = await readBody(req);
      if (body === null || typeof body.type !== 'string' || body.type.length === 0) {
        return send(res, 400, { error: 'invalid body' }), true;
      }
      room.eventSeq++;
      room.events.push({ i: room.eventSeq, type: body.type, payload: body.payload, at: Date.now() });
      if (room.events.length > MAX_EVENTS) room.events.splice(0, room.events.length - MAX_EVENTS);
      room.version++;
      return send(res, 200, { version: room.version }), true;
    }

    return send(res, 404, { error: 'not found' }), true;
  } catch {
    if (!res.headersSent) send(res, 500, { error: 'realtime error' });
    return true;
  }
}
