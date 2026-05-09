# Cinematic Bazaar

Reusable multiplayer party game platform. Provides networking, lobby/room management, player name selection, input handling, and a modular UI shell. Games supply their own logic, state, and renderer.

## Stack

- **Runtime**: Node.js 18+ (server), browser (client)
- **Language**: TypeScript 5.3
- **Transport**: WebSocket (`ws` on server, native on client)
- **Bundler**: esbuild
- **Deploy**: Cloudflare Workers (Durable Objects for WebSocket) + Cloudflare Pages (static)

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  Game Layer  (you implement)                │
│  src/games/<id>/  definition, engine,       │
│                   renderer, input, state    │
├─────────────────────────────────────────────┤
│  Framework Layer  (provided)                │
│  Rooms · Lobby · Network · Input · UI shell │
├─────────────────────────────────────────────┤
│  Transport Layer  (provided)                │
│  WebSocket server · Cloudflare Worker proxy │
└─────────────────────────────────────────────┘
```

### File Layout

```
src/
├── framework/
│   ├── shared/
│   │   ├── types.ts          # BaseGameState, BasePlayer, RoomState, all message types
│   │   ├── constants.ts      # PLAYER_COLORS, TICK_MS, MAX_PLAYERS
│   │   └── utils.ts          # clamp, dist, normalizeAngle, generateRoomCode
│   ├── server/
│   │   ├── network/ws.ts     # WebSocket server, connection lifecycle, message routing
│   │   ├── lobby/rooms.ts    # RoomManager: create/join/leave/toggleReady/start
│   │   └── engine/runner.ts  # 60Hz tick loop; calls game's tick(); broadcasts state
│   └── client/
│       ├── network/ws.ts     # WebSocket client with reconnect + message queue
│       ├── input/handler.ts  # Keyboard + mouse wheel + gamepad → named actions
│       └── ui/manager.ts     # Screen router, renders framework-owned screens
├── games/
│   ├── index.ts              # Client-side registerClientGame() calls (browser bundle only)
│   └── <game-id>/
│       ├── definition.ts     # GameDefinition export  ← entry point for each game
│       ├── state.ts          # TState interface + createInitialState
│       ├── input.ts          # ActionSchema, defaultActionMap, TInput type
│       ├── engine.ts         # tick() pure function
│       ├── renderer.ts       # GameRenderer<TState> implementation
│       ├── constants.ts      # Game-specific constants
│       └── events.ts         # (optional) custom GameEvent union type
├── server/main.ts            # HTTP server entry; registers games server-side
├── client/main.ts            # Browser entry; imports games/index.ts
└── worker/worker.ts          # Cloudflare Worker + Durable Object entry
```

#### Single game registry

All game registration happens in one file: **`src/games/registry.ts`**. Each game definition is imported once and exported in the `GAMES` array. The three entry points each import from this single registry:

- **Client** (`src/games/index.ts`): calls `registerClientGame(def)` for each game — imported by the browser bundle.
- **Server** (`src/server/main.ts`): calls `registerGame(def)` for each game — imported by the Node.js bundle.
- **Worker** (`src/worker/worker.ts`): calls `registerServerGame(def)` for each game — imported by the Cloudflare bundle.

The renderer is never imported by server entry points, so esbuild tree-shakes browser-only code from server bundles automatically.

---

## Core Concepts

**Server authority**: The server runs the authoritative 60Hz game loop. Clients send named-action inputs; server returns full `TState` each tick. Clients only render.

**Rooms**: Up to 8 players per room. Each game declares `minPlayers` and `maxPlayers`. The framework enforces these at join time. Unfilled slots up to `maxPlayers` become AI.

**Game lifecycle phases**: `waiting → lobby → starting → playing → game_over`

The phases `waiting`, `lobby`, and `starting` are managed entirely by the framework and never appear in `TState`. Only `playing` and `game_over` (plus any custom intermediate phases your game defines) appear in `BaseGameState.phase`.

**Disconnect recovery**: When a player disconnects mid-game, their slot switches to AI. The game continues. If the host disconnects in the lobby, the framework transfers host to the next player.

**Tick loop call order**: The runner calls functions in this order every tick:

1. Compute AI inputs via `aiAdapter.computeInput()` for each AI slot.
2. Call `tick(state, inputs, dt)` → get `result`.
3. Broadcast `state` message with `result.state` and `result.events`.
4. Call `isGameOver(result.state)`.
5. If true: call `getWinner(result.state)`, broadcast `game_over`, stop the loop.

`getWinner` always receives the post-tick state, the same object `isGameOver` received.

---

## Framework Interfaces

### `GameDefinition<TState, TInput>`

The single required export from `src/games/<id>/definition.ts`.

```typescript
import type {
  BaseGameState, BaseInput, PlayerId, GameConfig,
  GameRenderer, ActionSchema, ActionMap, AIAdapter, SettingDefinition,
} from '../../framework/shared/types';

