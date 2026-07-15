import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getCurrentRound,
  getRoundByID,
  getHistory,
  getUpcoming,
  getWallet,
  listBets,
  placeBet,
  ZONE_ORDER,
  type PlinkoBet,
  type PlinkoRound,
  type ZoneCode,
} from "./api";
import { Ball, Bins, Pegs, type BallPhase } from "./PegBoard";
import { playTick, playWin, playLose, setMuted, isMuted } from "./sound";
import { sendReaction, listReactions } from "./reactions/api";
import { REACTION_PRESETS, type Reaction, type ReactionCode } from "./reactions/types";
import "./plinko.css";

// How long before a board's real end_time the ball starts visibly gliding
// toward the already-known winning slot ("at least five seconds" of real
// movement before it settles).
const SETTLE_WINDOW_MS = 5_000;
// How long the settled result stays on screen before the board
// auto-advances to the next scheduled one.
const REVEAL_HOLD_MS = 3_000;

// Plinko's own id in blackbird's /api/v1/games catalog -- reactions are
// scoped by this exact id, same as a real launch would pass.
const PLINKO_GAME_ID = 2;
// Mirrors the backend's reaction.Cooldown -- used purely to grey out the
// buttons client-side between taps so the 429 case is rare, not to replace
// the server-side check.
const REACTION_COOLDOWN_MS = 3_000;

const STAKE_CHIPS = [10, 20, 100, 500];
const AUTOPLAY_CHOICES = [5, 10, 25];
const PROFILE_TAG_STORAGE_KEY = "plinko_profile_tag";
const LAST_ZONE_STORAGE_KEY = "plinko_last_zone";
const SESSION_STORAGE_KEY = "plinko_session";
// Fallback currency label for direct/local demo-mode testing (no launch
// session at all) -- a real launch always carries its own real currency
// (see LaunchSession/resolveSession below), which takes priority whenever
// present.
const CURRENCY = "KSh";

function resolveProfileTag(): string | null {
  const fromQuery = new URLSearchParams(window.location.search).get("profile_tag");
  if (fromQuery) {
    localStorage.setItem(PROFILE_TAG_STORAGE_KEY, fromQuery);
    return fromQuery;
  }
  return localStorage.getItem(PROFILE_TAG_STORAGE_KEY);
}

// A real launch (see blackbird's /launch_url, same mechanism the root
// blackbird-web app already bootstraps from) carries a bearer token plus
// the client_config/currency it belongs to -- balance itself isn't
// persisted here since it's immediately re-populated from the first
// bets-poll's piggybacked meta.balance (see betsQuery below).
interface LaunchSession {
  token: string;
  clientConfigId: string;
  currency: string;
}

function resolveSession(): LaunchSession | null {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  if (token) {
    const session: LaunchSession = {
      token,
      clientConfigId: params.get("client_config_id") ?? "",
      currency: params.get("currency") ?? "",
    };
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    return session;
  }
  const saved = localStorage.getItem(SESSION_STORAGE_KEY);
  if (!saved) return null;
  try {
    return JSON.parse(saved) as LaunchSession;
  } catch {
    return null;
  }
}

export default function App() {
  const [profileTag, setProfileTag] = useState<string | null>(() => resolveProfileTag());

  if (!profileTag) {
    return <ProfileTagPrompt onSubmit={(tag) => setProfileTag(tag)} />;
  }
  return <Game profileTag={profileTag} />;
}

