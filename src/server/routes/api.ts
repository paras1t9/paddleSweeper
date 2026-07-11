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
  StreakInfo,
  RevealedShip,
  ShareResultResponse,
  PracticeStartResponse,
  PracticeBombRequest,
  PracticeBombResponse,
  PracticeHintResponse,
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

// Deliberately NOT versioned with FLEET_VERSION — a streak is a long-lived
// motivational record, and shouldn't reset just because we tweak ship
// shapes or scoring. It only cares about "did you play yesterday".
const streakKey = (username: string) => `daily-battles:streak:${username}`;

// Practice mode — no date, no version. Each /practice/start overwrites
// whatever practice session existed before; there's nothing worth
// preserving across attempts.
const practicePuzzleKey = (username: string) =>
  `daily-battles:practice:${username}:puzzle`;
const practiceSessionKey = (username: string) =>
  `daily-battles:practice:${username}:session`;
const PRACTICE_BOMBS_MAX = 40;
const PRACTICE_HINTS_MAX = 8;

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

// Practice sessions are structurally identical to real ones — reusing the
// type (rather than a near-duplicate) guarantees applyResolvedCell() works
// on both without risk of the two shapes silently drifting apart.
type PracticeSessionState = SessionState;

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

// Applies a resolved hit/sunk cell to session state. Shared by /bomb, /hint,
// and both practice equivalents, so none of the four paths can silently
// diverge on how a "found" cell gets recorded.
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

// ---- Streaks ----

type StreakRecord = {
  currentStreak: number;
  longestStreak: number;
  lastPlayedDateKey: string;
};

async function getStreakRecord(username: string): Promise<StreakRecord> {
  const raw = await redis.get(streakKey(username));
  if (raw) return JSON.parse(raw) as StreakRecord;
  return { currentStreak: 0, longestStreak: 0, lastPlayedDateKey: '' };
}

function toStreakInfo(record: StreakRecord): StreakInfo {
  return {
    currentStreak: record.currentStreak,
    longestStreak: record.longestStreak,
  };
}

// Read-only — for responses that don't end a game (e.g. the initial load,
// or an early-return on an already-finished session).
async function peekStreak(username: string): Promise<StreakInfo> {
  return toStreakInfo(await getStreakRecord(username));
}

function isConsecutiveDay(
  prevDateKey: string,
  currentDateKey: string
): boolean {
  if (!prevDateKey) return false;
  const prev = new Date(`${prevDateKey}T00:00:00Z`).getTime();
  const curr = new Date(`${currentDateKey}T00:00:00Z`).getTime();
  if (Number.isNaN(prev) || Number.isNaN(curr)) return false;
  const diffDays = Math.round((curr - prev) / (24 * 60 * 60 * 1000));
  return diffDays === 1;
}

// Called exactly once, the moment a game actually finishes (win or loss).
// Idempotent against being called twice for the same day, just in case.
async function updateStreakOnFinish(
  username: string,
  dateKey: string
): Promise<StreakInfo> {
  const record = await getStreakRecord(username);

  if (record.lastPlayedDateKey === dateKey) {
    return toStreakInfo(record); // already recorded today
  }

  const nextCurrent = isConsecutiveDay(record.lastPlayedDateKey, dateKey)
    ? record.currentStreak + 1
    : 1;
  const nextRecord: StreakRecord = {
    currentStreak: nextCurrent,
    longestStreak: Math.max(record.longestStreak, nextCurrent),
    lastPlayedDateKey: dateKey,
  };
  await redis.set(streakKey(username), JSON.stringify(nextRecord));
  return toStreakInfo(nextRecord);
}

