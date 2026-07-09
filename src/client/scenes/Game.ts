import { Scene } from 'phaser';
import * as Phaser from 'phaser';
import type {
  GetDailyPuzzleResponse,
  BombRequest,
  BombResponse,
  FleetManifestEntry,
} from '../../shared/api';

const GRID_SIZE = 10;
const CELL = 36;
const GRID_PX = GRID_SIZE * CELL;
const HEADER_H = 44;
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
const STACK_DESIGN_H = HEADER_H + GRID_PX + STACK_FLEET_GAP + 20 + FLEET_ENTRY_H * 2 + MESSAGE_H + 10;

const COLORS = {
  cellIdle: 0x142c4a,
  cellHover: 0x1c3d61,
  cellMiss: 0x0e1c30,
  gridLine: 0x1c5c47,
  radarGreen: 0x3ddc97,
  brass: 0xd4a94a,
  alertRed: 0xd8544a,
  fogDim: 0x6f8394,
};

type CellState = 'idle' | 'miss' | 'hit' | 'sunk';

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

  bombsMax = 32;
  bombsUsed = 0;
  gameOver = false;
  won = false;

  bombCountText: Phaser.GameObjects.Text | null = null;
  messageText: Phaser.GameObjects.Text | null = null;
  scanline: Phaser.GameObjects.Rectangle | null = null;
  lastPuzzleData: GetDailyPuzzleResponse | null = null;

  constructor() {
    super('Game');
  }

  init(): void {
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
    this.bombsMax = 32;
    this.bombsUsed = 0;
    this.gameOver = false;
    this.won = false;
    this.bombCountText = null;
    this.messageText = null;
    this.scanline = null;
    this.lastPuzzleData = null;
  }

  create() {
    this.camera = this.cameras.main;
    this.camera.setBackgroundColor(0x0a1628);

    this.bgGraphics = this.add.graphics();
    this.drawBackground(this.scale.width, this.scale.height);

    const loadingText = this.add
      .text(this.scale.width / 2, this.scale.height / 2, 'Loading today\'s puzzle...', {
        fontFamily: 'Courier New',
        fontSize: 18,
        color: '#6f8394',
      })
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
      const response = await fetch('/api/daily-puzzle');
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const data = (await response.json()) as GetDailyPuzzleResponse;

      loadingText.destroy();
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
    this.gameOver = data.gameOver;
    this.won = data.won;
    this.fleetSunk = new Set(data.sunkShipIds);
    this.cellStates = data.cellStates as CellState[][];

    // Chosen at build time based on current aspect ratio — a tall narrow
    // viewport (phone portrait) gets the stacked layout, which needs far
    // less width and so can render at a legible, crisp size instead of
    // shrinking everything to fit a side-by-side layout designed for
    // desktop. Re-evaluated by layout() on resize/orientation change too —
    // see rebuildForModeChange().
    this.stacked = this.scale.height > this.scale.width;
    this.designW = this.stacked ? STACK_DESIGN_W : SIDE_DESIGN_W;
    this.designH = this.stacked ? STACK_DESIGN_H : SIDE_DESIGN_H;

    const container = this.add.container(0, 0);
    this.boardContainer = container;

    // ---- Console frame ----
    const frame = this.add.graphics();
    const framePad = 14;
    frame.lineStyle(1, COLORS.radarGreen, 0.35);
    frame.strokeRect(-framePad, -framePad, this.designW + framePad * 2, this.designH + framePad * 2);
    this.drawCornerTicks(frame, -framePad, -framePad, this.designW + framePad * 2, this.designH + framePad * 2);
    container.add(frame);

    // ---- Header ----
    const header = this.add.text(0, 0, 'DAILY BATTLES', {
      fontFamily: 'Courier New',
      fontSize: 20,
      color: '#3ddc97',
      fontStyle: 'bold',
    });
    container.add(header);

    this.bombCountText = this.add.text(this.designW - 100, 4, `BOMBS: ${this.bombsMax - this.bombsUsed}`, {
      fontFamily: 'Courier New',
      fontSize: 14,
      color: '#d4a94a',
    });
    container.add(this.bombCountText);

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

        this.applyCellVisual(rect, this.cellStates[r]?.[c] ?? 'idle');

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
    const scanline = this.add.rectangle(GRID_PX / 2, gridOriginY, GRID_PX, 2, COLORS.radarGreen, 0.25);
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
    const fleetTitleY = this.stacked ? gridOriginY + GRID_PX + STACK_FLEET_GAP : gridOriginY - 20;
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
      ? fleetOriginY + Math.ceil(this.fleet.length / fleetCols) * FLEET_ENTRY_H + 6
      : gridOriginY + GRID_PX + 10;
    this.messageText = this.add.text(0, messageY, '', {
      fontFamily: 'Courier New',
      fontSize: 13,
      color: '#6f8394',
    });
    container.add(this.messageText);

    if (this.gameOver) {
      this.showAlreadyFinished();
    }

    this.layout(this.scale.width, this.scale.height);
  }

  private drawCornerTicks(g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number) {
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
    const label = this.add.text(x, y, sunk ? `${ship.name} \u2713` : ship.name, {
      fontFamily: 'Courier New',
      fontSize: 10,
      color: sunk ? '#d4a94a' : '#6f8394',
    });
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

    const rowTargets: (Phaser.GameObjects.Text | Phaser.GameObjects.Rectangle)[] = [label, ...blocks];
    rowTargets.forEach((t) => t.setAlpha(0));
    this.tweens.add({
      targets: rowTargets,
      alpha: 1,
      duration: 300,
      delay: 400 + shipIndex * 120,
      ease: 'Sine.easeOut',
    });
  }

  private applyCellVisual(rect: Phaser.GameObjects.Rectangle, state: CellState) {
    if (state === 'miss') {
      rect.setFillStyle(COLORS.cellMiss);
      rect.setStrokeStyle(1, 0x2a3f52);
    } else if (state === 'hit') {
      rect.setFillStyle(COLORS.alertRed);
    } else if (state === 'sunk') {
      rect.setFillStyle(COLORS.brass);
      rect.setStrokeStyle(1, 0xffe6b0);
    }
  }

  private async fireBomb(r: number, c: number) {
    if (this.gameOver) return;
    if (this.cellStates[r]?.[c] !== 'idle') return;

    try {
      const body: BombRequest = { r, c };
      const response = await fetch('/api/bomb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const result = (await response.json()) as BombResponse;

      if (result.result === 'already-bombed' || result.result === 'no-bombs-left') {
        return;
      }

      const row = this.cellStates[r];
      if (row) row[c] = result.result === 'sunk' ? 'sunk' : (result.result as CellState);

      const rect = this.cellRects[r]?.[c];
      if (rect) this.applyCellVisual(rect, result.result === 'sunk' ? 'sunk' : (result.result as CellState));

      if (result.result === 'miss') {
        this.spawnMissMark(r, c);
      } else if (result.result === 'hit') {
        this.spawnHitFlash(r, c);
      } else if (result.result === 'sunk' && result.shipId !== undefined) {
        result.sunkShipCells?.forEach(({ r: sr, c: sc }: { r: number; c: number }) => {
          const shipRow = this.cellStates[sr];
          if (shipRow) shipRow[sc] = 'sunk';
          const shipRect = this.cellRects[sr]?.[sc];
          if (shipRect) this.applyCellVisual(shipRect, 'sunk');
        });
        this.sinkShipVisual(result.shipId, result.sunkShipCells ?? []);
      }

      this.bombsUsed = result.bombsUsed;
      this.bombCountText?.setText(`BOMBS: ${result.bombsLeft}`);

      if (result.gameOver) {
        this.gameOver = true;
        this.won = result.won;
        this.time.delayedCall(700, () => {
          this.scene.start('GameOver', {
            won: this.won,
            bombsUsed: this.bombsUsed,
            bombsMax: this.bombsMax,
          });
        });
      }
    } catch (error) {
      console.error('Failed to resolve bomb:', error);
    }
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
    const ring = this.add.circle(x, y, 4, 0xffffff, 0).setStrokeStyle(2, 0xffe6b0);
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
          const ring = this.add.circle(x, y, 6, 0xffffff, 0).setStrokeStyle(2, COLORS.brass);
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
      this.messageText.setText(`Already solved today in ${this.bombsUsed} bombs. Come back tomorrow!`);
      this.messageText.setColor('#3ddc97');
    } else {
      this.messageText.setText(`Out of bombs for today. Come back tomorrow!`);
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
        cellStates: this.cellStates,
        sunkShipIds: Array.from(this.fleetSunk),
        gameOver: this.gameOver,
        won: this.won,
      };
      this.boardContainer.destroy();
      this.boardContainer = null;
      this.cellRects = [];
      this.fleetBlocks = [];
      this.fleetLabels = [];
      this.buildBoard(liveData, true); // instant = skip entrance animation on rebuild
      return; // buildBoard() calls layout() again at its end with the new mode
    }

    const PADDING = 28;
    const availW = Math.max(width - PADDING * 2, 1);
    const availH = Math.max(height - PADDING * 2, 1);

    const scaleFactor = Math.min(availW / this.designW, availH / this.designH, 1.15);
    this.boardContainer.setScale(scaleFactor);
    this.boardContainer.setPosition(
      width / 2 - (this.designW * scaleFactor) / 2,
      height / 2 - (this.designH * scaleFactor) / 2
    );
  }
}