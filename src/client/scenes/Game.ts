import { Scene } from 'phaser';
import * as Phaser from 'phaser';
import { audioManager } from '../audio';
import type {
  GetDailyPuzzleResponse,
  BombRequest,
  BombResponse,
  HintResponse,
  FleetManifestEntry,
  StreakInfo,
  RevealedShip,
  PracticeStartResponse,
  PracticeBombResponse,
  PracticeHintResponse,
} from '../../shared/api';

const GRID_SIZE = 10;
const CELL = 36;
const GRID_PX = GRID_SIZE * CELL;
const HEADER_H = 58;
const MESSAGE_H = 30;
const FLEET_BLOCK_PX = 13;
const FLEET_ENTRY_W_SIDE = 85;
const FLEET_ENTRY_W_STACK = 127;
const FLEET_ENTRY_H = 78; // label + tallest shape (4 rows) + gap, same in both modes

// Side-by-side (wide/landscape): grid + a 2-column fleet panel beside it.
const SIDE_PANEL_GAP = 22;
const SIDE_PANEL_W = FLEET_ENTRY_W_SIDE * 2;
const SIDE_DESIGN_W = GRID_PX + SIDE_PANEL_GAP + SIDE_PANEL_W;
const SIDE_DESIGN_H = HEADER_H + GRID_PX + MESSAGE_H + 20;

// Stacked (narrow/portrait phones): 3-column fleet panel below the grid.
// Needs much less width than side-by-side, so it scales up instead of
// shrinking to illegibility on a phone screen.
const STACK_DESIGN_W = GRID_PX + 20;
const STACK_FLEET_GAP = 26;
const STACK_DESIGN_H =
  HEADER_H +
  GRID_PX +
  STACK_FLEET_GAP +
  20 +
  FLEET_ENTRY_H * 2 +
  MESSAGE_H +
  10;

const COLORS = {
  cellIdle: 0x142c4a,
  cellHover: 0x1c3d61,
  cellMiss: 0x0e1c30,
  gridLine: 0x1c5c47,
  radarGreen: 0x3ddc97,
  brass: 0xd4a94a,
  alertRed: 0xd8544a,
  fogDim: 0x6f8394,
  revealedMiss: 0x2a3550,
  revealedMissBorder: 0x6f8394,
};

type CellState = 'idle' | 'miss' | 'hit' | 'sunk';
type GameSceneData = { practice?: boolean };

export class Game extends Scene {
  camera: Phaser.Cameras.Scene2D.Camera;

  bgGraphics: Phaser.GameObjects.Graphics | null = null;
  boardContainer: Phaser.GameObjects.Container | null = null;
  cellRects: Phaser.GameObjects.Rectangle[][] = [];
  cellStates: CellState[][] = [];
  fleet: FleetManifestEntry[] = [];
  fleetSunk: Set<number> = new Set();
  fleetBlocks: Phaser.GameObjects.Rectangle[][] = [];
  fleetLabels: Phaser.GameObjects.Text[] = [];

  stacked = false;
  designW = SIDE_DESIGN_W;
  designH = SIDE_DESIGN_H;

  practiceMode = false;
  bombsMax = 32;
  bombsUsed = 0;
  hintsMax = 6;
  hintsUsed = 0;
  score = 0;
  streak: StreakInfo = { currentStreak: 0, longestStreak: 0 };
  gameOver = false;
  won = false;

  bombCountText: Phaser.GameObjects.Text | null = null;
  scoreText: Phaser.GameObjects.Text | null = null;
  hintButton: Phaser.GameObjects.Text | null = null;
  messageText: Phaser.GameObjects.Text | null = null;
  scanline: Phaser.GameObjects.Rectangle | null = null;
  lastPuzzleData: GetDailyPuzzleResponse | null = null;

  // Optimistic "in flight" state — a cell/hint request that's been sent but
  // hasn't heard back from the server yet. Purely a UX layer: it doesn't
  // change game logic, just gives instant feedback on click instead of a
  // dead pause while the network round-trip happens.
  pendingCells: Set<string> = new Set();
  pendingMarkers: Map<string, Phaser.GameObjects.Arc> = new Map();
  hintPending = false;

  constructor() {
    super('Game');
  }

