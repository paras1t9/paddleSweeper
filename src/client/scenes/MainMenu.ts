import { Scene } from 'phaser';
import * as Phaser from 'phaser';
import { audioManager } from '../audio';

const COLORS = {
  navyDeep: 0x0a1628,
  radarGreen: 0x3ddc97,
  radarDim: 0x1c5c47,
  brass: 0xd4a94a,
  fogDim: 0x6f8394,
};

const MARK_RADIUS = 34; // fixed, in pixels — never scaled, stays crisp on any screen

export class MainMenu extends Scene {
  markGraphics: Phaser.GameObjects.Graphics | null = null;
  title: Phaser.GameObjects.Text | null = null;
  playButton: Phaser.GameObjects.Text | null = null;
  practiceButton: Phaser.GameObjects.Text | null = null;
  sweepAngle = 0;

  constructor() {
    super('MainMenu');
  }

  init(): void {
    this.markGraphics = null;
    this.title = null;
    this.playButton = null;
    this.practiceButton = null;
    this.sweepAngle = 0;
  }

  create() {
    this.cameras.main.setBackgroundColor(COLORS.navyDeep);
    this.refreshLayout();

    this.scale.on('resize', () => this.refreshLayout());
    void audioManager.ensureStarted();
  }

  override update(_time: number, delta: number) {
    this.sweepAngle = (this.sweepAngle + delta * 0.12) % 360;
    this.drawMark();
  }

  private refreshLayout(): void {
    const { width, height } = this.scale;
    this.cameras.resize(width, height);

    const centerX = width / 2;
    const markY = Math.max(height * 0.34, MARK_RADIUS + 20);

    if (!this.markGraphics) {
      this.markGraphics = this.add.graphics();
    }
    this.markGraphics.setPosition(centerX, markY);
    this.markGraphics.setScale(1);
    this.drawMark();

    if (!this.title) {
      this.title = this.add
        .text(0, 0, 'DAILY BATTLES', {
          fontFamily: 'Courier New',
          fontSize: '30px',
          color: '#3ddc97',
          fontStyle: 'bold',
        })
        .setOrigin(0.5);
    }
    this.title.setPosition(centerX, markY + 68);

    if (!this.playButton) {
      this.playButton = this.add
        .text(0, 0, "PLAY TODAY'S PUZZLE", {
          fontFamily: 'Courier New',
          fontSize: '15px',
          color: '#3ddc97',
          backgroundColor: '#10233d',
          padding: { x: 18, y: 10 },
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });

      this.playButton.on('pointerover', () =>
        this.playButton?.setStyle({ backgroundColor: '#1c3d61' })
      );
      this.playButton.on('pointerout', () =>
        this.playButton?.setStyle({ backgroundColor: '#10233d' })
      );
      this.playButton.on('pointerdown', () => {
        void audioManager.ensureStarted();
        this.scene.start('Game', { practice: false });
      });
    }
    this.playButton.setPosition(centerX, markY + 112);

    if (!this.practiceButton) {
      this.practiceButton = this.add
        .text(0, 0, 'Practice Mode (unlimited, not scored)', {
          fontFamily: 'Courier New',
          fontSize: '12px',
          color: '#6f8394',
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });

      this.practiceButton.on('pointerover', () =>
        this.practiceButton?.setColor('#3ddc97')
      );
      this.practiceButton.on('pointerout', () =>
        this.practiceButton?.setColor('#6f8394')
      );
      this.practiceButton.on('pointerdown', () => {
        void audioManager.ensureStarted();
        this.scene.start('Game', { practice: true });
      });
    }
    this.practiceButton.setPosition(centerX, markY + 154);
  }

  private drawMark(): void {
    if (!this.markGraphics) return;
    const g = this.markGraphics;
    const r = MARK_RADIUS;
    g.clear();

    g.lineStyle(2, COLORS.radarGreen, 0.5).strokeCircle(0, 0, r);
    g.lineStyle(1.5, COLORS.radarGreen, 0.35).strokeCircle(0, 0, r * 0.7);
    g.lineStyle(1.5, COLORS.radarGreen, 0.25).strokeCircle(0, 0, r * 0.38);
    g.lineStyle(1.5, COLORS.radarDim, 1).lineBetween(0, -r, 0, r);
    g.lineStyle(1.5, COLORS.radarDim, 1).lineBetween(-r, 0, r, 0);

    const rad = (this.sweepAngle * Math.PI) / 180;
    const sweepWidth = 0.6;
    g.fillStyle(COLORS.radarGreen, 0.2);
    g.slice(0, 0, r, rad, rad + sweepWidth, false);
    g.fillPath();

    g.fillStyle(COLORS.brass, 1).fillCircle(0, 0, 4);
  }
}
