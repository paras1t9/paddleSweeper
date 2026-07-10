// src/shared/api.ts
//
// Types shared between client and server. Kept framework-agnostic —
// no Devvit imports — so both sides can import freely.

export type InitResponse = {
  type: 'init';
  postId: string;
  count: number;
  username: string;
};

export type IncrementResponse = {
  type: 'increment';
  postId: string;
  count: number;
};

export type DecrementResponse = {
  type: 'decrement';
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

// Shared scoring formula — used by both client (real-time HUD display) and
// server (authoritative leaderboard). Bigger ships are worth more; each hint
// used costs a flat penalty. Floored at 0 so a hint-heavy round can't go
// negative.
export const SCORE_PER_CELL = 10;
export const HINT_PENALTY = 15;

export function computeScore(
  shipSizesById: { id: number; size: number }[],
  sunkShipIds: number[],
  hintsUsed: number
): number {
  const sunkSet = new Set(sunkShipIds);
  const shipScore = shipSizesById
    .filter((s) => sunkSet.has(s.id))
    .reduce((sum, s) => sum + s.size * SCORE_PER_CELL, 0);
  return Math.max(0, shipScore - hintsUsed * HINT_PENALTY);
}

// GET /api/daily-puzzle
export type GetDailyPuzzleResponse = {
  dateKey: string;
  fleet: FleetManifestEntry[]; // sizes only — never positions
  bombsMax: number;
  bombsUsed: number; // resuming a session already in progress
  hintsMax: number;
  hintsUsed: number;
  score: number;
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
  score: number;
  gameOver: boolean;
  won: boolean;
};

// POST /api/hint — no request body needed
export type HintResponse = {
  cell: { r: number; c: number } | null; // null if no hints left, or nothing left to hint
  shipId?: number;
  sunk: boolean;
  sunkShipCells?: { r: number; c: number }[];
  hintsUsed: number;
  hintsLeft: number;
  score: number;
  gameOver: boolean;
  won: boolean;
};

// GET /api/leaderboard
export type LeaderboardEntry = {
  username: string;
  score: number;
  shipsFound: number;
  hintsUsed: number;
  bombsUsed: number; // quiet tiebreaker only, not part of the score itself
};

export type GetLeaderboardResponse = {
  dateKey: string;
  entries: LeaderboardEntry[]; // sorted by score descending, bombsUsed ascending as tiebreak
  myRank?: number;
};