  init(data?: GameSceneData): void {
    this.bgGraphics = null;
    this.boardContainer = null;
    this.cellRects = [];
    this.cellStates = [];
    this.fleet = [];
    this.fleetSunk = new Set();
    this.fleetBlocks = [];
    this.fleetLabels = [];
    this.stacked = false;
    this.designW = SIDE_DESIGN_W;
    this.designH = SIDE_DESIGN_H;
    this.practiceMode = data?.practice ?? false;
    this.bombsMax = 32;
    this.bombsUsed = 0;
    this.hintsMax = 6;
    this.hintsUsed = 0;
    this.score = 0;
    this.streak = { currentStreak: 0, longestStreak: 0 };
    this.gameOver = false;
    this.won = false;
    this.bombCountText = null;
    this.scoreText = null;
    this.hintButton = null;
    this.messageText = null;
    this.scanline = null;
    this.lastPuzzleData = null;
    this.pendingCells = new Set();
    this.pendingMarkers = new Map();
    this.hintPending = false;
  }

  create() {
    this.camera = this.cameras.main;
    this.camera.setBackgroundColor(0x0a1628);
    audioManager.duck();

    this.bgGraphics = this.add.graphics();
    this.drawBackground(this.scale.width, this.scale.height);

    const loadingText = this.add
      .text(
        this.scale.width / 2,
        this.scale.height / 2,
        "Loading today's puzzle...",
        {
          fontFamily: 'Courier New',
          fontSize: 18,
          color: '#6f8394',
        }
      )
      .setOrigin(0.5);

    void this.loadPuzzle(loadingText);

    this.scale.on('resize', (gameSize: Phaser.Structs.Size) => {
      this.layout(gameSize.width, gameSize.height);
    });
  }

  // Faint sonar-grid texture across the whole scene, matching the splash.
  // Lives outside boardContainer since it should cover the full viewport
  // regardless of how the board itself is scaled/positioned.
  private drawBackground(width: number, height: number) {
    if (!this.bgGraphics) return;
    const g = this.bgGraphics;
    g.clear();
    g.lineStyle(1, COLORS.radarGreen, 0.04);
    const step = 32;
    for (let x = 0; x < width; x += step) {
      g.lineBetween(x, 0, x, height);
    }
    for (let y = 0; y < height; y += step) {
      g.lineBetween(0, y, width, y);
    }
  }

  private async loadPuzzle(loadingText: Phaser.GameObjects.Text) {
    try {
      if (this.practiceMode) {
        const response = await fetch('/api/practice/start', { method: 'POST' });
        if (!response.ok) throw new Error(`API error: ${response.status}`);
        const data = (await response.json()) as PracticeStartResponse;
        loadingText.destroy();

        // Adapt into the same shape buildBoard() already knows how to render
        // — practice reuses all the same board/silhouette/animation code,
        // it just talks to different endpoints and never scores or streaks.
        const adapted: GetDailyPuzzleResponse = {
          dateKey: 'practice',
          fleet: data.fleet,
          bombsMax: data.bombsMax,
          bombsUsed: 0,
          hintsMax: data.hintsMax,
          hintsUsed: 0,
          score: 0,
          cellStates: Array.from({ length: GRID_SIZE }, () =>
            Array(GRID_SIZE).fill('idle')
          ) as CellState[][],
          sunkShipIds: [],
          gameOver: false,
          won: false,
          streak: { currentStreak: 0, longestStreak: 0 },
        };
        this.lastPuzzleData = adapted;
        this.buildBoard(adapted, false);
        return;
      }

      const response = await fetch('/api/daily-puzzle');
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const data = (await response.json()) as GetDailyPuzzleResponse;

      loadingText.destroy();

      if (data.gameOver) {
        // Already finished today's puzzle in an earlier session (or an
        // earlier tab/visit). Go straight to the leaderboard/result screen
        // instead of showing the board again — there's nothing left to
        // interact with, and this way "come back and check the leaderboard"
        // is one tap through the menu instead of a dead-end message.
        this.scene.start('GameOver', {
          won: data.won,
          bombsUsed: data.bombsUsed,
          bombsMax: data.bombsMax,
          hintsUsed: data.hintsUsed,
          score: data.score,
          streak: data.streak,
          practice: false,
        });
        return;
      }

      this.streak = data.streak;
      this.lastPuzzleData = data;
      this.buildBoard(data, false);
    } catch (error) {
      console.error('Failed to load daily puzzle:', error);
      loadingText.setText('Could not load puzzle. Please try again.');
      loadingText.setColor('#d8544a');
    }
  }

