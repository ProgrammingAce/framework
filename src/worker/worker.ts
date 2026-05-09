/**
 * Cloudflare Worker — WebSocket game server
 * Uses a Durable Object for persistent game state (like warlords).
 */

import { registerServerGame, RoomManager, getGameDef } from '../framework/server/lobby/rooms';
import { GameRunner } from '../framework/server/engine/runner';
import { GAMES } from '../games/registry';

for (const game of GAMES) registerServerGame(game);

// ── Types ──────────────────────────────────────────────────────────────────

interface WSClient {
  ws: WebSocket;
  socketId: string;
  name: string;
  playerId: number;
  quit: boolean;
}

// ── Durable Object — persistent singleton that keeps the game loop alive ───

export class GameServer {
  connections = new Map<string, WSClient>();
  private roomMgr = new RoomManager();
  activeRunners = new Map<string, GameRunner>();
  private nextId = 0;

  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      if (request.headers.get('upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
      server.accept();
      const socketId = String(this.nextId++);
      const conn: WSClient = { ws: server, socketId, name: 'Player', playerId: -1, quit: false };
      this.connections.set(socketId, conn);
      server.send(JSON.stringify({ type: 'connected', playerId: 0 }));
      this.handleSocket(server, socketId);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/keepalive') {
      return new Response('ok', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  }

  // ── Broadcast to all clients in a room ─────────────────────────────────

  private broadcast(roomCode: string, msg: object): void {
    const json = JSON.stringify(msg);
    for (const conn of this.connections.values()) {
      if (conn.quit) continue;
      const info = this.roomMgr.getRoomForSocket(conn.socketId);
      if (info?.roomCode === roomCode) {
        try { conn.ws.send(json); } catch { /* ignore closed */ }
      }
    }
  }

  // ── Send to a specific client ──────────────────────────────────────────

  private send(conn: WSClient, msg: object): void {
    try { conn.ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
  }

  // ── WebSocket handler ──────────────────────────────────────────────────

  private handleSocket(ws: WebSocket, socketId: string): void {
    ws.addEventListener('message', (event) => {
      const conn = this.connections.get(socketId);
      if (!conn) return;

      let msg: Record<string, unknown>;
      try { msg = JSON.parse(event.data.toString()); } catch { return; }

      switch (msg.type) {
        case 'join':
          conn.name = (msg.name as string) || 'Player';
          break;

        case 'rename':
          conn.name = (msg.name as string) || conn.name;
          const info1 = this.roomMgr.getRoomForSocket(conn.socketId);
          if (info1) {
            this.broadcast(info1.roomCode, { type: 'room_update', room: this.roomMgr.getRoom(info1.roomCode)! });
          }
          break;

        case 'create_room': {
          const result = this.roomMgr.createRoom(socketId, (msg.gameId as string) || '', conn.name);
          if ('error' in result) { this.send(conn, { type: 'error', message: result.error }); return; }
          this.send(conn, { type: 'connected', playerId: result.host });
          this.send(conn, { type: 'room_update', room: result });
          break;
        }

        case 'join_room': {
          const code = (msg.code as string)?.toUpperCase();
          const result = this.roomMgr.joinRoom(socketId, code, conn.name);
          if ('error' in result) {
            console.log('[DO] joinRoom error for socketId=' + socketId, code, ':', result.error);
            this.send(conn, { type: 'error', message: result.error });
            return;
          }
          const joinedInfo = this.roomMgr.getRoomForSocket(socketId);
          if (joinedInfo) {
            conn.playerId = joinedInfo.playerId;
            this.send(conn, { type: 'connected', playerId: joinedInfo.playerId });
          }
          // Broadcast updated room state to all players in the room
          this.broadcast(result.code, { type: 'room_update', room: result });
          console.log('[DO] joinRoom success: socketId=' + socketId + ' code=' + code + ' players=' + result.players.map(p => p.name).join(','));
          break;
        }

        case 'leave_room': {
          const left = this.roomMgr.leaveRoom(socketId);
          if (left) {
            this.broadcast(left.room.code, { type: 'room_update', room: left.room });
          }
          break;
        }

        case 'request_room_list': {
          this.send(conn, { type: 'room_list', rooms: this.roomMgr.listOpenRooms() });
          break;
        }

        case 'ready': {
          const toggled = this.roomMgr.toggleReady(socketId);
          if (toggled) this.broadcast(toggled.code, { type: 'room_update', room: toggled });
          break;
        }

        case 'update_settings': {
          const updated = this.roomMgr.updateSettings(socketId, msg.settings as Record<string, unknown>);
          if (updated) this.broadcast(updated.code, { type: 'room_update', room: updated });
          break;
        }

        case 'start_game': {
          const check = this.roomMgr.canStart(socketId);
          if (!check.ok) { this.send(conn, { type: 'error', message: check.error! }); return; }
          const room = check.room!;
          this.roomMgr.markStarted(room.code);
          const def = getGameDef(room.gameId);
          if (!def) { this.send(conn, { type: 'error', message: 'Game not found' }); return; }

          // Send each player their slot id
          for (const c of this.connections.values()) {
            const info = this.roomMgr.getRoomForSocket(c.socketId);
            if (info?.roomCode === room.code && !c.quit) {
              this.send(c, { type: 'connected', playerId: info.playerId });
            }
          }

          this.broadcast(room.code, {
            type: 'game_start',
            gameId: room.gameId,
            settings: room.gameSettings,
          });

          const runner = new GameRunner(def, room, (rc, m) => {
            this.broadcast(rc, m);
          }, (code) => {
            this.activeRunners.delete(code);
          });
          this.activeRunners.set(room.code, runner);
          runner.start();
          console.log('[DO] Game started for room ' + room.code);
          break;
        }

        case 'input': {
          const info = this.roomMgr.getRoomForSocket(socketId);
          if (!info) return;
          const runner = this.activeRunners.get(info.roomCode);
          if (!runner) return;
          runner.receiveInput(info.playerId, msg.input as any);
          break;
        }

        case 'ping':
          this.send(conn, { type: 'pong' });
          break;
      }
    });

    ws.addEventListener('close', () => {
      const left = this.roomMgr.leaveRoom(socketId);
      if (left) {
        this.broadcast(left.room.code, { type: 'room_update', room: left.room });
      }
      this.connections.delete(socketId);
    });

    ws.addEventListener('error', () => {
      this.connections.delete(socketId);
    });
  }
}

// ── Worker entry point — routes all requests to the GameServer DO ──────────

export default {
  async fetch(request: Request, env: { GAME_SERVER: DurableObjectNamespace }, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const id = env.GAME_SERVER.idFromName('main');
    const gameServer = env.GAME_SERVER.get(id);
    return gameServer.fetch(request);
  },
};
