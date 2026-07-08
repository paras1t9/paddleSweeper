import { Scene } from 'phaser';
import * as Phaser from 'phaser';
import type {
  GetDailyPuzzleResponse,
  BombRequest,
  BombResponse,
} from '../../shared/api';

const GRID_SIZE = 10;
const CELL = 36;
const GRID_PX = GRID_SIZE * CELL;
const PANEL_GAP = 30;
const PANEL_W = 190;
const DESIGN_W = GRID_PX + PANEL_GAP + PANEL_W;
const DESIGN_H = GRID_PX + 70; // grid + header row

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

  boardContainer: Phaser.GameObjects.Container | null = null;
  cellRects: Phaser.GameObjects.Rectangle[][] = [];
  cellStates: CellState[][] = [];
  fleet: { id: number; size: number }[] = [];
  fleetSunk: Set<number> = new Set();
  fleetBlocks: Phaser.GameObjects.Rectangle[][] = [];
  fleetLabels: Phaser.GameObjects.Text[] = [];

  bombsMax = 30;
  bombsUsed = 0;
  gameOver = false;
  won = false;

  bombCountText: Phaser.GameObjects.Text | null = null;
  messageText: Phaser.GameObjects.Text | null = null;

  constructor() {
    super('Game');
  }

  init(): void {
    // Reset all cached state — Phaser reuses this Scene instance if the
    // player replays, so nothing from a previous puzzle should leak in.
    this.boardContainer = null;
    this.cellRects = [];
    this.cellStates = [];
    this.fleet = [];
    this.fleetSunk = new Set();
    this.fleetBlocks = [];
    this.fleetLabels = [];
    this.bombsMax = 30;
    this.bombsUsed = 0;
    this.gameOver = false;
    this.won = false;
    this.bombCountText = null;
    this.messageText = null;
  }

  create() {
    this.camera = this.cameras.main;
    this.camera.setBackgroundColor(0x0a1628);

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

  private async loadPuzzle(loadingText: Phaser.GameObjects.Text) {
    try {
      const response = await fetch('/api/daily-puzzle');
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const data = (await response.json()) as GetDailyPuzzleResponse;

      loadingText.destroy();
      this.buildBoard(data);
    } catch (error) {
      console.error('Failed to load daily puzzle:', error);
      loadingText.setText('Could not load puzzle. Please try again.');
      loadingText.setColor('#d8544a');
    }
  }

  private buildBoard(data: GetDailyPuzzleResponse) {
    this.fleet = data.fleet;
    this.bombsMax = data.bombsMax;
    this.bombsUsed = data.bombsUsed;
    this.gameOver = data.gameOver;
    this.won = data.won;
    this.fleetSunk = new Set(data.sunkShipIds);
    this.cellStates = data.cellStates as CellState[][];

    const container = this.add.container(0, 0);
    this.boardContainer = container;

    // ---- Header ----
    const header = this.add.text(0, 0, 'DAILY BATTLES', {
      fontFamily: 'Courier New',
      fontSize: 20,
      color: '#3ddc97',
      fontStyle: 'bold',
    });
    container.add(header);

    this.bombCountText = this.add.text(GRID_PX - 90, 0, `BOMBS: ${this.bombsMax - this.bombsUsed}`, {
      fontFamily: 'Courier New',
      fontSize: 14,
      color: '#d4a94a',
    });
    container.add(this.bombCountText);

    const gridOriginY = 40;

    // ---- Grid ----
    for (let r = 0; r < GRID_SIZE; r++) {
      const row: Phaser.GameObjects.Rectangle[] = [];
      for (let c = 0; c < GRID_SIZE; c++) {
        const x = c * CELL + CELL / 2;
        const y = gridOriginY + r * CELL + CELL / 2;
        const rect = this.add
          .rectangle(x, y, CELL - 3, CELL - 3, COLORS.cellIdle)
          .setStrokeStyle(1, COLORS.gridLine)
          .setInteractive({ useHandCursor: true });

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
      }
      this.cellRects.push(row);
    }

    // ---- Silhouette panel ----
    const panelX = GRID_PX + PANEL_GAP;
    const fleetLabel = this.add.text(panelX, gridOriginY - 20, 'ENEMY FLEET', {
      fontFamily: 'Courier New',
      fontSize: 13,
      color: '#3ddc97',
    });
    container.add(fleetLabel);

    let cursorY = gridOriginY + 4;
    const blockPx = 15;
    this.fleet.forEach((ship) => {
      const label = this.add.text(panelX, cursorY, `SIZE ${ship.size}`, {
        fontFamily: 'Courier New',
        fontSize: 11,
        color: this.fleetSunk.has(ship.id) ? '#d4a94a' : '#6f8394',
      });
      container.add(label);
      this.fleetLabels[ship.id] = label;
      if (this.fleetSunk.has(ship.id)) label.setText(`SIZE ${ship.size}  \u2713 SUNK`);

      const blocks: Phaser.GameObjects.Rectangle[] = [];
      for (let i = 0; i < ship.size; i++) {
        const sunk = this.fleetSunk.has(ship.id);
        const block = this.add
          .rectangle(panelX + 62 + i * (blockPx + 2), cursorY + 6, blockPx, blockPx, sunk ? COLORS.brass : 0x1c3d61)
          .setStrokeStyle(1, sunk ? 0xffe6b0 : COLORS.radarGreen);
        container.add(block);
        blocks.push(block);
      }
      this.fleetBlocks[ship.id] = blocks;
      cursorY += 24;
    });

    // ---- Message line ----
    this.messageText = this.add.text(0, GRID_PX + gridOriginY + 10, '', {
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
        return; // stale click, nothing to animate
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
    const y = 40 + r * CELL + CELL / 2;
    const dot = this.add.circle(x, y, 4, COLORS.fogDim);
    this.boardContainer.add(dot);
    this.tweens.add({ targets: dot, alpha: 0.5, duration: 200 });
  }

  private spawnHitFlash(r: number, c: number) {
    if (!this.boardContainer) return;
    const x = c * CELL + CELL / 2;
    const y = 40 + r * CELL + CELL / 2;
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
      const y = 40 + mid.r * CELL + CELL / 2;
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
      label.setText(`SIZE ${ship.size}  \u2713 SUNK`);
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
    if (!this.boardContainer) return;

    const scaleFactor = Math.min(width / DESIGN_W, height / DESIGN_H, 1.4);
    this.boardContainer.setScale(scaleFactor);
    this.boardContainer.setPosition(
      width / 2 - (DESIGN_W * scaleFactor) / 2,
      height / 2 - (DESIGN_H * scaleFactor) / 2
    );
  }
}