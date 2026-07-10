import { Hono } from 'hono';
import { context, redis, reddit } from '@devvit/web/server';
import type {
  DecrementResponse,
  IncrementResponse,
  InitResponse,
  GetDailyPuzzleResponse,
  BombRequest,
  BombResponse,
  HintResponse,
  GetLeaderboardResponse,
  LeaderboardEntry,
} from '../../shared/api';
import { computeScore } from '../../shared/api';
import {
  generateDailyPuzzle,
  todayDateKey,
  resolveBomb,
  getHintCell,
  MAX_BOMBS,
  MAX_HINTS,
  toFleetManifest,
  FLEET_VERSION,
} from '../core/puzzle';

type ErrorResponse = {
  status: 'error';
  message: string;
};

export const api = new Hono();

// =========================================================================
// ORIGINAL TEMPLATE ROUTES (unchanged)
// =========================================================================

api.get('/init', async (c) => {
  const { postId } = context;

  if (!postId) {
    console.error('API Init Error: postId not found in devvit context');
    return c.json<ErrorResponse>(
      {
        status: 'error',
        message: 'postId is required but missing from context',
      },
      400
    );
  }

  try {
    const [count, username] = await Promise.all([
      redis.get('count'),
      reddit.getCurrentUsername(),
    ]);

    return c.json<InitResponse>({
      type: 'init',
      postId: postId,
      count: count ? parseInt(count) : 0,
      username: username ?? 'anonymous',
    });
  } catch (error) {
    console.error(`API Init Error for post ${postId}:`, error);
    let errorMessage = 'Unknown error during initialization';
    if (error instanceof Error) {
      errorMessage = `Initialization failed: ${error.message}`;
    }
    return c.json<ErrorResponse>(
      { status: 'error', message: errorMessage },
      400
    );
  }
});

api.post('/increment', async (c) => {
  const { postId } = context;
  if (!postId) {
    return c.json<ErrorResponse>(
      {
        status: 'error',
        message: 'postId is required',
      },
      400
    );
  }

  const count = await redis.incrBy('count', 1);
  return c.json<IncrementResponse>({
    count,
    postId,
    type: 'increment',
  });
});

api.post('/decrement', async (c) => {
  const { postId } = context;
  if (!postId) {
    return c.json<ErrorResponse>(
      {
        status: 'error',
        message: 'postId is required',
      },
      400
    );
  }

  const count = await redis.incrBy('count', -1);
  return c.json<DecrementResponse>({
    count,
    postId,
    type: 'decrement',
  });
});

// =========================================================================
// DAILY BATTLES ROUTES
// =========================================================================

// ---- Redis key helpers ----
// FLEET_VERSION is baked in here — bump it in puzzle.ts whenever ship
// shapes/sizes/rules change (including scoring rules), and old cached
// puzzles/sessions become orphaned (harmless, just ignored) instead of
// silently served stale.
const puzzleKey = (dateKey: string) =>
  `daily-battles:v${FLEET_VERSION}:puzzle:${dateKey}`;
const sessionKey = (dateKey: string, username: string) =>
  `daily-battles:v${FLEET_VERSION}:session:${dateKey}:${username}`;
const leaderboardKey = (dateKey: string) =>
  `daily-battles:v${FLEET_VERSION}:leaderboard:${dateKey}`;

type CellState = 'idle' | 'miss' | 'hit' | 'sunk';
type Puzzle = ReturnType<typeof generateDailyPuzzle>;

type SessionState = {
  bombsUsed: number;
  hintsUsed: number;
  cellStates: CellState[][];
  hitKeys: string[];
  sunkShipIds: number[];
  gameOver: boolean;
  won: boolean;
};

function emptyCellStates(): CellState[][] {
  return Array.from(
    { length: 10 },
    () => Array(10).fill('idle') as CellState[]
  );
}

function freshSession(): SessionState {
  return {
    bombsUsed: 0,
    hintsUsed: 0,
    cellStates: emptyCellStates(),
    hitKeys: [],
    sunkShipIds: [],
    gameOver: false,
    won: false,
  };
}

