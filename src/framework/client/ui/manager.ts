import type { GameDefinition, BaseGameState, BaseInput, PlayerId, RoomState, ServerMessage } from '../../shared/types';
import { CANVAS_WIDTH, CANVAS_HEIGHT } from '../../shared/constants';
import { GameWebSocket } from '../network/ws';
import { InputHandler } from '../input/handler';

type Screen = 'connecting' | 'main_menu' | 'browser' | 'lobby' | 'game' | 'game_over';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const gameRegistry = new Map<string, GameDefinition<any, any>>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerClientGame(def: GameDefinition<any, any>): void {
  gameRegistry.set(def.id, def);
}

export class UIManager {
  private screen: Screen = 'connecting';
  private socket: GameWebSocket;
  private input = new InputHandler();
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private root: HTMLElement;

  private myPlayerId: PlayerId = 0;
  private currentRoom: RoomState | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private currentGame: GameDefinition<any, any> | null = null;
  private latestState: BaseGameState | null = null;
  private gameOverData: { winner: PlayerId | null; scores: Record<PlayerId, number> } | null = null;
  private rafId: number | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private roomListInterval: ReturnType<typeof setInterval> | null = null;

  // Browser screen state
  private browsedGameId: string = '';
  private openRooms: RoomState[] = [];
  private errorMessage: string = '';

  constructor(root: HTMLElement) {
    this.root = root;
    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_WIDTH;
    this.canvas.height = CANVAS_HEIGHT;
    this.ctx = this.canvas.getContext('2d')!;
    this.socket = new GameWebSocket();
  }

