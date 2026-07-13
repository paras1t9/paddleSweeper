import { Scene } from 'phaser';
import * as Phaser from 'phaser';
import type {
  GetLeaderboardResponse,
  ShareResultResponse,
  StreakInfo,
} from '../../shared/api';
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
  streak?: StreakInfo;
  practice?: boolean;
};

export class GameOver extends Scene {
  camera: Phaser.Cameras.Scene2D.Camera;

  won = false;
  bombsUsed = 0;
  bombsMax = 32;
  hintsUsed = 0;
  score = 0;
  streak: StreakInfo = { currentStreak: 0, longestStreak: 0, superBombs: 0 };
  practice = false;

  resultText: Phaser.GameObjects.Text | null = null;
  scoreText: Phaser.GameObjects.Text | null = null;
  shareButton: Phaser.GameObjects.Text | null = null;
  shareStatusText: Phaser.GameObjects.Text | null = null;
  leaderboardTitle: Phaser.GameObjects.Text | null = null;
  leaderboardLines: Phaser.GameObjects.Text[] = [];
  playRealButton: Phaser.GameObjects.Text | null = null;
  menuButton: Phaser.GameObjects.Text | null = null;

  centeredTexts: Phaser.GameObjects.Text[] = [];

  constructor() {
    super('GameOver');
  }

  init(data: GameOverData): void {
    this.won = data?.won ?? false;
    this.bombsUsed = data?.bombsUsed ?? 0;
    this.bombsMax = data?.bombsMax ?? 32;
    this.hintsUsed = data?.hintsUsed ?? 0;
    this.score = data?.score ?? 0;
    this.streak = data?.streak ?? {
      currentStreak: 0,
      longestStreak: 0,
      superBombs: 0,
    };
    this.practice = data?.practice ?? false;

    this.resultText = null;
    this.scoreText = null;
    this.shareButton = null;
    this.shareStatusText = null;
    this.leaderboardTitle = null;
    this.leaderboardLines = [];
    this.playRealButton = null;
    this.menuButton = null;
    this.centeredTexts = [];
  }