  private buildBoard(data: GetDailyPuzzleResponse, instant: boolean) {
    this.fleet = data.fleet;
    this.bombsMax = data.bombsMax;
    this.bombsUsed = data.bombsUsed;
    this.hintsMax = data.hintsMax;
    this.hintsUsed = data.hintsUsed;
    this.score = data.score;
    this.gameOver = data.gameOver;
    this.won = data.won;
    this.fleetSunk = new Set(data.sunkShipIds);
    this.cellStates = data.cellStates as CellState[][];

    // Chosen at build time based on current aspect ratio — a tall narrow
    // viewport (phone portrait) gets the stacked layout, which needs far
    // less width and so can render at a legible, crisp size instead of
    // shrinking everything to fit a side-by-side layout designed for
    // desktop. Re-evaluated by layout() on resize/orientation change too.
    this.stacked = this.scale.height > this.scale.width;
    this.designW = this.stacked ? STACK_DESIGN_W : SIDE_DESIGN_W;
    this.designH = this.stacked ? STACK_DESIGN_H : SIDE_DESIGN_H;

    const container = this.add.container(0, 0);
    this.boardContainer = container;

    // ---- Console frame ----
    const frame = this.add.graphics();
    const framePad = 14;
    frame.lineStyle(1, COLORS.radarGreen, 0.35);
    frame.strokeRect(
      -framePad,
      -framePad,
      this.designW + framePad * 2,
      this.designH + framePad * 2
    );
    this.drawCornerTicks(
      frame,
      -framePad,
      -framePad,
      this.designW + framePad * 2,
      this.designH + framePad * 2
    );
    container.add(frame);

    // ---- Header, row 1: title + live score ----
    const header = this.add.text(
      0,
      0,
      this.practiceMode ? 'PRACTICE MODE' : 'DAILY BATTLES',
      {
        fontFamily: 'Courier New',
        fontSize: 20,
        color: '#3ddc97',
        fontStyle: 'bold',
      }
    );
    container.add(header);

    this.scoreText = this.add
      .text(
        this.designW,
        2,
        this.practiceMode ? 'NOT SCORED' : `SCORE: ${this.score}`,
        {
          fontFamily: 'Courier New',
          fontSize: 15,
          color: '#d4a94a',
          fontStyle: 'bold',
        }
      )
      .setOrigin(1, 0);
    container.add(this.scoreText);

    // ---- Header, row 2: bombs left + hint button ----
    this.bombCountText = this.add.text(
      0,
      27,
      `BOMBS: ${this.bombsMax - this.bombsUsed}`,
      {
        fontFamily: 'Courier New',
        fontSize: 13,
        color: '#6f8394',
      }
    );
    container.add(this.bombCountText);

    const hintsLeft = this.hintsMax - this.hintsUsed;
    this.hintButton = this.add
      .text(this.designW, 24, `HINT (${hintsLeft})`, {
        fontFamily: 'Courier New',
        fontSize: 12,
        color: '#3ddc97',
        backgroundColor: '#10233d',
        padding: { x: 8, y: 4 },
      })
      .setOrigin(1, 0);
    container.add(this.hintButton);
    this.refreshHintButton();
    this.hintButton.on('pointerover', () => {
      if (this.hintsMax - this.hintsUsed > 0 && !this.gameOver) {
        this.hintButton?.setStyle({ backgroundColor: '#1c3d61' });
      }
    });
    this.hintButton.on('pointerout', () =>
      this.hintButton?.setStyle({ backgroundColor: '#10233d' })
    );
    this.hintButton.on('pointerdown', () => void this.fireHint());

    const gridOriginY = HEADER_H;

    // ---- Grid ----
    for (let r = 0; r < GRID_SIZE; r++) {
      const row: Phaser.GameObjects.Rectangle[] = [];
      for (let c = 0; c < GRID_SIZE; c++) {
        const x = c * CELL + CELL / 2;
        const y = gridOriginY + r * CELL + CELL / 2;
        const rect = this.add
          .rectangle(x, y, CELL - 3, CELL - 3, COLORS.cellIdle)
          .setStrokeStyle(1, COLORS.gridLine);

        this.applyCellVisual(rect, this.cellStates[r]?.[c] ?? 'idle', r, c);

        rect.on('pointerover', () => {
          if (this.cellStates[r]?.[c] === 'idle' && !this.gameOver) {
            rect.setFillStyle(COLORS.cellHover);
          }
        });
        rect.on('pointerout', () => {
          if (this.cellStates[r]?.[c] === 'idle' && !this.gameOver) {
            rect.setFillStyle(COLORS.cellIdle);
          }
        });
        rect.on('pointerdown', () => void this.fireBomb(r, c));

        container.add(rect);
        row.push(rect);

        if (instant) {
          rect.setScale(1);
          rect.setInteractive({ useHandCursor: true });
        } else {
          rect.setScale(0);
          const stagger = (r * GRID_SIZE + c) * 14;
          this.tweens.add({
            targets: rect,
            scale: 1,
            duration: 260,
            delay: stagger,
            ease: 'Back.easeOut',
            onComplete: () => rect.setInteractive({ useHandCursor: true }),
          });
        }
      }
      this.cellRects.push(row);
    }

    // Slow scanline sweep down the grid — decorative, matches the sonar
    // language from the splash and main menu.
    const scanline = this.add.rectangle(
      GRID_PX / 2,
      gridOriginY,
      GRID_PX,
      2,
      COLORS.radarGreen,
      0.25
    );
    container.add(scanline);
    this.scanline = scanline;
    this.tweens.add({
      targets: scanline,
      y: gridOriginY + GRID_PX,
      duration: 3200,
      repeat: -1,
      ease: 'Sine.easeInOut',
      yoyo: true,
    });

    // ---- Fleet panel ----
    const fleetTitleY = this.stacked
      ? gridOriginY + GRID_PX + STACK_FLEET_GAP
      : gridOriginY - 20;
    const fleetTitleX = this.stacked ? 0 : GRID_PX + SIDE_PANEL_GAP;
    const fleetTitle = this.add.text(fleetTitleX, fleetTitleY, 'ENEMY FLEET', {
      fontFamily: 'Courier New',
      fontSize: 13,
      color: '#3ddc97',
    });
    container.add(fleetTitle);

    const fleetCols = this.stacked ? 3 : 2;
    const entryW = this.stacked ? FLEET_ENTRY_W_STACK : FLEET_ENTRY_W_SIDE;
    const fleetOriginX = this.stacked ? 0 : GRID_PX + SIDE_PANEL_GAP;
    const fleetOriginY = this.stacked ? fleetTitleY + 20 : gridOriginY + 4;

    this.fleet.forEach((ship, shipIndex) => {
      const col = shipIndex % fleetCols;
      const row = Math.floor(shipIndex / fleetCols);
      const entryX = fleetOriginX + col * entryW;
      const entryY = fleetOriginY + row * FLEET_ENTRY_H;
      this.buildFleetEntry(container, entryX, entryY, ship, shipIndex, instant);
    });

    // ---- Message line ----
    const messageY = this.stacked
      ? fleetOriginY +
        Math.ceil(this.fleet.length / fleetCols) * FLEET_ENTRY_H +
        6
      : gridOriginY + GRID_PX + 10;
    this.messageText = this.add
      .text(this.designW / 2, messageY, '', {
        fontFamily: 'Courier New',
        fontSize: 13,
        color: '#6f8394',
        align: 'center',
        wordWrap: { width: this.designW, useAdvancedWrap: true },
      })
      .setOrigin(0.5, 0);
    container.add(this.messageText);

    if (this.gameOver) {
      this.showAlreadyFinished();
    }

    this.layout(this.scale.width, this.scale.height);
  }