interface GameDefinition<
  TState extends BaseGameState,
  TInput extends BaseInput
> {
  // --- Metadata ---
  id: string;             // Unique slug, e.g. "warlords". Used in URLs and room configs.
  name: string;           // Display name shown in main menu.
  description: string;    // One-sentence description shown in main menu.
  minPlayers: number;     // Minimum to start (≥ 1). Use 1 to allow solo play.
  maxPlayers: number;     // Maximum per room (2–8 inclusive).

  // --- Controls ---
  actions: ActionSchema;          // What inputs this game uses.
  defaultActionMap: ActionMap;    // Default keyboard/gamepad bindings.

  // --- Server-side hooks (run in Node.js and in-browser for single-player) ---
  createInitialState(config: GameConfig): TState;
  // dt is in SECONDS (e.g. 0.01667 at 60Hz). Use for velocity integration: pos += vel * dt.
  // inputs always contains an entry for every player slot (human and AI). Never undefined.
  tick(state: TState, inputs: Map<PlayerId, TInput>, dt: number): TickResult<TState>;
  // Called every tick AFTER tick() returns and state is broadcast. Return true to end the game.
  // All score updates must be applied inside tick() before this can return true.
  isGameOver(state: TState): boolean;
  // Called once, with the exact state object that caused isGameOver() to return true.
  // Return null for a draw. For single-player games, return state.players[0].id or null.
  getWinner(state: TState): PlayerId | null;

  // --- Client-side (browser bundle only; never imported by server) ---
  renderer: GameRenderer<TState>;
  canvasSize?: { width: number; height: number }; // Optional. Default 800x600.


  // --- Optional server-side ---
  settings?: SettingDefinition[];             // Lobby config options (speed, map, etc.)
  aiAdapter?: AIAdapter<TState, TInput>;      // Custom AI; defaults to random valid input.
  // Called on the server when a player joins or leaves mid-game (after connected flag is updated).
  // Return updated state. The returned state is applied immediately before the next tick.
  onPlayerJoin?(state: TState, playerId: PlayerId): TState;
  onPlayerLeave?(state: TState, playerId: PlayerId): TState;

  // --- Optional client-side ---
  howToPlay?: string;                         // HTML string for the How To Play screen.
  // Hooks for reacting to server events on the client (sounds, particles, UI flashes, etc.)
  clientHooks?: ClientHooks<TState>;
}

interface ClientHooks<TState> {
  // Called once per event per client, in emit order, BEFORE renderer.render() for that frame.
  onEvent?(event: GameEvent, state: TState): void;
  // Called on the client when the game_over message is received.
  onGameOver?(winner: PlayerId | null, scores: Record<PlayerId, number>): void;
}
```

### `GameEvent` (framework base type)

```typescript
interface GameEvent {
  type: string;
  [key: string]: unknown;
}
```

### `TickResult<TState>`

`tick()` returns state plus any events to broadcast to clients.

```typescript
interface TickResult<TState> {
  state: TState;
  events?: GameEvent[];
}
```

### `BaseGameState`

Every `TState` must extend this.

```typescript
interface BaseGameState {
  tick: number;    // Incremented each server tick.
  phase: string;   // 'playing' | 'game_over' minimum. Extend freely.
  players: BasePlayer[];
}