async function getOrCreatePuzzle(dateKey: string): Promise<Puzzle> {
  const cached = await redis.get(puzzleKey(dateKey));
  if (cached) {
    return JSON.parse(cached) as Puzzle;
  }
  const puzzle = generateDailyPuzzle(dateKey);
  await redis.set(puzzleKey(dateKey), JSON.stringify(puzzle));
  return puzzle;
}

async function getOrCreateSession(
  dateKey: string,
  username: string
): Promise<SessionState> {
  const cached = await redis.get(sessionKey(dateKey, username));
  if (cached) return JSON.parse(cached) as SessionState;
  const fresh = freshSession();
  await redis.set(sessionKey(dateKey, username), JSON.stringify(fresh));
  return fresh;
}

async function saveSession(
  dateKey: string,
  username: string,
  session: SessionState
) {
  await redis.set(sessionKey(dateKey, username), JSON.stringify(session));
}

function sessionScore(session: SessionState, puzzle: Puzzle): number {
  return computeScore(
    puzzle.ships.map((s) => ({ id: s.id, size: s.size })),
    session.sunkShipIds,
    session.hintsUsed
  );
}

// Applies a resolved hit/sunk cell to session state. Shared by both /bomb
// and /hint so the two paths can't silently diverge on how a "found" cell
// gets recorded.
function applyResolvedCell(
  session: SessionState,
  outcome: ReturnType<typeof resolveBomb>,
  r: number,
  col: number
): void {
  if (outcome.result !== 'hit' && outcome.result !== 'sunk') return;

  const cellState: CellState = outcome.result === 'sunk' ? 'sunk' : 'hit';
  const targetRow = session.cellStates[r];
  if (targetRow !== undefined) targetRow[col] = cellState;

  session.hitKeys.push(`${r},${col}`);

  if (outcome.result === 'sunk' && outcome.shipId !== undefined) {
    session.sunkShipIds.push(outcome.shipId);
    outcome.sunkShipCells?.forEach(({ r: sr, c: sc }) => {
      const sunkRow = session.cellStates[sr];
      if (sunkRow !== undefined) sunkRow[sc] = 'sunk';
    });
  }
}

// Checks whether the round just ended (all ships sunk, or out of bombs) and,
// if so, marks the session over and records the final score on the
// leaderboard. Shared by /bomb and /hint — a hint can complete the last ship
// just as validly as a bomb can, so both paths need to end the game the
// same way.
async function finishGameIfNeeded(
  session: SessionState,
  puzzle: Puzzle,
  dateKey: string,
  username: string
): Promise<void> {
  if (session.gameOver) return;

  const allSunk = session.sunkShipIds.length === puzzle.ships.length;
  const outOfBombs = session.bombsUsed >= MAX_BOMBS;
  if (!allSunk && !outOfBombs) return;

  session.gameOver = true;
  session.won = allSunk;

  await appendToLeaderboard(dateKey, username, {
    score: sessionScore(session, puzzle),
    shipsFound: session.sunkShipIds.length,
    hintsUsed: session.hintsUsed,
    bombsUsed: session.bombsUsed,
  });
}

async function appendToLeaderboard(
  dateKey: string,
  username: string,
  entryData: {
    score: number;
    shipsFound: number;
    hintsUsed: number;
    bombsUsed: number;
  }
) {
  const raw = await redis.get(leaderboardKey(dateKey));
  const entries: LeaderboardEntry[] = raw ? JSON.parse(raw) : [];

  const existingIdx = entries.findIndex((e) => e.username === username);
  const existingEntry = existingIdx >= 0 ? entries[existingIdx] : undefined;
  const newEntry: LeaderboardEntry = { username, ...entryData };

  if (existingEntry !== undefined) {
    if (entryData.score > existingEntry.score) {
      entries[existingIdx] = newEntry;
    }
  } else {
    entries.push(newEntry);
  }

  entries.sort((a, b) => b.score - a.score || a.bombsUsed - b.bombsUsed);
  await redis.set(leaderboardKey(dateKey), JSON.stringify(entries));
}

