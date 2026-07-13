import { context, requestExpandedMode } from '@devvit/web/client';

const startButton = document.querySelector<HTMLButtonElement>('#start-button');
const greetingElement = document.querySelector<HTMLDivElement>('#greeting');
const helpButton = document.querySelector<HTMLButtonElement>('#help-button');
const helpClose = document.querySelector<HTMLButtonElement>('#help-close');
const helpOverlay = document.querySelector<HTMLDivElement>('#help-overlay');

startButton?.addEventListener('click', (e) => {
  requestExpandedMode(e, 'game');
});

function openHelp() {
  helpOverlay?.classList.add('open');
}

function closeHelp() {
  helpOverlay?.classList.remove('open');
}

helpButton?.addEventListener('click', openHelp);
helpClose?.addEventListener('click', closeHelp);

helpOverlay?.addEventListener('click', (e) => {
  if (e.target === helpOverlay) closeHelp();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeHelp();
});

function init() {
  if (greetingElement) {
    greetingElement.textContent = context.username
      ? `Commander ${context.username}`
      : 'New Commander';
  }
}

init();