  private drawCornerTicks(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    w: number,
    h: number
  ) {
    const len = 12;
    g.lineStyle(2, COLORS.brass, 0.8);
    // top-left
    g.lineBetween(x, y + len, x, y);
    g.lineBetween(x, y, x + len, y);
    // top-right
    g.lineBetween(x + w - len, y, x + w, y);
    g.lineBetween(x + w, y, x + w, y + len);
    // bottom-left
    g.lineBetween(x, y + h - len, x, y + h);
    g.lineBetween(x, y + h, x + len, y + h);
    // bottom-right
    g.lineBetween(x + w - len, y + h, x + w, y + h);
    g.lineBetween(x + w, y + h - len, x + w, y + h);
  }

  private buildFleetEntry(
    container: Phaser.GameObjects.Container,
    x: number,
    y: number,
    ship: FleetManifestEntry,
    shipIndex: number,
    instant: boolean
  ) {
    const sunk = this.fleetSunk.has(ship.id);
    const label = this.add.text(
      x,
      y,
      sunk ? `${ship.name} \u2713` : ship.name,
      {
        fontFamily: 'Courier New',
        fontSize: 10,
        color: sunk ? '#d4a94a' : '#6f8394',
      }
    );
    container.add(label);
    this.fleetLabels[ship.id] = label;

    const blocks: Phaser.GameObjects.Rectangle[] = [];
    ship.cells.forEach((cell) => {
      const block = this.add
        .rectangle(
          x + cell.dc * FLEET_BLOCK_PX + FLEET_BLOCK_PX / 2,
          y + 16 + cell.dr * FLEET_BLOCK_PX + FLEET_BLOCK_PX / 2,
          FLEET_BLOCK_PX - 1,
          FLEET_BLOCK_PX - 1,
          sunk ? COLORS.brass : 0x1c3d61
        )
        .setStrokeStyle(1.5, sunk ? 0xffe6b0 : COLORS.radarGreen);
      container.add(block);
      blocks.push(block);
    });
    this.fleetBlocks[ship.id] = blocks;

    if (instant) {
      label.setAlpha(1);
      blocks.forEach((b) => b.setAlpha(1));
      return;
    }

    const rowTargets: (
      | Phaser.GameObjects.Text
      | Phaser.GameObjects.Rectangle
    )[] = [label, ...blocks];
    rowTargets.forEach((t) => t.setAlpha(0));
    this.tweens.add({
      targets: rowTargets,
      alpha: 1,
      duration: 300,
      delay: 400 + shipIndex * 120,
      ease: 'Sine.easeOut',
    });
  }