// Checks whether the round just ended (all ships sunk, or out of bombs) and,
// if so: marks the session over, records the leaderboard entry, and updates
// the streak. Returns the fresh streak info if the game was just finished by
// THIS call, or null if it was already over (nothing to do). Shared by
// /bomb and /hint — a hint can complete the last ship just as validly as a
// bomb can, so both paths need to end the game the same way.
async function finishGameIfNeeded(
  session: SessionState,
  puzzle: Puzzle,
  dateKey: string,
  username: string
): Promise<StreakInfo | null> {
  if (session.gameOver) return null;

  const allSunk = session.sunkShipIds.length === puzzle.ships.length;
  const outOfBombs = session.bombsUsed >= MAX_BOMBS;
  if (!allSunk && !outOfBombs) return null;

  session.gameOver = true;
  session.won = allSunk;

  await appendToLeaderboard(dateKey, username, {
    score: sessionScore(session, puzzle),
    shipsFound: session.sunkShipIds.length,
    hintsUsed: session.hintsUsed,
    bombsUsed: session.bombsUsed,
  });

  return updateStreakOnFinish(username, dateKey);
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
    const resolvedUsername = username ?? 'anonymous';
    const [session, streak] = await Promise.all([
      getOrCreateSession(dateKey, resolvedUsername),
      peekStreak(resolvedUsername),
    ]);

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
      streak,
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
    const [usernameRaw, puzzle] = await Promise.all([
      reddit.getCurrentUsername(),
      getOrCreatePuzzle(dateKey),
    ]);
    const username = usernameRaw ?? 'anonymous';
    const session = await getOrCreateSession(dateKey, username);
    let streak = await peekStreak(username);

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
        streak,
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
        streak,
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
        streak,
      });
    }

    session.bombsUsed += 1;
    applyResolvedCell(session, outcome, r, col);

    const justFinishedStreak = await finishGameIfNeeded(
      session,
      puzzle,
      dateKey,
      username
    );
    if (justFinishedStreak) streak = justFinishedStreak;
    await saveSession(dateKey, username, session);

    let revealedShips: RevealedShip[] | undefined;
    if (justFinishedStreak && !session.won) {
      // This bomb is what just ended the round, and it was a loss — reveal
      // the ships that were never found instead of just cutting the round
      // short with no closure.
      revealedShips = puzzle.ships
        .filter((s) => !session.sunkShipIds.includes(s.id))
        .map((s) => ({ id: s.id, name: s.name, cells: s.cells }));
    }

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
      streak,
      revealedShips,
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
    const [usernameRaw, puzzle] = await Promise.all([
      reddit.getCurrentUsername(),
      getOrCreatePuzzle(dateKey),
    ]);
    const username = usernameRaw ?? 'anonymous';
    const session = await getOrCreateSession(dateKey, username);
    let streak = await peekStreak(username);

    if (session.gameOver) {
      return c.json<HintResponse>({
        cell: null,
        sunk: false,
        hintsUsed: session.hintsUsed,
        hintsLeft: Math.max(0, MAX_HINTS - session.hintsUsed),
        score: sessionScore(session, puzzle),
        gameOver: true,
        won: session.won,
        streak,
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
        streak,
      });
    }

    const hitsSoFar = new Set(session.hitKeys);
    const hintCell = getHintCell(puzzle, hitsSoFar);

    if (!hintCell) {
      return c.json<HintResponse>({
        cell: null,
        sunk: false,
        hintsUsed: session.hintsUsed,
        hintsLeft: Math.max(0, MAX_HINTS - session.hintsUsed),
        score: sessionScore(session, puzzle),
        gameOver: session.gameOver,
        won: session.won,
        streak,
      });
    }

    // getHintCell only ever returns an unhit, ship-occupied cell, so this is
    // guaranteed to resolve as 'hit' or 'sunk' — never 'miss'/'already-bombed'.
    const outcome = resolveBomb(puzzle, hintCell.r, hintCell.c, hitsSoFar);
    applyResolvedCell(session, outcome, hintCell.r, hintCell.c);
    session.hintsUsed += 1;

    const justFinishedStreak = await finishGameIfNeeded(
      session,
      puzzle,
      dateKey,
      username
    );
    if (justFinishedStreak) streak = justFinishedStreak;
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
      streak,
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

