import { useEffect, useRef, useState } from "react";

// Purely decorative peg triangle -- 6 rows of 3..8 pegs. The ball's landing
// position is driven by which of the 6 bins the real settlement resolved
// to, not by simulating physics against these pegs.
const ROWS = [3, 4, 5, 6, 7, 8];

export function Pegs() {
  return (
    <div className="pk-pegs">
      {ROWS.map((count, rowIdx) => (
        <div className="pk-peg-row" key={rowIdx}>
          {Array.from({ length: count }).map((_, i) => (
            <span className="pk-peg" key={i} />
          ))}
        </div>
      ))}
    </div>
  );
}

// "settling" is the final few seconds before a board's real end_time: the
// true winner is already known (settlement resolves well before this), but
// the ball only starts visibly gliding toward it here rather than snapping
// there instantly.
export type BallPhase = "idle" | "dropping" | "settling" | "landed";

// Vertical stop percentages the ball bounces through on its way down --
// roughly matches where the 6 peg rows sit inside .pk-board, ending just
// above the bins row. Purely decorative, not real peg-contact physics.
const FALL_STOPS = [10, 24, 40, 56, 72, 88];
// Per-step fall duration, front-loaded faster like gravity picking up
// speed, landing with a couple of quick low bounces at the end.
const FALL_STEP_MS = [480, 460, 500, 520, 540, 560];

// Deterministic pseudo-random in [-1, 1] seeded by the landing slot and
// step index -- gives each drop a slightly different bounce path without
// needing real randomness (purely cosmetic, never affects the outcome).
function jitter(seed: number, step: number): number {
  const x = Math.sin(seed * 12.9898 + step * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

export function Ball({ phase, landingSlot, slotCount }: { phase: BallPhase; landingSlot: number | null; slotCount: number }) {
  const [pos, setPos] = useState({ top: 4, left: 50 });
  const [stepDurationMs, setStepDurationMs] = useState(800);
  const timers = useRef<number[]>([]);
  const runningForSlot = useRef<number | null>(null);

  useEffect(() => {
    if (phase === "settling" && landingSlot !== null) {
      if (runningForSlot.current === landingSlot) return; // already falling toward this exact slot
      runningForSlot.current = landingSlot;
      timers.current.forEach((t) => clearTimeout(t));
      timers.current = [];

      const finalLeft = ((landingSlot + 0.5) / slotCount) * 100;
      setStepDurationMs(FALL_STEP_MS[0]);
      setPos({ top: 2, left: 50 });

      let elapsed = 0;
      FALL_STOPS.forEach((top, i) => {
        const t = window.setTimeout(() => {
          const isLast = i === FALL_STOPS.length - 1;
          // Horizontal wobble shrinks each bounce, converging exactly on
          // the real slot by the final stop -- a ball settling down, not
          // wandering randomly the whole way.
          const wobble = (1 - (i + 1) / FALL_STOPS.length) * 16 * jitter(landingSlot, i);
          const left = isLast ? finalLeft : Math.min(97, Math.max(3, finalLeft + wobble));
          setStepDurationMs(FALL_STEP_MS[Math.min(i + 1, FALL_STEP_MS.length - 1)]);
          setPos({ top, left });
        }, elapsed);
        timers.current.push(t);
        elapsed += FALL_STEP_MS[i];
      });
    } else if (phase !== "settling") {
      runningForSlot.current = null;
      timers.current.forEach((t) => clearTimeout(t));
      timers.current = [];
      if (phase === "landed" && landingSlot !== null) {
        setStepDurationMs(300);
        setPos({ top: 88, left: ((landingSlot + 0.5) / slotCount) * 100 });
      } else {
        // idle/dropping -- poised at the top, centered, waiting to drop.
        setStepDurationMs(800);
        setPos({ top: 4, left: 50 });
      }
    }

    return () => {
      timers.current.forEach((t) => clearTimeout(t));
    };
  }, [phase, landingSlot, slotCount]);

  return (
    <div className={`pk-ball-track pk-ball-${phase}`}>
      <div
        className="pk-ball"
        style={{
          top: `${pos.top}%`,
          left: `${pos.left}%`,
          transitionDuration: `${stepDurationMs}ms`,
        }}
      />
    </div>
  );
}

export function Bins({
  odds,
  labels,
  winningIndex,
  selectedIndex,
  suggestedIndex,
  disabled,
  onSelect,
}: {
  odds: number[];
  labels: string[];
  winningIndex: number | null;
  selectedIndex: number | null;
  // A visual "try this one" nudge for a player with no pick of their own
  // yet -- never auto-selected, only ever highlighted, so it never places
  // a choice on the player's behalf (see the earlier decision against
  // autoplay silently choosing a zone).
  suggestedIndex?: number | null;
  disabled: boolean;
  onSelect: (i: number) => void;
}) {
  const min = Math.min(...odds);
  const max = Math.max(...odds);
  const heat = (v: number) => (max === min ? 0.5 : (v - min) / (max - min));

  return (
    <div className="pk-bins">
      {odds.map((odd, i) => {
        const h = heat(odd);
        // cool teal (low multiplier) -> hot amber/red (high multiplier)
        const hue = 190 - h * 155;
        const isSuggested = selectedIndex === null && suggestedIndex === i;
        return (
          <button
            key={i}
            type="button"
            className={`pk-bin${selectedIndex === i ? " pk-bin-selected" : ""}${winningIndex === i ? " pk-bin-winner" : ""}${isSuggested ? " pk-bin-suggested" : ""}`}
            style={{ ["--pk-bin-hue" as string]: String(hue) }}
            disabled={disabled}
            onClick={() => onSelect(i)}
          >
            {isSuggested && <span className="pk-bin-suggest-badge">Try this</span>}
            <span className="pk-bin-mult">{odd.toFixed(2)}x</span>
            <span className="pk-bin-label">{labels[i]}</span>
          </button>
        );
      })}
    </div>
  );
}