interface BasePlayer {
  id: PlayerId;      // 0–7. Stable for the duration of the game.
  name: string;
  color: PlayerColor;
  score: number;     // Game-managed. Set directly in tick(). game_over reads it from here.
  isAI: boolean;
  connected: boolean;
}

type PlayerId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
type PlayerColor = 'yellow' | 'white' | 'red' | 'blue' | 'green' | 'orange' | 'magenta' | 'cyan';
```

### `BaseInput`

Every `TInput` must extend this.

```typescript
interface BaseInput {
  [action: string]: boolean | number;
}
```

The `inputs` map passed to `tick()` **always** contains an entry for every player slot — human and AI alike. Games should never need to guard against a missing key, but a typed default is still good practice:

```typescript
const inp = inputs.get(player.id) ?? ({} as MyInput);
```

### `ActionSchema` and `ActionMap`

```typescript
type ActionSchema = Record<string, ActionDescriptor>;

interface ActionDescriptor {
  label: string;               // Human-readable. Shown in controls screen.
  type: 'held' | 'press';     // held: true while key down. press: true on keydown only.
  axis?: boolean;              // If true, value is -1..1 (gamepad stick). Default false.
}

interface ActionMap {
  keyboard: Record<string, string>;   // KeyboardEvent.code → action name
  mouseWheel?: {
    up: string;
    down: string;
  };
  gamepad?: {
    buttons: Record<number, string>;
    axes: Record<number, string>;
  };
}
```

Example:

```typescript
// src/games/platformer/input.ts
export const actions: ActionSchema = {
  MOVE_LEFT:  { label: 'Move Left',  type: 'held' },
  MOVE_RIGHT: { label: 'Move Right', type: 'held' },
  JUMP:       { label: 'Jump',       type: 'press' },
};

export const defaultActionMap: ActionMap = {
  keyboard: {
    ArrowLeft: 'MOVE_LEFT', KeyA: 'MOVE_LEFT',
    ArrowRight: 'MOVE_RIGHT', KeyD: 'MOVE_RIGHT',
    ArrowUp: 'JUMP', KeyW: 'JUMP',
  },
  gamepad: {
    buttons: { 0: 'JUMP' },
    axes: { 0: 'MOVE_RIGHT' },
  },
};

export type PlatformerInput = { MOVE_LEFT: boolean; MOVE_RIGHT: boolean; JUMP: boolean };
```

### `GameRenderer<TState>`

Defined in `src/games/<id>/renderer.ts`. Called by the client game loop every animation frame.

```typescript
interface GameRenderer<TState> {
  render(ctx: CanvasRenderingContext2D, state: TState, myPlayerId: PlayerId): void;
  init?(canvas: HTMLCanvasElement): void;  // Called once when game screen mounts.
}
```

The canvas size is **800×600** by default. Games can override this by providing a `canvasSize` in their `GameDefinition`. The framework clears it to black before each `render()` call.

**Coordinate system**: origin `(0, 0)` is top-left. X increases rightward. Y increases downward. Angles (`angleBetween`, `normalizeAngle`) are in radians, clockwise from the positive X axis.

### Custom `GameEvent` types

```typescript
// src/games/<game-id>/events.ts
import type { PlayerId } from '../../framework/shared/types';

export type MyGameEvent =
  | { type: 'player_scored'; playerId: PlayerId; points: number }
  | { type: 'item_spawned'; x: number; y: number };
