/**
 * PLATFORM-MANAGED FILE — DO NOT EDIT OR DELETE.
 * The platform overwrites this file on every run; local changes are lost.
 *
 * Realtime room sync (client half) — shared live state between everyone in a
 * room, updated within ~2 seconds. Requires the backend half
 * (server/lib/realtime.ts) mounted in server/index.ts.
 *
 *   const { code } = await createRoom({ scores: {} });   // 6-digit room code
 *   const ok = await joinRoom(codeFromUser);             // false = wrong code
 *   const [scores, setScores] = useRoomState(code, 'scores', {});
 *   useRoomEvents(code, (e) => { if (e.type === 'buzz') playSound(); });
 *   await sendEvent(code, 'buzz');
 *
 * Honest limits (tell the user, do not hide them):
 * - Updates propagate within ~2s — live, not instantaneous.
 * - Rooms are ephemeral: a server restart/redeploy clears them. Durable data
 *   (final scores, leaderboards) belongs in your own /api routes + SQLite.
 * - DEMO_ROOM_CODE ('000000') always exists and is joinable — use it for
 *   demo screens and anything that must work without creating a room first.
 */
import { useEffect, useRef, useState } from 'react';

/** Always joinable — auto-created by the server. For demos and quick starts. */
export const DEMO_ROOM_CODE = '000000';

/** Ready-made Persian copy for the standard failure states. */
export const REALTIME_MESSAGES = {
  roomNotFound: 'اتاق پیدا نشد',
  wrongCode: 'کد اتاق اشتباه است',
  connectionLost: 'ارتباط قطع شد؛ در حال تلاش دوباره…',
  roomClosed: 'اتاق بسته شد (سرور راه‌اندازی مجدد شد)',
} as const;

export interface RoomEvent {
  i: number;
  type: string;
  payload: unknown;
  at: number;
}

const POLL_MS = 1500;

interface Conn {
  version: number;
  lastEvent: number;
  state: Record<string, unknown>;
  stateListeners: Set<() => void>;
  eventListeners: Set<(e: RoomEvent) => void>;
  refs: number;
  timer: ReturnType<typeof setInterval> | null;
}

const conns = new Map<string, Conn>();

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch('/api/_realtime/' + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init && init.headers) },
  });
}

async function pollOnce(code: string, conn: Conn): Promise<void> {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  try {
    const res = await api('rooms/' + encodeURIComponent(code) + '?since=' + conn.version + '&after=' + conn.lastEvent);
    if (!res.ok) return;
    const data: {
      version: number;
      changed: boolean;
      state?: Record<string, unknown>;
      events?: RoomEvent[];
      lastEvent?: number;
    } = await res.json();
    if (!data.changed) return;
    conn.version = data.version;
    if (data.state) conn.state = data.state;
    if (typeof data.lastEvent === 'number') conn.lastEvent = data.lastEvent;
    for (const notify of conn.stateListeners) notify();
    for (const e of data.events ?? []) {
      for (const handler of conn.eventListeners) handler(e);
    }
  } catch {
    // Network hiccup — the next tick retries. Surfacing every miss would
    // flicker the UI for nothing.
  }
}

function acquire(code: string): Conn {
  let conn = conns.get(code);
  if (!conn) {
    conn = {
      version: 0,
      lastEvent: 0,
      state: {},
      stateListeners: new Set(),
      eventListeners: new Set(),
      refs: 0,
      timer: null,
    };
    conns.set(code, conn);
  }
  conn.refs++;
  if (!conn.timer) {
    const c = conn;
    void pollOnce(code, c);
    c.timer = setInterval(() => { void pollOnce(code, c); }, POLL_MS);
  }
  return conn;
}

function release(code: string): void {
  const conn = conns.get(code);
  if (!conn) return;
  conn.refs--;
  if (conn.refs <= 0) {
    if (conn.timer) clearInterval(conn.timer);
    conns.delete(code);
  }
}

/** Create a new room. Returns its 6-digit code to share with other players. */
export async function createRoom(
  initial?: Record<string, unknown>,
): Promise<{ code: string }> {
  const res = await api('rooms', { method: 'POST', body: JSON.stringify({ initial: initial ?? {} }) });
  if (!res.ok) throw new Error('createRoom failed: ' + res.status);
  return res.json();
}

/** True when the room exists; false is the «کد اتاق اشتباه است» case. */
export async function joinRoom(code: string): Promise<boolean> {
  try {
    const res = await api('rooms/' + encodeURIComponent(code) + '/join', { method: 'POST', body: '{}' });
    return res.ok;
  } catch {
    return false;
  }
}

/** Fire an ephemeral event to everyone currently in the room. */
export async function sendEvent(code: string, type: string, payload?: unknown): Promise<void> {
  try {
    await api('rooms/' + encodeURIComponent(code) + '/events', {
      method: 'POST',
      body: JSON.stringify({ type, payload }),
    });
  } catch {
    // Best-effort, same as the poll loop.
  }
}

/**
 * Shared state under one key, live for everyone in the room. Last write wins
 * per key. Pass code=null while the user has not joined a room yet.
 */
export function useRoomState<T>(
  code: string | null,
  key: string,
  initial: T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(initial);
  const initialRef = useRef(initial);
  useEffect(() => {
    if (!code) return;
    const conn = acquire(code);
    const notify = () => {
      setValue(key in conn.state ? (conn.state[key] as T) : initialRef.current);
    };
    conn.stateListeners.add(notify);
    notify();
    return () => {
      conn.stateListeners.delete(notify);
      release(code);
    };
  }, [code, key]);

  const set = (next: T): void => {
    setValue(next);
    if (!code) return;
    const conn = conns.get(code);
    if (conn) {
      conn.state = { ...conn.state, [key]: next };
      for (const notify of conn.stateListeners) notify();
    }
    void api('rooms/' + encodeURIComponent(code) + '/state', {
      method: 'POST',
      body: JSON.stringify({ key, value: next }),
    }).catch(() => { /* next poll reconciles */ });
  };
  return [value, set];
}

/** Subscribe to room events (fired via sendEvent). */
export function useRoomEvents(
  code: string | null,
  onEvent: (e: RoomEvent) => void,
): void {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;
  useEffect(() => {
    if (!code) return;
    const conn = acquire(code);
    const handler = (e: RoomEvent) => handlerRef.current(e);
    conn.eventListeners.add(handler);
    return () => {
      conn.eventListeners.delete(handler);
      release(code);
    };
  }, [code]);
}
