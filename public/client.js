"use strict";
(() => {
  // src/framework/shared/constants.ts
  var CANVAS_WIDTH = 800;
  var CANVAS_HEIGHT = 600;
  var TICK_MS = 1e3 / 60;
  var PLAYER_COLORS = {
    0: "#ffff00",
    1: "#ffffff",
    2: "#ff4444",
    3: "#4488ff",
    4: "#44ff88",
    5: "#ff8844",
    6: "#ff44ff",
    7: "#44ffff"
  };

  // src/framework/client/network/ws.ts
  var GameWebSocket = class {
    ws = null;
    queue = [];
    handlers = [];
    primaryUrl;
    reconnectDelay = 1e3;
    fallbackUsed = false;
    constructor(url) {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      if (url) {
        this.primaryUrl = url;
      } else {
        const meta = document.querySelector('meta[name="cinematic-bazaar-ws"]');
        const metaUrl = meta?.getAttribute("content");
        this.primaryUrl = metaUrl ?? `${proto}://${location.host}/ws`;
      }
    }
    connect() {
      const urlToTry = this.fallbackUsed ? "ws://localhost:3000/ws" : this.primaryUrl;
      console.log(`[WebSocket] Attempting to connect to ${urlToTry}...`);
      this.ws = new WebSocket(urlToTry);
      this.ws.onopen = () => {
        console.log(`[WebSocket] Connected to ${urlToTry}`);
        this.reconnectDelay = 1e3;
        this.fallbackUsed = false;
        for (const msg of this.queue)
          this.rawSend(msg);
        this.queue = [];
      };
      this.ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        for (const h of this.handlers)
          h(msg);
      };
      this.ws.onerror = () => {
        console.error(`[WebSocket] Connection error on ${urlToTry}`);
      };
      this.ws.onclose = (event) => {
        console.warn(`[WebSocket] Connection closed. Code: ${event.code}, Reason: ${event.reason || "None"}`);
        if (!this.fallbackUsed && urlToTry !== "ws://localhost:3000/ws") {
          console.log(`[WebSocket] Primary connection failed. Attempting fallback to localhost:3000...`);
          this.fallbackUsed = true;
          this.connect();
        } else {
          console.log(`[WebSocket] Retrying in ${this.reconnectDelay}ms...`);
          setTimeout(() => this.connect(), this.reconnectDelay);
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 1e4);
        }
      };
    }
    send(msg) {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.rawSend(msg);
      } else {
        this.queue.push(msg);
      }
    }
    onMessage(handler) {
      this.handlers.push(handler);
      return () => {
        this.handlers = this.handlers.filter((h) => h !== handler);
      };
    }
    rawSend(msg) {
      this.ws?.send(JSON.stringify(msg));
    }
  };

  // src/framework/client/input/handler.ts
  var InputHandler = class {
    heldKeys = /* @__PURE__ */ new Set();
    pressedKeys = /* @__PURE__ */ new Set();
    schema = {};
    actionMap = { keyboard: {} };
    wheelActions = {};
    init(schema, actionMap) {
      this.schema = schema;
      this.actionMap = actionMap;
      this.wheelActions = actionMap.mouseWheel ?? {};
    }
    attach() {
      window.addEventListener("keydown", this.onKeyDown);
      window.addEventListener("keyup", this.onKeyUp);
      window.addEventListener("wheel", this.onWheel, { passive: true });
    }
    detach() {
      window.removeEventListener("keydown", this.onKeyDown);
      window.removeEventListener("keyup", this.onKeyUp);
      window.removeEventListener("wheel", this.onWheel);
      this.heldKeys.clear();
      this.pressedKeys.clear();
    }
    onKeyDown = (e) => {
      this.heldKeys.add(e.code);
      this.pressedKeys.add(e.code);
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) {
        e.preventDefault();
      }
    };
    onKeyUp = (e) => {
      this.heldKeys.delete(e.code);
    };
    onWheel = (e) => {
      if (e.deltaY < 0 && this.wheelActions.up)
        this.pressedKeys.add("__wheel_up__");
      if (e.deltaY > 0 && this.wheelActions.down)
        this.pressedKeys.add("__wheel_down__");
    };
    // Call once per frame after sending input to consume press events
    flush() {
      this.pressedKeys.clear();
    }
    getInput() {
      const input = {};
      const km = this.actionMap.keyboard;
      for (const [code, action] of Object.entries(km)) {
        const desc = this.schema[action];
        if (!desc)
          continue;
        if (desc.type === "held" && this.heldKeys.has(code)) {
          input[action] = true;
        } else if (desc.type === "press" && this.pressedKeys.has(code)) {
          input[action] = true;
        }
      }
      if (this.wheelActions.up && this.pressedKeys.has("__wheel_up__"))
        input[this.wheelActions.up] = true;
      if (this.wheelActions.down && this.pressedKeys.has("__wheel_down__"))
        input[this.wheelActions.down] = true;
      return input;
    }
  };

  // src/framework/client/ui/manager.ts
  var gameRegistry = /* @__PURE__ */ new Map();
  function registerClientGame(def) {
    gameRegistry.set(def.id, def);
  }
  var UIManager = class {
    screen = "connecting";
    socket;
    input = new InputHandler();
    canvas;
    ctx;
    root;
    myPlayerId = 0;
    currentRoom = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    currentGame = null;
    latestState = null;
    gameOverData = null;
    rafId = null;
    pingInterval = null;
    roomListInterval = null;
    // Browser screen state
    browsedGameId = "";
    openRooms = [];
    errorMessage = "";
    constructor(root2) {
      this.root = root2;
      this.canvas = document.createElement("canvas");
      this.canvas.width = CANVAS_WIDTH;
      this.canvas.height = CANVAS_HEIGHT;
      this.ctx = this.canvas.getContext("2d");
      this.socket = new GameWebSocket();
    }
    start() {
      this.socket.connect();
      this.socket.onMessage((msg) => this.handleMessage(msg));
      this.pingInterval = setInterval(() => this.socket.send({ type: "ping" }), 1e3);
      this.renderUI();
    }
    handleMessage(msg) {
      switch (msg.type) {
        case "connected":
          this.myPlayerId = msg.playerId;
          if (this.screen === "connecting") {
            this.socket.send({ type: "join", name: this.getStoredName() });
            this.setScreen("main_menu");
          }
          break;
        case "room_list":
          this.openRooms = msg.rooms;
          if (this.screen === "browser")
            this.renderUI();
          break;
        case "room_update":
          this.currentRoom = msg.room;
          this.errorMessage = "";
          if (this.screen !== "game")
            this.setScreen("lobby");
          break;
        case "error":
          this.errorMessage = msg.message;
          this.renderUI();
          break;
        case "game_start": {
          this.currentGame = gameRegistry.get(msg.gameId) ?? null;
          if (this.currentGame) {
            if (this.currentGame.canvasSize) {
              this.canvas.width = this.currentGame.canvasSize.width;
              this.canvas.height = this.currentGame.canvasSize.height;
            }
            this.input.init(this.currentGame.actions, this.currentGame.defaultActionMap);
            this.input.attach();
            if (this.currentGame.renderer.init)
              this.currentGame.renderer.init(this.canvas);
          }
          this.stopRoomListPolling();
          this.setScreen("game");
          this.startGameLoop();
          break;
        }
        case "state":
          this.latestState = msg.state;
          if (this.currentGame?.clientHooks?.onEvent && msg.events?.length) {
            for (const ev of msg.events)
              this.currentGame.clientHooks.onEvent(ev, msg.state);
          }
          break;
        case "game_over":
          this.gameOverData = { winner: msg.winner, scores: msg.scores };
          if (this.currentGame?.clientHooks?.onGameOver) {
            this.currentGame.clientHooks.onGameOver(msg.winner, msg.scores);
          }
          this.stopGameLoop();
          this.input.detach();
          this.setScreen("game_over");
          break;
      }
    }
    startGameLoop() {
      let lastSentInput = "";
      const loop = () => {
        if (this.screen !== "game")
          return;
        if (this.latestState && this.currentGame) {
          const input = this.input.getInput();
          const serialized = JSON.stringify(input);
          if (serialized !== lastSentInput) {
            this.socket.send({ type: "input", tick: this.latestState.tick, input });
            lastSentInput = serialized;
          }
          this.input.flush();
          this.ctx.fillStyle = "#000";
          this.ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
          this.currentGame.renderer.render(this.ctx, this.latestState, this.myPlayerId);
        }
        this.rafId = requestAnimationFrame(loop);
      };
      this.rafId = requestAnimationFrame(loop);
    }
    stopGameLoop() {
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
    }
    startRoomListPolling() {
      this.socket.send({ type: "request_room_list" });
      this.roomListInterval = setInterval(() => {
        this.socket.send({ type: "request_room_list" });
      }, 3e3);
    }
    stopRoomListPolling() {
      if (this.roomListInterval !== null) {
        clearInterval(this.roomListInterval);
        this.roomListInterval = null;
      }
    }
    setScreen(s) {
      if (this.screen === "browser" && s !== "browser")
        this.stopRoomListPolling();
      this.screen = s;
      if (s === "browser")
        this.startRoomListPolling();
      this.renderUI();
    }
    renderUI() {
      this.root.innerHTML = "";
      switch (this.screen) {
        case "connecting":
          this.root.appendChild(el("div", { className: "screen center" }, [
            el("p", { className: "muted" }, ["Connecting to server\u2026"])
          ]));
          break;
        case "main_menu":
          this.renderMainMenu();
          break;
        case "browser":
          this.renderBrowser();
          break;
        case "lobby":
          this.renderLobby();
          break;
        case "game":
          this.root.appendChild(this.canvas);
          break;
        case "game_over":
          this.renderGameOver();
          break;
      }
    }
    // ─── Screens ──────────────────────────────────────────────────────────────
    renderMainMenu() {
      const games = [...gameRegistry.values()];
      const nameRow = el("div", { className: "name-row" }, [
        el("label", {}, [
          "Your name ",
          (() => {
            const inp = document.createElement("input");
            inp.maxLength = 16;
            inp.value = this.getStoredName();
            inp.addEventListener("change", () => {
              localStorage.setItem("playerName", inp.value.trim() || "Player");
              this.socket.send({ type: "rename", name: inp.value.trim() || "Player" });
            });
            return inp;
          })()
        ])
      ]);
      const gameList = el("div", { className: "game-list" }, games.map(
        (def) => el("div", { className: "game-card" }, [
          el("div", { className: "game-card-body" }, [
            el("h2", {}, [def.name]),
            el("p", { className: "muted" }, [def.description])
          ]),
          el("button", {
            className: "btn-primary",
            onclick: () => {
              this.browsedGameId = def.id;
              this.openRooms = [];
              this.errorMessage = "";
              this.setScreen("browser");
            }
          }, ["Play"])
        ])
      ));
      this.root.appendChild(el("div", { className: "screen main-menu" }, [
        el("h1", {}, ["Cinematic Bazaar"]),
        nameRow,
        gameList
      ]));
    }
    renderBrowser() {
      const def = gameRegistry.get(this.browsedGameId);
      const rooms = this.openRooms.filter((r) => r.gameId === this.browsedGameId);
      const listContent = rooms.length > 0 ? rooms.map((room) => {
        const maxPlayers = def?.maxPlayers ?? 8;
        const isFull = room.players.length >= maxPlayers;
        return el("div", { className: "room-row" }, [
          el("div", { className: "room-info" }, [
            el("span", { className: "room-name" }, [room.name]),
            el("span", { className: "room-meta" }, [
              `${room.players.length}/${maxPlayers} players`,
              el("span", { className: "room-code" }, [room.code])
            ])
          ]),
          el("button", {
            className: isFull ? "btn-disabled" : "btn-secondary",
            disabled: isFull,
            onclick: () => {
              this.socket.send({ type: "join_room", code: room.code });
            }
          }, [isFull ? "Full" : "Join"])
        ]);
      }) : [el("p", { className: "empty-state" }, ["No open lobbies. Create one!"])];
      let codeInput;
      const joinByCode = el("div", { className: "join-code-row" }, [
        (() => {
          codeInput = document.createElement("input");
          codeInput.placeholder = "Room code";
          codeInput.maxLength = 5;
          codeInput.className = "code-input";
          codeInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter")
              joinByCodeFn();
          });
          return codeInput;
        })(),
        el("button", {
          className: "btn-secondary",
          onclick: () => joinByCodeFn()
        }, ["Join by Code"])
      ]);
      const joinByCodeFn = () => {
        const code = codeInput.value.trim().toUpperCase();
        if (code.length !== 5) {
          this.errorMessage = "Room codes are 5 characters.";
          this.renderUI();
          return;
        }
        this.socket.send({ type: "join_room", code });
      };
      const errorEl = this.errorMessage ? el("p", { className: "error-msg" }, [this.errorMessage]) : null;
      const howToPlayBtn = def?.howToPlay ? el("button", {
        className: "btn-secondary",
        onclick: () => this.showHowToPlay(def.howToPlay)
      }, ["? How to Play"]) : null;
      this.root.appendChild(el("div", { className: "screen browser" }, [
        el("div", { className: "browser-header" }, [
          el("button", {
            className: "btn-back",
            onclick: () => {
              this.errorMessage = "";
              this.setScreen("main_menu");
            }
          }, ["\u2190 Back"]),
          el("h1", {}, [def?.name ?? "Game"]),
          el("div", { className: "browser-header-actions" }, [
            ...howToPlayBtn ? [howToPlayBtn] : [],
            el("button", {
              className: "btn-primary",
              onclick: () => this.socket.send({ type: "create_room", gameId: this.browsedGameId })
            }, ["+ Create Room"])
          ])
        ]),
        ...errorEl ? [errorEl] : [],
        el("div", { className: "room-list" }, [
          el("div", { className: "section-label" }, [
            "Open Lobbies",
            el("span", { className: "refresh-note" }, [" (refreshes every 3s)"])
          ]),
          ...listContent
        ]),
        el("div", { className: "divider" }, ["\u2014 or join by code \u2014"]),
        joinByCode
      ]));
    }
    renderLobby() {
      const room = this.currentRoom;
      if (!room)
        return;
      const def = gameRegistry.get(room.gameId);
      const maxPlayers = def?.maxPlayers ?? 8;
      const me = room.players.find((p) => p.id === this.myPlayerId);
      const isHost = room.host === this.myPlayerId;
      const allNonHostReady = room.players.filter((p) => p.id !== room.host).every((p) => p.ready);
      const canStart = isHost && room.players.length >= (def?.minPlayers ?? 2) && allNonHostReady;
      const playerRows = room.players.map((p) => {
        const isMe = p.id === this.myPlayerId;
        const hostBadge = p.id === room.host ? el("span", { className: "badge badge-host" }, ["HOST"]) : null;
        const meBadge = isMe ? el("span", { className: "badge badge-me" }, ["YOU"]) : null;
        const readyBadge = p.id === room.host ? el("span", { className: "badge badge-neutral" }, ["\u2014"]) : el("span", { className: `badge ${p.ready ? "badge-ready" : "badge-waiting"}` }, [p.ready ? "\u2713 Ready" : "\u2026 Waiting"]);
        return el("div", { className: `player-row${isMe ? " player-row-me" : ""}` }, [
          el("span", { className: "player-swatch", style: `background:${PLAYER_COLORS2[p.id]}` }, []),
          el("span", { className: "player-name" }, [p.name]),
          el("span", { className: "player-badges" }, [
            ...hostBadge ? [hostBadge] : [],
            ...meBadge ? [meBadge] : [],
            readyBadge
          ])
        ]);
      });
      const actions4 = [];
      if (me && !isHost) {
        actions4.push(el("button", {
          className: me.ready ? "btn-secondary" : "btn-primary",
          onclick: () => this.socket.send({ type: "ready" })
        }, [me.ready ? "Unready" : "Ready"]));
      }
      if (isHost) {
        const startBtn = el("button", {
          className: canStart ? "btn-primary" : "btn-disabled",
          disabled: !canStart,
          onclick: () => {
            if (canStart)
              this.socket.send({ type: "start_game" });
          }
        }, ["Start Game"]);
        actions4.push(startBtn);
        if (!canStart) {
          const hint = room.players.length < (def?.minPlayers ?? 2) ? `Need at least ${def?.minPlayers ?? 2} players` : "Waiting for all players to ready up";
          actions4.push(el("p", { className: "muted hint" }, [hint]));
        }
      }
      actions4.push(el("button", {
        className: "btn-danger",
        onclick: () => {
          this.socket.send({ type: "leave_room" });
          this.currentRoom = null;
          this.errorMessage = "";
          if (this.browsedGameId) {
            this.setScreen("browser");
          } else {
            this.setScreen("main_menu");
          }
        }
      }, ["Leave Room"]));
      const errorEl = this.errorMessage ? el("p", { className: "error-msg" }, [this.errorMessage]) : null;
      this.root.appendChild(el("div", { className: "screen lobby" }, [
        el("div", { className: "lobby-header" }, [
          el("div", {}, [
            el("h1", {}, [room.name]),
            el("p", { className: "muted" }, [`${def?.name ?? ""} \xB7 ${room.players.length}/${maxPlayers} players`])
          ]),
          el("div", { className: "room-code-display" }, [
            el("span", { className: "code-label" }, ["Room Code"]),
            el("span", { className: "code-value" }, [room.code])
          ])
        ]),
        ...errorEl ? [errorEl] : [],
        el("div", { className: "player-list" }, playerRows),
        ...isHost && def?.settings?.length ? [this.renderSettings(def.settings, room.gameSettings)] : [],
        el("div", { className: "lobby-actions" }, actions4)
      ]));
    }
    renderSettings(defs, current) {
      const rows = defs.map((s) => {
        let control;
        if (s.type === "range") {
          const input = document.createElement("input");
          input.type = "range";
          input.min = String(s.min ?? 0);
          input.max = String(s.max ?? 100);
          input.step = String(s.step ?? 1);
          input.value = String(current[s.key] ?? s.default);
          const valueLabel = document.createElement("span");
          valueLabel.className = "setting-value";
          valueLabel.textContent = input.value;
          input.addEventListener("input", () => {
            valueLabel.textContent = input.value;
          });
          input.addEventListener("change", () => {
            this.socket.send({ type: "update_settings", settings: { [s.key]: Number(input.value) } });
          });
          const wrap = document.createElement("div");
          wrap.className = "setting-range-wrap";
          wrap.appendChild(input);
          wrap.appendChild(valueLabel);
          control = wrap;
        } else if (s.type === "toggle") {
          const input = document.createElement("input");
          input.type = "checkbox";
          input.className = "setting-toggle";
          input.checked = Boolean(current[s.key] ?? s.default);
          input.addEventListener("change", () => {
            this.socket.send({ type: "update_settings", settings: { [s.key]: input.checked } });
          });
          control = input;
        } else {
          const select = document.createElement("select");
          select.className = "setting-select";
          for (const opt of s.options ?? []) {
            const o = document.createElement("option");
            o.value = opt;
            o.textContent = opt;
            if (opt === String(current[s.key] ?? s.default))
              o.selected = true;
            select.appendChild(o);
          }
          select.addEventListener("change", () => {
            this.socket.send({ type: "update_settings", settings: { [s.key]: select.value } });
          });
          control = select;
        }
        return el("div", { className: "setting-row" }, [
          el("label", { className: "setting-label" }, [s.label]),
          control
        ]);
      });
      return el("div", { className: "settings-panel" }, [
        el("div", { className: "section-label" }, ["Game Settings"]),
        ...rows
      ]);
    }
    renderGameOver() {
      const data = this.gameOverData;
      const room = this.currentRoom;
      let winnerText = "Game Over";
      if (data) {
        if (data.winner !== null) {
          const winnerPlayer = room?.players.find((p) => p.id === data.winner);
          winnerText = `${winnerPlayer?.name ?? `Player ${data.winner + 1}`} wins!`;
        } else {
          winnerText = "Draw!";
        }
      }
      const scoreRows = data ? Object.entries(data.scores).sort(([, a], [, b]) => b - a).map(([pid, score]) => {
        const player = room?.players.find((p) => p.id === Number(pid));
        return el("div", { className: "score-row" }, [
          el("span", { className: "player-swatch", style: `background:${PLAYER_COLORS2[Number(pid)]}` }, []),
          el("span", {}, [player?.name ?? `Player ${Number(pid) + 1}`]),
          el("span", { className: "score-value" }, [String(score)])
        ]);
      }) : [];
      this.root.appendChild(el("div", { className: "screen game-over" }, [
        el("h1", {}, [winnerText]),
        ...scoreRows.length ? [el("div", { className: "score-list" }, scoreRows)] : [],
        el("div", { className: "game-over-actions" }, [
          el("button", {
            className: "btn-primary",
            onclick: () => {
              this.latestState = null;
              this.gameOverData = null;
              this.currentGame = null;
              this.currentRoom = null;
              this.errorMessage = "";
              this.setScreen("browser");
            }
          }, ["Play Again"]),
          el("button", {
            className: "btn-secondary",
            onclick: () => {
              this.latestState = null;
              this.gameOverData = null;
              this.currentGame = null;
              this.currentRoom = null;
              this.browsedGameId = "";
              this.errorMessage = "";
              this.setScreen("main_menu");
            }
          }, ["Main Menu"])
        ])
      ]));
    }
    showHowToPlay(html) {
      const overlay = el("div", { className: "htp-overlay" }, [
        el("div", { className: "htp-dialog" }, [
          el("div", { className: "htp-header" }, [
            el("h2", {}, ["How to Play"]),
            el("button", { className: "btn-back", onclick: () => overlay.remove() }, ["\u2715 Close"])
          ]),
          (() => {
            const body = document.createElement("div");
            body.className = "htp-body";
            body.innerHTML = html;
            return body;
          })()
        ])
      ]);
      this.root.appendChild(overlay);
    }
    getStoredName() {
      return localStorage.getItem("playerName") ?? "Player";
    }
  };
  var PLAYER_COLORS2 = {
    0: "#ffff00",
    1: "#ffffff",
    2: "#ff4444",
    3: "#4488ff",
    4: "#44ff88",
    5: "#ff8844",
    6: "#ff44ff",
    7: "#44ffff"
  };
  function el(tag, attrs, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null)
        continue;
      if (k === "onclick") {
        node.addEventListener("click", v);
      } else if (k === "disabled") {
        if (v)
          node.disabled = true;
      } else if (k === "className") {
        node.className = v;
      } else if (k === "style") {
        node.setAttribute("style", v);
      } else {
        node.setAttribute(k, String(v));
      }
    }
    for (const child of children) {
      if (child == null)
        continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  // src/games/tetromino/constants.ts
  var BOARD_COLS = 10;
  var BOARD_ROWS = 20;
  var CELL_SIZE = 18;
  var PANEL_WIDTH = BOARD_COLS * CELL_SIZE;
  var PANEL_HEIGHT = BOARD_ROWS * CELL_SIZE;
  var BASE_GRAVITY = 1;
  var GRAVITY_INCREMENT = 0.3;
  var LINE_POINTS = [0, 100, 300, 500, 800];
  var GARBAGE_PER_LINE = [0, 0, 1, 2, 4];
  var LOCK_DELAY_TICKS = 30;
  var TETROMINO_SHAPES = {
    // Each entry: [rotation0, rotation1, rotation2, rotation3], each rotation is array of [row, col] offsets
    I: [
      [[1, 0], [1, 1], [1, 2], [1, 3]],
      [[0, 2], [1, 2], [2, 2], [3, 2]],
      [[2, 0], [2, 1], [2, 2], [2, 3]],
      [[0, 1], [1, 1], [2, 1], [3, 1]]
    ],
    O: [
      [[0, 1], [0, 2], [1, 1], [1, 2]],
      [[0, 1], [0, 2], [1, 1], [1, 2]],
      [[0, 1], [0, 2], [1, 1], [1, 2]],
      [[0, 1], [0, 2], [1, 1], [1, 2]]
    ],
    T: [
      [[0, 1], [1, 0], [1, 1], [1, 2]],
      [[0, 1], [1, 1], [1, 2], [2, 1]],
      [[1, 0], [1, 1], [1, 2], [2, 1]],
      [[0, 1], [1, 0], [1, 1], [2, 1]]
    ],
    S: [
      [[0, 1], [0, 2], [1, 0], [1, 1]],
      [[0, 1], [1, 1], [1, 2], [2, 2]],
      [[1, 1], [1, 2], [2, 0], [2, 1]],
      [[0, 0], [1, 0], [1, 1], [2, 1]]
    ],
    Z: [
      [[0, 0], [0, 1], [1, 1], [1, 2]],
      [[0, 2], [1, 1], [1, 2], [2, 1]],
      [[1, 0], [1, 1], [2, 1], [2, 2]],
      [[0, 1], [1, 0], [1, 1], [2, 0]]
    ],
    J: [
      [[0, 0], [1, 0], [1, 1], [1, 2]],
      [[0, 1], [0, 2], [1, 1], [2, 1]],
      [[1, 0], [1, 1], [1, 2], [2, 2]],
      [[0, 1], [1, 1], [2, 0], [2, 1]]
    ],
    L: [
      [[0, 2], [1, 0], [1, 1], [1, 2]],
      [[0, 1], [1, 1], [2, 1], [2, 2]],
      [[1, 0], [1, 1], [1, 2], [2, 0]],
      [[0, 0], [0, 1], [1, 1], [2, 1]]
    ]
  };
  var TETROMINO_COLORS = {
    I: "#00ffff",
    O: "#ffff00",
    T: "#aa00ff",
    S: "#00ff00",
    Z: "#ff0000",
    J: "#0000ff",
    L: "#ff8800"
  };
  var TETROMINO_TYPES = ["I", "O", "T", "S", "Z", "J", "L"];

  // src/framework/shared/utils.ts
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }
  function dist(x1, y1, x2, y2) {
    return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
  }
  function normalizeAngle(angle) {
    const TWO_PI = Math.PI * 2;
    return (angle % TWO_PI + TWO_PI) % TWO_PI;
  }
  function seededRandom(seed) {
    const x = Math.sin(seed + 1) * 1e4;
    return x - Math.floor(x);
  }

  // src/games/tetromino/state.ts
  function emptyBoard() {
    return Array.from({ length: BOARD_ROWS }, () => Array(BOARD_COLS).fill(null));
  }
  function pickPiece(seed) {
    return TETROMINO_TYPES[Math.floor(seededRandom(seed) * TETROMINO_TYPES.length)];
  }
  function createInitialState(config) {
    const seed = Date.now() % 1e6;
    const colors = ["yellow", "white", "red", "blue", "green", "orange", "magenta", "cyan"];
    const players = [...config.playerIds, ...config.aiSlots].map((id) => {
      const isAI = config.aiSlots.includes(id);
      const humanIndex = config.playerIds.indexOf(id);
      const name = isAI ? `AI Player ${id}` : config.playerNames[humanIndex];
      const color = isAI ? colors[id % colors.length] : config.playerColors[humanIndex];
      return {
        id,
        name,
        color,
        score: 0,
        isAI,
        connected: true,
        board: emptyBoard(),
        current: spawnPiece(pickPiece(seed + id * 100)),
        next: pickPiece(seed + id * 100 + 1),
        held: null,
        holdUsed: false,
        gravityAccum: 0,
        lockTimer: 0,
        lockActive: false,
        linesCleared: 0,
        level: 1,
        dead: false,
        pendingGarbage: 0,
        lastAiActionTick: 0,
        lastAiInput: {
          MOVE_LEFT: false,
          MOVE_RIGHT: false,
          SOFT_DROP: false,
          HARD_DROP: false,
          ROTATE_CW: false,
          ROTATE_CCW: false,
          HOLD: false
        },
        aiMoveDelay: 8,
        aiDropDelay: 20,
        aiMoveTimer: 0,
        aiDropTimer: 0,
        aiTargetCol: 3,
        aiTargetRot: 0
      };
    });
    return {
      tick: 0,
      phase: "playing",
      players,
      seed
    };
  }
  function spawnPiece(type) {
    return { type, rotation: 0, row: 0, col: 3 };
  }

  // src/games/tetromino/engine.ts
  function getCells(t) {
    return TETROMINO_SHAPES[t.type][t.rotation].map(([r, c]) => [t.row + r, t.col + c]);
  }
  function isValid(board, t) {
    for (const [r, c] of getCells(t)) {
      if (r < 0 || r >= BOARD_ROWS || c < 0 || c >= BOARD_COLS)
        return false;
      if (board[r][c] !== null)
        return false;
    }
    return true;
  }
  function lockPiece(board, t) {
    const color = TETROMINO_COLORS[t.type];
    for (const [r, c] of getCells(t)) {
      if (r >= 0 && r < BOARD_ROWS && c >= 0 && c < BOARD_COLS) {
        board[r][c] = color;
      }
    }
  }
  function clearLines(board) {
    const kept = board.filter((row) => row.some((cell) => cell === null));
    const cleared = BOARD_ROWS - kept.length;
    while (kept.length < BOARD_ROWS)
      kept.unshift(Array(BOARD_COLS).fill(null));
    board.splice(0, BOARD_ROWS, ...kept);
    return cleared;
  }
  function addGarbageLines(board, count, seed) {
    const gapCol = Math.floor(seededRandom(seed) * BOARD_COLS);
    for (let i = 0; i < count; i++) {
      board.shift();
      const garbageLine = Array(BOARD_COLS).fill("#555555");
      garbageLine[gapCol] = null;
      board.push(garbageLine);
    }
  }
  function hardDropRow(board, t) {
    let piece = { ...t };
    while (isValid(board, { ...piece, row: piece.row + 1 }))
      piece.row++;
    return piece.row;
  }
  function tryRotate(board, t, dir) {
    const newRot = (t.rotation + dir + 4) % 4;
    const candidate = { ...t, rotation: newRot };
    for (const dc of [0, -1, 1, -2, 2]) {
      const kicked = { ...candidate, col: candidate.col + dc };
      if (isValid(board, kicked))
        return kicked;
    }
    return null;
  }
  function tick(state, inputs, dt) {
    const next = {
      ...state,
      tick: state.tick + 1,
      players: state.players.map((p) => ({
        ...p,
        board: p.board.map((row) => [...row]),
        current: p.current ? { ...p.current } : null
      }))
    };
    const events = [];
    const garbageToSend = /* @__PURE__ */ new Map();
    let activePlayers = next.players.filter((p) => !p.dead);
    for (const player of activePlayers) {
      if (player.current === null)
        continue;
      const inp = inputs.get(player.id) ?? {};
      if (player.isAI) {
        const changed = inp.MOVE_LEFT !== player.lastAiInput.MOVE_LEFT || inp.MOVE_RIGHT !== player.lastAiInput.MOVE_RIGHT || inp.SOFT_DROP !== player.lastAiInput.SOFT_DROP || inp.HARD_DROP !== player.lastAiInput.HARD_DROP || inp.ROTATE_CW !== player.lastAiInput.ROTATE_CW || inp.ROTATE_CCW !== player.lastAiInput.ROTATE_CCW || inp.HOLD !== player.lastAiInput.HOLD;
        if (changed) {
          player.lastAiActionTick = state.tick;
          player.lastAiInput = { ...inp };
        }
      }
      const board = player.board;
      let piece = { ...player.current };
      if (player.pendingGarbage > 0) {
        addGarbageLines(board, player.pendingGarbage, state.tick + player.id);
        player.pendingGarbage = 0;
      }
      if (inp.HOLD && !player.holdUsed) {
        player.holdUsed = true;
        const swapType = player.held ?? player.next;
        player.held = piece.type;
        if (!player.held) {
        }
        const newNext = player.held === player.next ? pickNextPiece(state, player, next.tick) : player.next;
        if (player.held === player.next)
          player.next = newNext;
        piece = spawnPiece(swapType);
        player.lockActive = false;
        player.lockTimer = 0;
        if (!isValid(board, piece)) {
          player.dead = true;
          continue;
        }
      }
      if (inp.ROTATE_CW) {
        const rotated = tryRotate(board, piece, 1);
        if (rotated) {
          piece = rotated;
          player.lockTimer = LOCK_DELAY_TICKS;
        }
      }
      if (inp.ROTATE_CCW) {
        const rotated = tryRotate(board, piece, -1);
        if (rotated) {
          piece = rotated;
          player.lockTimer = LOCK_DELAY_TICKS;
        }
      }
      if (inp.MOVE_LEFT) {
        const moved = { ...piece, col: piece.col - 1 };
        if (isValid(board, moved)) {
          piece = moved;
          player.lockTimer = LOCK_DELAY_TICKS;
        }
      }
      if (inp.MOVE_RIGHT) {
        const moved = { ...piece, col: piece.col + 1 };
        if (isValid(board, moved)) {
          piece = moved;
          player.lockTimer = LOCK_DELAY_TICKS;
        }
      }
      if (inp.HARD_DROP) {
        piece.row = hardDropRow(board, piece);
        lockPiece(board, piece);
        const cleared = clearLines(board);
        player.linesCleared += cleared;
        player.score += LINE_POINTS[cleared] * player.level;
        player.level = Math.floor(player.linesCleared / 10) + 1;
        const garbage = GARBAGE_PER_LINE[cleared];
        if (garbage > 0)
          garbageToSend.set(player.id, (garbageToSend.get(player.id) ?? 0) + garbage);
        if (cleared > 0)
          events.push({ type: "lines_cleared", playerId: player.id, count: cleared });
        piece = spawnPiece(player.next);
        player.next = pickNextPiece(state, player, next.tick);
        player.holdUsed = false;
        player.lockActive = false;
        player.lockTimer = 0;
        player.gravityAccum = 0;
        if (!isValid(board, piece)) {
          player.dead = true;
          events.push({ type: "player_dead", playerId: player.id });
          player.current = null;
          continue;
        }
        player.current = piece;
        if (player.isAI) {
          player.aiMoveTimer = 0;
          player.aiDropTimer = player.aiDropDelay;
        }
        continue;
      }
      const gravitySpeed = BASE_GRAVITY + (player.level - 1) * GRAVITY_INCREMENT;
      const softMult = inp.SOFT_DROP ? 10 : 1;
      player.gravityAccum += gravitySpeed * softMult * dt;
      let dropped = false;
      while (player.gravityAccum >= 1) {
        player.gravityAccum -= 1;
        const fallen = { ...piece, row: piece.row + 1 };
        if (isValid(board, fallen)) {
          piece = fallen;
          dropped = true;
        } else {
          player.gravityAccum = 0;
          break;
        }
      }
      const onGround = !isValid(board, { ...piece, row: piece.row + 1 });
      if (onGround) {
        if (!player.lockActive) {
          player.lockActive = true;
          player.lockTimer = LOCK_DELAY_TICKS;
        } else {
          player.lockTimer--;
        }
        if (player.lockTimer <= 0) {
          lockPiece(board, piece);
          const cleared = clearLines(board);
          player.linesCleared += cleared;
          player.score += LINE_POINTS[cleared] * player.level;
          player.level = Math.floor(player.linesCleared / 10) + 1;
          const garbage = GARBAGE_PER_LINE[cleared];
          if (garbage > 0)
            garbageToSend.set(player.id, (garbageToSend.get(player.id) ?? 0) + garbage);
          if (cleared > 0)
            events.push({ type: "lines_cleared", playerId: player.id, count: cleared });
          piece = spawnPiece(player.next);
          player.next = pickNextPiece(state, player, next.tick);
          player.holdUsed = false;
          player.lockActive = false;
          player.lockTimer = 0;
          player.gravityAccum = 0;
          if (!isValid(board, piece)) {
            player.dead = true;
            events.push({ type: "player_dead", playerId: player.id });
            player.current = null;
            continue;
          }
          if (player.isAI) {
            player.aiMoveTimer = 0;
            player.aiDropTimer = player.aiDropDelay;
          }
        }
      } else {
        player.lockActive = false;
      }
      player.current = piece;
    }
    activePlayers = next.players.filter((p) => !p.dead);
    for (const [senderId, garbageCount] of garbageToSend) {
      const targets = next.players.filter((p) => p.id !== senderId && !p.dead);
      if (targets.length === 0)
        continue;
      const perTarget = Math.floor(garbageCount / targets.length);
      const extra = garbageCount % targets.length;
      for (let i = 0; i < targets.length; i++) {
        targets[i].pendingGarbage += perTarget + (i === 0 ? extra : 0);
      }
    }
    const aliveAfter = next.players.filter((p) => !p.dead);
    const gameEnded = next.players.length === 1 ? aliveAfter.length === 0 : aliveAfter.length <= 1;
    if (gameEnded)
      next.phase = "game_over";
    return { state: next, events };
  }
  function pickNextPiece(state, player, currentTick) {
    const seed = state.seed + player.id * 1e4 + currentTick;
    return TETROMINO_TYPES[Math.floor(seededRandom(seed) * TETROMINO_TYPES.length)];
  }
  function isGameOver(state) {
    if (state.phase === "game_over")
      return true;
    const alive = state.players.filter((p) => !p.dead);
    if (state.players.length === 1)
      return alive.length === 0;
    return alive.length <= 1;
  }
  function getWinner(state) {
    const alive = state.players.filter((p) => !p.dead);
    if (alive.length === 1)
      return alive[0].id;
    const sorted = [...state.players].sort((a, b) => b.score - a.score);
    if (sorted[0].score === sorted[1]?.score)
      return null;
    return sorted[0].id;
  }
  var aiAdapter = {
    computeInput(state, playerId) {
      const player = state.players.find((p) => p.id === playerId);
      const inp = {
        MOVE_LEFT: false,
        MOVE_RIGHT: false,
        SOFT_DROP: false,
        HARD_DROP: false,
        ROTATE_CW: false,
        ROTATE_CCW: false,
        HOLD: false
      };
      if (!player || !player.current || player.dead)
        return inp;
      const piece = player.current;
      const board = player.board;
      const ai = player;
      if (state.tick - ai.lastAiActionTick >= 10) {
        let bestScore = Infinity;
        let bestCol = piece.col;
        let bestRot = piece.rotation;
        for (let rot = 0; rot < 4; rot++) {
          const candidate = { ...piece, rotation: rot };
          for (let col = 0; col < BOARD_COLS; col++) {
            const placed = { ...candidate, col };
            if (!isValid(board, placed))
              continue;
            const dropped = { ...placed, row: hardDropRow(board, placed) };
            const score = evalBoard(board, dropped);
            if (score < bestScore) {
              bestScore = score;
              bestCol = col;
              bestRot = rot;
            }
          }
        }
        const changed = bestCol !== ai.aiTargetCol || bestRot !== ai.aiTargetRot;
        ai.aiTargetCol = bestCol;
        ai.aiTargetRot = bestRot;
        ai.lastAiActionTick = state.tick;
        if (changed) {
          ai.aiMoveTimer = 0;
          ai.aiDropTimer = ai.aiDropDelay;
        }
      }
      ai.aiMoveTimer = Math.max(0, ai.aiMoveTimer - 1);
      if (ai.aiMoveTimer > 0)
        return inp;
      if (piece.rotation !== ai.aiTargetRot) {
        inp.ROTATE_CW = true;
        ai.aiMoveTimer = ai.aiMoveDelay;
      } else if (ai.aiTargetCol < piece.col) {
        inp.MOVE_LEFT = true;
        ai.aiMoveTimer = ai.aiMoveDelay;
      } else if (ai.aiTargetCol > piece.col) {
        inp.MOVE_RIGHT = true;
        ai.aiMoveTimer = ai.aiMoveDelay;
      } else if (ai.aiDropTimer > 0) {
        ai.aiDropTimer--;
      } else {
        inp.HARD_DROP = true;
      }
      return inp;
    }
  };
  function evalBoard(board, piece) {
    const scratch = board.map((r) => [...r]);
    const color = TETROMINO_COLORS[piece.type];
    for (const [r, c] of TETROMINO_SHAPES[piece.type][piece.rotation].map(([r2, c2]) => [piece.row + r2, piece.col + c2])) {
      if (r >= 0 && r < BOARD_ROWS && c >= 0 && c < BOARD_COLS)
        scratch[r][c] = color;
    }
    let aggregateHeight = 0;
    let holes = 0;
    let bumpiness = 0;
    const heights = [];
    for (let c = 0; c < BOARD_COLS; c++) {
      let h = 0;
      for (let r = 0; r < BOARD_ROWS; r++) {
        if (scratch[r][c] !== null) {
          h = BOARD_ROWS - r;
          break;
        }
      }
      heights.push(h);
      aggregateHeight += h;
      let inBlock = false;
      for (let r = 0; r < BOARD_ROWS; r++) {
        if (scratch[r][c] !== null)
          inBlock = true;
        else if (inBlock)
          holes++;
      }
    }
    for (let c = 0; c < BOARD_COLS - 1; c++)
      bumpiness += Math.abs(heights[c] - heights[c + 1]);
    const completedLines = scratch.filter((row) => row.every((cell) => cell !== null)).length;
    return aggregateHeight * 0.51 + holes * 0.75 + bumpiness * 0.35 - completedLines * 3;
  }

  // src/games/tetromino/input.ts
  var actions = {
    MOVE_LEFT: { label: "Move Left", type: "press" },
    MOVE_RIGHT: { label: "Move Right", type: "press" },
    SOFT_DROP: { label: "Soft Drop", type: "held" },
    HARD_DROP: { label: "Hard Drop", type: "press" },
    ROTATE_CW: { label: "Rotate CW", type: "press" },
    ROTATE_CCW: { label: "Rotate CCW", type: "press" },
    HOLD: { label: "Hold Piece", type: "press" }
  };
  var defaultActionMap = {
    keyboard: {
      ArrowLeft: "MOVE_LEFT",
      KeyA: "MOVE_LEFT",
      ArrowRight: "MOVE_RIGHT",
      KeyD: "MOVE_RIGHT",
      ArrowDown: "SOFT_DROP",
      KeyS: "SOFT_DROP",
      Space: "HARD_DROP",
      ArrowUp: "ROTATE_CW",
      KeyW: "ROTATE_CW",
      KeyZ: "ROTATE_CCW",
      ShiftLeft: "HOLD",
      ShiftRight: "HOLD",
      KeyC: "HOLD"
    }
  };

  // src/games/tetromino/renderer.ts
  var CELL = 18;
  var BOARD_W = BOARD_COLS * CELL;
  var BOARD_H = BOARD_ROWS * CELL;
  var PANEL_W = BOARD_W + 60;
  var PANEL_H = BOARD_H + 40;
  var PANEL_POSITIONS = [
    { x: 20, y: 20 },
    { x: 420, y: 20 },
    { x: 20, y: 420 },
    { x: 420, y: 420 }
  ];
  function drawCell(ctx, x, y, color, size = CELL) {
    ctx.fillStyle = color;
    ctx.fillRect(x + 1, y + 1, size - 2, size - 2);
    ctx.fillStyle = "rgba(255,255,255,0.15)";
    ctx.fillRect(x + 1, y + 1, size - 2, 3);
    ctx.fillRect(x + 1, y + 1, 3, size - 2);
  }
  function drawBoard(ctx, ox, oy, board) {
    ctx.fillStyle = "#111";
    ctx.fillRect(ox, oy, BOARD_W, BOARD_H);
    ctx.strokeStyle = "#222";
    ctx.lineWidth = 0.5;
    for (let r = 0; r <= BOARD_ROWS; r++) {
      ctx.beginPath();
      ctx.moveTo(ox, oy + r * CELL);
      ctx.lineTo(ox + BOARD_W, oy + r * CELL);
      ctx.stroke();
    }
    for (let c = 0; c <= BOARD_COLS; c++) {
      ctx.beginPath();
      ctx.moveTo(ox + c * CELL, oy);
      ctx.lineTo(ox + c * CELL, oy + BOARD_H);
      ctx.stroke();
    }
    for (let r = 0; r < BOARD_ROWS; r++) {
      for (let c = 0; c < BOARD_COLS; c++) {
        const color = board[r][c];
        if (color)
          drawCell(ctx, ox + c * CELL, oy + r * CELL, color);
      }
    }
  }
  function drawPiece(ctx, ox, oy, piece, alpha = 1) {
    ctx.globalAlpha = alpha;
    const color = TETROMINO_COLORS[piece.type];
    for (const [r, c] of TETROMINO_SHAPES[piece.type][piece.rotation]) {
      const pr = piece.row + r;
      const pc = piece.col + c;
      if (pr >= 0 && pr < BOARD_ROWS && pc >= 0 && pc < BOARD_COLS) {
        drawCell(ctx, ox + pc * CELL, oy + pr * CELL, color);
      }
    }
    ctx.globalAlpha = 1;
  }
  function drawGhost(ctx, ox, oy, board, piece) {
    let ghostRow = piece.row;
    while (true) {
      const next = { ...piece, row: ghostRow + 1 };
      let valid = true;
      for (const [r, c] of TETROMINO_SHAPES[next.type][next.rotation]) {
        const nr = next.row + r;
        const nc = next.col + c;
        if (nr >= BOARD_ROWS || nc < 0 || nc >= BOARD_COLS || board[nr]?.[nc]) {
          valid = false;
          break;
        }
      }
      if (!valid)
        break;
      ghostRow++;
    }
    if (ghostRow === piece.row)
      return;
    const ghost = { ...piece, row: ghostRow };
    drawPiece(ctx, ox, oy, ghost, 0.25);
  }
  function drawMini(ctx, cx, cy, type) {
    if (!type)
      return;
    const t = type;
    const color = TETROMINO_COLORS[t];
    const cells = TETROMINO_SHAPES[t][0];
    const miniSize = 10;
    for (const [r, c] of cells) {
      drawCell(ctx, cx + c * miniSize, cy + r * miniSize, color, miniSize);
    }
  }
  function drawPanel(ctx, player, px, py, isMe) {
    const ox = px;
    const oy = py + 22;
    ctx.fillStyle = PLAYER_COLORS[player.id];
    ctx.font = `bold 13px monospace`;
    ctx.fillText(`${player.name} L${player.level}`, px, py + 14);
    ctx.fillStyle = "#aaa";
    ctx.font = "11px monospace";
    ctx.fillText(`${player.score}`, px + BOARD_W + 4, py + 14);
    if (player.dead) {
      drawBoard(ctx, ox, oy, player.board);
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(ox, oy, BOARD_W, BOARD_H);
      ctx.fillStyle = "#ff4444";
      ctx.font = "bold 20px monospace";
      ctx.textAlign = "center";
      ctx.fillText("DEAD", ox + BOARD_W / 2, oy + BOARD_H / 2);
      ctx.textAlign = "left";
      return;
    }
    drawBoard(ctx, ox, oy, player.board);
    if (player.current) {
      drawGhost(ctx, ox, oy, player.board, player.current);
      drawPiece(ctx, ox, oy, player.current);
    }
    const nextX = ox + BOARD_W + 4;
    ctx.fillStyle = "#555";
    ctx.font = "9px monospace";
    ctx.fillText("NEXT", nextX, oy + 10);
    drawMini(ctx, nextX, oy + 14, player.next);
    ctx.fillText("HOLD", nextX, oy + 70);
    drawMini(ctx, nextX, oy + 74, player.held ?? null);
    if (player.pendingGarbage > 0) {
      ctx.fillStyle = "#ff6600";
      ctx.fillRect(ox + BOARD_W - 6, oy + BOARD_H - player.pendingGarbage * CELL, 5, player.pendingGarbage * CELL);
    }
    if (isMe) {
      ctx.fillStyle = "rgba(255,255,0,0.8)";
      ctx.font = "bold 10px monospace";
      ctx.fillText("YOU", ox + BOARD_W - 28, oy - 6);
    }
  }
  var renderer = {
    render(ctx, state, myPlayerId) {
      const width = ctx.canvas.width;
      const height = ctx.canvas.height;
      ctx.fillStyle = "#0a0a0a";
      ctx.fillRect(0, 0, width, height);
      for (let i = 0; i < state.players.length && i < 4; i++) {
        const player = state.players[i];
        const pos = PANEL_POSITIONS[i];
        drawPanel(ctx, player, pos.x, pos.y, player.id === myPlayerId);
      }
      if (state.phase === "game_over") {
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = "#fff";
        ctx.font = "bold 36px monospace";
        ctx.textAlign = "center";
        ctx.fillText("GAME OVER", width / 2, height / 2);
        ctx.textAlign = "left";
      }
    }
  };

  // src/games/tetromino/definition.ts
  var definition = {
    id: "tetromino",
    name: "Tetromino Battle",
    description: "Competitive 4-player Tetromino \u2014 clear lines to send garbage to your opponents.",
    minPlayers: 1,
    maxPlayers: 4,
    actions,
    defaultActionMap,
    createInitialState,
    tick,
    isGameOver,
    getWinner,
    aiAdapter,
    renderer,
    canvasSize: { width: 800, height: 800 },
    howToPlay: `
     <h3>Controls</h3>
     <ul>
       <li>\u2190 \u2192 Arrow keys / A D \u2014 Move</li>
       <li>\u2191 Arrow / W \u2014 Rotate clockwise</li>
       <li>Z \u2014 Rotate counter-clockwise</li>
       <li>\u2193 Arrow / S \u2014 Soft drop</li>
       <li>Space \u2014 Hard drop</li>
       <li>Shift / C \u2014 Hold piece</li>
     </ul>
     <h3>Rules</h3>
     <p>Clear 2+ lines at once to send garbage lines to all other players.
     Last player standing wins. If you fill your board to the top, you're out!</p>
     <h3>Garbage</h3>
     <ul>
       <li>2 lines \u2192 1 garbage line sent</li>
       <li>3 lines \u2192 2 garbage lines sent</li>
       <li>4 lines (Tetromino) \u2192 4 garbage lines sent</li>
     </ul>
   `,
    settings: [
      {
        key: "startLevel",
        label: "Starting Level",
        type: "range",
        default: 1,
        min: 1,
        max: 15,
        step: 1
      }
    ],
    clientHooks: {
      onEvent(event) {
        if (event.type === "lines_cleared") {
          const count = event.count;
          if (count >= 4)
            console.log("TETRIS!");
        }
      }
    }
  };
  var definition_default = definition;

  // src/games/warlords/constants.ts
  var CANVAS_WIDTH2 = 800;
  var CANVAS_HEIGHT2 = 600;
  var CASTLE_SIZE = 192;
  var BRICK_WIDTH = 32;
  var BRICK_HEIGHT = 32;
  var BRICK_HP = 2;
  var CASTLE_POSITIONS = [
    { x: 20, y: 20 },
    { x: CANVAS_WIDTH2 - 20 - CASTLE_SIZE, y: 20 },
    { x: 20, y: CANVAS_HEIGHT2 - 20 - CASTLE_SIZE },
    { x: CANVAS_WIDTH2 - 20 - CASTLE_SIZE, y: CANVAS_HEIGHT2 - 20 - CASTLE_SIZE }
  ];
  var SHIELD_WIDTH = 45;
  var SHIELD_HEIGHT = 12;
  var SHIELD_SPEED_AI = 0.012;
  var FIREBALL_RADIUS = 6;
  var FIREBALL_SPEED_SLOW = 2.5;
  var FIREBALL_SPEED_FAST = 5;
  var MAX_FIREBALLS = 4;
  var BOUNCE_LIMIT = 60;
  var GAME_TICK_RATE = 60;
  var TICK_MS2 = 1e3 / GAME_TICK_RATE;
  var AI_CONFIG = {
    shieldSpeed: SHIELD_SPEED_AI,
    reactionDelay: 15,
    throwAccuracy: 0.6,
    predictBalls: true
  };
  function getShieldPosition(angle, cornerIndex) {
    const pos = CASTLE_POSITIONS[cornerIndex];
    const cx = pos.x + CASTLE_SIZE / 2;
    const cy = pos.y + CASTLE_SIZE / 2;
    const orbitRadius = (CASTLE_SIZE / 2 + 16) * 1.25;
    const x = cx + orbitRadius * Math.cos(angle);
    const y = cy + orbitRadius * Math.sin(angle);
    const facingAngle = angle + Math.PI / 2;
    return { x, y, angle: facingAngle };
  }
  var GAME_SETTINGS = [
    { key: "ballSpeed", label: "Ball Speed", type: "select", default: "fast", options: ["fast", "slow"] },
    { key: "shieldSpeed", label: "Shield Speed", type: "range", default: 9, min: 1, max: 20, step: 1 },
    { key: "battlesToWin", label: "Battles to Win", type: "range", default: 3, min: 1, max: 7, step: 1 }
  ];

  // src/games/warlords/state.ts
  function getBrickLayout() {
    const bricks = [];
    const cols = 6;
    const rows = 6;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        bricks.push({ x: c * BRICK_WIDTH, y: r * BRICK_HEIGHT });
      }
    }
    return bricks;
  }
  function createCastle(cornerIndex) {
    const layout = getBrickLayout();
    const pos = CASTLE_POSITIONS[cornerIndex];
    const bricks = layout.map((b) => ({
      x: pos.x + b.x,
      y: pos.y + b.y,
      hp: BRICK_HP,
      flashTimer: 0
    }));
    return { bricks, destroyed: false, warlordAlive: true };
  }
  function createShield() {
    return { angle: 0 };
  }
  function createInitialState2(config) {
    const battlesToWin = Number(config.settings["battlesToWin"] ?? 3);
    const ballSpeed = config.settings["ballSpeed"] ?? "fast";
    const shieldSpeedPct = Number(config.settings["shieldSpeed"] ?? 9);
    const allPlayerIds = [...config.playerIds, ...config.aiSlots];
    const players = allPlayerIds.map((id) => {
      const humanIndex = config.playerIds.indexOf(id);
      return {
        id,
        name: humanIndex >= 0 ? config.playerNames[humanIndex] : `AI ${id + 1}`,
        color: humanIndex >= 0 ? config.playerColors[humanIndex] : ["yellow", "white", "red", "blue", "green", "orange", "magenta", "cyan"][id],
        score: 0,
        isAI: config.aiSlots.includes(id),
        connected: true,
        castle: createCastle(id),
        shield: createShield(),
        alive: true,
        ghostX: 0,
        ghostY: 0,
        ghostActive: false,
        ghostTimer: 0
      };
    });
    return {
      tick: 0,
      phase: "dragon",
      players,
      balls: [],
      battleNumber: 1,
      winner: null,
      dragonX: CANVAS_WIDTH2 / 2,
      dragonY: 50,
      dragonTimer: 0,
      battlesToWin,
      ballSpeed,
      shieldSpeed: shieldSpeedPct
    };
  }

  // src/games/warlords/engine.ts
  function getShieldPosition2(angle, cornerIndex) {
    const pos = CASTLE_POSITIONS[cornerIndex];
    const cx = pos.x + CASTLE_SIZE / 2;
    const cy = pos.y + CASTLE_SIZE / 2;
    const orbitRadius = (CASTLE_SIZE / 2 + 16) * 1.25;
    const x = cx + orbitRadius * Math.cos(angle);
    const y = cy + orbitRadius * Math.sin(angle);
    const facingAngle = angle + Math.PI / 2;
    return { x, y, angle: facingAngle };
  }
  function getShieldBounds(player) {
    const sp = getShieldPosition2(player.shield.angle, player.id);
    return {
      x: sp.x - SHIELD_WIDTH / 2,
      y: sp.y - SHIELD_HEIGHT / 2,
      w: SHIELD_WIDTH,
      h: SHIELD_HEIGHT
    };
  }
  function getWarlordPosition(player) {
    const pos = CASTLE_POSITIONS[player.id];
    return {
      x: pos.x + BRICK_WIDTH * 6 / 2,
      y: pos.y + BRICK_HEIGHT * 6 / 2
    };
  }
  function createCastleForPlayer(playerId) {
    const pos = CASTLE_POSITIONS[playerId];
    const bricks = [];
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 6; c++) {
        bricks.push({
          x: pos.x + c * BRICK_WIDTH,
          y: pos.y + r * BRICK_HEIGHT,
          hp: 2,
          flashTimer: 0
        });
      }
    }
    return { bricks, destroyed: false, warlordAlive: true };
  }
  function spawnFireball(x, y, vx, vy, speed, owner) {
    return { x, y, vx, vy, speed, spin: 0, owner, bounceCount: 0 };
  }
  function getBallSpeed(state) {
    return state.ballSpeed === "fast" ? FIREBALL_SPEED_FAST : FIREBALL_SPEED_SLOW;
  }
  function updateBall(ball) {
    ball.x += ball.vx;
    ball.y += ball.vy;
    ball.spin += 0.3;
    const currentSpeed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
    if (currentSpeed < 8) {
      const scale = 8 / currentSpeed;
      ball.vx *= scale;
      ball.vy *= scale;
    } else if (currentSpeed > 20) {
      const scale = 20 / currentSpeed;
      ball.vx *= scale;
      ball.vy *= scale;
    }
  }
  function perturbVelocity(ball, amount) {
    const currentSpeed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
    if (currentSpeed === 0)
      return;
    const angle = Math.atan2(ball.vy, ball.vx) + (Math.random() - 0.5) * amount;
    ball.vx = Math.cos(angle) * currentSpeed;
    ball.vy = Math.sin(angle) * currentSpeed;
  }
  function bounceOffWalls(ball) {
    let bounced = false;
    const halfW = CANVAS_WIDTH2 / 2;
    const halfH = CANVAS_HEIGHT2 / 2;
    if (ball.x - FIREBALL_RADIUS <= 0) {
      ball.x = FIREBALL_RADIUS;
      ball.vx = Math.abs(ball.vx);
      const centerWeight = 1 - Math.abs(ball.y - halfH) / halfH;
      const pushDir = ball.y < halfH ? -1 : 1;
      ball.vy += pushDir * centerWeight * 3;
      perturbVelocity(ball, 0.15);
      bounced = true;
    } else if (ball.x + FIREBALL_RADIUS >= CANVAS_WIDTH2) {
      ball.x = CANVAS_WIDTH2 - FIREBALL_RADIUS;
      ball.vx = -Math.abs(ball.vx);
      const centerWeight = 1 - Math.abs(ball.y - halfH) / halfH;
      const pushDir = ball.y < halfH ? -1 : 1;
      ball.vy += pushDir * centerWeight * 3;
      perturbVelocity(ball, 0.15);
      bounced = true;
    }
    if (ball.y - FIREBALL_RADIUS <= 0) {
      ball.y = FIREBALL_RADIUS;
      ball.vy = Math.abs(ball.vy);
      const centerWeight = 1 - Math.abs(ball.x - halfW) / halfW;
      const pushDir = ball.x < halfW ? -1 : 1;
      ball.vx += pushDir * centerWeight * 3;
      perturbVelocity(ball, 0.15);
      bounced = true;
    } else if (ball.y + FIREBALL_RADIUS >= CANVAS_HEIGHT2) {
      ball.y = CANVAS_HEIGHT2 - FIREBALL_RADIUS;
      ball.vy = -Math.abs(ball.vy);
      const centerWeight = 1 - Math.abs(ball.x - halfW) / halfW;
      const pushDir = ball.x < halfW ? -1 : 1;
      ball.vx += pushDir * centerWeight * 3;
      perturbVelocity(ball, 0.15);
      bounced = true;
    }
    if (bounced)
      ball.bounceCount++;
    return bounced;
  }
  function isBallOverlappingBrick(ball, brick) {
    return ball.x + FIREBALL_RADIUS > brick.x && ball.x - FIREBALL_RADIUS < brick.x + BRICK_WIDTH && ball.y + FIREBALL_RADIUS > brick.y && ball.y - FIREBALL_RADIUS < brick.y + BRICK_HEIGHT;
  }
  function handleCastleCollision(ball, state, targetPlayerId) {
    const player = state.players[targetPlayerId];
    if (!player || !player.alive) {
      return { hit: false, destroyed: false, brickX: 0, brickY: 0 };
    }
    let hit = false;
    let destroyed = false;
    let lastBrickX = 0, lastBrickY = 0;
    for (let pass = 0; pass < 3; pass++) {
      let resolved = false;
      for (const brick of player.castle.bricks) {
        if (brick.hp <= 0)
          continue;
        if (!isBallOverlappingBrick(ball, brick))
          continue;
        const brickCenterX = brick.x + BRICK_WIDTH / 2;
        const brickCenterY = brick.y + BRICK_HEIGHT / 2;
        const dx = ball.x - brickCenterX;
        const dy = ball.y - brickCenterY;
        const overlapX = BRICK_WIDTH / 2 + FIREBALL_RADIUS - Math.abs(dx);
        const overlapY = BRICK_HEIGHT / 2 + FIREBALL_RADIUS - Math.abs(dy);
        if (overlapX < overlapY) {
          ball.vx = -ball.vx;
          ball.x += (dx > 0 ? 1 : -1) * (overlapX + FIREBALL_RADIUS);
        } else {
          ball.vy = -ball.vy;
          ball.y += (dy > 0 ? 1 : -1) * (overlapY + FIREBALL_RADIUS);
        }
        perturbVelocity(ball, 0.1);
        let safety = 0;
        while (isBallOverlappingBrick(ball, brick) && safety < 10) {
          if (overlapX < overlapY) {
            ball.x += (dx > 0 ? 1 : -1) * FIREBALL_RADIUS;
          } else {
            ball.y += (dy > 0 ? 1 : -1) * FIREBALL_RADIUS;
          }
          safety++;
        }
        brick.hp--;
        hit = true;
        if (brick.hp <= 0)
          destroyed = true;
        lastBrickX = brick.x;
        lastBrickY = brick.y;
        ball.bounceCount++;
        resolved = true;
      }
      if (!resolved)
        break;
    }
    return { hit, destroyed, brickX: lastBrickX, brickY: lastBrickY };
  }
  function handleShieldRicochet(ball, player) {
    const bounds = getShieldBounds(player);
    const oldX = ball.x - ball.vx;
    const oldY = ball.y - ball.vy;
    const dx = ball.x - oldX;
    const dy = ball.y - oldY;
    const minX = bounds.x - FIREBALL_RADIUS;
    const maxX = bounds.x + bounds.w + FIREBALL_RADIUS;
    const minY = bounds.y - FIREBALL_RADIUS;
    const maxY = bounds.y + bounds.h + FIREBALL_RADIUS;
    if (ball.x >= minX && ball.x <= maxX && ball.y >= minY && ball.y <= maxY) {
    } else {
      let tEnter = 0, tExit = 1;
      if (Math.abs(dx) > 1e-10) {
        const t1 = (minX - oldX) / dx, t2 = (maxX - oldX) / dx;
        tEnter = Math.max(tEnter, Math.min(t1, t2));
        tExit = Math.min(tExit, Math.max(t1, t2));
        if (tEnter > tExit)
          return false;
      } else {
        if (oldX < minX || oldX > maxX)
          return false;
      }
      if (Math.abs(dy) > 1e-10) {
        const t1 = (minY - oldY) / dy, t2 = (maxY - oldY) / dy;
        tEnter = Math.max(tEnter, Math.min(t1, t2));
        tExit = Math.min(tExit, Math.max(t1, t2));
        if (tEnter > tExit)
          return false;
      } else {
        if (oldY < minY || oldY > maxY)
          return false;
      }
      if (tEnter < 0)
        return false;
    }
    const sp = getShieldPosition2(player.shield.angle, player.id);
    const shieldAngle = sp.angle;
    const cx = bounds.x + bounds.w / 2;
    const cy = bounds.y + bounds.h / 2;
    const contactX = ball.x - cx;
    const contactY = ball.y - cy;
    const normX = contactX / (bounds.w / 2);
    const normY = contactY / (bounds.h / 2);
    const isFrontBack = Math.abs(normY) < Math.abs(normX);
    const centerNorm = isFrontBack ? Math.abs(normY) : Math.abs(normX);
    const centerWeight = 1 - centerNorm;
    const shieldNx = Math.cos(shieldAngle);
    const shieldNy = Math.sin(shieldAngle);
    const faceNx = isFrontBack ? 0 : normX > 0 ? 1 : -1;
    const faceNy = isFrontBack ? normY > 0 ? 1 : -1 : 0;
    const reflectNx = shieldNx * centerWeight + faceNx * (1 - centerWeight);
    const reflectNy = shieldNy * centerWeight + faceNy * (1 - centerWeight);
    const reflectLen = Math.sqrt(reflectNx * reflectNx + reflectNy * reflectNy);
    const rnx = reflectLen > 0 ? reflectNx / reflectLen : shieldNx;
    const rny = reflectLen > 0 ? reflectNy / reflectLen : shieldNy;
    const dot = ball.vx * rnx + ball.vy * rny;
    const strength = 0.7 + centerWeight * 0.5;
    let newVx = ball.vx - 2 * dot * rnx * strength;
    let newVy = ball.vy - 2 * dot * rny * strength;
    if (centerWeight < 0.5) {
      const tangentX = -rny;
      const tangentY = rnx;
      const tangentDot = ball.vx * tangentX + ball.vy * tangentY;
      newVx += tangentDot * tangentX * (1 - centerWeight) * 0.3;
      newVy += tangentDot * tangentY * (1 - centerWeight) * 0.3;
    }
    ball.vx = newVx;
    ball.vy = newVy;
    perturbVelocity(ball, 0.12);
    const newSpeed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
    if (newSpeed > 0.01) {
      const nx = ball.vx / newSpeed;
      const ny = ball.vy / newSpeed;
      for (let step = 0; step < 200; step++) {
        ball.x += nx * 2;
        ball.y += ny * 2;
        const outside = ball.x + FIREBALL_RADIUS < bounds.x || ball.x - FIREBALL_RADIUS > bounds.x + bounds.w || ball.y + FIREBALL_RADIUS < bounds.y || ball.y - FIREBALL_RADIUS > bounds.y + bounds.h;
        if (outside)
          break;
      }
    }
    ball.x = Math.max(FIREBALL_RADIUS, Math.min(CANVAS_WIDTH2 - FIREBALL_RADIUS, ball.x));
    ball.y = Math.max(FIREBALL_RADIUS, Math.min(CANVAS_HEIGHT2 - FIREBALL_RADIUS, ball.y));
    ball.bounceCount++;
    return true;
  }
  function ballHitsWarlord(ball, player) {
    if (!player.alive)
      return false;
    const wl = getWarlordPosition(player);
    return dist(ball.x, ball.y, wl.x, wl.y) < FIREBALL_RADIUS + 8;
  }
  function rotateToward(currentAngle, targetAngle, maxDelta) {
    let diff = targetAngle - currentAngle;
    if (Math.abs(diff) > Math.PI) {
      diff = diff > 0 ? diff - Math.PI * 2 : diff + Math.PI * 2;
    }
    return currentAngle + clamp(diff, -maxDelta, maxDelta);
  }
  function aiComputeInput(state, playerId) {
    const player = state.players.find((p) => p.id === playerId);
    if (!player || !player.alive) {
      return { SHIELD_LEFT: false, SHIELD_RIGHT: false };
    }
    const castle = { x: CASTLE_POSITIONS[playerId].x + CASTLE_SIZE / 2, y: CASTLE_POSITIONS[playerId].y + CASTLE_SIZE / 2 };
    let bestThreat = null;
    let bestScore = Infinity;
    for (const ball of state.balls) {
      if (ball.owner === playerId)
        continue;
      const ballDistToCastle = dist(ball.x, ball.y, castle.x, castle.y);
      const toCastleDist = Math.sqrt((castle.x - ball.x) ** 2 + (castle.y - ball.y) ** 2);
      const ballSpeed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
      let headingTowardCastle = 1;
      if (ballSpeed > 0 && toCastleDist > 0) {
        const ballDirX = ball.vx / ballSpeed;
        const ballDirY = ball.vy / ballSpeed;
        const castleDirX = (castle.x - ball.x) / toCastleDist;
        const castleDirY = (castle.y - ball.y) / toCastleDist;
        headingTowardCastle = Math.max(0, ballDirX * castleDirX + ballDirY * castleDirY);
      }
      const score = ballDistToCastle * (1 - headingTowardCastle * 0.7);
      if (score < bestScore) {
        bestScore = score;
        bestThreat = ball;
      }
    }
    let targetAngle;
    if (bestThreat) {
      const ballSpeed = Math.sqrt(bestThreat.vx * bestThreat.vx + bestThreat.vy * bestThreat.vy);
      if (ballSpeed > 0.1) {
        const dx = castle.x - bestThreat.x;
        const dy = castle.y - bestThreat.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        const t = Math.max(5, d / ballSpeed);
        const predX = bestThreat.x + bestThreat.vx * t;
        const predY = bestThreat.y + bestThreat.vy * t;
        targetAngle = Math.atan2(predY - castle.y, predX - castle.x);
      } else {
        targetAngle = player.shield.angle;
      }
    } else {
      let ballCenterX = CANVAS_WIDTH2 / 2;
      let ballCenterY = CANVAS_HEIGHT2 / 2;
      if (state.balls.length > 0) {
        for (const ball of state.balls) {
          ballCenterX += ball.x;
          ballCenterY += ball.y;
        }
        ballCenterX /= state.balls.length;
        ballCenterY /= state.balls.length;
      }
      targetAngle = Math.atan2(ballCenterY - castle.y, ballCenterX - castle.x);
    }
    const moveAmount = AI_CONFIG.shieldSpeed * 2;
    const newAngle = rotateToward(player.shield.angle, targetAngle, moveAmount);
    let diff = normalizeAngle(newAngle) - normalizeAngle(player.shield.angle);
    if (diff > Math.PI)
      diff -= Math.PI * 2;
    if (diff < -Math.PI)
      diff += Math.PI * 2;
    return {
      SHIELD_LEFT: diff < -0.01,
      SHIELD_RIGHT: diff > 0.01
    };
  }
  function tick2(state, inputs, dt) {
    const next = {
      ...state,
      tick: state.tick + 1,
      players: state.players.map((p) => ({
        ...p,
        castle: {
          ...p.castle,
          bricks: p.castle.bricks.map((b) => ({ ...b }))
        },
        shield: { ...p.shield }
      })),
      balls: state.balls.map((b) => ({ ...b }))
    };
    const events = [];
    for (const player of next.players) {
      const inp = inputs.get(player.id) ?? {};
      const shieldSpeed = state.shieldSpeed / 20 * 0.09;
      if (player.alive) {
        const isTopSide = CASTLE_POSITIONS[player.id].y < CANVAS_HEIGHT2 / 2;
        const dir = isTopSide ? -1 : 1;
        if (inp.SHIELD_LEFT) {
          player.shield.angle -= shieldSpeed * dir;
        }
        if (inp.SHIELD_RIGHT) {
          player.shield.angle += shieldSpeed * dir;
        }
        player.shield.angle = (player.shield.angle % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      }
    }
    if (next.phase === "dragon") {
      next.dragonTimer++;
      if (next.dragonTimer === 60) {
        const alivePlayers = next.players.filter((p) => p.alive);
        if (alivePlayers.length > 0) {
          const target = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
          const targetPos = CASTLE_POSITIONS[target.id];
          const targetX = targetPos.x + CASTLE_SIZE / 2;
          const targetY = targetPos.y + CASTLE_SIZE / 2;
          const dx = targetX - next.dragonX;
          const dy = targetY - next.dragonY;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d > 0 && next.balls.length < MAX_FIREBALLS) {
            const speed = getBallSpeed(next);
            next.balls.push(spawnFireball(
              next.dragonX,
              next.dragonY,
              dx / d,
              dy / d,
              speed,
              null
            ));
            events.push({ type: "ball_spawned", x: next.dragonX, y: next.dragonY, vx: dx / d, vy: dy / d });
          }
        }
      }
      if (next.dragonTimer > 120) {
        next.phase = "playing";
        events.push({ type: "battle_start", battleNumber: next.battleNumber });
      }
    }
    const ballsToRemove = [];
    for (let i = 0; i < next.balls.length; i++) {
      const ball = next.balls[i];
      updateBall(ball);
      for (const player of next.players) {
        if (player.alive) {
          const result = handleCastleCollision(ball, next, player.id);
          if (result.hit) {
            if (result.destroyed) {
              events.push({ type: "brick_destroyed", x: result.brickX, y: result.brickY, playerId: player.id });
            }
          }
          if (ballHitsWarlord(ball, player)) {
            player.alive = false;
            player.ghostActive = true;
            const wl = getWarlordPosition(player);
            player.ghostX = wl.x;
            player.ghostY = wl.y;
            player.ghostTimer = 0;
            events.push({ type: "warlord_dead", playerId: player.id });
            const aliveOthers = next.players.filter((p) => p.alive && p.id !== player.id);
            if (aliveOthers.length > 0 && next.balls.length < MAX_FIREBALLS) {
              const killerId = ball.owner;
              if (killerId !== null && killerId !== player.id) {
                const killer = next.players[killerId];
                if (killer && killer.alive) {
                  const killerPos = CASTLE_POSITIONS[killerId];
                  const targetPos = CASTLE_POSITIONS[player.id];
                  const tx = targetPos.x + CASTLE_SIZE / 2;
                  const ty = targetPos.y + CASTLE_SIZE / 2;
                  const kx = killerPos.x + CASTLE_SIZE / 2;
                  const ky = killerPos.y + CASTLE_SIZE / 2;
                  const ddx = tx - kx;
                  const ddy = ty - ky;
                  const dd = Math.sqrt(ddx * ddx + ddy * ddy);
                  if (dd > 0) {
                    const speed2 = getBallSpeed(next);
                    next.balls.push(spawnFireball(kx, ky, ddx / dd, ddy / dd, speed2, killerId));
                  }
                }
              }
            }
          }
        }
      }
      for (const player of next.players) {
        if (player.alive && handleShieldRicochet(ball, player)) {
          events.push({ type: "shield_hit", x: ball.x, y: ball.y, angle: 0 });
        }
      }
      bounceOffWalls(ball);
      const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
      if (speed === 0 || isNaN(speed) || !isFinite(speed)) {
        ballsToRemove.push(i);
        continue;
      }
      if (ball.x < -50 || ball.x > CANVAS_WIDTH2 + 50 || ball.y < -50 || ball.y > CANVAS_HEIGHT2 + 50) {
        ballsToRemove.push(i);
        continue;
      }
    }
    for (let i = ballsToRemove.length - 1; i >= 0; i--) {
      next.balls.splice(ballsToRemove[i], 1);
    }
    for (let i = next.balls.length - 1; i >= 0; i--) {
      const ball = next.balls[i];
      if (ball.bounceCount >= BOUNCE_LIMIT && next.balls.length < MAX_FIREBALLS) {
        const angle = seededRandom(next.tick * 7 + i * 13) * Math.PI * 2;
        const speed = getBallSpeed(next);
        next.balls.push(spawnFireball(
          CANVAS_WIDTH2 / 2,
          CANVAS_HEIGHT2 / 2,
          Math.cos(angle),
          Math.sin(angle),
          speed,
          null
        ));
        ball.bounceCount = 0;
      }
    }
    while (next.balls.length > MAX_FIREBALLS) {
      next.balls.pop();
    }
    if (next.phase === "playing" && next.balls.length === 0) {
      const angle = seededRandom(next.tick * 3 + 42) * Math.PI * 2;
      const speed = getBallSpeed(next);
      next.balls.push(spawnFireball(
        CANVAS_WIDTH2 / 2,
        CANVAS_HEIGHT2 / 2,
        Math.cos(angle),
        Math.sin(angle),
        speed,
        null
      ));
    }
    for (const player of next.players) {
      if (!player.ghostActive)
        continue;
      player.ghostTimer++;
      player.ghostX += Math.sin(player.ghostTimer * 0.05) * 0.3;
      player.ghostY += Math.cos(player.ghostTimer * 0.03) * 0.2;
    }
    if (next.phase === "playing") {
      const alivePlayers = next.players.filter((p) => p.alive);
      if (alivePlayers.length <= 1) {
        const winner = alivePlayers.length === 1 ? alivePlayers[0].id : null;
        if (winner !== null) {
          next.phase = "battle_end";
          const winnerPlayer = next.players[winner];
          if (winnerPlayer) {
            winnerPlayer.score++;
          }
          events.push({ type: "battle_won", winner });
          const warWinner = next.players.find((p) => p.score >= next.battlesToWin);
          if (warWinner) {
            next.phase = "game_over";
            next.winner = warWinner.id;
            events.push({ type: "war_won", winner: warWinner.id });
          } else {
            next._battleResetTick = next.tick + 120;
          }
        }
      }
    }
    if (next.phase === "battle_end" && next._battleResetTick !== void 0 && next.tick >= next._battleResetTick) {
      delete next._battleResetTick;
      for (const player of next.players) {
        player.alive = true;
        player.castle = createCastleForPlayer(player.id);
        player.shield.angle = 0;
        player.ghostActive = false;
        player.ghostTimer = 0;
      }
      next.balls = [];
      next.phase = "dragon";
      next.dragonTimer = 0;
      next.battleNumber++;
      events.push({ type: "battle_start", battleNumber: next.battleNumber });
    }
    return { state: next, events };
  }
  function isGameOver2(state) {
    return state.phase === "game_over";
  }
  function getWinner2(state) {
    if (state.players.length === 1)
      return state.players[0].id;
    if (state.winner !== null)
      return state.winner;
    const sorted = [...state.players].sort((a, b) => b.score - a.score);
    if (sorted[0].score === sorted[1]?.score)
      return null;
    return sorted[0].id;
  }
  var aiAdapter2 = {
    computeInput(state, playerId) {
      return aiComputeInput(state, playerId);
    }
  };

  // src/games/warlords/input.ts
  var actions2 = {
    SHIELD_LEFT: { label: "Shield Rotate Left", type: "held" },
    SHIELD_RIGHT: { label: "Shield Rotate Right", type: "held" }
  };
  var defaultActionMap2 = {
    keyboard: {
      ArrowLeft: "SHIELD_LEFT",
      KeyA: "SHIELD_LEFT",
      ArrowRight: "SHIELD_RIGHT",
      KeyD: "SHIELD_RIGHT"
    },
    mouseWheel: {
      up: "SHIELD_RIGHT",
      down: "SHIELD_LEFT"
    },
    gamepad: {
      buttons: {},
      axes: { 0: "SHIELD_RIGHT" }
    }
  };

  // src/games/warlords/renderer.ts
  function getPlayerColor(color, variant) {
    const colorMap = {
      yellow: { castle: "#ffff00", "castle-dim": "#aaaa00", shield: "#ffff00", warlord: "#ffff00" },
      white: { castle: "#ffffff", "castle-dim": "#aaaaaa", shield: "#ffffff", warlord: "#ffffff" },
      red: { castle: "#ff4444", "castle-dim": "#aa2222", shield: "#ff4444", warlord: "#ff4444" },
      blue: { castle: "#4488ff", "castle-dim": "#2244aa", shield: "#4488ff", warlord: "#4488ff" },
      green: { castle: "#44ff88", "castle-dim": "#22aa44", shield: "#44ff88", warlord: "#44ff88" },
      orange: { castle: "#ff8844", "castle-dim": "#aa4422", shield: "#ff8844", warlord: "#ff8844" },
      magenta: { castle: "#ff44ff", "castle-dim": "#aa22aa", shield: "#ff44ff", warlord: "#ff44ff" },
      cyan: { castle: "#44ffff", "castle-dim": "#22aaaa", shield: "#44ffff", warlord: "#44ffff" }
    };
    return colorMap[color]?.[variant] || "#ffffff";
  }
  function getWarlordPosition2(player) {
    const pos = CASTLE_POSITIONS[player.id];
    return {
      x: pos.x + BRICK_WIDTH * 6 / 2,
      y: pos.y + BRICK_HEIGHT * 6 / 2
    };
  }
  var renderer2 = {
    render(ctx, state, myPlayerId) {
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      ctx.strokeStyle = "#444444";
      ctx.lineWidth = 2;
      ctx.strokeRect(20, 20, CANVAS_WIDTH - 40, CANVAS_HEIGHT - 40);
      ctx.strokeStyle = "#222222";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(CANVAS_WIDTH / 2, 20);
      ctx.lineTo(CANVAS_WIDTH / 2, CANVAS_HEIGHT - 20);
      ctx.moveTo(20, CANVAS_HEIGHT / 2);
      ctx.lineTo(CANVAS_WIDTH - 20, CANVAS_HEIGHT / 2);
      ctx.stroke();
      for (const player of state.players) {
        for (const brick of player.castle.bricks) {
          if (brick.hp <= 0)
            continue;
          ctx.fillStyle = brick.hp === 2 ? getPlayerColor(player.color, "castle") : getPlayerColor(player.color, "castle-dim");
          ctx.fillRect(brick.x, brick.y, BRICK_WIDTH, BRICK_HEIGHT);
        }
      }
      for (const player of state.players) {
        if (!player.alive)
          continue;
        const pos = getWarlordPosition2(player);
        const cx = pos.x;
        const cy = pos.y;
        const w = 10;
        const h = 8;
        ctx.fillStyle = getPlayerColor(player.color, "castle-dim");
        ctx.beginPath();
        ctx.moveTo(cx - w, cy + h);
        ctx.lineTo(cx - w, cy - h / 2);
        ctx.lineTo(cx - w / 2, cy - h / 2);
        ctx.lineTo(cx - w / 4, cy - h);
        ctx.lineTo(cx, cy - h / 2);
        ctx.lineTo(cx + w / 4, cy - h);
        ctx.lineTo(cx + w / 2, cy - h / 2);
        ctx.lineTo(cx + w, cy - h / 2);
        ctx.lineTo(cx + w, cy + h);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      for (const player of state.players) {
        if (!player.ghostActive)
          continue;
        const alpha = 0.3 + Math.sin(player.ghostTimer * 0.1) * 0.2;
        ctx.fillStyle = `rgba(200, 200, 200, ${alpha})`;
        ctx.beginPath();
        ctx.arc(player.ghostX, player.ghostY, 12, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
        ctx.beginPath();
        ctx.arc(player.ghostX - 4, player.ghostY - 2, 2, 0, Math.PI * 2);
        ctx.arc(player.ghostX + 4, player.ghostY - 2, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      for (const ball of state.balls) {
        const gradient = ctx.createRadialGradient(
          ball.x,
          ball.y,
          0,
          ball.x,
          ball.y,
          FIREBALL_RADIUS * 2
        );
        gradient.addColorStop(0, "#ff8800");
        gradient.addColorStop(0.5, "#ff4400");
        gradient.addColorStop(1, "rgba(255, 68, 0, 0)");
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(ball.x, ball.y, FIREBALL_RADIUS * 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ffcc00";
        ctx.beginPath();
        ctx.arc(ball.x, ball.y, FIREBALL_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#ff6600";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(ball.x, ball.y, FIREBALL_RADIUS - 1, ball.spin, ball.spin + Math.PI);
        ctx.stroke();
      }
      for (const player of state.players) {
        if (!player.alive)
          continue;
        const sp = getShieldPosition(player.shield.angle, player.id);
        const { x, y, angle } = sp;
        ctx.fillStyle = getPlayerColor(player.color, "shield");
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);
        ctx.fillRect(-SHIELD_WIDTH / 2, -SHIELD_HEIGHT / 2, SHIELD_WIDTH, SHIELD_HEIGHT);
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = 1;
        ctx.strokeRect(-SHIELD_WIDTH / 2, -SHIELD_HEIGHT / 2, SHIELD_WIDTH, SHIELD_HEIGHT);
        ctx.restore();
      }
      if (state.phase === "dragon") {
        const dx = state.dragonX;
        const dy = state.dragonY;
        ctx.fillStyle = "#8800ff";
        ctx.beginPath();
        ctx.moveTo(dx, dy - 12);
        ctx.lineTo(dx + 12, dy + 8);
        ctx.lineTo(dx + 6, dy + 8);
        ctx.lineTo(dx + 6, dy + 12);
        ctx.lineTo(dx - 6, dy + 12);
        ctx.lineTo(dx - 6, dy + 8);
        ctx.lineTo(dx - 12, dy + 8);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#ff0000";
        ctx.beginPath();
        ctx.arc(dx - 4, dy, 2, 0, Math.PI * 2);
        ctx.arc(dx + 4, dy, 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.font = "10px monospace";
        ctx.textAlign = "center";
        ctx.fillText("DRAGON", dx, dy + 24);
      }
      ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
      ctx.fillRect(0, 0, CANVAS_WIDTH, 30);
      const numPlayers = state.players.length;
      const colors = {
        0: "#ffff00",
        1: "#ffffff",
        2: "#ff4444",
        3: "#4488ff",
        4: "#44ff88",
        5: "#ff8844",
        6: "#ff44ff",
        7: "#44ffff"
      };
      const names = {
        0: "P1",
        1: "P2",
        2: "P3",
        3: "P4",
        4: "P5",
        5: "P6",
        6: "P7",
        7: "P8"
      };
      ctx.font = "14px monospace";
      ctx.textAlign = "left";
      for (let i = 0; i < numPlayers; i++) {
        const player = state.players[i];
        const x = 10 + i * Math.floor((CANVAS_WIDTH - 40) / numPlayers);
        ctx.fillStyle = colors[player.id] ?? "#ffffff";
        ctx.fillText(
          `${names[player.id] ?? "P" + (player.id + 1)}: ${player.score}  ${player.alive ? "\u25CF" : "\u2717"}`,
          x,
          20
        );
      }
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.font = "13px monospace";
      ctx.fillText(`Battle ${state.battleNumber}`, CANVAS_WIDTH / 2, 20);
      if (state.phase === "battle_end") {
        ctx.fillStyle = "#ffcc00";
        ctx.font = "20px monospace";
        ctx.textAlign = "center";
        ctx.fillText("BATTLE COMPLETE", CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
      }
      if (state.phase === "game_over" && state.winner !== null) {
        ctx.fillStyle = "#ffcc00";
        ctx.font = "bold 24px monospace";
        ctx.textAlign = "center";
        ctx.fillText(`PLAYER ${state.winner + 1} WINS THE WAR!`, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 - 20);
      }
      if (state.phase === "dragon") {
        ctx.fillStyle = "#8800ff";
        ctx.font = "bold 18px monospace";
        ctx.textAlign = "center";
        ctx.fillText("DRAGON ATTACK!", CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
      }
    }
  };

  // src/games/warlords/definition.ts
  var definition2 = {
    id: "warlords",
    name: "Warlords",
    description: "Destroy enemy castles and warlords in this classic arcade shooter.",
    minPlayers: 1,
    maxPlayers: 4,
    actions: actions2,
    defaultActionMap: defaultActionMap2,
    createInitialState: createInitialState2,
    tick: tick2,
    isGameOver: isGameOver2,
    getWinner: getWinner2,
    renderer: renderer2,
    aiAdapter: aiAdapter2,
    howToPlay: `
    <h3>Objective</h3>
    <p>Destroy the enemy warlord (crown) in the center of each castle.
    The first player to win the required number of battles wins the war.</p>
    <h3>Controls</h3>
    <ul>
      <li>Arrow Left / A \u2014 Rotate shield counter-clockwise</li>
      <li>Arrow Right / D \u2014 Rotate shield clockwise</li>
      <li>Mouse Wheel \u2014 Rotate shield</li>
    </ul>
    <h3>Gameplay</h3>
    <p>Each battle begins with a dragon launching a fireball.
    Deflect fireballs with your rotating shield.
    Destroy the enemy castle bricks to expose the warlord.
    Hit the exposed warlord to win the battle.
    Your dead warlord launches a retaliatory fireball.</p>
    <h3>Shields</h3>
    <p>Each player has a shield that orbits their castle.
    Use it to ricochet fireballs toward other players.</p>
  `,
    settings: GAME_SETTINGS,
    clientHooks: {
      onEvent(event, state) {
        if (event.type === "brick_destroyed") {
        } else if (event.type === "warlord_dead") {
        } else if (event.type === "battle_won") {
        } else if (event.type === "war_won") {
        } else if (event.type === "shield_hit") {
        }
      }
    }
  };
  var definition_default2 = definition2;

  // src/games/pong/constants.ts
  var PADDLE_WIDTH = 12;
  var PADDLE_HEIGHT = 80;
  var BALL_SIZE = 10;
  var PADDLE_SPEED = 440;
  var BALL_SPEED_INITIAL = 320;
  var BALL_SPEED_MAX = 720;
  var SPEED_INCREASE_PCT_DEFAULT = 5;
  var WIN_SCORE = 7;
  var PADDLE_X = 40;

  // src/games/pong/state.ts
  function createInitialState3(config) {
    return {
      tick: 0,
      phase: "playing",
      hitCount: 0,
      speedIncreasePct: typeof config.settings.speedIncreasePct === "number" ? config.settings.speedIncreasePct : SPEED_INCREASE_PCT_DEFAULT,
      ball: {
        x: CANVAS_WIDTH / 2,
        y: CANVAS_HEIGHT / 2,
        vx: BALL_SPEED_INITIAL,
        vy: BALL_SPEED_INITIAL * 0.3
      },
      players: config.playerIds.map((id, i) => ({
        id,
        name: config.playerNames[i],
        color: config.playerColors[i],
        score: 0,
        isAI: config.aiSlots.includes(id),
        connected: true,
        paddleY: CANVAS_HEIGHT / 2
      }))
    };
  }

  // src/games/pong/engine.ts
  function tick3(state, inputs, dt) {
    const next = {
      ...state,
      tick: state.tick + 1,
      ball: { ...state.ball },
      players: state.players.map((p) => ({ ...p }))
    };
    for (const player of next.players) {
      const inp = inputs.get(player.id) ?? {};
      if (inp.MOVE_UP)
        player.paddleY -= PADDLE_SPEED * dt;
      if (inp.MOVE_DOWN)
        player.paddleY += PADDLE_SPEED * dt;
      player.paddleY = clamp(
        player.paddleY,
        PADDLE_HEIGHT / 2,
        CANVAS_HEIGHT - PADDLE_HEIGHT / 2
      );
    }
    next.ball.x += next.ball.vx * dt;
    next.ball.y += next.ball.vy * dt;
    if (next.ball.y - BALL_SIZE / 2 <= 0) {
      next.ball.y = BALL_SIZE / 2;
      next.ball.vy = Math.abs(next.ball.vy);
    } else if (next.ball.y + BALL_SIZE / 2 >= CANVAS_HEIGHT) {
      next.ball.y = CANVAS_HEIGHT - BALL_SIZE / 2;
      next.ball.vy = -Math.abs(next.ball.vy);
    }
    const events = [];
    const leftPlayer = next.players[0];
    if (leftPlayer) {
      const px = PADDLE_X;
      const py = leftPlayer.paddleY;
      if (next.ball.vx < 0 && next.ball.x - BALL_SIZE / 2 <= px + PADDLE_WIDTH / 2 && next.ball.x + BALL_SIZE / 2 >= px - PADDLE_WIDTH / 2 && next.ball.y + BALL_SIZE / 2 >= py - PADDLE_HEIGHT / 2 && next.ball.y - BALL_SIZE / 2 <= py + PADDLE_HEIGHT / 2) {
        next.ball.x = px + PADDLE_WIDTH / 2 + BALL_SIZE / 2;
        const rel = clamp((next.ball.y - py) / (PADDLE_HEIGHT / 2), -1, 1);
        const speed = Math.min(speedOf(next.ball) * (1 + next.speedIncreasePct / 100), BALL_SPEED_MAX);
        next.ball.vx = speed * Math.cos(rel * 0.7);
        next.ball.vy = speed * Math.sin(rel * 0.7);
        next.hitCount++;
        events.push({ type: "paddle_hit", paddleIndex: 0 });
      }
    }
    const rightPlayer = next.players[1];
    if (rightPlayer) {
      const px = CANVAS_WIDTH - PADDLE_X;
      const py = rightPlayer.paddleY;
      if (next.ball.vx > 0 && next.ball.x + BALL_SIZE / 2 >= px - PADDLE_WIDTH / 2 && next.ball.x - BALL_SIZE / 2 <= px + PADDLE_WIDTH / 2 && next.ball.y + BALL_SIZE / 2 >= py - PADDLE_HEIGHT / 2 && next.ball.y - BALL_SIZE / 2 <= py + PADDLE_HEIGHT / 2) {
        next.ball.x = px - PADDLE_WIDTH / 2 - BALL_SIZE / 2;
        const rel = clamp((next.ball.y - py) / (PADDLE_HEIGHT / 2), -1, 1);
        const speed = Math.min(speedOf(next.ball) * (1 + next.speedIncreasePct / 100), BALL_SPEED_MAX);
        next.ball.vx = -speed * Math.cos(rel * 0.7);
        next.ball.vy = speed * Math.sin(rel * 0.7);
        next.hitCount++;
        events.push({ type: "paddle_hit", paddleIndex: 1 });
      }
    }
    if (next.ball.x < -BALL_SIZE) {
      if (next.players[1])
        next.players[1].score++;
      events.push({ type: "score", scorer: 1 });
      resetBall(next, 1);
    } else if (next.ball.x > CANVAS_WIDTH + BALL_SIZE) {
      if (next.players[0])
        next.players[0].score++;
      events.push({ type: "score", scorer: 0 });
      resetBall(next, -1);
    }
    for (const player of next.players) {
      if (player.score >= WIN_SCORE) {
        next.phase = "game_over";
        break;
      }
    }
    return { state: next, events };
  }
  function speedOf(ball) {
    return Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
  }
  function resetBall(state, direction) {
    const rng = seededRandom(state.tick);
    const angle = (rng - 0.5) * 0.8;
    const speed = BALL_SPEED_INITIAL;
    state.ball = {
      x: CANVAS_WIDTH / 2,
      y: CANVAS_HEIGHT / 2,
      vx: direction * speed * Math.cos(angle),
      vy: speed * Math.sin(angle)
    };
    state.hitCount = 0;
  }
  function isGameOver3(state) {
    return state.phase === "game_over";
  }
  function getWinner3(state) {
    if (state.players.length < 2)
      return state.players[0]?.id ?? null;
    const sorted = [...state.players].sort((a, b) => b.score - a.score);
    if (sorted[0].score === sorted[1].score)
      return null;
    return sorted[0].id;
  }

  // src/games/pong/input.ts
  var actions3 = {
    MOVE_UP: { label: "Move Up", type: "held" },
    MOVE_DOWN: { label: "Move Down", type: "held" }
  };
  var defaultActionMap3 = {
    keyboard: {
      ArrowUp: "MOVE_UP",
      KeyW: "MOVE_UP",
      ArrowDown: "MOVE_DOWN",
      KeyS: "MOVE_DOWN"
    }
  };

  // src/games/pong/renderer.ts
  var renderer3 = {
    render(ctx, state, myPlayerId) {
      const p0 = state.players[0];
      const p1 = state.players[1];
      ctx.setLineDash([10, 14]);
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(CANVAS_WIDTH / 2, 0);
      ctx.lineTo(CANVAS_WIDTH / 2, CANVAS_HEIGHT);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = "bold 64px monospace";
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      if (p0)
        ctx.fillText(String(p0.score), CANVAS_WIDTH / 2 - 80, 80);
      if (p1)
        ctx.fillText(String(p1.score), CANVAS_WIDTH / 2 + 80, 80);
      const dotY = 95;
      const dotSize = 5;
      const dotGap = 13;
      for (let i = 0; i < WIN_SCORE; i++) {
        const filled0 = p0 && i < p0.score;
        const filled1 = p1 && i < p1.score;
        const baseX0 = CANVAS_WIDTH / 2 - 50 - (WIN_SCORE - 1) * dotGap / 2;
        const baseX1 = CANVAS_WIDTH / 2 + 50 - (WIN_SCORE - 1) * dotGap / 2;
        ctx.fillStyle = filled0 ? "#ffff00" : "rgba(255,255,255,0.2)";
        ctx.beginPath();
        ctx.arc(baseX0 + i * dotGap, dotY, dotSize / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = filled1 ? "#ffffff" : "rgba(255,255,255,0.2)";
        ctx.beginPath();
        ctx.arc(baseX1 + i * dotGap, dotY, dotSize / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      if (p0) {
        const isMe = p0.id === myPlayerId;
        ctx.fillStyle = isMe ? "#ffff88" : "#ffffff";
        ctx.shadowColor = isMe ? "#ffff00" : "transparent";
        ctx.shadowBlur = isMe ? 8 : 0;
        ctx.fillRect(
          PADDLE_X - PADDLE_WIDTH / 2,
          p0.paddleY - PADDLE_HEIGHT / 2,
          PADDLE_WIDTH,
          PADDLE_HEIGHT
        );
      }
      if (p1) {
        const isMe = p1.id === myPlayerId;
        ctx.fillStyle = isMe ? "#ffff88" : "#ffffff";
        ctx.shadowColor = isMe ? "#ffff00" : "transparent";
        ctx.shadowBlur = isMe ? 8 : 0;
        ctx.fillRect(
          CANVAS_WIDTH - PADDLE_X - PADDLE_WIDTH / 2,
          p1.paddleY - PADDLE_HEIGHT / 2,
          PADDLE_WIDTH,
          PADDLE_HEIGHT
        );
      }
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#ffffff";
      ctx.shadowColor = "#ffffff";
      ctx.shadowBlur = 10;
      ctx.fillRect(
        state.ball.x - BALL_SIZE / 2,
        state.ball.y - BALL_SIZE / 2,
        BALL_SIZE,
        BALL_SIZE
      );
      ctx.shadowBlur = 0;
      ctx.font = "11px monospace";
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      if (p0) {
        ctx.textAlign = "left";
        ctx.fillText(p0.name + (p0.isAI ? " [AI]" : ""), PADDLE_X + PADDLE_WIDTH / 2 + 6, CANVAS_HEIGHT - 8);
      }
      if (p1) {
        ctx.textAlign = "right";
        ctx.fillText(p1.name + (p1.isAI ? " [AI]" : ""), CANVAS_WIDTH - PADDLE_X - PADDLE_WIDTH / 2 - 6, CANVAS_HEIGHT - 8);
      }
      ctx.textAlign = "left";
      if (state.phase === "game_over") {
        ctx.fillStyle = "rgba(0,0,0,0.65)";
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        const winner = state.players.reduce((a, b) => a.score > b.score ? a : b, state.players[0]);
        const isWinner = winner?.id === myPlayerId;
        ctx.font = "bold 52px monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = isWinner ? "#ffff44" : "#ffffff";
        ctx.fillText(isWinner ? "YOU WIN!" : "GAME OVER", CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 - 20);
        if (winner) {
          ctx.font = "22px monospace";
          ctx.fillStyle = "#aaa";
          ctx.fillText(`${winner.name} wins ${winner.score}\u2013${state.players.find((p) => p.id !== winner.id)?.score ?? 0}`, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 + 28);
        }
        ctx.textAlign = "left";
      }
    }
  };

  // src/games/pong/definition.ts
  var definition3 = {
    id: "pong",
    name: "Pong",
    description: "Classic 1v1 paddle game. First to 7 wins.",
    minPlayers: 2,
    maxPlayers: 2,
    actions: actions3,
    defaultActionMap: defaultActionMap3,
    createInitialState: createInitialState3,
    tick: tick3,
    isGameOver: isGameOver3,
    getWinner: getWinner3,
    renderer: renderer3,
    howToPlay: `
    <h3>Objective</h3>
    <p>First player to score ${WIN_SCORE} points wins. Score by getting the ball past your opponent's paddle.</p>
    <h3>Controls</h3>
    <ul>
      <li><strong>W / \u2191</strong> \u2014 Move paddle up</li>
      <li><strong>S / \u2193</strong> \u2014 Move paddle down</li>
    </ul>
    <h3>Tips</h3>
    <p>Hit the ball with the edge of your paddle to add angle. The ball speeds up with each hit!</p>
  `,
    settings: [
      { key: "winScore", label: "Points to win", type: "range", default: 7, min: 3, max: 15, step: 1 },
      { key: "speedIncreasePct", label: "Speed increase per hit (%)", type: "range", default: SPEED_INCREASE_PCT_DEFAULT, min: 0, max: 30, step: 1 }
    ],
    aiAdapter: {
      computeInput(state, playerId) {
        const idx = state.players.findIndex((p) => p.id === playerId);
        if (idx === -1)
          return { MOVE_UP: false, MOVE_DOWN: false };
        const paddle = state.players[idx];
        const ball = state.ball;
        const diff = ball.y - paddle.paddleY;
        const deadzone = 6;
        return {
          MOVE_UP: diff < -deadzone,
          MOVE_DOWN: diff > deadzone
        };
      }
    }
  };
  var definition_default3 = definition3;

  // src/games/registry.ts
  var GAMES = [
    definition_default,
    definition_default2,
    definition_default3
    // Add new games here ↓
  ];

  // src/games/index.ts
  for (const game of GAMES)
    registerClientGame(game);

  // src/client/main.ts
  var root = document.getElementById("app");
  if (!root)
    throw new Error("No #app element");
  var ui = new UIManager(root);
  ui.start();
})();
