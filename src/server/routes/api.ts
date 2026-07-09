import { Hono } from 'hono';
import { context, redis, reddit } from '@devvit/web/server';
import type {
  DecrementResponse,
  IncrementResponse,
  InitResponse,
  GetDailyPuzzleResponse,
  BombRequest,
  BombResponse,
  GetLeaderboardResponse,
  LeaderboardEntry,
} from '../../shared/api';
import {
  generateDailyPuzzle,
  todayDateKey,
  resolveBomb,
  MAX_BOMBS,
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
// NEW: DAILY BATTLES ROUTES
// =========================================================================

// ---- Redis key helpers ----
// FLEET_VERSION is baked in here — bump it in puzzle.ts whenever ship
// shapes/sizes/rules change, and old cached puzzles/sessions become
// orphaned (harmless, just ignored) instead of silently served stale.
const puzzleKey = (dateKey: string) => `daily-battles:v${FLEET_VERSION}:puzzle:${dateKey}`;
const sessionKey = (dateKey: string, username: string) =>
  `daily-battles:v${FLEET_VERSION}:session:${dateKey}:${username}`;
const leaderboardKey = (dateKey: string) => `daily-battles:v${FLEET_VERSION}:leaderboard:${dateKey}`;

type CellState = 'idle' | 'miss' | 'hit' | 'sunk';

type SessionState = {
  bombsUsed: number;
  cellStates: CellState[][];
  hitKeys: string[];
  sunkShipIds: number[];
  gameOver: boolean;
  won: boolean;
};

function emptyCellStates(): CellState[][] {
  return Array.from({ length: 10 }, () => Array(10).fill('idle') as CellState[]);
}

function freshSession(): SessionState {
  return {
    bombsUsed: 0,
    cellStates: emptyCellStates(),
    hitKeys: [],
    sunkShipIds: [],
    gameOver: false,
    won: false,
  };
}

async function getOrCreatePuzzle(dateKey: string) {
  const cached = await redis.get(puzzleKey(dateKey));
  if (cached) {
    return JSON.parse(cached) as ReturnType<typeof generateDailyPuzzle>;
  }
  const puzzle = generateDailyPuzzle(dateKey);
  await redis.set(puzzleKey(dateKey), JSON.stringify(puzzle));
  return puzzle;
}

async function getOrCreateSession(dateKey: string, username: string): Promise<SessionState> {
  const cached = await redis.get(sessionKey(dateKey, username));
  if (cached) return JSON.parse(cached) as SessionState;
  const fresh = freshSession();
  await redis.set(sessionKey(dateKey, username), JSON.stringify(fresh));
  return fresh;
}

async function saveSession(dateKey: string, username: string, session: SessionState) {
  await redis.set(sessionKey(dateKey, username), JSON.stringify(session));
}

async function appendToLeaderboard(dateKey: string, username: string, bombsUsed: number) {
  const raw = await redis.get(leaderboardKey(dateKey));
  const entries: LeaderboardEntry[] = raw ? JSON.parse(raw) : [];

  const existingIdx = entries.findIndex((e) => e.username === username);
  const existingEntry = existingIdx >= 0 ? entries[existingIdx] : undefined;
  if (existingEntry !== undefined) {
    if (bombsUsed < existingEntry.bombsUsed) {
      existingEntry.bombsUsed = bombsUsed;
    }
  } else {
    entries.push({ username, bombsUsed });
  }

  entries.sort((a, b) => a.bombsUsed - b.bombsUsed);
  await redis.set(leaderboardKey(dateKey), JSON.stringify(entries));
}

// ---- GET /api/daily-puzzle ----
api.get('/daily-puzzle', async (c) => {
  const { postId } = context;
  if (!postId) {
    return c.json<ErrorResponse>({ status: 'error', message: 'postId is required' }, 400);
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
      cellStates: session.cellStates,
      sunkShipIds: session.sunkShipIds,
      gameOver: session.gameOver,
      won: session.won,
    });
  } catch (error) {
    console.error(`Daily puzzle error for post ${postId}:`, error);
    const message = error instanceof Error ? error.message : 'Unknown error fetching puzzle';
    return c.json<ErrorResponse>({ status: 'error', message }, 400);
  }
});

