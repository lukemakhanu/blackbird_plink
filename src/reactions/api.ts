import type { Reaction, ReactionCode } from "./types";

// Bare origin, same convention as every other API client module in this
// app (chickencross/api.ts, api/client.ts).
const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8090";

interface Envelope<T> {
  data: T;
  error: string | null;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(API_BASE_URL + path);
  const body = (await res.json()) as Envelope<T>;
  if (!res.ok || body.error) {
    throw new Error(body.error ?? `request failed (${res.status})`);
  }
  return body.data;
}

async function post<T>(path: string, payload: unknown): Promise<T> {
  const res = await fetch(API_BASE_URL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as Envelope<T>;
  if (!res.ok || body.error) {
    throw new Error(body.error ?? `request failed (${res.status})`);
  }
  return body.data;
}

// sendReaction posts one preset reaction. roundRef is whatever this game
// calls "the current round" -- purely informational on the backend, never
// validated against anything.
export function sendReaction(req: {
  gameId: number;
  playerId: string;
  code: ReactionCode;
  roundRef?: string;
}): Promise<Reaction> {
  return post<Reaction>("/api/v1/reactions", {
    game_id: req.gameId,
    player_id: req.playerId,
    code: req.code,
    round_ref: req.roundRef ?? "",
  });
}

// listReactions returns the last limit reactions for gameId, most recent
// first -- backs a live reaction feed.
export function listReactions(gameId: number, limit = 20): Promise<Reaction[]> {
  return get<Reaction[]>(`/api/v1/reactions?game_id=${gameId}&limit=${limit}`);
}