```

Wire client reactions via `clientHooks.onEvent`:

```typescript
clientHooks: {
  onEvent(event, state) {
    if (event.type === 'player_scored') audioManager.play('score');
  },
},
```

### `SettingDefinition`

```typescript
interface SettingDefinition {
  key: string;
  label: string;
  type: 'range' | 'toggle' | 'select';
  default: number | boolean | string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
}
```

Values are stored in `RoomState.gameSettings` and passed to `createInitialState()` via `GameConfig.settings`.

### `AIAdapter<TState, TInput>`

Optional. If omitted, the framework sends empty inputs (`{}`) for every AI slot.

```typescript
interface AIAdapter<TState, TInput> {
  computeInput(state: TState, playerId: PlayerId): TInput;
}
```

`computeInput` is called once per AI slot per tick, **before** `tick()` runs. It may use `Math.random()` freely — it runs client-side only and does not affect determinism.

---

## Network Protocol

### Connection lifecycle

1. Client connects → server sends `{ type: 'connected', playerId: 0 }` (placeholder ack; slot is not yet assigned).
2. Client sends `{ type: 'join', name }`.
3. Client creates or joins a room → server sends `{ type: 'connected', playerId }` to that client only (actual slot), followed by a `room_update` broadcast to the room.
4. Game starts → server sends `{ type: 'connected', playerId }` again to each player individually (slot is stable but re-confirmed), then broadcasts `game_start`.

`connected` with a real `playerId` is always sent **to the specific client** whose slot is being communicated. It is never broadcast.

### Framework-owned messages

| Direction | Type | Payload | Purpose |
|-----------|------|---------|---------|
| C→S | `join` | `{ name }` | Send player name immediately after connect |
| C→S | `rename` | `{ name }` | Change display name |
| C→S | `create_room` | `{ gameId }` | Create a new room for a game |
| C→S | `join_room` | `{ code }` | Join an existing room by 5-char code |
| C→S | `leave_room` | — | Leave current room |
| C→S | `request_room_list` | — | Request list of open (unstarted) rooms |
| C→S | `ready` | — | Toggle ready state (not "set ready") |
| C→S | `start_game` | — | Host starts game; server validates all non-host players ready |
| C→S | `ping` | — | Keep-alive, sent every 1 s |
| S→C | `connected` | `{ playerId }` | Connection ack (placeholder `0`) on connect; real slot after create/join/start |
| S→C | `room_update` | `{ room: RoomState }` | Room state changed; sent to every member |
| S→C | `room_list` | `{ rooms: RoomState[] }` | Open rooms (response to `request_room_list`) |
| S→C | `error` | `{ message }` | Human-readable error string |
| S→C | `pong` | — | Response to ping |

### Game-level messages

| Direction | Type | Payload | Notes |
|-----------|------|---------|-------|
| C→S | `input` | `{ tick: number; input: TInput }` | Sent each frame by the input handler |
| S→C | `game_start` | `{ gameId: string; settings: Record<string, unknown> }` | Broadcast to room; no playerId (each player already received `connected` with their slot) |
| S→C | `state` | `{ tick: number; state: TState; events: GameEvent[] }` | Authoritative state, 60Hz |
| S→C | `game_over` | `{ winner: PlayerId \| null; scores: Record<PlayerId, number> }` | Sent when `isGameOver()` returns true |

---

## Room & Lobby System

`RoomManager` lives in `src/framework/server/lobby/rooms.ts`. Games never call it directly.

```typescript
interface RoomState {
  code: string;           // 5-char alphanumeric, e.g. "AB3XZ"
  gameId: string;
  name: string;           // Host's player name + "'s room"
  players: RoomPlayer[];  // 1–8 entries
  started: boolean;
  host: PlayerId;
  gameSettings: Record<string, unknown>;
}

interface RoomPlayer {
  id: PlayerId;
  name: string;
  ready: boolean;
  color: PlayerColor;
}
```

**Ready state**: `ready` is a per-player boolean that **toggles** on each `ready` message. The host's ready state is ignored by `canStart` — only non-host players must be ready. The framework enforces `minPlayers` before allowing start.

**Slot assignment**: Players are assigned slots 0–N in join order. Slots not filled by humans (up to `maxPlayers`) are AI.

---

## UI Screens

The framework owns all non-game screens. The player-facing flow is:

```
connecting → main_menu → browser → lobby → game → game_over
                                      ↑               |
                                      └───────────────┘  (Play Again)
