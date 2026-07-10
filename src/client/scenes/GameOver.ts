import { Scene } from 'phaser';
import * as Phaser from 'phaser';
import type { GetLeaderboardResponse } from '../../shared/api';
import { audioManager } from '../audio';

const COLORS = {
  radarGreen: '#3ddc97',
  brass: '#d4a94a',
  alertRed: '#d8544a',
  fogDim: '#6f8394',
};

type GameOverData = {
  won?: boolean;
  bombsUsed?: number;
  bombsMax?: number;
  hintsUsed?: number;
  score?: number;
};

export class GameOver extends Scene {
  camera: Phaser.Cameras.Scene2D.Camera;

  won = false;
  bombsUsed = 0;
  bombsMax = 32;
  hintsUsed = 0;
  score = 0;

  resultText: Phaser.GameObjects.Text | null = null;
  scoreText: Phaser.GameObjects.Text | null = null;
  leaderboardTitle: Phaser.GameObjects.Text | null = null;
  leaderboardLines: Phaser.GameObjects.Text[] = [];
  hintText: Phaser.GameObjects.Text | null = null;

  constructor() {
    super('GameOver');
  }

  init(data: GameOverData): void {
    this.won = data?.won ?? false;
    this.bombsUsed = data?.bombsUsed ?? 0;
    this.bombsMax = data?.bombsMax ?? 32;
    this.hintsUsed = data?.hintsUsed ?? 0;
    this.score = data?.score ?? 0;

    // Reset cached objects — this Scene instance is reused across replays.
    this.resultText = null;
    this.scoreText = null;
    this.leaderboardTitle = null;
    this.leaderboardLines = [];
    this.hintText = null;
  }

  create() {
    this.camera = this.cameras.main;
    this.camera.setBackgroundColor(0x0a1628);
    audioManager.restore();

    const { width } = this.scale;

    this.resultText = this.add
      .text(width / 2, 70, this.resultHeadline(), {
        fontFamily: 'Courier New',
        fontSize: 24,
        color: this.won ? COLORS.radarGreen : COLORS.alertRed,
        fontStyle: 'bold',
        align: 'center',
      })
      .setOrigin(0.5);

    this.scoreText = this.add
      .text(width / 2, 106, `SCORE: ${this.score}`, {
        fontFamily: 'Courier New',
        fontSize: 20,
        color: COLORS.brass,
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    const subText = `${this.bombsUsed} bombs used, ${this.hintsUsed} hint${this.hintsUsed === 1 ? '' : 's'} used`;

    this.add
      .text(width / 2, 136, subText, {
        fontFamily: 'Courier New',
        fontSize: 13,
        color: COLORS.fogDim,
      })
      .setOrigin(0.5);

    this.leaderboardTitle = this.add
      .text(width / 2, 176, 'Loading leaderboard...', {
        fontFamily: 'Courier New',
        fontSize: 14,
        color: COLORS.brass,
      })
      .setOrigin(0.5);

    void this.loadLeaderboard();

    this.hintText = this.add
      .text(
        width / 2,
        this.scale.height - 40,
        'Tap anywhere to return to menu',
        {
          fontFamily: 'Courier New',
          fontSize: 12,
          color: COLORS.fogDim,
        }
      )
      .setOrigin(0.5);

    this.scale.on('resize', (gameSize: Phaser.Structs.Size) => {
      this.layout(gameSize.width, gameSize.height);
    });

    this.input.once('pointerdown', () => {
      this.scene.start('MainMenu');
    });
  }

  private resultHeadline(): string {
    return this.won ? 'FLEET DESTROYED' : 'OUT OF BOMBS';
  }

  private async loadLeaderboard() {
    try {
      const response = await fetch('/api/leaderboard');
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const data = (await response.json()) as GetLeaderboardResponse;

      this.leaderboardTitle?.setText(
        `TODAY'S LEADERBOARD${data.myRank ? ` — you: #${data.myRank}` : ''}`
      );

      const startY = 206;
      const lineHeight = 20;
      const top = data.entries.slice(0, 8);

      if (top.length === 0) {
        const line = this.add
          .text(
            this.scale.width / 2,
            startY,
            'No solves yet today — be the first!',
            {
              fontFamily: 'Courier New',
              fontSize: 12,
              color: COLORS.fogDim,
            }
          )
          .setOrigin(0.5);
        this.leaderboardLines.push(line);
        return;
      }

      top.forEach(
        (
          entry: {
            username: string;
            score: number;
            shipsFound: number;
            hintsUsed: number;
          },
          i: number
        ) => {
          const line = this.add
            .text(
              this.scale.width / 2,
              startY + i * lineHeight,
              `${i + 1}. ${entry.username} — ${entry.score} pts (${entry.shipsFound}/6 ships, ${entry.hintsUsed} hints)`,
              {
                fontFamily: 'Courier New',
                fontSize: 12,
                color: i === 0 ? COLORS.brass : '#cfd9e0',
              }
            )
            .setOrigin(0.5);
          this.leaderboardLines.push(line);
        }
      );
    } catch (error) {
      console.error('Failed to load leaderboard:', error);
      this.leaderboardTitle?.setText('Leaderboard unavailable.');
    }
  }

  private layout(width: number, height: number) {
    this.cameras.resize(width, height);

    this.resultText?.setX(width / 2);
    this.scoreText?.setX(width / 2);
    this.leaderboardTitle?.setX(width / 2);
    this.hintText?.setPosition(width / 2, height - 40);
    this.leaderboardLines.forEach((line) => line.setX(width / 2));
  }
}
