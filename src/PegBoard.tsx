import { useMemo } from "react";

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
// there instantly -- see plinko.css's slow 5s transition on this phase vs.
// the quick 0.6s default used once "landed".
export type BallPhase = "idle" | "dropping" | "settling" | "landed";

export function Ball({ phase, landingSlot, slotCount }: { phase: BallPhase; landingSlot: number | null; slotCount: number }) {
  const style = useMemo(() => {
    if ((phase === "settling" || phase === "landed") && landingSlot !== null) {
      const pct = ((landingSlot + 0.5) / slotCount) * 100;
      return { left: `${pct}%` };
    }
    return { left: "50%" };
  }, [phase, landingSlot, slotCount]);

  return (
    <div className={`pk-ball-track pk-ball-${phase}`}>
      <div className="pk-ball" style={style} />
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
