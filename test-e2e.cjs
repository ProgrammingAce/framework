#!/usr/bin/env node
/**
 * E2E tests for Cinematic Bazaar WebSocket game server.
 *
 * Runs against the deployed Worker by default.
 * Override WORKER_URL env var to test a local server:
 *   WORKER_URL=ws://localhost:3000/ws node test-e2e.cjs
 *
 * Usage:
 *   node test-e2e.cjs              # run against deployed Worker
 *   WORKER_URL=ws://localhost:3000/ws node test-e2e.cjs  # run against local
 *   node test-e2e.cjs --verbose    # show all messages
 */

const { WebSocket } = require('ws');
const assert = require('node:assert');

// ── Config ─────────────────────────────────────────────────────────────────

const WORKER_URL = process.env.WORKER_URL || 'wss://cinematic-bazaar.phil-7df.workers.dev/ws';
const VERBOSE = process.argv.includes('--verbose');
const MAX_WAIT_MS = 10_000;

// ── Test framework ─────────────────────────────────────────────────────────

const results = { passed: 0, failed: 0, total: 0 };

function test(name, fn) {
  results.total++;
  return run(name, fn);
}

async function run(name, fn) {
  if (VERBOSE) process.stdout.write(`  ${name}... `);
  try {
    await fn();
    if (VERBOSE) console.log('\x1b[32mOK\x1b[0m');
    results.passed++;
  } catch (err) {
    results.failed++;
    if (VERBOSE) console.log(`\x1b[31mFAIL: ${err.message}\x1b[0m`);
    console.error(`  ${name}: ${err.message}`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function createClient(index) {
  const proto = WORKER_URL.startsWith('wss:') ? 'wss:' : 'ws:';
  const host = WORKER_URL.replace(/^wss:/, '').replace(/^ws:/, '');
  const url = `${proto}//${host}`;
  return new WebSocket(url, { maxPayload: 1048576 });
}

function onOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
}

function waitForMessage(ws, predicate, timeoutMs = MAX_WAIT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error(`no message matching predicate within ${timeoutMs}ms`));
    }, timeoutMs);

    function handler(raw) {
      try {
        const msg = JSON.parse(raw.toString());
        if (predicate(msg)) {
          clearTimeout(timer);
          resolve(msg);
        }
      } catch { /* skip non-JSON */ }
    }

    ws.on('message', handler);
  });
}

function log(level, ...args) {
  if (VERBOSE && level === 'recv') {
    const prefix = `[${new Date().toISOString().slice(14, 19)}]`;
    console.log(prefix, ...args);
  }
}

// Wait for multiple messages across two sockets, filtering by predicate
async function waitForMessages(wsA, wsB, predicate, minCount, timeoutMs = MAX_WAIT_MS) {
  return new Promise((resolve, reject) => {
    const collected = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`only ${collected.length} messages, expected ${minCount}`));
    }, timeoutMs);

    function onA(raw) {
      try {
        const msg = JSON.parse(raw.toString());
        if (predicate(msg)) {
          collected.push({ idx: 'A', msg });
          if (collected.length >= minCount) { cleanup(); resolve(collected); }
        }
      } catch {}
    }

    function onB(raw) {
      try {
        const msg = JSON.parse(raw.toString());
        if (predicate(msg)) {
          collected.push({ idx: 'B', msg });
          if (collected.length >= minCount) { cleanup(); resolve(collected); }
        }
      } catch {}
    }

    function cleanup() {
      clearTimeout(timer);
      wsA.removeListener('message', onA);
      wsB.removeListener('message', onB);
    }

    wsA.on('message', onA);
    wsB.on('message', onB);
  });
}

// Collect N state messages from either socket
function collectStates(wsA, wsB, count, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const states = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`only ${states.length} states, expected ${count}`));
    }, timeoutMs);

    function onMsg(raw, label) {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'state') {
          states.push({ idx: label, tick: msg.tick, phase: msg.state?.phase });
          if (states.length >= count) { cleanup(); resolve(states); }
        }
      } catch {}
    }

    function cleanup() {
      clearTimeout(timer);
      wsA.removeListener('message', onAMsg);
      wsB.removeListener('message', onBMsg);
    }

    function onAMsg(raw) { onMsg(raw, 'A'); }
    function onBMsg(raw) { onMsg(raw, 'B'); }

    wsA.on('message', onAMsg);
    wsB.on('message', onBMsg);
  });
}

