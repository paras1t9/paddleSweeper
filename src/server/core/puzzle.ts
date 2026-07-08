// src/server/core/puzzle.ts
//
// Deterministic daily puzzle generation for Daily Battles.
// Same date string -> same ship layout, for every player.
// No Devvit imports here on purpose — pure logic, easy to unit test.

export const GRID_SIZE = 10;
export const SHIP_SIZES = [5, 4, 3, 3, 2, 1] as const;
export const MAX_BOMBS = 30;

export type Cell = { r: number; c: number };

export type ShipPlacement = {
  id: number;
  size: number;
  cells: Cell[];
};

export type DailyPuzzle = {
  dateKey: string;          // e.g. "2026-07-06"
  seed: number;
  occupied: number[][];     // GRID_SIZE x GRID_SIZE, -1 or shipId
  ships: ShipPlacement[];
};

// --- Deterministic RNG (mulberry32) ---
// Same seed -> same sequence, every time, on any machine.
function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Turn "2026-07-06" into a stable numeric seed.
function seedFromDateKey(dateKey: string): number {
  let hash = 0;
  for (let i = 0; i < dateKey.length; i++) {
    hash = (hash * 31 + dateKey.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

export function todayDateKey(): string {
  // UTC, so "the daily puzzle" flips at a consistent time worldwide.
  return new Date().toISOString().slice(0, 10);
}

export function generateDailyPuzzle(dateKey: string): DailyPuzzle {
  const seed = seedFromDateKey(dateKey);
  const rng = mulberry32(seed);

  const occupied: number[][] = Array.from({ length: GRID_SIZE }, () =>
    Array(GRID_SIZE).fill(-1)
  );
  const ships: ShipPlacement[] = [];

  SHIP_SIZES.forEach((size, id) => {
    let placed = false;
    let attempts = 0;
    while (!placed && attempts < 1000) {
      attempts++;
      const horizontal = rng() < 0.5;
      const r = Math.floor(rng() * GRID_SIZE);
      const c = Math.floor(rng() * GRID_SIZE);
      const cells: Cell[] = [];
      let ok = true;

      for (let i = 0; i < size; i++) {
        const rr = horizontal ? r : r + i;
        const cc = horizontal ? c + i : c;
        if (rr >= GRID_SIZE || cc >= GRID_SIZE) {
          ok = false;
          break;
        }
        const row = occupied[rr];
        if (row === undefined || row[cc] !== -1) {
          ok = false;
          break;
        }
        cells.push({ r: rr, c: cc });
      }

      if (ok) {
        cells.forEach(({ r, c }) => {
          const row = occupied[r];
          if (row !== undefined) row[c] = id;
        });
        ships.push({ id, size, cells });
        placed = true;
      }
    }
    if (!placed) {
      // Extremely unlikely with a 10x10 grid and these ship sizes, but
      // fail loudly rather than silently shipping a broken puzzle.
      throw new Error(
        `Failed to place ship of size ${size} for dateKey=${dateKey} after 1000 attempts`
      );
    }
  });

  return { dateKey, seed, occupied, ships };
}

// What the CLIENT is allowed to see before playing: sizes only, no positions.
// This is the "silhouette" — the whole point is players can't peek at cells[].
export type FleetManifest = { id: number; size: number }[];

export function toFleetManifest(puzzle: DailyPuzzle): FleetManifest {
  return puzzle.ships.map((s) => ({ id: s.id, size: s.size }));
}

// Result of a single bomb, computed server-side against the real puzzle.
export type BombOutcome = {
  result: 'miss' | 'hit' | 'sunk' | 'already-bombed';
  shipId?: number;
  sunkShipCells?: Cell[]; // only populated on 'sunk', so client can reveal+animate
};

export function resolveBomb(
  puzzle: DailyPuzzle,
  r: number,
  c: number,
  hitsSoFar: Set<string> // "r,c" keys already bombed this session, from server-tracked state
): BombOutcome {
  const key = `${r},${c}`;
  if (hitsSoFar.has(key)) {
    return { result: 'already-bombed' };
  }

  const shipId = puzzle.occupied[r]?.[c];
  if (shipId === undefined || shipId === -1) {
    return { result: 'miss' };
  }

  const ship = puzzle.ships[shipId];
  if (ship === undefined) {
    // shipId came straight out of occupied[][], which is only ever populated
    // with valid indices into puzzle.ships during generation — this branch
    // means the puzzle data itself is corrupt, not a normal game state.
    throw new Error(`Invalid shipId ${shipId} referenced in puzzle data`);
  }

  const hitKeys = new Set(
    [...hitsSoFar, key].filter((k) => {
      const parts = k.split(',');
      const rr = Number(parts[0]);
      const cc = Number(parts[1]);
      if (Number.isNaN(rr) || Number.isNaN(cc)) return false;
      const row = puzzle.occupied[rr];
      return row !== undefined && row[cc] === shipId;
    })
  );

  if (hitKeys.size === ship.size) {
    return { result: 'sunk', shipId, sunkShipCells: ship.cells };
  }
  return { result: 'hit', shipId };
}