// src/shared/api.ts
//
// Types shared between client and server. Kept framework-agnostic —
// no Devvit imports — so both sides can import freely.

export type InitResponse = {
  type: "init";
  postId: string;
  count: number;
  username: string;
};

export type IncrementResponse = {
  type: "increment";
  postId: string;
  count: number;
};

export type DecrementResponse = {
  type: "decrement";
  postId: string;
  count: number;
};

export type FleetManifestEntry = {
  id: number;
  size: number;
  name: string;
  shapeName: 'L' | 'square' | 'Z' | 'I' | 'corner' | 'domino';
  cells: { dr: number; dc: number }[]; // canonical shape only — never today's rotation
};

// GET /api/daily-puzzle
export type GetDailyPuzzleResponse = {
  dateKey: string;
  fleet: FleetManifestEntry[];   // sizes only — never positions
  bombsMax: number;
  bombsUsed: number;             // resuming a session already in progress
  cellStates: ('idle' | 'miss' | 'hit' | 'sunk')[][]; // player's own board so far
  sunkShipIds: number[];
  gameOver: boolean;
  won: boolean;
};

// POST /api/bomb
export type BombRequest = {
  r: number;
  c: number;
};

export type BombResponse = {
  result: 'miss' | 'hit' | 'sunk' | 'already-bombed' | 'no-bombs-left';
  r: number;
  c: number;
  shipId?: number;
  sunkShipCells?: { r: number; c: number }[]; // reveal full ship on sink, for the animation
  bombsUsed: number;
  bombsLeft: number;
  gameOver: boolean;
  won: boolean;
};

// GET /api/leaderboard
export type LeaderboardEntry = {
  username: string;
  bombsUsed: number;
};

export type GetLeaderboardResponse = {
  dateKey: string;
  entries: LeaderboardEntry[]; // sorted ascending by bombsUsed
  myRank?: number;
};