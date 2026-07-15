import type { ChickenBet, ChickenRound } from "./types";

// Bare origin, same convention as the main game's api/client.ts -- blackbird
// itself, not blackbird_backoffice.
const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8090";

interface Envelope<T> {
  data: T;
  meta?: Record<string, unknown>;
  error: string | null;
}

// The exact, stable error string blackbird returns whenever the operator's
// own wallet rejected the replayed session token (see blackbird's
// operator.ErrSessionInvalid) -- same mechanism as the root api/client.ts.
// bandaPlink runs inside the same operator iframe, so the same
// re-launch-on-expiry handling applies here too.
const OPERATOR_SESSION_EXPIRED = "operator_session_expired";

function notifyParentIfSessionExpired(error: string | null): void {
  if (error !== OPERATOR_SESSION_EXPIRED) return;
  if (window.parent === window) return; // not embedded in an iframe
  window.parent.postMessage({ type: "blackbird:session_expired" }, "*");
}

function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function get<T>(path: string, token?: string): Promise<T> {
  const res = await fetch(API_BASE_URL + path, { headers: authHeaders(token) });
  const body = (await res.json()) as Envelope<T>;
  if (!res.ok || body.error) {
    notifyParentIfSessionExpired(body.error);
    throw new Error(body.error ?? `request failed (${res.status})`);
  }
  return body.data;
}

async function getWithMeta<T>(path: string, token?: string): Promise<{ data: T; meta: Record<string, unknown> }> {
  const res = await fetch(API_BASE_URL + path, { headers: authHeaders(token) });
  const body = (await res.json()) as Envelope<T>;
  if (!res.ok || body.error) {
    notifyParentIfSessionExpired(body.error);
    throw new Error(body.error ?? `request failed (${res.status})`);
  }
  return { data: body.data, meta: body.meta ?? {} };
}

async function postWithMeta<T>(path: string, payload: unknown, token?: string): Promise<{ data: T; meta: Record<string, unknown> }> {
  const res = await fetch(API_BASE_URL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as Envelope<T>;
  if (!res.ok || body.error) {
    notifyParentIfSessionExpired(body.error);
    throw new Error(body.error ?? `request failed (${res.status})`);
  }
  return { data: body.data, meta: body.meta ?? {} };
}

export function getCurrentRound(): Promise<ChickenRound> {
  return get<ChickenRound>("/api/v1/chickencross/round");
}

export function getUpcoming(): Promise<ChickenRound[]> {
  return get<ChickenRound[]>("/api/v1/chickencross/upcoming");
}

// getRoundByID returns a round regardless of its status -- unlike
// getCurrentRound/getUpcoming (which only ever surface 'open' rounds),
// this is how the client keeps polling a round it already committed to
// displaying through its own settle/reveal pacing, even after the round
// has settled/expired and dropped out of the schedule endpoints.
export function getRoundByID(id: number): Promise<ChickenRound> {
  return get<ChickenRound>(`/api/v1/chickencross/rounds/${id}`);
}

// getHistory returns the last N settled rounds' real winning zones, most
// recent first -- a global feed, not scoped to any one player's own bets.
export function getHistory(limit = 10): Promise<ChickenRound[]> {
  return get<ChickenRound[]>(`/api/v1/chickencross/history?limit=${limit}`);
}

// placeBet's response piggybacks the player's latest known balance in
// `meta` when this bet was placed live (a launch token was passed) -- same
// mechanism the football game's placeBet/listBets use. meta is empty for a
// demo-mode bet (no token).
export function placeBet(
  req: { round_id: number; zone: string; stake: number; profile_tag?: string },
  token?: string,
): Promise<{ data: ChickenBet; meta: Record<string, unknown> }> {
  return postWithMeta<ChickenBet>("/api/v1/chickencross/bets", req, token);
}

// listBets' response piggybacks the latest known balance the same way --
// this is what actually keeps a live session's displayed balance current
// after a later async settlement, since this poll already runs every 5s.
export function listBets(profileTag: string, token?: string): Promise<{ data: ChickenBet[]; meta: Record<string, unknown> }> {
  const query = profileTag ? `?profile_tag=${encodeURIComponent(profileTag)}` : "";
  return getWithMeta<ChickenBet[]>(`/api/v1/chickencross/bets${query}`, token);
}

export interface ChickenWallet {
  profile_tag: string;
  balance: number;
}

// getWallet is the demo-mode-only wallet -- never called once a launch
// token is present (live balance comes from placeBet/listBets' meta instead).
export function getWallet(profileTag: string): Promise<ChickenWallet> {
  return get<ChickenWallet>(`/api/v1/chickencross/wallet?profile_tag=${encodeURIComponent(profileTag)}`);
}