  // Fill color is never the only signal — a small glyph is layered on top
  // of hit/sunk cells too, so the board reads correctly for colorblind
  // players who might not reliably distinguish the red/gold hue difference.
  private applyCellVisual(
    rect: Phaser.GameObjects.Rectangle,
    state: CellState,
    r: number,
    c: number
  ) {
    if (state === 'miss') {
      rect.setFillStyle(COLORS.cellMiss);
      rect.setStrokeStyle(1, 0x2a3f52);
    } else if (state === 'hit') {
      rect.setFillStyle(COLORS.alertRed);
      this.addGlyph(r, c, '\u25CF', '#3a0d0d');
    } else if (state === 'sunk') {
      rect.setFillStyle(COLORS.brass);
      rect.setStrokeStyle(1, 0xffe6b0);
      this.addGlyph(r, c, '\u2715', '#4a3410');
    }
  }

  private addGlyph(r: number, c: number, symbol: string, color: string) {
    if (!this.boardContainer) return;
    const x = c * CELL + CELL / 2;
    const y = HEADER_H + r * CELL + CELL / 2;
    const glyph = this.add
      .text(x, y, symbol, { fontFamily: 'Courier New', fontSize: 14 })
      .setOrigin(0.5)
      .setColor(color);
    this.boardContainer.add(glyph);
  }