```

| Screen | Owned by | Game provides |
|--------|----------|---------------|
| `connecting` | Framework | — |
| `main_menu` | Framework | `name`, `description` per registered game |
| `browser` | Framework | — (lists open rooms for selected game; auto-refreshes every 3 s) |
| `lobby` | Framework | `settings[]` rendered as form controls; `minPlayers` for start hint |
| `game` | Framework shell; game fills the canvas | `renderer.render()` |
| `game_over` | Framework | Winner from `getWinner()`; scores from `BasePlayer.score` |
| `how_to_play` | Framework | `howToPlay` HTML string |

### Browser screen behaviour

- Entered when a player selects a game from the main menu.
- Sends `request_room_list` immediately and then every 3 seconds while the screen is active; polls stop on navigation.
- Displays open rooms filtered to the selected `gameId`, with player count and room code.
- Provides a **Join by Code** input (Enter key submits).
- **+ Create Room** button in the header creates a room and navigates directly to the lobby.

### Lobby screen behaviour

- Entered when `room_update` arrives (create or join).
- Each player row shows: colour swatch · name · HOST / YOU badges · ready badge.
- **Ready / Unready** button shown to every non-host player; toggles on each click.
- **Start Game** button shown only to the host; disabled until `minPlayers` is met and all non-host players are ready. A hint explains why it is disabled.
- **Leave Room** returns to the browser screen for the same game.
- Server errors (full room, game not found, etc.) appear inline above the player list.

Games must not modify `src/framework/client/ui/manager.ts`. All customisation goes through `GameDefinition`.

---

## Player Colors

```typescript
const PLAYER_COLORS: Record<PlayerId, string> = {
  0: '#ffff00',  // P1 Yellow
  1: '#ffffff',  // P2 White
  2: '#ff4444',  // P3 Red
  3: '#4488ff',  // P4 Blue
  4: '#44ff88',  // P5 Green
  5: '#ff8844',  // P6 Orange
  6: '#ff44ff',  // P7 Magenta
  7: '#44ffff',  // P8 Cyan
};
```

Use `PLAYER_COLORS[playerId]` from `src/framework/shared/constants.ts`.

---

## Build Output

`build.mjs` produces three artefacts:

| Bundle | Output | Target |
|--------|--------|--------|
| Server | `dist/server.js` | Node.js 18 CJS |
| Client | `public/client.js` | Browser IIFE |
| Worker | `dist/worker/worker.js` | Cloudflare Worker ESM |

The client bundle is written to `public/` (not `dist/`) so the dev HTTP server can serve it as a static asset. The server resolves the `public/` directory relative to `process.cwd()`, so **always run the server from the project root**:

```
node dist/server.js        # correct — cwd is project root
node dist/server/server.js # wrong — cwd changes, public/ not found
```

---

## Building a New Game

### Step 1 — Copy the template

```
cp -r src/games/_template src/games/<game-id>
```

Rename every occurrence of `Template` / `template` in the copied files to match your game. The template files compile as-is and include inline TODOs for every decision point.

The directory structure is:

```
src/games/<game-id>/
  definition.ts   ← entry point; assemble all pieces here
  state.ts        ← TState interface + createInitialState
  input.ts        ← ActionSchema, defaultActionMap, TInput type
  engine.ts       ← tick(), isGameOver(), getWinner()
  renderer.ts     ← GameRenderer<TState> implementation
  constants.ts    ← game-specific magic numbers
  events.ts       ← (optional) typed GameEvent union
```

### Step 2 — Define state

```typescript
// src/games/<game-id>/state.ts
import type { BaseGameState, BasePlayer, GameConfig } from '../../framework/shared/types';

export interface MyGameState extends BaseGameState {
  players: (BasePlayer & { x: number; y: number; hp: number })[];
  items: Item[];
  timeRemaining: number;
}

export function createInitialState(config: GameConfig): MyGameState {
  return {
    tick: 0,
    phase: 'playing',
    players: config.playerIds.map((id, i) => ({
      id,
      name: config.playerNames[i],
      color: config.playerColors[i],
      score: 0,
      isAI: config.aiSlots.includes(id),
      connected: true,
      x: START_POSITIONS[i].x,
      y: START_POSITIONS[i].y,
      hp: 3,
    })),
    items: [],
    timeRemaining: 120,
  };
}
```

### Step 3 — Define inputs

```typescript
// src/games/<game-id>/input.ts
import type { ActionSchema, ActionMap } from '../../framework/shared/types';

