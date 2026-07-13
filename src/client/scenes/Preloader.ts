import { Scene } from 'phaser';

export class Preloader extends Scene {
  constructor() {
    super('Preloader');
  }

  init() {
    this.cameras.main.setBackgroundColor(0x0a1628);

    this.add.rectangle(512, 384, 300, 6).setStrokeStyle(1, 0x1c5c47);

    const bar = this.add.rectangle(512 - 148, 384, 4, 4, 0x3ddc97);

    this.load.on('progress', (progress: number) => {
      bar.width = 4 + 292 * progress;
    });
  }

  preload() {}

  create() {
    this.scene.start('MainMenu');
  }
}