  // Shared by fireBomb() and fireHint() — a hint reveal and a bomb hit look
  // and behave identically once the server has told us which cell it is;
  // the only difference is which endpoint produced it and whether it cost
  // a bomb, both handled by the caller.
  private applyHitOrSunk(
    r: number,
    c: number,
    sunk: boolean,
    shipId?: number,
    sunkShipCells?: { r: number; c: number }[]
  ) {
    const row = this.cellStates[r];
    if (row) row[c] = sunk ? 'sunk' : 'hit';

    const rect = this.cellRects[r]?.[c];
    if (rect) this.applyCellVisual(rect, sunk ? 'sunk' : 'hit', r, c);

    if (sunk && shipId !== undefined) {
      sunkShipCells?.forEach(({ r: sr, c: sc }) => {
        const shipRow = this.cellStates[sr];
        if (shipRow) shipRow[sc] = 'sunk';
        const shipRect = this.cellRects[sr]?.[sc];
        if (shipRect) this.applyCellVisual(shipRect, 'sunk', sr, sc);
      });
      this.sinkShipVisual(shipId, sunkShipCells ?? []);
      audioManager.playSunk();
    } else {
      this.spawnHitFlash(r, c);
      audioManager.playHit();
    }
  }

  private refreshHintButton() {
    if (!this.hintButton) return;
    const hintsLeft = this.hintsMax - this.hintsUsed;
    this.hintButton.setText(`HINT (${hintsLeft})`);
    if (hintsLeft <= 0 || this.gameOver) {
      this.hintButton.disableInteractive();
      this.hintButton.setStyle({ color: '#3f4f5c' });
    } else {
      this.hintButton.setInteractive({ useHandCursor: true });
      this.hintButton.setStyle({ color: '#3ddc97' });
    }
  }

  private goToGameOverNow() {
    this.scene.start('GameOver', {
      won: this.won,
      bombsUsed: this.bombsUsed,
      bombsMax: this.bombsMax,
      hintsUsed: this.hintsUsed,
      score: this.score,
      streak: this.streak,
      practice: this.practiceMode,
    });
  }

  private goToGameOver() {
    this.time.delayedCall(700, () => this.goToGameOverNow());
  }

  private spawnPendingMarker(
    r: number,
    c: number
  ): Phaser.GameObjects.Arc | null {
    if (!this.boardContainer) return null;
    const x = c * CELL + CELL / 2;
    const y = HEADER_H + r * CELL + CELL / 2;
    const ring = this.add
      .circle(x, y, 8, 0xffffff, 0)
      .setStrokeStyle(2, COLORS.brass, 0.8);
    this.boardContainer.add(ring);
    this.tweens.add({
      targets: ring,
      alpha: { from: 0.9, to: 0.25 },
      scale: { from: 0.8, to: 1.25 },
      duration: 380,
      yoyo: true,
      repeat: -1,
    });
    return ring;
  }

  private clearPendingMarker(key: string) {
    const marker = this.pendingMarkers.get(key);
    marker?.destroy();
    this.pendingMarkers.delete(key);
  }

  private async fireBomb(r: number, c: number) {
    if (this.gameOver) return;
    if (this.cellStates[r]?.[c] !== 'idle') return;
    const key = `${r},${c}`;
    if (this.pendingCells.has(key)) return; // already in flight, ignore repeat clicks

    this.pendingCells.add(key);
    const marker = this.spawnPendingMarker(r, c);
    if (marker) this.pendingMarkers.set(key, marker);

    try {
      const endpoint = this.practiceMode ? '/api/practice/bomb' : '/api/bomb';
      const body: BombRequest = { r, c };
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const result = (await response.json()) as
        | BombResponse
        | PracticeBombResponse;

      if (
        result.result === 'already-bombed' ||
        result.result === 'no-bombs-left'
      ) {
        return;
      }

      if (result.result === 'miss') {
        this.spawnMissMark(r, c);
        audioManager.playMiss();
      } else if (result.result === 'hit') {
        this.applyHitOrSunk(r, c, false);
      } else if (result.result === 'sunk') {
        this.applyHitOrSunk(r, c, true, result.shipId, result.sunkShipCells);
      }

      // bombsMax - bombsLeft works identically for both response shapes,
      // so this stays correct without needing to branch on which one it is.
      this.bombsUsed = this.bombsMax - result.bombsLeft;
      this.bombCountText?.setText(`BOMBS: ${result.bombsLeft}`);

      if ('score' in result) {
        this.score = result.score;
        this.streak = result.streak;
        this.scoreText?.setText(`SCORE: ${this.score}`);
      }

      if (result.gameOver) {
        this.gameOver = true;
        this.won = result.won;
        this.refreshHintButton();

        if (
          !this.practiceMode &&
          !result.won &&
          'revealedShips' in result &&
          result.revealedShips
        ) {
          // This is the bomb that ended the round in a loss — show what was
          // missed before cutting to the result screen, instead of just
          // ending abruptly with no closure.
          this.revealMissedShips(result.revealedShips);
          this.time.delayedCall(2600, () => this.goToGameOverNow());
        } else {
          this.goToGameOver();
        }
      }
    } catch (error) {
      console.error('Failed to resolve bomb:', error);
    } finally {
      this.pendingCells.delete(key);
      this.clearPendingMarker(key);
    }
  }

