# Cinematic Bazaar

A reusable multiplayer mini-game platform. Drop in a game definition and get rooms, lobbies, ready/start flow, 60Hz server-authoritative gameplay, and Cloudflare deployment — all for free.

---

## What it does

The framework handles everything that isn't the game itself:

- **Lobby browser** — players choose a game, see open rooms, join by code or create their own
- **Ready/start flow** — host waits for all players to ready up, then starts
- **Networking** — WebSocket server with reconnect, input queuing, and 60Hz state broadcast
- **Server authority** — the server runs the game loop; clients only render
- **AI backfill** — disconnected or missing players become AI automatically
- **Cloudflare-ready** — Durable Objects for WebSocket + Pages for static assets

You write the game. The framework writes everything else.

---

## Quick start

```bash
npm install
npm run build
node dist/server.js
```

Open `http://localhost:3000`. The Tetromino Battle example game is pre-registered and playable immediately — open two tabs to test multiplayer.

---

## Included example: Tetromino Battle

A 4-player competitive Tetromino. Clear 2+ lines at once to send garbage to your opponents. Last board standing wins.

Located at `src/games/tetromino/`. It exercises the full framework surface — physics-driven state, deterministic PRNG, AI heuristics, multi-panel canvas rendering, and custom game events — making it the best reference when building a new game.

---

## Adding a new game

The full specification lives in **[FRAMEWORK.md](./FRAMEWORK.md)**. The short version:

### 1. Create your game directory

```
src/games/<your-game-id>/
  definition.ts   ← entry point; export default GameDefinition
  state.ts        ← TState interface + createInitialState()
  input.ts        ← ActionSchema, ActionMap, TInput type
  engine.ts       ← tick(), isGameOver(), getWinner()
  renderer.ts     ← GameRenderer<TState>
  constants.ts
  events.ts       ← (optional) typed GameEvent union
```

### 2. Implement the four required functions

| Function | Where it runs | What it does |
|----------|--------------|--------------|
| `createInitialState(config)` | server + browser | Returns the starting `TState` |
| `tick(state, inputs, dt)` | server + browser | Advances state by one frame; must be pure |
| `isGameOver(state)` | server + browser | Returns `true` to end the game |
| `getWinner(state)` | server + browser | Returns the winning `PlayerId` or `null` for a draw |

And one client-only function:

| Function | Where it runs | What it does |
|----------|--------------|--------------|
| `renderer.render(ctx, state, myPlayerId)` | browser only | Draws the current state onto the 800×600 canvas |

### 3. Register the game

```typescript
// src/games/index.ts  — client bundle
import { registerClientGame } from '../framework/client/ui/manager';
import myGame from './your-game-id/definition';
registerClientGame(myGame);

// src/server/main.ts  — server bundle
import { registerGame } from '../framework/server/network/ws';
import myGame from '../games/your-game-id/definition';
registerGame(myGame);
```

### 4. Build and test

```bash
npm run build
node dist/server.js
```

Your game appears in the main menu automatically.

---

## Key rules

- `tick()` must be a **pure function** — no `Math.random()`, no I/O, no side effects. Use `seededRandom(seed)` from `framework/shared/utils.ts` for deterministic randomness.
- `TState` must be **JSON-serializable** — no class instances, no circular refs, no functions.
- `renderer.render()` is **browser-only** — never import it from server files.
- State cloning inside `tick()`: prefer shallow spread over `structuredClone` for performance at 60Hz.

---

## Project structure

```
src/
├── framework/          # Do not edit — shared networking, lobby, UI shell
│   ├── shared/         # Types, constants, utilities (runs everywhere)
│   ├── server/         # WebSocket server, RoomManager, GameRunner
│   └── client/         # WebSocket client, InputHandler, UIManager
├── games/
│   ├── index.ts        # Client-side game registration
│   └── tetromino/      # Reference implementation
├── server/main.ts      # Node.js entry point
├── client/main.ts      # Browser entry point
└── worker/worker.ts    # Cloudflare Worker entry point
public/
├── index.html
└── client.js           # Built by `npm run build`
```

---

## Deploying to Cloudflare

The Worker entry (`src/worker/worker.ts`) uses a Durable Object for WebSocket state and a Pages binding for static assets. See the **Cloudflare Compatibility** section of [FRAMEWORK.md](./FRAMEWORK.md) for the one difference from the local dev server: the 60Hz game loop must use the Durable Object `alarm()` API instead of `setInterval`.

```bash
npm run build
wrangler deploy
```

---

## Testing

Run the E2E test suite against the deployed Worker:

```bash
npm test
```

10 integration tests covering the full game lifecycle:

| Test | What it verifies |
|------|-----------------|
| connect & get connected ack | WebSocket upgrade and initial `connected` message |
| create room & see it in room_list | Room creation and `request_room_list` polling |
| join room & receive room_update | Two clients join the same room |
| both players ready → game starts | Ready flow, game start, and state broadcasting |
| state broadcasts continue | 60Hz server loop runs for at least 5 ticks |
| player input accepted | Client `input` message is processed without error |
| leave room updates reflect | Disconnection updates room state for remaining player |
| ping / pong | Basic keepalive |
| join non-existent room error | Error handling for bad codes |
| join_room while already in room | Conflict detection |

Verbose output (logs every message):

```bash
npm run test:verbose
```

Test against the local Node.js server:

```bash
npm run build
node dist/server.js &
WORKER_URL=ws://localhost:3000/ws npm test
```

Tests live in `test-e2e.cjs` — zero dependencies, uses `ws` and `node:assert`. Each test creates its own connections, drives the full protocol, and cleans up. The `setupGame()` helper creates a ready-to-play game session so each test focuses on what it wants to verify.

---

## Further reading

**FRAMEWORK.md** — complete specification covering:

- All interface types (`GameDefinition`, `BaseGameState`, `BaseInput`, `TickResult`, …)
- Network protocol and message reference
- Lobby and room system
- UI screen flow and customisation points
- Build output layout
- Round-based game pattern
- Framework utilities reference
- Cloudflare compatibility notes