export const actions: ActionSchema = {
  MOVE_LEFT:  { label: 'Move Left',  type: 'held' },
  MOVE_RIGHT: { label: 'Move Right', type: 'held' },
  JUMP:       { label: 'Jump',       type: 'press' },
};

export const defaultActionMap: ActionMap = {
  keyboard: {
    ArrowLeft: 'MOVE_LEFT',  KeyA: 'MOVE_LEFT',
    ArrowRight: 'MOVE_RIGHT', KeyD: 'MOVE_RIGHT',
    ArrowUp:   'JUMP',        KeyW: 'JUMP',
  },
};

export type MyInput = { MOVE_LEFT: boolean; MOVE_RIGHT: boolean; JUMP: boolean };
```

### Step 4 — Implement engine

`tick()` must be a **pure function**: same state + same inputs → same result. No random numbers unless seeded from `state.tick`. No I/O.

`dt` is in **seconds** (`0.01667` at 60Hz). Use it for velocity integration: `x += vx * dt`.

**State cloning**: `structuredClone` is correct but expensive at 60Hz. Prefer shallow spread with explicit cloning of mutated sub-objects:

```typescript
// Recommended pattern for performance-sensitive games
const next = {
  ...state,
  tick: state.tick + 1,
  players: state.players.map(p => ({ ...p })),
  // only deep-clone arrays/objects you actually mutate
};
```

**`isGameOver` / `getWinner`** are called on the post-tick state after the broadcast, in that order. Ensure all score mutations happen inside `tick()` before either function runs.

**Single-player edge case**: If `state.players.length === 1`, `getWinner` should return `state.players[0].id` directly rather than comparing against an undefined `sorted[1]`.

```typescript
// src/games/<game-id>/engine.ts
import type { TickResult } from '../../framework/shared/types';
import type { MyGameState } from './state';
import type { MyInput } from './input';

export function tick(
  state: MyGameState,
  inputs: Map<number, MyInput>,
  dt: number,
): TickResult<MyGameState> {
  const next = {
    ...state,
    tick: state.tick + 1,
    players: state.players.map(p => ({ ...p })),
  };
  const inp = inputs.get(next.players[0].id) ?? ({} as MyInput);
  // ... physics, collision, scoring ...
  return { state: next, events: [] };
}

export function isGameOver(state: MyGameState): boolean {
  return state.timeRemaining <= 0;
}

export function getWinner(state: MyGameState): number | null {
  if (state.players.length === 1) return state.players[0].id;
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  if (sorted[0].score === sorted[1].score) return null;
  return sorted[0].id;
}
```

### Step 5 — Implement renderer

Import `CANVAS_WIDTH`, `CANVAS_HEIGHT`, and `PLAYER_COLORS` from the framework barrel rather than hardcoding pixel values:

```typescript
// src/games/<game-id>/renderer.ts
import type { GameRenderer } from '../../framework/shared/types';
import { PLAYER_COLORS, CANVAS_WIDTH, CANVAS_HEIGHT } from '../../framework/shared/constants';
import type { MyGameState } from './state';

export const renderer: GameRenderer<MyGameState> = {
  render(ctx, state, myPlayerId) {
    for (const player of state.players) {
      ctx.fillStyle = PLAYER_COLORS[player.id];
      ctx.fillRect(player.x, player.y, 32, 32);
    }
  },
};
```

### Step 6 — Assemble definition

```typescript
// src/games/<game-id>/definition.ts
import type { GameDefinition } from '../../framework/shared/types';
import { createInitialState } from './state';
import { tick, isGameOver, getWinner } from './engine';
import { actions, defaultActionMap } from './input';
import { renderer } from './renderer';
import type { MyGameState } from './state';
import type { MyInput } from './input';

