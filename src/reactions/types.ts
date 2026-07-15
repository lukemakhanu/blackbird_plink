// Preset-only reactions, reusable across every game (virtual football,
// Chicken Cross/Plinko, whatever comes next) via game_id -- the same id
// /api/v1/games serves. There is deliberately no free-text path: Code is
// always one of the fixed Presets, matching internal/domain/reaction on
// the backend, which is what keeps this feature out of chat-moderation
// territory.
export type ReactionCode = "nice_pick" | "unlucky" | "lets_go" | "wow" | "gg";

export const REACTION_PRESETS: { code: ReactionCode; label: string }[] = [
  { code: "nice_pick", label: "Nice pick" },
  { code: "unlucky", label: "Unlucky" },
  { code: "lets_go", label: "Let's go" },
  { code: "wow", label: "Wow" },
  { code: "gg", label: "GG" },
];

export interface Reaction {
  id: number;
  game_id: number;
  player_id: string;
  code: ReactionCode;
  round_ref?: string;
  created_at: string;
}