  private async fireHint() {
    if (this.gameOver) return;
    if (this.hintsMax - this.hintsUsed <= 0) return;
    if (this.hintPending) return; // already in flight, ignore repeat clicks

    this.hintPending = true;
    this.hintButton?.setText('...');
    this.hintButton?.disableInteractive();

    try {
      const endpoint = this.practiceMode ? '/api/practice/hint' : '/api/hint';
      const response = await fetch(endpoint, { method: 'POST' });
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const result = (await response.json()) as
        | HintResponse
        | PracticeHintResponse;

      this.hintsUsed = this.hintsMax - result.hintsLeft;

      if ('score' in result) {
        this.score = result.score;
        this.streak = result.streak;
        this.scoreText?.setText(`SCORE: ${this.score}`);
      }

      if (result.cell) {
        audioManager.playHint();
        this.applyHitOrSunk(
          result.cell.r,
          result.cell.c,
          result.sunk,
          result.shipId,
          result.sunkShipCells
        );
      }

      if (result.gameOver) {
        this.gameOver = true;
        this.won = result.won;
        this.goToGameOver();
      }
    } catch (error) {
      console.error('Failed to resolve hint:', error);
    } finally {
      this.hintPending = false;
      this.refreshHintButton();
    }
  }

  // Called once, right when a live game ends in a loss — paints the ships
  // that were never found so the round has closure instead of just cutting
  // off abruptly. Purely visual, staggered ship-by-ship for a "reveal"
  // beat rather than everything dumping in at once.
  private revealMissedShips(ships: RevealedShip[]) {
    if (!this.boardContainer) return;
    ships.forEach((ship, shipIndex) => {
      ship.cells.forEach((cell, cellIndex) => {
        const rect = this.cellRects[cell.r]?.[cell.c];
        if (!rect) return;
        if (this.cellStates[cell.r]?.[cell.c] !== 'idle') return; // already hit — leave it as-is
        const delay = shipIndex * 150 + cellIndex * 40;
        this.time.delayedCall(delay, () => {
          rect.setFillStyle(COLORS.revealedMiss);
          rect.setStrokeStyle(1.5, COLORS.revealedMissBorder);
          rect.setAlpha(0);
          this.tweens.add({ targets: rect, alpha: 1, duration: 250 });
        });
      });
    });
  }

  private spawnMissMark(r: number, c: number) {
    if (!this.boardContainer) return;
    const x = c * CELL + CELL / 2;
    const y = HEADER_H + r * CELL + CELL / 2;
    const dot = this.add.circle(x, y, 4, COLORS.fogDim);
    this.boardContainer.add(dot);
    this.tweens.add({ targets: dot, alpha: 0.5, duration: 200 });
  }

  private spawnHitFlash(r: number, c: number) {
    if (!this.boardContainer) return;
    const x = c * CELL + CELL / 2;
    const y = HEADER_H + r * CELL + CELL / 2;
    const ring = this.add
      .circle(x, y, 4, 0xffffff, 0)
      .setStrokeStyle(2, 0xffe6b0);
    this.boardContainer.add(ring);
    this.tweens.addCounter({
      from: 4,
      to: CELL * 0.6,
      duration: 300,
      onUpdate: (tw) => {
        const v = tw.getValue();
        if (v !== null) ring.setRadius(v);
      },
      onComplete: () => ring.destroy(),
    });
  }