const definition: GameDefinition<MyGameState, MyInput> = {
  id: 'my-game',
  name: 'My Game',
  description: 'One sentence describing the game.',
  minPlayers: 2,
  maxPlayers: 4,
  actions,
  defaultActionMap,
  createInitialState,
  tick,
  isGameOver,
  getWinner,
  renderer,
  howToPlay: '<p>Use arrow keys to move. Last one standing wins.</p>',
  settings: [
    { key: 'gameDuration', label: 'Duration (s)', type: 'range', default: 120, min: 30, max: 300, step: 30 },
  ],
};

export default definition;
```

### Step 7 — Register the game

Edit **one file only**: `src/games/registry.ts`.

```typescript
// src/games/registry.ts
import tetrominoGame from './tetromino/definition';
import myGame from './my-game/definition'; // ← add this line

export const GAMES = [
  tetrominoGame,
  myGame,                                  // ← and this line
];
```

`registry.ts` is imported by all three entry points (`src/games/index.ts`, `src/server/main.ts`, `src/worker/worker.ts`). You never need to touch those files when adding a game.

### Step 8 — Verify

1. `npm run build` — TypeScript compiles with no errors; three bundles emitted.
2. `node dist/server.js` from project root — server starts on port 3000.
3. Open `http://localhost:3000` — main menu shows your game.
4. Click the game → browser screen shows (empty lobby list is fine).
5. Click **+ Create Room** → lobby screen shows; room code visible.
6. Open a second tab, navigate to the browser screen, click **Join** or enter the code.
7. Both players are shown with correct names and colour swatches.
8. Non-host clicks **Ready** → badge updates for both tabs.
9. Host clicks **Start Game** → game screen appears on both tabs.
10. Both tabs show matching state each tick.
11. Close one tab → that slot switches to AI, game continues.
12. Game over → scores show with player names → **Play Again** returns to browser; **Main Menu** returns to game list.

---

## `GameConfig` passed to `createInitialState`

```typescript
interface GameConfig {
  gameId: string;
  roomCode: string;
  playerIds: PlayerId[];       // Human player slots, in join order
  playerNames: string[];       // Index-matched to playerIds
  playerColors: PlayerColor[]; // Index-matched to playerIds
  aiSlots: PlayerId[];         // Slots filled by AI (up to maxPlayers)
  settings: Record<string, unknown>;
}
```

---

## Constraints

- `tick()` must be a pure function (no side effects, no I/O, no `Math.random()`).
- `TState` must be JSON-serializable (no functions, no class instances, no circular refs).
- `TInput` values must be `boolean` or `number` only.
- `renderer.render()` runs in the browser only. Never import renderer files from server entry points.
- `createInitialState()`, `tick()`, `isGameOver()`, `getWinner()` run on both server and in-browser. Never reference `window`, `document`, or any browser API in these functions.
- Canvas size is configurable via `canvasSize` in `GameDefinition`. Default is **800×600**.
- `maxPlayers` must be between 2 and 8 inclusive.
- `minPlayers` may be 1 (solo play). Handle the single-player case in `getWinner()`.

---

## Round-Based Games

Games with multiple rounds extend `phase` beyond the base two values. The framework keeps ticking as long as `isGameOver()` returns false, regardless of phase.

```typescript
export interface MyGameState extends BaseGameState {
  phase: 'playing' | 'round_end' | 'game_over';
  round: number;
  roundWinner: PlayerId | null;
  scores: Record<PlayerId, number>;
}
```

**Recommended pattern**:

1. Detect round-end in `tick()`: set `phase = 'round_end'`, record winner.
2. Count down `roundEndTimer` each tick while `phase === 'round_end'`.
3. When timer expires: reset per-round state, increment `round`, set `phase = 'playing'`.
4. `isGameOver()` checks overall win condition (e.g. `scores[id] >= 3`).

The renderer reads `phase` to show a round-end overlay. No extra framework hooks needed.

---

## Reference Implementation: Tetromino Battle

`src/games/tetromino/` is the canonical example. Key things to study:

| File | What to learn |
|------|---------------|
| `state.ts` | Per-player board as a 2D array; deterministic seed pattern |
| `engine.ts` | Shallow clone of large state; `inputs.get(id) ?? {}` default; `isGameOver` with single-player guard |
| `renderer.ts` | 2×2 panel layout for 4 players; ghost piece; mini-piece previews |
| `input.ts` | Mix of `held` (soft drop) and `press` (rotate, hard drop) actions |
| `events.ts` | Typed event union: `lines_cleared`, `player_dead` |

---

## Framework Utilities

### Import paths

All framework types, constants, and utilities can be imported from the barrel:

```typescript
// Preferred — single import for everything
import type { GameDefinition, BaseGameState, PlayerId } from '../../framework';
import { CANVAS_WIDTH, CANVAS_HEIGHT, PLAYER_COLORS, clamp, seededRandom } from '../../framework';
```

Or import from the specific sub-modules if you prefer explicit paths:

```typescript
import type { GameDefinition } from '../../framework/shared/types';
import { CANVAS_WIDTH }        from '../../framework/shared/constants';
import { clamp }               from '../../framework/shared/utils';
```

---

From `src/framework/shared/utils.ts`:

```typescript
clamp(value: number, min: number, max: number): number
lerp(a: number, b: number, t: number): number
dist(x1: number, y1: number, x2: number, y2: number): number
angleBetween(x1: number, y1: number, x2: number, y2: number): number
normalizeAngle(angle: number): number  // → 0..2π

generateRoomCode(): string  // 5-char alphanumeric

// Deterministic PRNG — SAFE inside tick().
// Vary the seed per entity to avoid correlation:
//   seededRandom(state.tick * 7 + entityId * 13)
seededRandom(seed: number): number

// Non-deterministic — NOT safe inside tick().
// Use only in renderer, clientHooks, or aiAdapter.computeInput().
randomRange(min: number, max: number): number
randomInt(min: number, max: number): number
```

From `src/framework/shared/constants.ts`:

```typescript
CANVAS_WIDTH  = 800
CANVAS_HEIGHT = 600
TICK_MS       = 16.667   // 60Hz
MAX_PLAYERS   = 8
PLAYER_COLORS: Record<PlayerId, string>
```

---

## Cloudflare Deployment

The Node.js dev server uses `setInterval` for the 60Hz game loop inside `GameRunner`. Cloudflare Durable Objects **fully support persistent `setInterval`** — the DO actor stays alive as long as it has active WebSocket connections, and timers fire normally within the actor's execution context.

The same `GameRunner` from `framework/server/engine/runner.ts` runs identically on both the Node.js dev server and the Cloudflare Worker. No code changes are needed between environments.

The `worker/worker.ts` entry defines a `GameServer` Durable Object class that hosts WebSocket connections and game runners. A Worker-level fetch handler routes all requests to the single `GameServer` instance via `idFromName('main')`. This ensures all players connect to the same persistent actor regardless of which Cloudflare edge node handles their request.

```
┌─────────────────────────────────────┐
│  Cloudflare Pages (static)          │
│  serves public/index.html + client.js│
├─────────────────────────────────────┤
│  Cloudflare Worker (HTTP handler)   │
│  routes /ws → GameServer DO         │
│  routes /keepalive → 200 OK         │
├─────────────────────────────────────┤
│  Durable Object: GameServer         │
│  - persistent state                 │
│  - WebSocket connections            │
│  - GameRunner with setInterval      │
│  - RoomManager                      │
└─────────────────────────────────────┘
```

The rest of the framework (message routing, room management, game logic) is environment-agnostic and works identically in both runtimes.

---

## Testing

E2E integration tests live in `test-e2e.cjs` and run against the deployed Worker by default:

```bash
npm test                # against deployed Worker
npm run test:verbose    # logs every WebSocket message
WORKER_URL=ws://localhost:3000/ws npm test  # against local server
```

10 tests covering: connection, room creation/listing/joining, ready/start flow, state broadcasting, player input, leave room, ping/pong, and error handling.

Tests are zero-dependency (uses `ws` and `node:assert`), each creates its own WebSocket connections, and the `setupGame()` helper creates a ready-to-play game session so each test focuses on what it verifies.