function ProfileTagPrompt({ onSubmit }: { onSubmit: (tag: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="pk-page pk-center">
      <form
        className="pk-prompt"
        onSubmit={(e) => {
          e.preventDefault();
          const tag = value.trim();
          if (!tag) return;
          localStorage.setItem(PROFILE_TAG_STORAGE_KEY, tag);
          onSubmit(tag);
        }}
      >
        <p className="pk-eyebrow">
          <span className="pk-wordmark-banda">banda</span>Plink
        </p>
        <h1>Enter a player tag</h1>
        <p className="pk-muted">Testing mode -- real launches will carry this automatically.</p>
        <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. tester1" />
        <button type="submit">Continue</button>
      </form>
    </div>
  );
}

type Phase = "picking" | "waiting" | "settling" | "reveal";

function Game({ profileTag }: { profileTag: string }) {
  const queryClient = useQueryClient();
  // Remembers the last slot picked across visits/rounds (localStorage,
  // same convention as the profile tag) so autoplay is enabled the moment
  // the board loads instead of forcing a fresh pick every single time --
  // still an explicit, visible choice the player made at some point, never
  // one invented for them (see the earlier discussion on why autoplay
  // should never silently choose a zone on its own).
  const [selectedIndex, setSelectedIndex] = useState<number | null>(() => {
    const saved = localStorage.getItem(LAST_ZONE_STORAGE_KEY);
    if (!saved) return null;
    const idx = ZONE_ORDER.indexOf(saved as ZoneCode);
    return idx >= 0 ? idx : null;
  });
  const [stake, setStake] = useState(20);
  const [myBet, setMyBet] = useState<PlinkoBet | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // The single source of truth for "which board is on screen" -- distinct
  // from whatever /round (earliest still-'open' board) currently says,
  // since a board keeps being shown here through its own settle/reveal
  // even after it has left 'open' status and dropped out of /round.
  const [activeRoundId, setActiveRoundId] = useState<number | null>(null);
  const [soundOn, setSoundOn] = useState(() => !isMuted());
  // Autoplay's zone/stake are captured once when it starts, deliberately
  // separate from the live selectedIndex/stake -- selectedIndex gets reset
  // every time the active round changes (see the myBet-reconciliation
  // effect below), which would otherwise cancel autoplay's pick after its
  // very first drop.
  const [autoplay, setAutoplay] = useState<{ zone: ZoneCode; stake: number; remaining: number } | null>(null);
  const [autoplayHint, setAutoplayHint] = useState(false);
  // Set only when this launch (or a previous one, restored from
  // localStorage) carries a real operator session -- see resolveSession's
  // doc. null means direct/local demo-mode testing, unchanged from before.
  const [session] = useState<LaunchSession | null>(() => resolveSession());
  // The live operator balance, kept current by whichever of
  // placeBetMutation/betsQuery's piggybacked `meta.balance` arrived last
  // (see the football game's identical mechanism) -- only used when
  // `session` is set; demo mode keeps reading walletQuery instead.
  const [liveBalance, setLiveBalance] = useState<number | null>(() => {
    const balance = new URLSearchParams(window.location.search).get("balance");
    return balance !== null ? parseFloat(balance) : null;
  });
  const currency = session?.currency || CURRENCY;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Strips the launch query string once read (token/balance shouldn't sit
  // visibly in the address bar), same as the root blackbird-web app's own
  // launch-bootstrap effect. Runs once on mount only.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("token")) {
      window.history.replaceState({}, "", window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setMuted(!soundOn);
  }, [soundOn]);

  useEffect(() => {
    if (selectedIndex !== null) {
      localStorage.setItem(LAST_ZONE_STORAGE_KEY, ZONE_ORDER[selectedIndex]);
    }
  }, [selectedIndex]);

  const currentRoundQuery = useQuery({
    queryKey: ["plinko-round"],
    queryFn: getCurrentRound,
    refetchInterval: 3000,
  });

  const upcomingQuery = useQuery({
    queryKey: ["plinko-upcoming"],
    queryFn: getUpcoming,
    refetchInterval: 5000,
  });

  const activeRoundQuery = useQuery({
    queryKey: ["plinko-active-round", activeRoundId],
    queryFn: () => getRoundByID(activeRoundId!),
    enabled: activeRoundId !== null,
    refetchInterval: 2000,
    // Seed from the schedule strip's already-fetched data so switching
    // boards doesn't flash a "Loading board..." blank between requests.
    initialData: () => upcomingQuery.data?.find((r) => r.id === activeRoundId),
  });

  // Piggybacks the latest operator balance in `meta` when a session is
  // live (see chickencross_handlers.go's listChickenCrossBets) -- this
  // already-polled 5s loop is what actually keeps balance current after a
  // later async settlement, exactly like the football game's listBets.
  const betsQuery = useQuery({
    queryKey: ["plinko-bets", profileTag],
    queryFn: () => listBets(profileTag, session?.token),
    refetchInterval: 5000,
  });

  useEffect(() => {
    const balance = betsQuery.data?.meta.balance;
    if (typeof balance === "number") setLiveBalance(balance);
  }, [betsQuery.data]);

  // Demo-mode-only wallet -- never queried once a real launch session is
  // present (live balance comes from betsQuery/placeBetMutation's meta).
  const walletQuery = useQuery({
    queryKey: ["plinko-wallet", profileTag],
    queryFn: () => getWallet(profileTag),
    refetchInterval: 4000,
    enabled: !session,
  });

  const historyQuery = useQuery({
    queryKey: ["plinko-history"],
    queryFn: () => getHistory(10),
    refetchInterval: 5000,
  });

  const reactionsQuery = useQuery({
    queryKey: ["plinko-reactions"],
    queryFn: () => listReactions(PLINKO_GAME_ID, 20),
    refetchInterval: 4000,
  });

  const [lastReactionSentAt, setLastReactionSentAt] = useState(0);
  const sendReactionMutation = useMutation({
    mutationFn: sendReaction,
    onSuccess: () => {
      setLastReactionSentAt(Date.now());
      queryClient.invalidateQueries({ queryKey: ["plinko-reactions"] });
    },
  });

  // Bootstrap: adopt whatever /round first resolves to. Also recovers if
  // the active board ever fails to load (e.g. purged) by dropping back to
  // null, which re-triggers this same bootstrap.
  useEffect(() => {
    if (activeRoundId === null && currentRoundQuery.data) {
      setActiveRoundId(currentRoundQuery.data.id);
    }
  }, [activeRoundId, currentRoundQuery.data]);

  useEffect(() => {
    if (activeRoundId !== null && activeRoundQuery.isError) {
      setActiveRoundId(null);
    }
  }, [activeRoundId, activeRoundQuery.isError]);

  const round = activeRoundQuery.data;

  const endsAtMs = round ? new Date(round.ends_at).getTime() : 0;
  const hasResult = round?.status === "settled" || round?.status === "expired";

  // Auto-advance to the next scheduled board once this one's result has
  // been on screen for REVEAL_HOLD_MS -- "show which pick was correct,
  // let it be seen for a few seconds, then load the new board."
  useEffect(() => {
    if (!round || !hasResult) return;
    if (now < endsAtMs + REVEAL_HOLD_MS) return;
    const next = (upcomingQuery.data ?? [])
      .filter((r) => new Date(r.starts_at).getTime() > new Date(round.starts_at).getTime())
      .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())[0];
    if (next && next.id !== activeRoundId) {
      setActiveRoundId(next.id);
    }
  }, [round, hasResult, now, endsAtMs, upcomingQuery.data, activeRoundId]);

  useEffect(() => {
    if (round && myBet && myBet.round_id !== round.id) {
      setMyBet(null);
      setSelectedIndex(null);
    }
  }, [round, myBet]);

  useEffect(() => {
    if (!myBet || !betsQuery.data) return;
    const resolved = betsQuery.data.data.find((b) => b.id === myBet.id);
    if (resolved && resolved.status !== myBet.status) {
      setMyBet(resolved);
    }
  }, [betsQuery.data, myBet]);

  const placeBetMutation = useMutation({
    mutationFn: (vars: { round_id: number; zone: ZoneCode; stake: number; profile_tag: string }) =>
      placeBet(vars, session?.token),
    onSuccess: ({ data, meta }) => {
      setMyBet(data);
      if (typeof meta.balance === "number") setLiveBalance(meta.balance);
      queryClient.invalidateQueries({ queryKey: ["plinko-bets", profileTag] });
      queryClient.invalidateQueries({ queryKey: ["plinko-wallet", profileTag] });
    },
  });

  // Autoplay: fires the captured zone/stake the instant a fresh board
  // enters picking, same as a manual click on the Drop button -- stops
  // itself (remaining -> 0) or can be cancelled early via the Stop button.
  useEffect(() => {
    if (!round || !autoplay || autoplay.remaining <= 0) return;
    if (myBet || placeBetMutation.isPending) return;
    if (now >= new Date(round.closes_at).getTime()) return;
    placeBetMutation.mutate(
      { round_id: round.id, zone: autoplay.zone, stake: autoplay.stake, profile_tag: profileTag },
      {
        onSuccess: () => {
          setAutoplay((a) => (a ? { ...a, remaining: a.remaining - 1 } : a));
        },
      },
    );
  }, [round, autoplay, myBet, now, placeBetMutation, profileTag]);

  const secondsLeft = useMemo(() => {
    if (!round) return 0;
    return Math.max(0, Math.floor((new Date(round.closes_at).getTime() - now) / 1000));
  }, [round, now]);

  // The board stays visible, unchanged, from kickoff to its own end_time
  // (~picking, then waiting) -- the ball only starts actually moving
  // toward the (already-known) result in the final SETTLE_WINDOW_MS, and
  // the result itself only shows once end_time has actually passed, even
  // though the backend typically resolves the true winner well before then.
  const phase: Phase = useMemo(() => {
    if (!round) return "picking";
    if (now < new Date(round.closes_at).getTime()) return "picking";
    if (now < endsAtMs - SETTLE_WINDOW_MS) return "waiting";
    if (now < endsAtMs || !hasResult) return "settling";
    return "reveal";
  }, [round, now, endsAtMs, hasResult]);

  // A round still without a result more than 10s after its own match
  // end_time is a real problem, not just "still settling" -- flagged
  // explicitly rather than left to look like an endlessly-moving ball with
  // no explanation.
  const isOverdue = useMemo(() => {
    if (!round || hasResult) return false;
    return now - endsAtMs > 10_000;
  }, [round, hasResult, now, endsAtMs]);

  const won = phase === "reveal" && myBet?.status === "won";
  const lost = phase === "reveal" && myBet?.status === "lost";

  // Sound cues, each fired exactly once per round: a tick the instant the
  // ball starts actually gliding toward the result, then a win chime or
  // lose thud the instant that result is revealed (silent if this player
  // had no bet on the board at all).
  const settleSoundRef = useRef<number | null>(null);
  useEffect(() => {
    if (!round || phase !== "settling" || settleSoundRef.current === round.id) return;
    settleSoundRef.current = round.id;
    playTick();
  }, [round, phase]);

  const revealSoundRef = useRef<number | null>(null);
  useEffect(() => {
    if (!round || phase !== "reveal" || revealSoundRef.current === round.id) return;
    revealSoundRef.current = round.id;
    if (won) playWin();
    else if (lost) playLose();
  }, [round, phase, won, lost]);

  // Computed here (not after the early return below) so this useMemo
  // always runs, matching the Rules of Hooks -- a round-not-loaded-yet
  // render must call exactly the same hooks as every other render.
  const odds = round ? ZONE_ORDER.map((z) => round.zones.find((zz) => zz.zone === z)?.odd ?? 0) : [];

  // A starting-point nudge for a player with no pick of their own yet: the
  // zone whose odd sits closest to this board's median, i.e. the most
  // "balanced" of the six -- not the safest or the riskiest, just a
  // reasonable first tap. Only ever a highlight (see Bins), never a
  // pre-made selection.
  const suggestedIndex = useMemo(() => {
    if (odds.length === 0) return 0;
    const sorted = [...odds].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    let best = 0;
    let bestDiff = Infinity;
    odds.forEach((o, i) => {
      const diff = Math.abs(o - median);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    });
    return best;
  }, [odds]);

  if (!round) {
    return (
      <div className="pk-page pk-center">
        <p className="pk-muted">Loading board...</p>
      </div>
    );
  }

  const labels = ZONE_ORDER.map((_, i) => String(i + 1));
  const winningIndex = round.winner ? ZONE_ORDER.indexOf(round.winner) : null;
  const potentialWin = selectedIndex !== null ? Math.round(stake * odds[selectedIndex] * 100) / 100 : 0;

  const ballPhase: BallPhase =
    phase === "picking" ? "idle" : phase === "waiting" ? "dropping" : phase === "settling" ? "settling" : "landed";

  return (
    <div className="pk-page">
      <TimeSlotStrip
        rounds={(upcomingQuery.data ?? []).slice(0, 5)}
        currentRoundId={round.id}
        now={now}
        onSelect={(id) => setActiveRoundId(id)}
      />

      <header className="pk-hud">
        <div className="pk-hud-row">
          <span className="pk-wordmark">
            <span className="pk-wordmark-banda">banda</span>Plink
          </span>
        </div>
        <div className="pk-hud-row">
          <span className="pk-player">
            {profileTag} &middot;{" "}
            {session
              ? liveBalance !== null
                ? `${currency} ${liveBalance.toFixed(2)}`
                : "..."
              : walletQuery.data
                ? `${currency} ${walletQuery.data.balance.toFixed(2)}`
                : "..."}
          </span>
          <button type="button" className="pk-sound-toggle" onClick={() => setSoundOn((v) => !v)}>
            Sound: {soundOn ? "On" : "Off"}
          </button>
        </div>
        <div className="pk-hud-row">
          <span className="pk-round">Board #{round.id}</span>
          <span className="pk-timer">
            {phase === "picking"
              ? `${String(Math.floor(secondsLeft / 60)).padStart(2, "0")}:${String(secondsLeft % 60).padStart(2, "0")}`
              : phase === "reveal"
                ? won
                  ? "won!"
                  : lost
                    ? "lost"
                    : "-"
                : phase === "settling"
                  ? "revealing..."
                  : "..."}
          </span>
          <span className="pk-endtime">ends {new Date(round.ends_at).toLocaleTimeString()}</span>
        </div>
      </header>
      {autoplay && autoplay.remaining > 0 && (
        <div className="pk-autoplay-banner">
          <span>
            Autoplay -- {autoplay.remaining} drop{autoplay.remaining === 1 ? "" : "s"} left on Slot{" "}
            {ZONE_ORDER.indexOf(autoplay.zone) + 1} @ {currency} {autoplay.stake}
          </span>
          <button type="button" onClick={() => setAutoplay(null)}>
            Stop
          </button>
        </div>
      )}
      {isOverdue && (
        <div className="pk-overdue-banner">
          This board is past its end time ({new Date(round.ends_at).toLocaleTimeString()}) and hasn't settled yet --
          settlement is delayed.
        </div>
      )}

      <div className="pk-board">
        <Pegs />
        <Ball phase={ballPhase} landingSlot={phase === "settling" || phase === "reveal" ? winningIndex : null} slotCount={odds.length} />
        <Bins
          odds={odds}
          labels={labels}
          winningIndex={phase === "reveal" ? winningIndex : null}
          selectedIndex={selectedIndex}
          suggestedIndex={suggestedIndex}
          disabled={phase !== "picking"}
          onSelect={setSelectedIndex}
        />
      </div>

      {phase === "reveal" && (
        <div className={`pk-result-banner ${won ? "pk-won" : lost ? "pk-lost" : ""}`}>
          {(won || lost) && <span className={`pk-result-icon ${won ? "pk-icon-win" : "pk-icon-lose"}`} aria-hidden="true" />}
          {round.status === "expired"
            ? "Board expired -- stake refunded"
            : won
              ? `Slot ${winningIndex !== null ? winningIndex + 1 : "?"} -- you won ${currency} ${myBet!.potential_win.toFixed(2)}`
              : lost
                ? `Slot ${winningIndex !== null ? winningIndex + 1 : "?"} hit -- better luck next drop`
                : `Slot ${winningIndex !== null ? winningIndex + 1 : "?"} settled`}
        </div>
      )}

      {phase === "picking" && (
        <div className="pk-stake-bar">
          <div className="pk-chips">
            {STAKE_CHIPS.map((v) => (
              <button
                key={v}
                type="button"
                className={`pk-chip${stake === v ? " pk-active" : ""}`}
                onClick={() => setStake(v)}
              >
                {currency} {v}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="pk-drop-button"
            disabled={selectedIndex === null || placeBetMutation.isPending}
            onClick={() => {
              if (selectedIndex === null) return;
              placeBetMutation.mutate({ round_id: round.id, zone: ZONE_ORDER[selectedIndex], stake, profile_tag: profileTag });
            }}
          >
            {selectedIndex !== null
              ? `Drop - Slot ${selectedIndex + 1} - win up to ${currency} ${potentialWin.toFixed(2)}`
              : "Pick a slot"}
          </button>
          {placeBetMutation.isError && <p className="pk-error">{(placeBetMutation.error as Error).message}</p>}

          {!autoplay && (
            <div className="pk-autoplay-start">
              <span className={`pk-muted${autoplayHint ? " pk-autoplay-hint" : ""}`}>
                {selectedIndex === null ? "Pick a slot on the board above first" : "Autoplay this slot & stake:"}
              </span>
              <div className="pk-chips">
                {AUTOPLAY_CHOICES.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`pk-chip${selectedIndex === null ? " pk-chip-locked" : ""}`}
                    onClick={() => {
                      if (selectedIndex === null) {
                        setAutoplayHint(true);
                        setTimeout(() => setAutoplayHint(false), 1500);
                        return;
                      }
                      setAutoplay({ zone: ZONE_ORDER[selectedIndex], stake, remaining: n });
                    }}
                  >
                    {n}x
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {(phase === "waiting" || phase === "settling") && !myBet && (
        <p className="pk-muted pk-center-text">Betting closed -- this board kicks off shortly, settling automatically.</p>
      )}

      <WinnerHistory
        rounds={(historyQuery.data ?? []).filter((r) => phase === "reveal" || r.id !== round.id)}
      />

      <MyBetsHistory
        bets={(betsQuery.data?.data ?? []).filter((b) => phase === "reveal" || b.round_id !== round.id)}
        currency={currency}
      />

      <ReactionBar
        reactions={reactionsQuery.data ?? []}
        cooldownRemainingMs={Math.max(0, REACTION_COOLDOWN_MS - (now - lastReactionSentAt))}
        sending={sendReactionMutation.isPending}
        error={sendReactionMutation.isError ? (sendReactionMutation.error as Error).message : null}
        onSend={(code) =>
          sendReactionMutation.mutate({ gameId: PLINKO_GAME_ID, playerId: profileTag, code, roundRef: String(round.id) })
        }
      />
    </div>
  );
}

// The real, global "recent winners" strip -- every settled board's actual
// winning slot, most recent first, independent of what this player bet on.
function WinnerHistory({ rounds }: { rounds: PlinkoRound[] }) {
  if (rounds.length === 0) return null;
  return (
    <div className="pk-history">
      <p className="pk-slots-label">Previous winning numbers</p>
      <div className="pk-history-list">
        {rounds.map((r) => {
          const idx = r.winner ? ZONE_ORDER.indexOf(r.winner) : -1;
          return (
            <span key={r.id} className="pk-hist-chip">
              {idx + 1}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// Your own picks, most recent first, and whether each actually won -- as
// opposed to WinnerHistory above, which is the real global outcome
// regardless of what you bet on. Excludes the currently-displayed board's
// own bet until it reaches "reveal" the same way WinnerHistory does, so a
// pending pick doesn't show its real won/lost state before the ball has
// visibly stopped.
function MyBetsHistory({ bets, currency }: { bets: PlinkoBet[]; currency: string }) {
  if (bets.length === 0) return null;
  return (
    <div className="pk-history">
      <p className="pk-slots-label">Your picks</p>
      <div className="pk-mybets-list">
        {bets.slice(0, 10).map((b) => {
          const idx = ZONE_ORDER.indexOf(b.zone);
          return (
            <div key={b.id} className={`pk-mybet-row pk-mybet-${b.status}`}>
              <span className="pk-mybet-slot">Slot {idx + 1}</span>
              <span className="pk-mybet-stake">
                {currency} {b.stake.toFixed(2)}
              </span>
              <span className="pk-mybet-status">
                {b.status === "won"
                  ? `won ${currency} ${b.potential_win.toFixed(2)}`
                  : b.status === "lost"
                    ? "lost"
                    : b.status === "refunded"
                      ? "refunded"
                      : "pending"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Preset-only reactions -- tap a fixed phrase, see everyone else's recent
// taps. Deliberately no free-text input anywhere here: this is the
// low-moderation-risk alternative to chat, reusable across every game via
// game_id (see ../reactions). Buttons grey out for REACTION_COOLDOWN_MS
// after a send so the server-side 429 (domain.ErrTooSoon) is rarely hit,
// not relied on as the only guard.
function ReactionBar({
  reactions,
  cooldownRemainingMs,
  sending,
  error,
  onSend,
}: {
  reactions: Reaction[];
  cooldownRemainingMs: number;
  sending: boolean;
  error: string | null;
  onSend: (code: ReactionCode) => void;
}) {
  const onCooldown = cooldownRemainingMs > 0;
  return (
    <div className="pk-history">
      <p className="pk-slots-label">Reactions</p>
      <div className="pk-reaction-buttons">
        {REACTION_PRESETS.map((p) => (
          <button
            key={p.code}
            type="button"
            className="pk-chip"
            disabled={sending || onCooldown}
            onClick={() => onSend(p.code)}
          >
            {p.label}
          </button>
        ))}
      </div>
      {error && <p className="pk-error">{error}</p>}
      {reactions.length > 0 && (
        <div className="pk-reaction-feed">
          {reactions.map((r) => (
            <span key={r.id} className="pk-reaction-chip">
              {r.player_id}: {REACTION_PRESETS.find((p) => p.code === r.code)?.label ?? r.code}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function formatCountdown(startsAt: string, now: number): string {
  const secs = Math.max(0, Math.floor((new Date(startsAt).getTime() - now) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// The full schedule strip at the top of the page -- the next 10 boards
// EnsureSchedule currently has open (real EnglishLeague kickoffs every ~2
// minutes), each slot's real kickoff clock time, with whichever one the
// board below is actually showing picked out as "NOW"/"LIVE". Every slot is
// clickable -- jumping ahead to a future board is just switching which
// round is "active"; that board is already open for bets the same as any
// other, it just settles later since its own kickoff is further out.
function TimeSlotStrip({
  rounds,
  currentRoundId,
  now,
  onSelect,
}: {
  rounds: PlinkoRound[];
  currentRoundId: number;
  now: number;
  onSelect: (id: number) => void;
}) {
  if (rounds.length === 0) return null;
  return (
    <div className="pk-slots">
      <p className="pk-slots-label">Next {rounds.length} boards -- every 2 min</p>
      <div className="pk-slots-list">
        {rounds.map((r) => {
          const isCurrent = r.id === currentRoundId;
          const started = new Date(r.starts_at).getTime() <= now;
          return (
            <button
              key={r.id}
              type="button"
              className={`pk-slot${isCurrent ? " pk-slot-current" : ""}`}
              onClick={() => onSelect(r.id)}
            >
              <span className="pk-slot-badge">{isCurrent ? (started ? "LIVE" : "NOW") : formatCountdown(r.starts_at, now)}</span>
              <span className="pk-slot-time">{new Date(r.starts_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
              <span className="pk-slot-board">#{r.id}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