// ---- POST /api/bomb ----
api.post('/bomb', async (c) => {
  const { postId } = context;
  if (!postId) {
    return c.json<ErrorResponse>({ status: 'error', message: 'postId is required' }, 400);
  }

  try {
    const body = await c.req.json<BombRequest>();
    const { r, c: col } = body;

    if (
      typeof r !== 'number' || typeof col !== 'number' ||
      r < 0 || r > 9 || col < 0 || col > 9
    ) {
      return c.json<ErrorResponse>({ status: 'error', message: 'Invalid cell coordinates' }, 400);
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
        r, c: col,
        bombsUsed: session.bombsUsed,
        bombsLeft: MAX_BOMBS - session.bombsUsed,
        gameOver: true,
        won: session.won,
      });
    }

    if (session.bombsUsed >= MAX_BOMBS) {
      return c.json<BombResponse>({
        result: 'no-bombs-left',
        r, c: col,
        bombsUsed: session.bombsUsed,
        bombsLeft: 0,
        gameOver: true,
        won: false,
      });
    }

    const hitsSoFar = new Set(session.hitKeys);
    const outcome = resolveBomb(puzzle, r, col, hitsSoFar);

    if (outcome.result === 'already-bombed') {
      return c.json<BombResponse>({
        result: 'already-bombed',
        r, c: col,
        bombsUsed: session.bombsUsed,
        bombsLeft: MAX_BOMBS - session.bombsUsed,
        gameOver: session.gameOver,
        won: session.won,
      });
    }

    session.bombsUsed += 1;
    const cellState: CellState = outcome.result === 'miss' ? 'miss'
      : outcome.result === 'sunk' ? 'sunk' : 'hit';
    const targetRow = session.cellStates[r];
    if (targetRow === undefined) {
      return c.json<ErrorResponse>({ status: 'error', message: 'Invalid row index' }, 400);
    }
    targetRow[col] = cellState;

    if (outcome.result === 'hit' || outcome.result === 'sunk') {
      session.hitKeys.push(`${r},${col}`);
    }
    if (outcome.result === 'sunk' && outcome.shipId !== undefined) {
      session.sunkShipIds.push(outcome.shipId);
      outcome.sunkShipCells?.forEach(({ r: sr, c: sc }) => {
        const sunkRow = session.cellStates[sr];
        if (sunkRow !== undefined) sunkRow[sc] = 'sunk';
      });
    }

    const allSunk = session.sunkShipIds.length === puzzle.ships.length;
    const outOfBombs = session.bombsUsed >= MAX_BOMBS;

    if (allSunk) {
      session.gameOver = true;
      session.won = true;
      await appendToLeaderboard(dateKey, username, session.bombsUsed);
    } else if (outOfBombs) {
      session.gameOver = true;
      session.won = false;
    }

    await saveSession(dateKey, username, session);

    return c.json<BombResponse>({
      result: outcome.result,
      r, c: col,
      shipId: outcome.shipId,
      sunkShipCells: outcome.sunkShipCells,
      bombsUsed: session.bombsUsed,
      bombsLeft: MAX_BOMBS - session.bombsUsed,
      gameOver: session.gameOver,
      won: session.won,
    });
  } catch (error) {
    console.error(`Bomb error for post ${postId}:`, error);
    const message = error instanceof Error ? error.message : 'Unknown error resolving bomb';
    return c.json<ErrorResponse>({ status: 'error', message }, 400);
  }
});

// ---- GET /api/leaderboard ----
api.get('/leaderboard', async (c) => {
  const { postId } = context;
  if (!postId) {
    return c.json<ErrorResponse>({ status: 'error', message: 'postId is required' }, 400);
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
    const message = error instanceof Error ? error.message : 'Unknown error fetching leaderboard';
    return c.json<ErrorResponse>({ status: 'error', message }, 400);
  }
});