  private sinkShipVisual(shipId: number, cells: { r: number; c: number }[]) {
    if (!this.boardContainer || cells.length === 0) return;
    this.fleetSunk.add(shipId);

    const mid = cells[Math.floor(cells.length / 2)];
    if (mid) {
      const x = mid.c * CELL + CELL / 2;
      const y = HEADER_H + mid.r * CELL + CELL / 2;
      for (let i = 0; i < 3; i++) {
        this.time.delayedCall(i * 150, () => {
          if (!this.boardContainer) return;
          const ring = this.add
            .circle(x, y, 6, 0xffffff, 0)
            .setStrokeStyle(2, COLORS.brass);
          this.boardContainer.add(ring);
          this.tweens.addCounter({
            from: 6,
            to: 90,
            duration: 700,
            onUpdate: (tw) => {
              const v = tw.getValue();
              if (v !== null) {
                ring.setRadius(v);
                ring.setAlpha(1 - v / 90);
              }
            },
            onComplete: () => ring.destroy(),
          });
        });
      }
    }

    const blocks = this.fleetBlocks[shipId];
    blocks?.forEach((b) => {
      b.setFillStyle(COLORS.brass);
      b.setStrokeStyle(1, 0xffe6b0);
    });
    const label = this.fleetLabels[shipId];
    const ship = this.fleet.find((s) => s.id === shipId);
    if (label && ship) {
      label.setColor('#d4a94a');
      label.setText(`${ship.name} \u2713`);
    }
  }

  private showAlreadyFinished() {
    if (!this.messageText) return;
    if (this.won) {
      this.messageText.setText(
        `Already solved today — score ${this.score}. Come back tomorrow!`
      );
      this.messageText.setColor('#3ddc97');
    } else {
      this.messageText.setText(
        `Out of bombs for today — score ${this.score}. Come back tomorrow!`
      );
      this.messageText.setColor('#d8544a');
    }
  }

  private layout(width: number, height: number) {
    this.cameras.resize(width, height);
    this.drawBackground(width, height);
    if (!this.boardContainer) return;

    // If the aspect ratio has crossed the stacked/side-by-side threshold
    // since the board was built — including if the very first build ran
    // before Phaser's container reported its true final size — rebuild the
    // board in the correct mode. Rebuilt from LIVE game state (current
    // cellStates/fleetSunk/bombsUsed), not the original fetch snapshot, so
    // any bombs already placed this session aren't lost.
    const wantStacked = height > width;
    if (wantStacked !== this.stacked) {
      const liveData: GetDailyPuzzleResponse = {
        dateKey: this.lastPuzzleData?.dateKey ?? '',
        fleet: this.fleet,
        bombsMax: this.bombsMax,
        bombsUsed: this.bombsUsed,
        hintsMax: this.hintsMax,
        hintsUsed: this.hintsUsed,
        score: this.score,
        cellStates: this.cellStates,
        sunkShipIds: Array.from(this.fleetSunk),
        gameOver: this.gameOver,
        won: this.won,
        streak: this.streak,
      };
      this.boardContainer.destroy();
      this.boardContainer = null;
      this.cellRects = [];
      this.fleetBlocks = [];
      this.fleetLabels = [];
      this.buildBoard(liveData, true); // instant = skip entrance animation on rebuild

      // Any bomb still in flight had its pulsing marker destroyed along with
      // the old container — respawn it in the new one so it doesn't just
      // silently vanish mid-request.
      this.pendingMarkers.clear();
      this.pendingCells.forEach((key) => {
        const [rStr, cStr] = key.split(',');
        const r = Number(rStr);
        const cc = Number(cStr);
        if (!Number.isNaN(r) && !Number.isNaN(cc)) {
          const marker = this.spawnPendingMarker(r, cc);
          if (marker) this.pendingMarkers.set(key, marker);
        }
      });
      return; // buildBoard() calls layout() again at its end with the new mode
    }

    const PADDING = 28;
    const availW = Math.max(width - PADDING * 2, 1);
    const availH = Math.max(height - PADDING * 2, 1);

    const scaleFactor = Math.min(
      availW / this.designW,
      availH / this.designH,
      1.15
    );
    this.boardContainer.setScale(scaleFactor);
    this.boardContainer.setPosition(
      width / 2 - (this.designW * scaleFactor) / 2,
      height / 2 - (this.designH * scaleFactor) / 2
    );
  }
}
