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
// used costs a flat penalty; bombs saved add a smaller bonus, so efficiency
// matters but finding the fleet is still the dominant factor (max ship
// score 210 vs max efficiency bonus 64 — a full fleet always outscores a
// merely-efficient partial one). Floored at 0 overall.
export const SCORE_PER_CELL = 10;
export const HINT_PENALTY = 15;
export const BOMB_EFFICIENCY_BONUS = 2;

export function computeScore(
  shipSizesById: { id: number; size: number }[],
  sunkShipIds: number[],
  hintsUsed: number,
  bombsUsed: number,
  bombsMax: number
): number {
  const sunkSet = new Set(sunkShipIds);
  const shipScore = shipSizesById
    .filter((s) => sunkSet.has(s.id))
    .reduce((sum, s) => sum + s.size * SCORE_PER_CELL, 0);
  const bombsRemaining = Math.max(0, bombsMax - bombsUsed);
  const efficiencyBonus = bombsRemaining * BOMB_EFFICIENCY_BONUS;
  return Math.max(0, shipScore + efficiencyBonus - hintsUsed * HINT_PENALTY);
}

// Streak info — persists across days, independent of any single day's
// puzzle. Included in every response that can end a game, plus the initial
// load, so the client always has a current view of it.
export type StreakInfo = {
  currentStreak: number;
  longestStreak: number;
  superBombs: number; // +1 every time currentStreak hits a multiple of 5
};

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
  streak: StreakInfo;
};

// POST /api/bomb
export type BombRequest = {
  r: number;
  c: number;
};

export type RevealedShip = {
  id: number;
  name: string;
  cells: { r: number; c: number }[];
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
  streak: StreakInfo;
  // Populated only when this response is the one that ends the game in a
  // loss (gameOver && !won) — the ships that were never found, so the
  // client can show what was missed instead of just ending abruptly.
  revealedShips?: RevealedShip[];
};

// POST /api/super-bomb — earned via streak milestones, not tied to the
// normal bomb count. Hits a 2x2 area at once: (r,c), (r,c+1), (r+1,c),
// (r+1,c+1). r/c must leave room for the full 2x2 (0-8 on a 10-wide grid).
export type SuperBombRequest = {
  r: number;
  c: number;
};

export type SuperBombCellResult = {
  r: number;
  c: number;
  result: 'miss' | 'hit' | 'sunk' | 'already-bombed';
  shipId?: number;
  sunkShipCells?: { r: number; c: number }[];
};

export type SuperBombResponse = {
  cells: SuperBombCellResult[]; // always 4, in (r,c)/(r,c+1)/(r+1,c)/(r+1,c+1) order
  superBombsLeft: number;
  score: number;
  gameOver: boolean;
  won: boolean;
  streak: StreakInfo;
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
  streak: StreakInfo;
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

// POST /api/share-result — no request body needed, uses the caller's own
// finished session
export type ShareResultResponse = {
  status: 'ok' | 'error';
  message?: string;
};

// ---- Practice mode ----
// Same shapes as the real endpoints, deliberately kept separate rather than
// reusing GetDailyPuzzleResponse/BombResponse/HintResponse — practice has no
// streak, no leaderboard, no daily reset, and mixing those concerns into the
// real types risked a real session accidentally picking up practice-only
// fields (or vice versa).

export type PracticeStartResponse = {
  fleet: FleetManifestEntry[];
  bombsMax: number;
  hintsMax: number;
};

export type PracticeBombRequest = {
  r: number;
  c: number;
};

export type PracticeBombResponse = {
  result: 'miss' | 'hit' | 'sunk' | 'already-bombed' | 'no-bombs-left';
  r: number;
  c: number;
  shipId?: number;
  sunkShipCells?: { r: number; c: number }[];
  bombsLeft: number;
  gameOver: boolean;
  won: boolean;
};

export type PracticeHintResponse = {
  cell: { r: number; c: number } | null;
  shipId?: number;
  sunk: boolean;
  sunkShipCells?: { r: number; c: number }[];
  hintsLeft: number;
  gameOver: boolean;
  won: boolean;
};
