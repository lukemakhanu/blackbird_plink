// Plinko is a frontend-only reskin of the same chicken-cross backend used
// by blackbird-web's chickencross game -- same rounds, same bets, same
// wallet, same settlement poller. gameApi.ts/types.ts are this repo's own
// copies of that client, kept separate so this module's dependency surface
// stays explicit and swappable later if Plinko ever gets a dedicated backend.
export { getCurrentRound, getRoundByID, getHistory, getUpcoming, getWallet, listBets, placeBet } from "./gameApi";
export type { ChickenWallet as PlinkoWallet } from "./gameApi";
export { ZONE_ORDER } from "./types";
export type { ChickenBet as PlinkoBet, ChickenRound as PlinkoRound, ZoneCode } from "./types";
