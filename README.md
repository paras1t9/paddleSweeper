# Daily Battles

**One hidden fleet. One shot a day. Your whole subreddit is hunting the same ships.**

A daily naval deduction puzzle built on [Devvit](https://developers.reddit.com/), Reddit's developer platform. Every day, a new fleet is secretly placed on a 10×10 grid — the *same* layout for every player in the subreddit. You know the shapes of the ships going in, but never their position or rotation. Find them all before you run out of bombs.

Built for Reddit's **Games with a Hook Hackathon**.

---

## How to play

- A fleet of 6 ships is hidden on a 10×10 grid, refreshed every day at midnight UTC.
- Ships aren't just straight lines — each has a real shape: **Carrier** (L), **Battleship** (square), **Destroyer** (Z), **Submarine** (straight), **Patrol Boat** (corner), **Scout** (domino).
- You're shown each ship's shape ahead of time, but never its position or that day's rotation.
- Tap a cell to bomb it. You get **32 bombs**. Each one is a miss, a hit, or the finishing blow that sinks a ship.
- Stuck? Use a **hint** to instantly reveal one cell of an unfound ship — free, doesn't cost a bomb. You get 6 per day, but each one lowers your final score.
- Run out of bombs before finding everything, and the ships you missed are revealed so the round has some closure.
- Play daily to build a **streak**. Every 5-day streak earns a **super bomb** — clears a 2×2 area in one shot, doesn't touch your normal bomb count.
- Share your result straight to the post's comments, and check the daily leaderboard.
- New to the mechanics? **Practice Mode** gives you an unlimited, unscored puzzle to learn on before spending your one real attempt for the day.

## Scoring

```
score = (10 × cells of ships sunk) + (2 × bombs remaining) − (15 × hints used)
```

Bigger ships are worth more (Carrier alone is worth 50), floored at 0. Finding the full fleet always outweighs pure efficiency — the bomb-efficiency bonus is a tiebreaker, not a way to out-score someone who actually found more ships.

## Features

- **Server-authoritative puzzle** — the client never receives ship positions, only shapes. Every bomb is resolved against a secretly-held grid on the server; there's nothing to find by opening dev tools.
- **Deterministic daily generation** — a seeded RNG derives the day's layout from the date itself, so every player gets an identical puzzle without needing a scheduled job.
- **Real polyomino ship shapes** with random daily rotation, not just straight lines.
- **Fully responsive board** — automatically switches between a side-by-side layout (desktop/landscape) and a stacked layout (phone/portrait) so cells stay legible and crisp instead of shrinking to illegibility on mobile.
- **Procedurally synthesized audio** — music and every sound effect are generated live with the Web Audio API, no audio files shipped.
- **Streaks & super bombs** — a persistent, durable reward loop independent of any single day's puzzle.
- **Reddit-native sharing** — post your result as a comment with one tap.
- **Daily leaderboard** with rank tracking.
- **Practice mode** — a separate, unscored sandbox for learning the mechanics.
- **Colorblind-conscious design** — hit/sunk cells carry distinct glyphs, not just color.

## Tech stack

- **Platform:** [Devvit Web](https://developers.reddit.com/docs) (Reddit's developer platform)
- **Client:** [Phaser 3](https://phaser.io/), TypeScript, Vite
- **Server:** [Hono](https://hono.dev/), Node.js, running in Devvit's serverless backend
- **Storage:** Redis (via `@devvit/web/server`)
- **Audio:** Web Audio API (no audio assets — everything is synthesized)

## Project structure

```
paddlesweeper/
├── src/
│   ├── client/                 # Runs in an iframe on reddit.com
│   │   ├── splash.html/ts/css  # Lightweight preview shown in the feed
│   │   ├── game.ts             # Phaser config + scene registration
│   │   ├── audio.ts            # Procedural music/SFX (Web Audio API)
│   │   └── scenes/
│   │       ├── Boot.ts
│   │       ├── Preloader.ts
│   │       ├── MainMenu.ts     # "Play" / "Practice Mode" entry point
│   │       ├── Game.ts         # Main gameplay scene
│   │       └── GameOver.ts     # Result, leaderboard, share, streak
│   ├── server/                 # Runs in Devvit's secure backend
│   │   ├── index.ts            # Hono app entry point
│   │   ├── core/
│   │   │   └── puzzle.ts       # Fleet definitions, generation, hint/bomb resolution
│   │   └── routes/
│   │       └── api.ts          # /daily-puzzle, /bomb, /hint, /super-bomb,
│   │                           # /leaderboard, /share-result, /practice/*
│   └── shared/
│       └── api.ts              # Request/response types + scoring formula,
│                                # shared between client and server
├── devvit.json                 # App manifest
└── package.json
```

## Running locally

```bash
npm install
npm run dev
```

This starts Devvit's local dev server and gives you a live-updating playtest link inside a real subreddit. Changes to client or server code hot-reload automatically.

```bash
npm run type-check   # TypeScript
npm run lint         # Linter
```

## Architecture notes

**Nothing secret ever reaches the client.** `GetDailyPuzzleResponse` only ever includes each ship's canonical *shape* (for the silhouette panel) — never its position or that day's rotation. Every bomb and hint is resolved server-side against `puzzle.occupied`, a grid that lives only in Redis and in server memory for the duration of a request.

**Cache keys are versioned.** Redis keys for the day's puzzle and each player's session include a `FLEET_VERSION` constant from `puzzle.ts`. Bumping it whenever ship shapes, sizes, or scoring rules change automatically invalidates old cached data instead of silently serving stale puzzles generated under different rules. Streak data is deliberately stored under a *separate, unversioned* key, since a player's streak shouldn't reset just because gameplay rules changed.

**Board layout is decided per-load, not assumed.** The client picks between a side-by-side and a stacked arrangement based on actual viewport aspect ratio at build time, and re-evaluates on resize/orientation change — rebuilding from live game state (not the original fetch) so no progress is lost if the layout mode flips mid-session.

## Credits

Built for Reddit's Games with a Hook Hackathon, using the Devvit Phaser template as a starting point.