  create() {
    this.camera = this.cameras.main;
    this.camera.setBackgroundColor(0x0a1628);
    audioManager.restore();

    const { width } = this.scale;
    const centerX = width / 2;

    this.resultText = this.add
      .text(centerX, 60, this.resultHeadline(), {
        fontFamily: 'Courier New',
        fontSize: 24,
        color: this.won ? COLORS.radarGreen : COLORS.alertRed,
        fontStyle: 'bold',
        align: 'center',
      })
      .setOrigin(0.5);
    this.centeredTexts.push(this.resultText);

    let cursorY = 96;

    if (!this.practice) {
      this.scoreText = this.add
        .text(centerX, cursorY, `SCORE: ${this.score}`, {
          fontFamily: 'Courier New',
          fontSize: 20,
          color: COLORS.brass,
          fontStyle: 'bold',
        })
        .setOrigin(0.5);
      this.centeredTexts.push(this.scoreText);
      cursorY += 30;
    }

    const subText = this.practice
      ? `Practice round — ${this.bombsUsed} bombs, ${this.hintsUsed} hints used`
      : `${this.bombsUsed} bombs used, ${this.hintsUsed} hint${this.hintsUsed === 1 ? '' : 's'} used`;
    const subTextObj = this.add
      .text(centerX, cursorY, subText, {
        fontFamily: 'Courier New',
        fontSize: 13,
        color: COLORS.fogDim,
      })
      .setOrigin(0.5);
    this.centeredTexts.push(subTextObj);
    cursorY += 28;

    if (this.practice) {
      const note = this.add
        .text(
          centerX,
          cursorY,
          'Not scored — no effect on your streak or the leaderboard.',
          {
            fontFamily: 'Courier New',
            fontSize: 11,
            color: COLORS.fogDim,
            align: 'center',
            wordWrap: {
              width: Math.min(width - 40, 340),
              useAdvancedWrap: true,
            },
          }
        )
        .setOrigin(0.5);
      this.centeredTexts.push(note);
      cursorY += 40;

      this.playRealButton = this.add
        .text(centerX, cursorY, "Play Today's Puzzle", {
          fontFamily: 'Courier New',
          fontSize: 14,
          color: COLORS.radarGreen,
          backgroundColor: '#10233d',
          padding: { x: 16, y: 9 },
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });
      this.centeredTexts.push(this.playRealButton);
      this.playRealButton.on('pointerover', () =>
        this.playRealButton?.setStyle({ backgroundColor: '#1c3d61' })
      );
      this.playRealButton.on('pointerout', () =>
        this.playRealButton?.setStyle({ backgroundColor: '#10233d' })
      );
      this.playRealButton.on('pointerdown', () =>
        this.scene.start('Game', { practice: false })
      );
    } else {
      const superBombNote =
        this.streak.superBombs > 0
          ? `  \u2022  ${this.streak.superBombs} super bomb${this.streak.superBombs === 1 ? '' : 's'} ready`
          : '';
      const streakLabel = `Streak: ${this.streak.currentStreak} day${this.streak.currentStreak === 1 ? '' : 's'} (best: ${this.streak.longestStreak})${superBombNote}`;
      const streakText = this.add
        .text(centerX, cursorY, streakLabel, {
          fontFamily: 'Courier New',
          fontSize: 13,
          color:
            this.streak.currentStreak > 0 ? COLORS.radarGreen : COLORS.fogDim,
          align: 'center',
          wordWrap: {
            width: Math.min(this.scale.width - 40, 380),
            useAdvancedWrap: true,
          },
        })
        .setOrigin(0.5);
      this.centeredTexts.push(streakText);
      cursorY += superBombNote ? 46 : 32;

      this.shareButton = this.add
        .text(centerX, cursorY, 'Share Result', {
          fontFamily: 'Courier New',
          fontSize: 13,
          color: COLORS.radarGreen,
          backgroundColor: '#10233d',
          padding: { x: 14, y: 7 },
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });
      this.centeredTexts.push(this.shareButton);
      this.shareButton.on('pointerover', () =>
        this.shareButton?.setStyle({ backgroundColor: '#1c3d61' })
      );
      this.shareButton.on('pointerout', () =>
        this.shareButton?.setStyle({ backgroundColor: '#10233d' })
      );
      this.shareButton.on('pointerdown', () => void this.shareResult());
      cursorY += 32;

      this.shareStatusText = this.add
        .text(centerX, cursorY, '', {
          fontFamily: 'Courier New',
          fontSize: 11,
          color: COLORS.fogDim,
        })
        .setOrigin(0.5);
      this.centeredTexts.push(this.shareStatusText);
      cursorY += 26;

      this.leaderboardTitle = this.add
        .text(centerX, cursorY, 'Loading leaderboard...', {
          fontFamily: 'Courier New',
          fontSize: 14,
          color: COLORS.brass,
        })
        .setOrigin(0.5);
      this.centeredTexts.push(this.leaderboardTitle);
      cursorY += 30;

      void this.loadLeaderboard(cursorY);
    }

    this.menuButton = this.add
      .text(centerX, this.scale.height - 40, 'Back to Menu', {
        fontFamily: 'Courier New',
        fontSize: 12,
        color: COLORS.fogDim,
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    this.menuButton.on('pointerover', () =>
      this.menuButton?.setColor(COLORS.radarGreen)
    );
    this.menuButton.on('pointerout', () =>
      this.menuButton?.setColor(COLORS.fogDim)
    );
    this.menuButton.on('pointerdown', () => this.scene.start('MainMenu'));

    this.scale.on('resize', (gameSize: Phaser.Structs.Size) => {
      this.layout(gameSize.width, gameSize.height);
    });
  }

  private resultHeadline(): string {
    if (this.practice) {
      return this.won ? 'FLEET DESTROYED' : 'PRACTICE COMPLETE';
    }
    return this.won ? 'FLEET DESTROYED' : 'OUT OF BOMBS';
  }

  private async shareResult() {
    if (!this.shareButton || !this.shareStatusText) return;
    this.shareButton.disableInteractive();
    this.shareButton.setText('Sharing...');
    this.shareStatusText.setText('');

    try {
      const response = await fetch('/api/share-result', { method: 'POST' });
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const result = (await response.json()) as ShareResultResponse;

      if (result.status === 'ok') {
        this.shareStatusText.setText('Posted to comments!');
        this.shareStatusText.setColor(COLORS.radarGreen);
        this.shareButton.setText('Shared \u2713');
      } else {
        this.shareStatusText.setText(
          result.message ?? 'Could not share result.'
        );
        this.shareStatusText.setColor(COLORS.alertRed);
        this.shareButton.setText('Share Result');
        this.shareButton.setInteractive({ useHandCursor: true });
      }
    } catch (error) {
      console.error('Failed to share result:', error);
      this.shareStatusText.setText('Could not share result. Try again.');
      this.shareStatusText.setColor(COLORS.alertRed);
      this.shareButton.setText('Share Result');
      this.shareButton.setInteractive({ useHandCursor: true });
    }
  }

  private async loadLeaderboard(startY: number) {
    try {
      const response = await fetch('/api/leaderboard');
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const data = (await response.json()) as GetLeaderboardResponse;

      this.leaderboardTitle?.setText(
        `TODAY'S LEADERBOARD${data.myRank ? ` — you: #${data.myRank}` : ''}`
      );

      const lineHeight = 20;
      const top = data.entries.slice(0, 8);
      const centerX = this.scale.width / 2;

      if (top.length === 0) {
        const line = this.add
          .text(centerX, startY, 'No solves yet today — be the first!', {
            fontFamily: 'Courier New',
            fontSize: 12,
            color: COLORS.fogDim,
          })
          .setOrigin(0.5);
        this.leaderboardLines.push(line);
        this.centeredTexts.push(line);
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
              centerX,
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
          this.centeredTexts.push(line);
        }
      );
    } catch (error) {
      console.error('Failed to load leaderboard:', error);
      this.leaderboardTitle?.setText('Leaderboard unavailable.');
    }
  }

  private layout(width: number, height: number) {
    this.cameras.resize(width, height);
    const centerX = width / 2;
    this.centeredTexts.forEach((t) => t.setX(centerX));
    this.menuButton?.setPosition(centerX, height - 40);
  }
}