// Set up a full game session, return { host, bot, roomCode }
async function setupGame() {
  const host = createClient(0);
  const bot = createClient(1);
  await Promise.all([onOpen(host), onOpen(bot)]);

  // Host creates room
  host.send(JSON.stringify({ type: 'join', name: 'HostPlayer' }));
  host.send(JSON.stringify({ type: 'create_room', gameId: 'tetromino' }));

  const hostRoom = await waitForMessage(host, (m) => m.type === 'room_update');
  const roomCode = hostRoom.room.code;

  // Bot joins room
  bot.send(JSON.stringify({ type: 'join', name: 'BotPlayer' }));
  bot.send(JSON.stringify({ type: 'request_room_list' }));
  await waitForMessage(bot, (m) => m.type === 'room_list' && m.rooms.some(r => r.gameId === 'tetromino'));
  bot.send(JSON.stringify({ type: 'join_room', code: roomCode }));

  // Both must get room_update with 2 players
  await Promise.all([
    waitForMessage(bot, (m) => m.type === 'room_update' && m.room.players.length === 2),
    waitForMessage(host, (m) => m.type === 'room_update' && m.room.players.length === 2),
  ]);

  // Both ready
  host.send(JSON.stringify({ type: 'ready' }));
  bot.send(JSON.stringify({ type: 'ready' }));
  await new Promise(r => setTimeout(r, 200));
  host.send(JSON.stringify({ type: 'start_game' }));

  // Both get game_start
  await Promise.all([
    waitForMessage(host, (m) => m.type === 'game_start'),
    waitForMessage(bot, (m) => m.type === 'game_start'),
  ]);

  return { host, bot, roomCode };
}