// ---- GET /api/daily-puzzle ----
api.get('/daily-puzzle', async (c) => {
  const { postId } = context;
  if (!postId) {
    return c.json<ErrorResponse>(
      { status: 'error', message: 'postId is required' },
      400
    );
  }

  try {
    const dateKey = todayDateKey();
    const [puzzle, username] = await Promise.all([
      getOrCreatePuzzle(dateKey),
      reddit.getCurrentUsername(),
    ]);
    const session = await getOrCreateSession(dateKey, username ?? 'anonymous');

    return c.json<GetDailyPuzzleResponse>({
      dateKey,
      fleet: toFleetManifest(puzzle),
      bombsMax: MAX_BOMBS,
      bombsUsed: session.bombsUsed,
      hintsMax: MAX_HINTS,
      hintsUsed: session.hintsUsed,
      score: sessionScore(session, puzzle),
      cellStates: session.cellStates,
      sunkShipIds: session.sunkShipIds,
      gameOver: session.gameOver,
      won: session.won,
    });
  } catch (error) {
    console.error(`Daily puzzle error for post ${postId}:`, error);
    const message =
      error instanceof Error ? error.message : 'Unknown error fetching puzzle';
    return c.json<ErrorResponse>({ status: 'error', message }, 400);
  }
});

// ---- POST /api/bomb ----
api.post('/bomb', async (c) => {
  const { postId } = context;
  if (!postId) {
    return c.json<ErrorResponse>(
      { status: 'error', message: 'postId is required' },
      400
    );
  }

  try {
    const body = await c.req.json<BombRequest>();
    const { r, c: col } = body;

    if (
      typeof r !== 'number' ||
      typeof col !== 'number' ||
      r < 0 ||
      r > 9 ||
      col < 0 ||
      col > 9
    ) {
      return c.json<ErrorResponse>(
        { status: 'error', message: 'Invalid cell coordinates' },
        400
      );
    }

    const dateKey = todayDateKey();
    const username = (await reddit.getCurrentUsername()) ?? 'anonymous';
    const [puzzle, session] = await Promise.all([
      getOrCreatePuzzle(dateKey),
      getOrCreateSession(dateKey, username),
    ]);

    if (session.gameOver) {
      return c.json<BombResponse>({
        result: 'already-bombed',
        r,
        c: col,
        bombsUsed: session.bombsUsed,
        bombsLeft: MAX_BOMBS - session.bombsUsed,
        score: sessionScore(session, puzzle),
        gameOver: true,
        won: session.won,
      });
    }

    if (session.bombsUsed >= MAX_BOMBS) {
      return c.json<BombResponse>({
        result: 'no-bombs-left',
        r,
        c: col,
        bombsUsed: session.bombsUsed,
        bombsLeft: 0,
        score: sessionScore(session, puzzle),
        gameOver: true,
        won: false,
      });
    }

    const hitsSoFar = new Set(session.hitKeys);
    const outcome = resolveBomb(puzzle, r, col, hitsSoFar);

    if (outcome.result === 'already-bombed') {
      return c.json<BombResponse>({
        result: 'already-bombed',
        r,
        c: col,
        bombsUsed: session.bombsUsed,
        bombsLeft: MAX_BOMBS - session.bombsUsed,
        score: sessionScore(session, puzzle),
        gameOver: session.gameOver,
        won: session.won,
      });
    }

    session.bombsUsed += 1;
    applyResolvedCell(session, outcome, r, col);
    await finishGameIfNeeded(session, puzzle, dateKey, username);
    await saveSession(dateKey, username, session);

    return c.json<BombResponse>({
      result: outcome.result,
      r,
      c: col,
      shipId: outcome.shipId,
      sunkShipCells: outcome.sunkShipCells,
      bombsUsed: session.bombsUsed,
      bombsLeft: MAX_BOMBS - session.bombsUsed,
      score: sessionScore(session, puzzle),
      gameOver: session.gameOver,
      won: session.won,
    });
  } catch (error) {
    console.error(`Bomb error for post ${postId}:`, error);
    const message =
      error instanceof Error ? error.message : 'Unknown error resolving bomb';
    return c.json<ErrorResponse>({ status: 'error', message }, 400);
  }
});

