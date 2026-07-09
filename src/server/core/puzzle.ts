// src/server/core/puzzle.ts
//
// Deterministic daily puzzle generation for Daily Battles.
// Same date string -> same ship layout, for every player.
// No Devvit imports here on purpose — pure logic, easy to unit test.

export const GRID_SIZE = 10;
export const MAX_BOMBS = 32;

// Bump this whenever fleet shapes, sizes, or grid rules change. It's baked
// into the Redis keys in api.ts, so a version bump automatically invalidates
// any previously-cached puzzle/session instead of silently serving stale
// data generated under the old rules.
export const FLEET_VERSION = 2;

export type Cell = { r: number; c: number };
export type Offset = { dr: number; dc: number };

// Canonical (unrotated) polyomino shapes. `cells` are offsets from a (0,0)
// top-left corner. shapeName is just for the client to pick an icon/label —
// gameplay logic only cares about the cell list.
export type FleetShapeDef = {
  id: number;
  name: string;
  shapeName: 'L' | 'square' | 'Z' | 'I' | 'corner' | 'domino';
  cells: Offset[];
};

export const FLEET_SHAPES: FleetShapeDef[] = [
  {
    id: 0,
    name: 'Carrier',
    shapeName: 'L',
    cells: [
      { dr: 0, dc: 0 },
      { dr: 1, dc: 0 },
      { dr: 2, dc: 0 },
      { dr: 3, dc: 0 },
      { dr: 3, dc: 1 },
    ], // 5 cells
  },
  {
    id: 1,
    name: 'Battleship',
    shapeName: 'square',
    cells: [
      { dr: 0, dc: 0 },
      { dr: 0, dc: 1 },
      { dr: 1, dc: 0 },
      { dr: 1, dc: 1 },
    ], // 4 cells
  },
  {
    id: 2,
    name: 'Destroyer',
    shapeName: 'Z',
    cells: [
      { dr: 0, dc: 1 },
      { dr: 0, dc: 2 },
      { dr: 1, dc: 0 },
      { dr: 1, dc: 1 },
    ], // 4 cells
  },
  {
    id: 3,
    name: 'Submarine',
    shapeName: 'I',
    cells: [
      { dr: 0, dc: 0 },
      { dr: 1, dc: 0 },
      { dr: 2, dc: 0 },
    ], // 3 cells
  },
  {
    id: 4,
    name: 'Patrol Boat',
    shapeName: 'corner',
    cells: [
      { dr: 0, dc: 0 },
      { dr: 1, dc: 0 },
      { dr: 1, dc: 1 },
    ], // 3 cells
  },
  {
    id: 5,
    name: 'Scout',
    shapeName: 'domino',
    cells: [
      { dr: 0, dc: 0 },
      { dr: 1, dc: 0 },
    ], // 2 cells
  },
];

export type ShipPlacement = {
  id: number;
  size: number;
  name: string;
  shapeName: FleetShapeDef['shapeName'];
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

// Rotate a shape 90° clockwise, `times` times, then re-normalize so its
// bounding box starts at (0,0) again — same shape, different orientation.
function rotateCells(cells: Offset[], times: number): Offset[] {
  let result = cells;
  for (let t = 0; t < times; t++) {
    result = result.map(({ dr, dc }) => ({ dr: dc, dc: -dr }));
  }
  const drValues = result.map((c) => c.dr);
  const dcValues = result.map((c) => c.dc);
  const minDr = Math.min(...drValues);
  const minDc = Math.min(...dcValues);
  return result.map(({ dr, dc }) => ({ dr: dr - minDr, dc: dc - minDc }));
}

export function generateDailyPuzzle(dateKey: string): DailyPuzzle {
  const seed = seedFromDateKey(dateKey);
  const rng = mulberry32(seed);

  const occupied: number[][] = Array.from({ length: GRID_SIZE }, () =>
    Array(GRID_SIZE).fill(-1)
  );
  const ships: ShipPlacement[] = [];

  FLEET_SHAPES.forEach((shapeDef) => {
    let placed = false;
    let attempts = 0;

    while (!placed && attempts < 3000) {
      attempts++;
      const rotation = Math.floor(rng() * 4);
      const rotated = rotateCells(shapeDef.cells, rotation);

      const maxDr = Math.max(...rotated.map((o) => o.dr));
      const maxDc = Math.max(...rotated.map((o) => o.dc));
      const anchorR = Math.floor(rng() * (GRID_SIZE - maxDr));
      const anchorC = Math.floor(rng() * (GRID_SIZE - maxDc));

      const cells: Cell[] = rotated.map(({ dr, dc }) => ({
        r: anchorR + dr,
        c: anchorC + dc,
      }));

      let ok = true;
      for (const { r, c } of cells) {
        if (r < 0 || r >= GRID_SIZE || c < 0 || c >= GRID_SIZE) {
          ok = false;
          break;
        }
        const row = occupied[r];
        if (row === undefined || row[c] !== -1) {
          ok = false;
          break;
        }
      }

      if (ok) {
        cells.forEach(({ r, c }) => {
          const row = occupied[r];
          if (row !== undefined) row[c] = shapeDef.id;
        });
        ships.push({
          id: shapeDef.id,
          size: cells.length,
          name: shapeDef.name,
          shapeName: shapeDef.shapeName,
          cells,
        });
        placed = true;
      }
    }

    if (!placed) {
      // Extremely unlikely on a 10x10 grid with this fleet, but fail loudly
      // rather than silently shipping a broken puzzle.
      throw new Error(
        `Failed to place ${shapeDef.name} for dateKey=${dateKey} after 3000 attempts`
      );
    }
  });

  return { dateKey, seed, occupied, ships };
}

// What the CLIENT is allowed to see before playing: each ship's identity and
// canonical shape, but NOT today's actual rotation or position. Pulling
// `cells` from FLEET_SHAPES (not from puzzle.ships[].cells) is deliberate —
// the puzzle instance's cells are today's real secret placement.
export type FleetManifestEntry = {
  id: number;
  size: number;
  name: string;
  shapeName: FleetShapeDef['shapeName'];
  cells: Offset[];
};

export function toFleetManifest(puzzle: DailyPuzzle): FleetManifestEntry[] {
  return puzzle.ships.map((s) => {
    const def = FLEET_SHAPES.find((f) => f.id === s.id);
    if (!def) {
      throw new Error(`Unknown shape id ${s.id} in puzzle data`);
    }
    return {
      id: s.id,
      size: s.size,
      name: def.name,
      shapeName: def.shapeName,
      cells: def.cells,
    };
  });
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