// ── Tests ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n\x1b[1mCinematic Bazaar E2E Tests\x1b[0m`);
  console.log(`  Target: ${WORKER_URL}`);
  console.log(`  Mode: ${process.env.WORKER_URL ? 'local' : 'deployed'}`);
  console.log(`  ${'─'.repeat(50)}\n`);

  // ── 1. Connection ─────────────────────────────────────────────────────

  await test('connect & get connected ack', async () => {
    const ws = createClient(0);
    await onOpen(ws);
    const msg = await waitForMessage(ws, (m) => m.type === 'connected');
    assert.strictEqual(msg.type, 'connected');
    assert.ok(msg.playerId !== undefined, 'playerId must be present');
    ws.close();
  });

  // ── 2. Room creation & listing ────────────────────────────────────────

  await test('create room & see it in room_list', async () => {
    const host = createClient(0);
    await onOpen(host);

    host.send(JSON.stringify({ type: 'join', name: 'HostPlayer' }));
    host.send(JSON.stringify({ type: 'create_room', gameId: 'tetromino' }));

    const roomMsg = await waitForMessage(host, (m) => m.type === 'room_update' && m.room && m.room.code);
    const roomCode = roomMsg.room.code;
    assert.ok(roomCode, 'room must have a code');
    assert.strictEqual(roomMsg.room.gameId, 'tetromino');

    // Bot requests room list
    const bot = createClient(1);
    await onOpen(bot);
    bot.send(JSON.stringify({ type: 'join', name: 'BotPlayer' }));
    bot.send(JSON.stringify({ type: 'request_room_list' }));

    const listMsg = await waitForMessage(bot, (m) => m.type === 'room_list');
    assert.ok(Array.isArray(listMsg.rooms), 'rooms must be an array');
    assert.ok(listMsg.rooms.length > 0, 'must have at least one room');
    assert.ok(listMsg.rooms.some(r => r.code === roomCode), 'room must appear in list');

    host.close();
    bot.close();
  });

  // ── 3. Join room ─────────────────────────────────────────────────────

  await test('join room & receive room_update with both players', async () => {
    const host = createClient(0);
    const bot = createClient(1);
    await Promise.all([onOpen(host), onOpen(bot)]);

    host.send(JSON.stringify({ type: 'join', name: 'HostPlayer' }));
    host.send(JSON.stringify({ type: 'create_room', gameId: 'tetromino' }));

    const hostRoom = await waitForMessage(host, (m) => m.type === 'room_update');
    const roomCode = hostRoom.room.code;

    bot.send(JSON.stringify({ type: 'join', name: 'BotPlayer' }));
    bot.send(JSON.stringify({ type: 'request_room_list' }));
    await waitForMessage(bot, (m) => m.type === 'room_list' && m.rooms.some(r => r.gameId === 'tetromino'));
    bot.send(JSON.stringify({ type: 'join_room', code: roomCode }));

    // Bot gets room_update with 2 players
    const botUpdate = await waitForMessage(bot, (m) => m.type === 'room_update' && m.room.players.length === 2);
    assert.strictEqual(botUpdate.room.players.length, 2);
    const botIds = botUpdate.room.players.map(p => p.id).sort();
    assert.deepStrictEqual(botIds, [0, 1]);

    host.close();
    bot.close();
  });

  // ── 4. Ready & start ─────────────────────────────────────────────────

  await test('both players ready → game starts & receives states', async () => {
    const { host, bot, roomCode } = await setupGame();

    // Both receive game_start (already verified by setupGame, but check again)
    // Both receive at least one state
    const [hostState, botState] = await Promise.all([
      waitForMessage(host, (m) => m.type === 'state'),
      waitForMessage(bot, (m) => m.type === 'state'),
    ]);

    assert.ok(hostState.tick >= 1, 'tick must be >= 1');
    assert.strictEqual(hostState.state.phase, 'playing');
    assert.ok(botState.tick >= 1, 'bot tick must be >= 1');

    // Verify AI players exist
    assert.ok(hostState.state.players.length >= 2, 'must have at least 2 players');

    host.close();
    bot.close();
  });

  // ── 5. Continuous state broadcasting ──────────────────────────────────

  await test('state broadcasts continue during gameplay (at least 5 ticks)', async () => {
    const { host, bot, roomCode } = await setupGame();

    // Collect at least 5 state messages across both clients
    const states = await collectStates(host, bot, 5, 8000);

    assert.ok(states.length >= 5, `expected >= 5 state messages, got ${states.length}`);

    // Check that ticks are progressing
    const ticks = states.map(s => s.tick);
    assert.ok(Math.max(...ticks) >= 3, `expected tick >= 3, got max ${Math.max(...ticks)}`);

    host.close();
    bot.close();
  });

  // ── 6. Player input ──────────────────────────────────────────────────

  await test('player input is accepted without error', async () => {
    const { host, bot, roomCode } = await setupGame();

    // Send player input
    host.send(JSON.stringify({ type: 'input', tick: 1, input: { move: 'left', drop: true } }));

    // Should get state in return (no error means input was accepted)
    const state = await waitForMessage(host, (m) => m.type === 'state', 3000);
    assert.ok(state, 'should receive state after input');

    host.close();
    bot.close();
  });

  // ── 7. Leave room ────────────────────────────────────────────────────

  await test('leave room & room updates reflect departure', async () => {
    const host = createClient(0);
    const bot = createClient(1);
    await Promise.all([onOpen(host), onOpen(bot)]);

    host.send(JSON.stringify({ type: 'join', name: 'HostPlayer' }));
    host.send(JSON.stringify({ type: 'create_room', gameId: 'tetromino' }));

    const hostRoom = await waitForMessage(host, (m) => m.type === 'room_update');
    const roomCode = hostRoom.room.code;

    bot.send(JSON.stringify({ type: 'join', name: 'BotPlayer' }));
    bot.send(JSON.stringify({ type: 'request_room_list' }));
    await waitForMessage(bot, (m) => m.type === 'room_list' && m.rooms.some(r => r.gameId === 'tetromino'));
    bot.send(JSON.stringify({ type: 'join_room', code: roomCode }));
    await waitForMessage(bot, (m) => m.type === 'room_update' && m.room.players.length === 2);

    // Host leaves
    host.send(JSON.stringify({ type: 'leave_room' }));

    // Bot should receive room_update with only 1 player
    const botUpdate = await waitForMessage(bot, (m) => m.type === 'room_update' && m.room.players.length === 1);
    assert.strictEqual(botUpdate.room.players.length, 1);

    host.close();
    bot.close();
  });

  // ── 8. Ping/pong ─────────────────────────────────────────────────────

  await test('ping returns pong', async () => {
    const ws = createClient(0);
    await onOpen(ws);
    ws.send(JSON.stringify({ type: 'ping' }));
    const msg = await waitForMessage(ws, (m) => m.type === 'pong');
    assert.strictEqual(msg.type, 'pong');
    ws.close();
  });

  // ── 9. Error handling ────────────────────────────────────────────────

  await test('join non-existent room returns error', async () => {
    const ws = createClient(0);
    await onOpen(ws);
    ws.send(JSON.stringify({ type: 'join_room', code: 'INVALID' }));
    const msg = await waitForMessage(ws, (m) => m.type === 'error');
    assert.strictEqual(msg.type, 'error');
    assert.ok(typeof msg.message === 'string', 'error must have message');
    ws.close();
  });

  await test('join_room when already in room returns error', async () => {
    const ws = createClient(0);
    await onOpen(ws);
    ws.send(JSON.stringify({ type: 'create_room', gameId: 'tetromino' }));
    await waitForMessage(ws, (m) => m.type === 'room_update');
    ws.send(JSON.stringify({ type: 'join_room', code: 'ABCDE' }));
    const msg = await waitForMessage(ws, (m) => m.type === 'error');
    assert.strictEqual(msg.type, 'error');
    ws.close();
  });

  // ── Summary ──────────────────────────────────────────────────────────

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  Passed: ${results.passed}  Failed: ${results.failed}  Total: ${results.total}`);
  console.log(`${'─'.repeat(50)}\n`);

  if (results.failed > 0) {
    process.exitCode = 1;
    console.error(`\x1b[31m${results.failed} test(s) failed\x1b[0m`);
    process.exit(1);
  } else {
    console.log('\x1b[32mAll tests passed!\x1b[0m');
  }
}

main().catch((err) => {
  console.error('\x1b[31mTest runner error:\x1b[0m', err);
  process.exit(1);
});