// ---- POST /api/hint ----
api.post('/hint', async (c) => {
  const { postId } = context;
  if (!postId) {
    return c.json<ErrorResponse>(
      { status: 'error', message: 'postId is required' },
      400
    );
  }

  try {
    const dateKey = todayDateKey();
    const username = (await reddit.getCurrentUsername()) ?? 'anonymous';
    const [puzzle, session] = await Promise.all([
      getOrCreatePuzzle(dateKey),
      getOrCreateSession(dateKey, username),
    ]);

    if (session.gameOver) {
      return c.json<HintResponse>({
        cell: null,
        sunk: false,
        hintsUsed: session.hintsUsed,
        hintsLeft: Math.max(0, MAX_HINTS - session.hintsUsed),
        score: sessionScore(session, puzzle),
        gameOver: true,
        won: session.won,
      });
    }

    if (session.hintsUsed >= MAX_HINTS) {
      return c.json<HintResponse>({
        cell: null,
        sunk: false,
        hintsUsed: session.hintsUsed,
        hintsLeft: 0,
        score: sessionScore(session, puzzle),
        gameOver: false,
        won: false,
      });
    }

    const hitsSoFar = new Set(session.hitKeys);
    const hintCell = getHintCell(puzzle, hitsSoFar);

    if (!hintCell) {
      // Every ship cell already found — nothing left to hint.
      return c.json<HintResponse>({
        cell: null,
        sunk: false,
        hintsUsed: session.hintsUsed,
        hintsLeft: Math.max(0, MAX_HINTS - session.hintsUsed),
        score: sessionScore(session, puzzle),
        gameOver: session.gameOver,
        won: session.won,
      });
    }

    // getHintCell only ever returns an unhit, ship-occupied cell, so this is
    // guaranteed to resolve as 'hit' or 'sunk' — never 'miss'/'already-bombed'.
    const outcome = resolveBomb(puzzle, hintCell.r, hintCell.c, hitsSoFar);
    applyResolvedCell(session, outcome, hintCell.r, hintCell.c);
    session.hintsUsed += 1;

    await finishGameIfNeeded(session, puzzle, dateKey, username);
    await saveSession(dateKey, username, session);

    return c.json<HintResponse>({
      cell: { r: hintCell.r, c: hintCell.c },
      shipId: outcome.shipId,
      sunk: outcome.result === 'sunk',
      sunkShipCells: outcome.sunkShipCells,
      hintsUsed: session.hintsUsed,
      hintsLeft: Math.max(0, MAX_HINTS - session.hintsUsed),
      score: sessionScore(session, puzzle),
      gameOver: session.gameOver,
      won: session.won,
    });
  } catch (error) {
    console.error(`Hint error for post ${postId}:`, error);
    const message =
      error instanceof Error ? error.message : 'Unknown error resolving hint';
    return c.json<ErrorResponse>({ status: 'error', message }, 400);
  }
});

// ---- GET /api/leaderboard ----
api.get('/leaderboard', async (c) => {
  const { postId } = context;
  if (!postId) {
    return c.json<ErrorResponse>(
      { status: 'error', message: 'postId is required' },
      400
    );
  }

  try {
    const dateKey = todayDateKey();
    const [raw, username] = await Promise.all([
      redis.get(leaderboardKey(dateKey)),
      reddit.getCurrentUsername(),
    ]);
    const entries: LeaderboardEntry[] = raw ? JSON.parse(raw) : [];
    const myRank = username
      ? entries.findIndex((e) => e.username === username) + 1 || undefined
      : undefined;

    return c.json<GetLeaderboardResponse>({
      dateKey,
      entries: entries.slice(0, 20),
      myRank,
    });
  } catch (error) {
    console.error('Leaderboard error:', error);
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown error fetching leaderboard';
    return c.json<ErrorResponse>({ status: 'error', message }, 400);
  }
});
