import { Scene } from 'phaser';

export class Boot extends Scene {
  constructor() {
    super('Boot');
  }

  preload() {
    // Daily Battles draws its UI with Phaser Graphics/Text rather than
    // image assets, so there's nothing to preload before the Preloader
    // scene itself runs.
  }

  create() {
    this.scene.start('Preloader');
  }
}