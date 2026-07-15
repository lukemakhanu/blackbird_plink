// Lightweight, dependency-free sound effects synthesized with the Web Audio
// API -- no asset files to fetch or bundle. Browsers require a user gesture
// before audio can play; the first bet placement / slot pick click on the
// page satisfies that naturally, so no explicit "enable sound" step is needed.
let ctx: AudioContext | null = null;
let muted = false;

function getCtx(): AudioContext {
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor();
  }
  return ctx;
}

function tone(freq: number, durationMs: number, type: OscillatorType, startGain: number) {
  if (muted) return;
  try {
    const audio = getCtx();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(startGain, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + durationMs / 1000);
    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + durationMs / 1000);
  } catch {
    // Audio isn't critical to gameplay -- a blocked/unsupported AudioContext
    // (autoplay policy, older browser) should never break the game itself.
  }
}

export function setMuted(v: boolean): void {
  muted = v;
}

export function isMuted(): boolean {
  return muted;
}

// A single peg-tick as the ball starts visibly gliding toward the result.
export function playTick(): void {
  tone(720, 90, "square", 0.08);
}

// A short rising three-note chime for a win.
export function playWin(): void {
  tone(523.25, 140, "sine", 0.16); // C5
  setTimeout(() => tone(659.25, 160, "sine", 0.16), 120); // E5
  setTimeout(() => tone(783.99, 220, "sine", 0.18), 260); // G5
}

// A short low thud for a loss -- deliberately quiet/brief, not punishing.
export function playLose(): void {
  tone(220, 220, "sawtooth", 0.1);
}
