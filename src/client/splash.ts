import { navigateTo, context, requestExpandedMode } from '@devvit/web/client';

const startButton = document.querySelector<HTMLButtonElement>('#start-button');
const docsLink = document.querySelector<HTMLDivElement>('#docs-link');
const playtestLink = document.querySelector<HTMLDivElement>('#playtest-link');
const discordLink = document.querySelector<HTMLDivElement>('#discord-link');
const greetingElement = document.querySelector<HTMLDivElement>('#greeting');

startButton?.addEventListener('click', (e) => {
  requestExpandedMode(e, 'game');
});

docsLink?.addEventListener('click', () => {
  navigateTo('https://developers.reddit.com/docs');
});

playtestLink?.addEventListener('click', () => {
  navigateTo('https://www.reddit.com/r/Devvit');
});

discordLink?.addEventListener('click', () => {
  navigateTo('https://discord.com/invite/R7yu2wh9Qz');
});

function init() {
  if (greetingElement) {
    greetingElement.textContent = context.username ? `Commander ${context.username}` : 'New Commander';
  }
}

init();