  start(): void {
    this.socket.connect();
    this.socket.onMessage(msg => this.handleMessage(msg));
    this.pingInterval = setInterval(() => this.socket.send({ type: 'ping' }), 1000);
    this.renderUI();
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'connected':
        this.myPlayerId = msg.playerId;
        if (this.screen === 'connecting') {
          this.socket.send({ type: 'join', name: this.getStoredName() });
          this.setScreen('main_menu');
        }
        break;

      case 'room_list':
        this.openRooms = msg.rooms;
        if (this.screen === 'browser') this.renderUI();
        break;

      case 'room_update':
        this.currentRoom = msg.room;
        this.errorMessage = '';
        if (this.screen !== 'game') this.setScreen('lobby');
        break;

      case 'error':
        this.errorMessage = msg.message;
        this.renderUI();
        break;

       case 'game_start':
         this.currentGame = gameRegistry.get(msg.gameId) ?? null;
         if (this.currentGame) {
           if (this.currentGame.canvasSize) {
             this.canvas.width = this.currentGame.canvasSize.width;
             this.canvas.height = this.currentGame.canvasSize.height;
           }
           this.input.init(this.currentGame.actions, this.currentGame.defaultActionMap);
           this.input.attach();
           if (this.currentGame.renderer.init) this.currentGame.renderer.init(this.canvas);
         }
         this.myPlayerId = msg.playerId;
         this.stopRoomListPolling();
         this.setScreen('game');
         this.startGameLoop();
         break;

      case 'state':
        this.latestState = msg.state;
        if (this.currentGame?.clientHooks?.onEvent && msg.events?.length) {
          for (const ev of msg.events) this.currentGame.clientHooks.onEvent(ev, msg.state);
        }
        break;

      case 'game_over':
        this.gameOverData = { winner: msg.winner, scores: msg.scores };
        if (this.currentGame?.clientHooks?.onGameOver) {
          this.currentGame.clientHooks.onGameOver(msg.winner, msg.scores);
        }
        this.stopGameLoop();
        this.input.detach();
        this.setScreen('game_over');
        break;
    }
  }

  private startGameLoop(): void {
    let lastSentInput = '';
    const loop = (): void => {
      if (this.screen !== 'game') return;
      if (this.latestState && this.currentGame) {
        const input = this.input.getInput();
        const serialized = JSON.stringify(input);
        if (serialized !== lastSentInput) {
          this.socket.send({ type: 'input', tick: this.latestState.tick, input });
          lastSentInput = serialized;
        }
        this.input.flush();
        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        this.currentGame.renderer.render(this.ctx, this.latestState, this.myPlayerId);
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private stopGameLoop(): void {
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
  }

  private startRoomListPolling(): void {
    this.socket.send({ type: 'request_room_list' });
    this.roomListInterval = setInterval(() => {
      this.socket.send({ type: 'request_room_list' });
    }, 3000);
  }

  private stopRoomListPolling(): void {
    if (this.roomListInterval !== null) {
      clearInterval(this.roomListInterval);
      this.roomListInterval = null;
    }
  }

  private setScreen(s: Screen): void {
    if (this.screen === 'browser' && s !== 'browser') this.stopRoomListPolling();
    this.screen = s;
    if (s === 'browser') this.startRoomListPolling();
    this.renderUI();
  }

  private renderUI(): void {
    this.root.innerHTML = '';

    switch (this.screen) {
      case 'connecting':
        this.root.appendChild(el('div', { className: 'screen center' }, [
          el('p', { className: 'muted' }, ['Connecting to server…']),
        ]));
        break;
      case 'main_menu':
        this.renderMainMenu();
        break;
      case 'browser':
        this.renderBrowser();
        break;
      case 'lobby':
        this.renderLobby();
        break;
      case 'game':
        this.root.appendChild(this.canvas);
        break;
      case 'game_over':
        this.renderGameOver();
        break;
    }
  }

  // ─── Screens ──────────────────────────────────────────────────────────────

  private renderMainMenu(): void {
    const games = [...gameRegistry.values()];

    const nameRow = el('div', { className: 'name-row' }, [
      el('label', {}, [
        'Your name ',
        (() => {
          const inp = document.createElement('input');
          inp.maxLength = 16;
          inp.value = this.getStoredName();
          inp.addEventListener('change', () => {
            localStorage.setItem('playerName', inp.value.trim() || 'Player');
            this.socket.send({ type: 'rename', name: inp.value.trim() || 'Player' });
          });
          return inp;
        })(),
      ]),
    ]);

    const gameList = el('div', { className: 'game-list' }, games.map(def =>
      el('div', { className: 'game-card' }, [
        el('div', { className: 'game-card-body' }, [
          el('h2', {}, [def.name]),
          el('p', { className: 'muted' }, [def.description]),
        ]),
        el('button', {
          className: 'btn-primary',
          onclick: () => {
            this.browsedGameId = def.id;
            this.openRooms = [];
            this.errorMessage = '';
            this.setScreen('browser');
          },
        }, ['Play']),
      ])
    ));

    this.root.appendChild(el('div', { className: 'screen main-menu' }, [
      el('h1', {}, ['Cinematic Bazaar']),
      nameRow,
      gameList,
    ]));
  }

  private renderBrowser(): void {
    const def = gameRegistry.get(this.browsedGameId);
    const rooms = this.openRooms.filter(r => r.gameId === this.browsedGameId);

    // Room list or empty state
    const listContent: HTMLElement[] = rooms.length > 0
      ? rooms.map(room => {
          const maxPlayers = def?.maxPlayers ?? 8;
          const isFull = room.players.length >= maxPlayers;
          return el('div', { className: 'room-row' }, [
            el('div', { className: 'room-info' }, [
              el('span', { className: 'room-name' }, [room.name]),
              el('span', { className: 'room-meta' }, [
                `${room.players.length}/${maxPlayers} players`,
                el('span', { className: 'room-code' }, [room.code]),
              ]),
            ]),
            el('button', {
              className: isFull ? 'btn-disabled' : 'btn-secondary',
              disabled: isFull,
              onclick: () => {
                this.socket.send({ type: 'join_room', code: room.code });
              },
            }, [isFull ? 'Full' : 'Join']),
          ]);
        })
      : [el('p', { className: 'empty-state' }, ['No open lobbies. Create one!'])];

    // Join by code
    let codeInput: HTMLInputElement;
    const joinByCode = el('div', { className: 'join-code-row' }, [
      (() => {
        codeInput = document.createElement('input');
        codeInput.placeholder = 'Room code';
        codeInput.maxLength = 5;
        codeInput.className = 'code-input';
        codeInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') joinByCodeFn();
        });
        return codeInput;
      })(),
      el('button', {
        className: 'btn-secondary',
        onclick: () => joinByCodeFn(),
      }, ['Join by Code']),
    ]);

    const joinByCodeFn = (): void => {
      const code = codeInput!.value.trim().toUpperCase();
      if (code.length !== 5) { this.errorMessage = 'Room codes are 5 characters.'; this.renderUI(); return; }
      this.socket.send({ type: 'join_room', code });
    };

    const errorEl = this.errorMessage
      ? el('p', { className: 'error-msg' }, [this.errorMessage])
      : null;

    const howToPlayBtn = def?.howToPlay
      ? el('button', {
          className: 'btn-secondary',
          onclick: () => this.showHowToPlay(def.howToPlay!),
        }, ['? How to Play'])
      : null;

    this.root.appendChild(el('div', { className: 'screen browser' }, [
      el('div', { className: 'browser-header' }, [
        el('button', {
          className: 'btn-back',
          onclick: () => { this.errorMessage = ''; this.setScreen('main_menu'); },
        }, ['← Back']),
        el('h1', {}, [def?.name ?? 'Game']),
        el('div', { className: 'browser-header-actions' }, [
          ...(howToPlayBtn ? [howToPlayBtn] : []),
          el('button', {
            className: 'btn-primary',
            onclick: () => this.socket.send({ type: 'create_room', gameId: this.browsedGameId }),
          }, ['+ Create Room']),
        ]),
      ]),
      ...(errorEl ? [errorEl] : []),
      el('div', { className: 'room-list' }, [
        el('div', { className: 'section-label' }, [
          'Open Lobbies',
          el('span', { className: 'refresh-note' }, [' (refreshes every 3s)']),
        ]),
        ...listContent,
      ]),
      el('div', { className: 'divider' }, ['— or join by code —']),
      joinByCode,
    ]));
  }

  private renderLobby(): void {
    const room = this.currentRoom;
    if (!room) return;

    const def = gameRegistry.get(room.gameId);
    const maxPlayers = def?.maxPlayers ?? 8;
    const me = room.players.find(p => p.id === this.myPlayerId);
    const isHost = room.host === this.myPlayerId;
    const allNonHostReady = room.players.filter(p => p.id !== room.host).every(p => p.ready);
    const canStart = isHost && room.players.length >= (def?.minPlayers ?? 2) && allNonHostReady;

    // Player rows
    const playerRows = room.players.map(p => {
      const isMe = p.id === this.myPlayerId;
      const hostBadge = p.id === room.host ? el('span', { className: 'badge badge-host' }, ['HOST']) : null;
      const meBadge = isMe ? el('span', { className: 'badge badge-me' }, ['YOU']) : null;
      const readyBadge = p.id === room.host
        ? el('span', { className: 'badge badge-neutral' }, ['—'])
        : el('span', { className: `badge ${p.ready ? 'badge-ready' : 'badge-waiting'}` }, [p.ready ? '✓ Ready' : '… Waiting']);

      return el('div', { className: `player-row${isMe ? ' player-row-me' : ''}` }, [
        el('span', { className: 'player-swatch', style: `background:${PLAYER_COLORS[p.id]}` }, []),
        el('span', { className: 'player-name' }, [p.name]),
        el('span', { className: 'player-badges' }, [
          ...(hostBadge ? [hostBadge] : []),
          ...(meBadge ? [meBadge] : []),
          readyBadge,
        ]),
      ]);
    });

    // Action buttons
    const actions: HTMLElement[] = [];

    // Ready / Unready — everyone except host
    if (me && !isHost) {
      actions.push(el('button', {
        className: me.ready ? 'btn-secondary' : 'btn-primary',
        onclick: () => this.socket.send({ type: 'ready' }),
      }, [me.ready ? 'Unready' : 'Ready']));
    }

    // Start — host only
    if (isHost) {
      const startBtn = el('button', {
        className: canStart ? 'btn-primary' : 'btn-disabled',
        disabled: !canStart,
        onclick: () => { if (canStart) this.socket.send({ type: 'start_game' }); },
      }, ['Start Game']) as HTMLButtonElement;
      actions.push(startBtn);

      if (!canStart) {
        const hint = room.players.length < (def?.minPlayers ?? 2)
          ? `Need at least ${def?.minPlayers ?? 2} players`
          : 'Waiting for all players to ready up';
        actions.push(el('p', { className: 'muted hint' }, [hint]));
      }
    }

    actions.push(el('button', {
      className: 'btn-danger',
      onclick: () => {
        this.socket.send({ type: 'leave_room' });
        this.currentRoom = null;
        this.errorMessage = '';
        // Go back to browser if we know the game, otherwise main menu
        if (this.browsedGameId) {
          this.setScreen('browser');
        } else {
          this.setScreen('main_menu');
        }
      },
    }, ['Leave Room']));

    const errorEl = this.errorMessage
      ? el('p', { className: 'error-msg' }, [this.errorMessage])
      : null;

    this.root.appendChild(el('div', { className: 'screen lobby' }, [
      el('div', { className: 'lobby-header' }, [
        el('div', {}, [
          el('h1', {}, [room.name]),
          el('p', { className: 'muted' }, [`${def?.name ?? ''} · ${room.players.length}/${maxPlayers} players`]),
        ]),
        el('div', { className: 'room-code-display' }, [
          el('span', { className: 'code-label' }, ['Room Code']),
          el('span', { className: 'code-value' }, [room.code]),
        ]),
      ]),
      ...(errorEl ? [errorEl] : []),
      el('div', { className: 'player-list' }, playerRows),
      ...(isHost && def?.settings?.length ? [this.renderSettings(def.settings, room.gameSettings)] : []),
      el('div', { className: 'lobby-actions' }, actions),
    ]));
  }

  private renderSettings(
    defs: import('../../shared/types').SettingDefinition[],
    current: Record<string, unknown>,
  ): HTMLElement {
    const rows = defs.map(s => {
      let control: HTMLElement;

      if (s.type === 'range') {
        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(s.min ?? 0);
        input.max = String(s.max ?? 100);
        input.step = String(s.step ?? 1);
        input.value = String(current[s.key] ?? s.default);
        const valueLabel = document.createElement('span');
        valueLabel.className = 'setting-value';
        valueLabel.textContent = input.value;
        input.addEventListener('input', () => {
          valueLabel.textContent = input.value;
        });
        input.addEventListener('change', () => {
          this.socket.send({ type: 'update_settings', settings: { [s.key]: Number(input.value) } });
        });
        const wrap = document.createElement('div');
        wrap.className = 'setting-range-wrap';
        wrap.appendChild(input);
        wrap.appendChild(valueLabel);
        control = wrap;

      } else if (s.type === 'toggle') {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'setting-toggle';
        input.checked = Boolean(current[s.key] ?? s.default);
        input.addEventListener('change', () => {
          this.socket.send({ type: 'update_settings', settings: { [s.key]: input.checked } });
        });
        control = input;

      } else {
        const select = document.createElement('select');
        select.className = 'setting-select';
        for (const opt of s.options ?? []) {
          const o = document.createElement('option');
          o.value = opt;
          o.textContent = opt;
          if (opt === String(current[s.key] ?? s.default)) o.selected = true;
          select.appendChild(o);
        }
        select.addEventListener('change', () => {
          this.socket.send({ type: 'update_settings', settings: { [s.key]: select.value } });
        });
        control = select;
      }

      return el('div', { className: 'setting-row' }, [
        el('label', { className: 'setting-label' }, [s.label]),
        control,
      ]);
    });

    return el('div', { className: 'settings-panel' }, [
      el('div', { className: 'section-label' }, ['Game Settings']),
      ...rows,
    ]);
  }

  private renderGameOver(): void {
    const data = this.gameOverData;
    const room = this.currentRoom;

    let winnerText = 'Game Over';
    if (data) {
      if (data.winner !== null) {
        const winnerPlayer = room?.players.find(p => p.id === data.winner);
        winnerText = `${winnerPlayer?.name ?? `Player ${data.winner + 1}`} wins!`;
      } else {
        winnerText = 'Draw!';
      }
    }

    const scoreRows = data
      ? Object.entries(data.scores)
          .sort(([, a], [, b]) => (b as number) - (a as number))
          .map(([pid, score]) => {
            const player = room?.players.find(p => p.id === Number(pid));
            return el('div', { className: 'score-row' }, [
              el('span', { className: 'player-swatch', style: `background:${PLAYER_COLORS[Number(pid) as PlayerId]}` }, []),
              el('span', {}, [player?.name ?? `Player ${Number(pid) + 1}`]),
              el('span', { className: 'score-value' }, [String(score)]),
            ]);
          })
      : [];

    this.root.appendChild(el('div', { className: 'screen game-over' }, [
      el('h1', {}, [winnerText]),
      ...(scoreRows.length ? [el('div', { className: 'score-list' }, scoreRows)] : []),
      el('div', { className: 'game-over-actions' }, [
        el('button', {
          className: 'btn-primary',
          onclick: () => {
            this.latestState = null;
            this.gameOverData = null;
            this.currentGame = null;
            this.currentRoom = null;
            this.errorMessage = '';
            this.setScreen('browser');
          },
        }, ['Play Again']),
        el('button', {
          className: 'btn-secondary',
          onclick: () => {
            this.latestState = null;
            this.gameOverData = null;
            this.currentGame = null;
            this.currentRoom = null;
            this.browsedGameId = '';
            this.errorMessage = '';
            this.setScreen('main_menu');
          },
        }, ['Main Menu']),
      ]),
    ]));
  }

  private showHowToPlay(html: string): void {
    const overlay = el('div', { className: 'htp-overlay' }, [
      el('div', { className: 'htp-dialog' }, [
        el('div', { className: 'htp-header' }, [
          el('h2', {}, ['How to Play']),
          el('button', { className: 'btn-back', onclick: () => overlay.remove() }, ['✕ Close']),
        ]),
        (() => {
          const body = document.createElement('div');
          body.className = 'htp-body';
          body.innerHTML = html;
          return body;
        })(),
      ]),
    ]);
    this.root.appendChild(overlay);
  }

  private getStoredName(): string {
    return localStorage.getItem('playerName') ?? 'Player';
  }
}

// ─── Player color hex table (mirrors server constants) ────────────────────────

const PLAYER_COLORS: Record<number, string> = {
  0: '#ffff00',
  1: '#ffffff',
  2: '#ff4444',
  3: '#4488ff',
  4: '#44ff88',
  5: '#ff8844',
  6: '#ff44ff',
  7: '#44ffff',
};

// ─── DOM helpers ──────────────────────────────────────────────────────────────

type Attrs = Record<string, string | boolean | (() => void) | null | undefined>;
type Child = HTMLElement | string | null | undefined;

function el(tag: string, attrs: Attrs, children: Child[] = []): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'onclick') { node.addEventListener('click', v as () => void); }
    else if (k === 'disabled') { if (v) (node as HTMLButtonElement).disabled = true; }
    else if (k === 'className') { node.className = v as string; }
    else if (k === 'style') { node.setAttribute('style', v as string); }
    else { node.setAttribute(k, String(v)); }
  }
  for (const child of children) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}