// ---- POST /api/share-result ----
api.post('/share-result', async (c) => {
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

    if (!session.gameOver) {
      return c.json<ShareResultResponse>({
        status: 'error',
        message: "Finish today's puzzle before sharing your result.",
      });
    }

    const score = sessionScore(session, puzzle);
    const shipsFound = session.sunkShipIds.length;
    const totalShips = puzzle.ships.length;

    const resultLine = session.won
      ? `\u2693 Solved today's Daily Battles fleet! Score: ${score} (${session.bombsUsed} bombs, ${session.hintsUsed} hints used)`
      : `\u2693 Fought today's Daily Battles fleet — found ${shipsFound}/${totalShips} ships. Score: ${score} (${session.bombsUsed} bombs, ${session.hintsUsed} hints used)`;

    // Not using runAs: 'USER' here — that requires a specific
    // permissions.reddit.asUser scope in devvit.json that Devvit's own docs
    // don't spell out an exact value for, and getting it wrong just trades
    // one error for another. Posting as the app avoids that dependency
    // entirely; the comment text still clearly states it's the player's
    // result, just not cryptographically "from" their account.
    await reddit.submitComment({ id: postId, text: resultLine });

    return c.json<ShareResultResponse>({ status: 'ok' });
  } catch (error) {
    console.error('Share result error:', error);
    const message =
      error instanceof Error ? error.message : 'Unknown error sharing result';
    return c.json<ShareResultResponse>({ status: 'error', message });
  }
});

// =========================================================================
// PRACTICE MODE — separate puzzle/session, no streak, no leaderboard,
// no daily reset. Lets a new player learn the mechanics without spending
// their one real attempt for the day.
// =========================================================================

