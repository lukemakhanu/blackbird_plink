export type ZoneCode = "bus_stop" | "crosswalk" | "hydrant" | "lamp_post" | "pothole" | "mailbox";

export interface ChickenZone {
  zone: ZoneCode;
  odd: number;
}

export type RoundStatus = "open" | "settled" | "expired";

export interface ChickenRound {
  id: number;
  status: RoundStatus;
  zones: ChickenZone[];
  starts_at: string;
  closes_at: string;
  ends_at: string;
  winner?: ZoneCode;
}

export type BetStatus = "pending" | "won" | "lost" | "refunded";

export interface ChickenBet {
  id: number;
  round_id: number;
  zone: ZoneCode;
  stake: number;
  odd: number;
  potential_win: number;
  status: BetStatus;
  created_at: string;
}

export const ZONE_LABELS: Record<ZoneCode, string> = {
  bus_stop: "Bus Stop",
  crosswalk: "Crosswalk",
  hydrant: "Hydrant",
  lamp_post: "Lamp Post",
  pothole: "Pothole",
  mailbox: "Mailbox",
};

export const ZONE_ORDER: ZoneCode[] = ["bus_stop", "crosswalk", "hydrant", "lamp_post", "pothole", "mailbox"];