api.post('/practice/start', async (c) => {
  const { postId } = context;
  if (!postId) {
    return c.json<ErrorResponse>(
      { status: 'error', message: 'postId is required' },
      400
    );
  }

  try {
    const username = (await reddit.getCurrentUsername()) ?? 'anonymous';
    const seed = `practice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const puzzle = generateDailyPuzzle(seed);
    const fresh = freshSession();

    await Promise.all([
      redis.set(practicePuzzleKey(username), JSON.stringify(puzzle)),
      redis.set(practiceSessionKey(username), JSON.stringify(fresh)),
    ]);

    return c.json<PracticeStartResponse>({
      fleet: toFleetManifest(puzzle),
      bombsMax: PRACTICE_BOMBS_MAX,
      hintsMax: PRACTICE_HINTS_MAX,
    });
  } catch (error) {
    console.error('Practice start error:', error);
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown error starting practice';
    return c.json<ErrorResponse>({ status: 'error', message }, 400);
  }
});

api.post('/practice/bomb', async (c) => {
  const { postId } = context;
  if (!postId) {
    return c.json<ErrorResponse>(
      { status: 'error', message: 'postId is required' },
      400
    );
  }

  try {
    const body = await c.req.json<PracticeBombRequest>();
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

    const username = (await reddit.getCurrentUsername()) ?? 'anonymous';
    const [puzzleRaw, sessionRaw] = await Promise.all([
      redis.get(practicePuzzleKey(username)),
      redis.get(practiceSessionKey(username)),
    ]);
    if (!puzzleRaw || !sessionRaw) {
      return c.json<ErrorResponse>(
        {
          status: 'error',
          message: 'No active practice session — start one first',
        },
        400
      );
    }
    const puzzle = JSON.parse(puzzleRaw) as Puzzle;
    const session = JSON.parse(sessionRaw) as PracticeSessionState;

    if (session.gameOver) {
      return c.json<PracticeBombResponse>({
        result: 'already-bombed',
        r,
        c: col,
        bombsLeft: PRACTICE_BOMBS_MAX - session.bombsUsed,
        gameOver: true,
        won: session.won,
      });
    }
    if (session.bombsUsed >= PRACTICE_BOMBS_MAX) {
      return c.json<PracticeBombResponse>({
        result: 'no-bombs-left',
        r,
        c: col,
        bombsLeft: 0,
        gameOver: true,
        won: false,
      });
    }

    const hitsSoFar = new Set(session.hitKeys);
    const outcome = resolveBomb(puzzle, r, col, hitsSoFar);

    if (outcome.result === 'already-bombed') {
      return c.json<PracticeBombResponse>({
        result: 'already-bombed',
        r,
        c: col,
        bombsLeft: PRACTICE_BOMBS_MAX - session.bombsUsed,
        gameOver: session.gameOver,
        won: session.won,
      });
    }

    session.bombsUsed += 1;
    applyResolvedCell(session, outcome, r, col);

    const allSunk = session.sunkShipIds.length === puzzle.ships.length;
    const outOfBombs = session.bombsUsed >= PRACTICE_BOMBS_MAX;
    if (allSunk || outOfBombs) {
      session.gameOver = true;
      session.won = allSunk;
    }

    await redis.set(practiceSessionKey(username), JSON.stringify(session));

    return c.json<PracticeBombResponse>({
      result: outcome.result,
      r,
      c: col,
      shipId: outcome.shipId,
      sunkShipCells: outcome.sunkShipCells,
      bombsLeft: PRACTICE_BOMBS_MAX - session.bombsUsed,
      gameOver: session.gameOver,
      won: session.won,
    });
  } catch (error) {
    console.error('Practice bomb error:', error);
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown error resolving practice bomb';
    return c.json<ErrorResponse>({ status: 'error', message }, 400);
  }
});

api.post('/practice/hint', async (c) => {
  const { postId } = context;
  if (!postId) {
    return c.json<ErrorResponse>(
      { status: 'error', message: 'postId is required' },
      400
    );
  }

  try {
    const username = (await reddit.getCurrentUsername()) ?? 'anonymous';
    const [puzzleRaw, sessionRaw] = await Promise.all([
      redis.get(practicePuzzleKey(username)),
      redis.get(practiceSessionKey(username)),
    ]);
    if (!puzzleRaw || !sessionRaw) {
      return c.json<ErrorResponse>(
        {
          status: 'error',
          message: 'No active practice session — start one first',
        },
        400
      );
    }
    const puzzle = JSON.parse(puzzleRaw) as Puzzle;
    const session = JSON.parse(sessionRaw) as PracticeSessionState;

    if (session.gameOver) {
      return c.json<PracticeHintResponse>({
        cell: null,
        sunk: false,
        hintsLeft: Math.max(0, PRACTICE_HINTS_MAX - session.hintsUsed),
        gameOver: true,
        won: session.won,
      });
    }
    if (session.hintsUsed >= PRACTICE_HINTS_MAX) {
      return c.json<PracticeHintResponse>({
        cell: null,
        sunk: false,
        hintsLeft: 0,
        gameOver: false,
        won: false,
      });
    }

    const hitsSoFar = new Set(session.hitKeys);
    const hintCell = getHintCell(puzzle, hitsSoFar);
    if (!hintCell) {
      return c.json<PracticeHintResponse>({
        cell: null,
        sunk: false,
        hintsLeft: Math.max(0, PRACTICE_HINTS_MAX - session.hintsUsed),
        gameOver: session.gameOver,
        won: session.won,
      });
    }

    const outcome = resolveBomb(puzzle, hintCell.r, hintCell.c, hitsSoFar);
    applyResolvedCell(session, outcome, hintCell.r, hintCell.c);
    session.hintsUsed += 1;

    const allSunk = session.sunkShipIds.length === puzzle.ships.length;
    if (allSunk) {
      session.gameOver = true;
      session.won = true;
    }

    await redis.set(practiceSessionKey(username), JSON.stringify(session));

    return c.json<PracticeHintResponse>({
      cell: { r: hintCell.r, c: hintCell.c },
      shipId: outcome.shipId,
      sunk: outcome.result === 'sunk',
      sunkShipCells: outcome.sunkShipCells,
      hintsLeft: Math.max(0, PRACTICE_HINTS_MAX - session.hintsUsed),
      gameOver: session.gameOver,
      won: session.won,
    });
  } catch (error) {
    console.error('Practice hint error:', error);
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown error resolving practice hint';
    return c.json<ErrorResponse>({ status: 'error', message }, 400);
  }
});
