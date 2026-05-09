import type { TickResult, PlayerId, BaseInput } from '../../framework/shared/types';
import { clamp, dist, normalizeAngle, seededRandom } from '../../framework/shared/utils';
import type { WarlordsState, WarlordsPlayer, Fireball, Brick, Castle } from './state';
import type { WarlordsInput } from './input';
import {
  CANVAS_WIDTH, CANVAS_HEIGHT, CASTLE_SIZE, BRICK_WIDTH, BRICK_HEIGHT,
  FIREBALL_RADIUS, FIREBALL_SPEED_SLOW, FIREBALL_SPEED_FAST,
  MAX_FIREBALLS, BOUNCE_LIMIT, SHIELD_WIDTH, SHIELD_HEIGHT,
  BATTLES_TO_WIN_WAR, GHOST_RADIUS, GHOST_DEFLCHANCE, DRAGON_SIZE,
  DRAGON_APPEAR_TIME, DRAGON_BALL_DELAY, AI_CONFIG,
  CASTLE_POSITIONS, PLAYER_COLORS,
} from './constants';
import type { WarlordsEvent } from './events';

// --- World helpers ---

function getShieldPosition(angle: number, cornerIndex: number): { x: number; y: number; angle: number } {
  const pos = CASTLE_POSITIONS[cornerIndex];
  const cx = pos.x + CASTLE_SIZE / 2;
  const cy = pos.y + CASTLE_SIZE / 2;
  const orbitRadius = (CASTLE_SIZE / 2 + 16) * 1.25;
  const x = cx + orbitRadius * Math.cos(angle);
  const y = cy + orbitRadius * Math.sin(angle);
  const facingAngle = angle + Math.PI / 2;
  return { x, y, angle: facingAngle };
}

function getShieldBounds(player: WarlordsPlayer): { x: number; y: number; w: number; h: number } {
  const sp = getShieldPosition(player.shield.angle, player.id);
  return {
    x: sp.x - SHIELD_WIDTH / 2,
    y: sp.y - SHIELD_HEIGHT / 2,
    w: SHIELD_WIDTH,
    h: SHIELD_HEIGHT,
  };
}

function getWarlordPosition(player: WarlordsPlayer): { x: number; y: number } {
  const pos = CASTLE_POSITIONS[player.id];
  return {
    x: pos.x + (BRICK_WIDTH * 6) / 2,
    y: pos.y + (BRICK_HEIGHT * 6) / 2,
  };
}

function createCastleForPlayer(playerId: PlayerId): Castle {
  const pos = CASTLE_POSITIONS[playerId];
  const bricks: Brick[] = [];
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) {
      bricks.push({
        x: pos.x + c * BRICK_WIDTH,
        y: pos.y + r * BRICK_HEIGHT,
        hp: 2,
        flashTimer: 0,
      });
    }
  }
  return { bricks, destroyed: false, warlordAlive: true };
}

function spawnFireball(x: number, y: number, vx: number, vy: number, speed: number, owner: PlayerId | null): Fireball {
  return { x, y, vx, vy, speed, spin: 0, owner, bounceCount: 0 };
}

function getBallSpeed(state: WarlordsState): number {
  return state.ballSpeed === 'fast' ? FIREBALL_SPEED_FAST : FIREBALL_SPEED_SLOW;
}

// --- Physics ---

function updateBall(ball: Fireball): void {
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

function perturbVelocity(ball: Fireball, amount: number): void {
  const currentSpeed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
  if (currentSpeed === 0) return;
  const angle = Math.atan2(ball.vy, ball.vx) + (Math.random() - 0.5) * amount;
  ball.vx = Math.cos(angle) * currentSpeed;
  ball.vy = Math.sin(angle) * currentSpeed;
}

function bounceOffWalls(ball: Fireball): boolean {
  let bounced = false;
  const halfW = CANVAS_WIDTH / 2;
  const halfH = CANVAS_HEIGHT / 2;

  if (ball.x - FIREBALL_RADIUS <= 0) {
    ball.x = FIREBALL_RADIUS;
    ball.vx = Math.abs(ball.vx);
    const centerWeight = 1 - Math.abs(ball.y - halfH) / halfH;
    const pushDir = ball.y < halfH ? -1 : 1;
    ball.vy += pushDir * centerWeight * 3;
    perturbVelocity(ball, 0.15);
    bounced = true;
  } else if (ball.x + FIREBALL_RADIUS >= CANVAS_WIDTH) {
    ball.x = CANVAS_WIDTH - FIREBALL_RADIUS;
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
  } else if (ball.y + FIREBALL_RADIUS >= CANVAS_HEIGHT) {
    ball.y = CANVAS_HEIGHT - FIREBALL_RADIUS;
    ball.vy = -Math.abs(ball.vy);
    const centerWeight = 1 - Math.abs(ball.x - halfW) / halfW;
    const pushDir = ball.x < halfW ? -1 : 1;
    ball.vx += pushDir * centerWeight * 3;
    perturbVelocity(ball, 0.15);
    bounced = true;
  }

  if (bounced) ball.bounceCount++;
  return bounced;
}

function isBallOverlappingBrick(ball: Fireball, brick: Brick): boolean {
  return (
    ball.x + FIREBALL_RADIUS > brick.x &&
    ball.x - FIREBALL_RADIUS < brick.x + BRICK_WIDTH &&
    ball.y + FIREBALL_RADIUS > brick.y &&
    ball.y - FIREBALL_RADIUS < brick.y + BRICK_HEIGHT
  );
}

function handleCastleCollision(
  ball: Fireball,
  state: WarlordsState,
  targetPlayerId: PlayerId
): { hit: boolean; destroyed: boolean; brickX: number; brickY: number } {
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
      if (brick.hp <= 0) continue;
      if (!isBallOverlappingBrick(ball, brick)) continue;

      const brickCenterX = brick.x + BRICK_WIDTH / 2;
      const brickCenterY = brick.y + BRICK_HEIGHT / 2;
      const dx = ball.x - brickCenterX;
      const dy = ball.y - brickCenterY;

      const overlapX = (BRICK_WIDTH / 2 + FIREBALL_RADIUS) - Math.abs(dx);
      const overlapY = (BRICK_HEIGHT / 2 + FIREBALL_RADIUS) - Math.abs(dy);

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
      if (brick.hp <= 0) destroyed = true;
      lastBrickX = brick.x;
      lastBrickY = brick.y;
      ball.bounceCount++;
      resolved = true;
    }
    if (!resolved) break;
  }

  return { hit, destroyed, brickX: lastBrickX, brickY: lastBrickY };
}

function handleShieldRicochet(ball: Fireball, player: WarlordsPlayer): boolean {
  const bounds = getShieldBounds(player);

  // Swept AABB check
  const oldX = ball.x - ball.vx;
  const oldY = ball.y - ball.vy;
  const dx = ball.x - oldX;
  const dy = ball.y - oldY;

  const minX = bounds.x - FIREBALL_RADIUS;
  const maxX = bounds.x + bounds.w + FIREBALL_RADIUS;
  const minY = bounds.y - FIREBALL_RADIUS;
  const maxY = bounds.y + bounds.h + FIREBALL_RADIUS;

  if (ball.x >= minX && ball.x <= maxX && ball.y >= minY && ball.y <= maxY) {
    // Already inside
  } else {
    let tEnter = 0, tExit = 1;
    if (Math.abs(dx) > 1e-10) {
      const t1 = (minX - oldX) / dx, t2 = (maxX - oldX) / dx;
      tEnter = Math.max(tEnter, Math.min(t1, t2));
      tExit = Math.min(tExit, Math.max(t1, t2));
      if (tEnter > tExit) return false;
    } else {
      if (oldX < minX || oldX > maxX) return false;
    }
    if (Math.abs(dy) > 1e-10) {
      const t1 = (minY - oldY) / dy, t2 = (maxY - oldY) / dy;
      tEnter = Math.max(tEnter, Math.min(t1, t2));
      tExit = Math.min(tExit, Math.max(t1, t2));
      if (tEnter > tExit) return false;
    } else {
      if (oldY < minY || oldY > maxY) return false;
    }
    if (tEnter < 0) return false;
  }

  const sp = getShieldPosition(player.shield.angle, player.id);
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
  const faceNx = isFrontBack ? 0 : (normX > 0 ? 1 : -1);
  const faceNy = isFrontBack ? (normY > 0 ? 1 : -1) : 0;

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
      const outside = ball.x + FIREBALL_RADIUS < bounds.x ||
                      ball.x - FIREBALL_RADIUS > bounds.x + bounds.w ||
                      ball.y + FIREBALL_RADIUS < bounds.y ||
                      ball.y - FIREBALL_RADIUS > bounds.y + bounds.h;
      if (outside) break;
    }
  }

  ball.x = Math.max(FIREBALL_RADIUS, Math.min(CANVAS_WIDTH - FIREBALL_RADIUS, ball.x));
  ball.y = Math.max(FIREBALL_RADIUS, Math.min(CANVAS_HEIGHT - FIREBALL_RADIUS, ball.y));

  ball.bounceCount++;
  return true;
}

function ballHitsWarlord(ball: Fireball, player: WarlordsPlayer): boolean {
  if (!player.alive) return false;
  const wl = getWarlordPosition(player);
  return dist(ball.x, ball.y, wl.x, wl.y) < FIREBALL_RADIUS + 8;
}

// --- AI ---

function rotateToward(currentAngle: number, targetAngle: number, maxDelta: number): number {
  let diff = targetAngle - currentAngle;
  if (Math.abs(diff) > Math.PI) {
    diff = diff > 0 ? diff - Math.PI * 2 : diff + Math.PI * 2;
  }
  return currentAngle + clamp(diff, -maxDelta, maxDelta);
}

function aiComputeInput(state: WarlordsState, playerId: PlayerId): WarlordsInput {
  const player = state.players.find(p => p.id === playerId);
  if (!player || !player.alive) {
    return { SHIELD_LEFT: false, SHIELD_RIGHT: false };
  }

  const castle = { x: CASTLE_POSITIONS[playerId].x + CASTLE_SIZE / 2, y: CASTLE_POSITIONS[playerId].y + CASTLE_SIZE / 2 };

  // Find most threatening ball
  let bestThreat: Fireball | null = null;
  let bestScore = Infinity;

  for (const ball of state.balls) {
    if (ball.owner === playerId) continue;
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

  let targetAngle: number;
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
    let ballCenterX = CANVAS_WIDTH / 2;
    let ballCenterY = CANVAS_HEIGHT / 2;
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

  // Determine direction for input
  let diff = normalizeAngle(newAngle) - normalizeAngle(player.shield.angle);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;

  return {
    SHIELD_LEFT: diff < -0.01,
    SHIELD_RIGHT: diff > 0.01,
  };
}

// --- Main tick ---

export function tick(
  state: WarlordsState,
  inputs: Map<PlayerId, WarlordsInput>,
  dt: number,
): TickResult<WarlordsState> {
  const next: WarlordsState = {
    ...state,
    tick: state.tick + 1,
    players: state.players.map(p => ({
      ...p,
      castle: {
        ...p.castle,
        bricks: p.castle.bricks.map(b => ({ ...b })),
      },
      shield: { ...p.shield },
    })),
    balls: state.balls.map(b => ({ ...b })),
  };

  const events: WarlordsEvent[] = [];

  // Process inputs
  for (const player of next.players) {
    const inp = inputs.get(player.id) ?? {} as WarlordsInput;
    const shieldSpeed = (state.shieldSpeed / 20) * 0.09; // percentage of base speed

    if (player.alive) {
      if (inp.SHIELD_LEFT) {
        player.shield.angle -= shieldSpeed;
      }
      if (inp.SHIELD_RIGHT) {
        player.shield.angle += shieldSpeed;
      }
      player.shield.angle = ((player.shield.angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    }
  }

  // Update dragon phase
  if (next.phase === 'dragon') {
    next.dragonTimer++;

    if (next.dragonTimer === 60) {
      // Launch first ball from dragon
      const alivePlayers = next.players.filter(p => p.alive);
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
            next.dragonX, next.dragonY,
            dx / d, dy / d, speed, null
          ));
          events.push({ type: 'ball_spawned', x: next.dragonX, y: next.dragonY, vx: dx / d, vy: dy / d });
        }
      }
    }

    if (next.dragonTimer > 120) {
      next.phase = 'playing';
      events.push({ type: 'battle_start', battleNumber: next.battleNumber });
    }
  }

  // Update balls and handle collisions
  const ballsToRemove: number[] = [];
  for (let i = 0; i < next.balls.length; i++) {
    const ball = next.balls[i];
    updateBall(ball);

    // Castle collisions
    for (const player of next.players) {
      if (player.alive) {
        const result = handleCastleCollision(ball, next, player.id);
        if (result.hit) {
          if (result.destroyed) {
            events.push({ type: 'brick_destroyed', x: result.brickX, y: result.brickY, playerId: player.id });
          }
        }

        // Warlord hit
        if (ballHitsWarlord(ball, player)) {
          player.alive = false;
          player.ghostActive = true;
          const wl = getWarlordPosition(player);
          player.ghostX = wl.x;
          player.ghostY = wl.y;
          player.ghostTimer = 0;
          events.push({ type: 'warlord_dead', playerId: player.id });

          // Spawn death ball from killer
          const aliveOthers = next.players.filter(p => p.alive && p.id !== player.id);
          if (aliveOthers.length > 0 && next.balls.length < MAX_FIREBALLS) {
            // Find who killed this player (the ball's owner)
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
                  const speed = getBallSpeed(next);
                  next.balls.push(spawnFireball(kx, ky, ddx / dd, ddy / dd, speed, killerId));
                }
              }
            }
          }
        }
      }
    }

    // Shield collisions
    for (const player of next.players) {
      if (player.alive && handleShieldRicochet(ball, player)) {
        events.push({ type: 'shield_hit', x: ball.x, y: ball.y, angle: 0 });
      }
    }

    // Wall bounces
    bounceOffWalls(ball);

    // Check if ball is stuck
    const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
    if (speed === 0 || isNaN(speed) || !isFinite(speed)) {
      ballsToRemove.push(i);
      continue;
    }

    // Remove if out of bounds
    if (ball.x < -50 || ball.x > CANVAS_WIDTH + 50 || ball.y < -50 || ball.y > CANVAS_HEIGHT + 50) {
      ballsToRemove.push(i);
      continue;
    }
  }

  // Remove dead balls (reverse order)
  for (let i = ballsToRemove.length - 1; i >= 0; i--) {
    next.balls.splice(ballsToRemove[i], 1);
  }

  // Spawn additional balls for bounced balls
  for (let i = next.balls.length - 1; i >= 0; i--) {
    const ball = next.balls[i];
    if (ball.bounceCount >= BOUNCE_LIMIT && next.balls.length < MAX_FIREBALLS) {
      const angle = seededRandom(next.tick * 7 + i * 13) * Math.PI * 2;
      const speed = getBallSpeed(next);
      next.balls.push(spawnFireball(
        CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2,
        Math.cos(angle), Math.sin(angle), speed, null
      ));
      ball.bounceCount = 0;
    }
  }

  // Cap balls
  while (next.balls.length > MAX_FIREBALLS) {
    next.balls.pop();
  }

  // Failsafe: if no balls and playing, respawn one
  if (next.phase === 'playing' && next.balls.length === 0) {
    const angle = seededRandom(next.tick * 3 + 42) * Math.PI * 2;
    const speed = getBallSpeed(next);
    next.balls.push(spawnFireball(
      CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2,
      Math.cos(angle), Math.sin(angle), speed, null
    ));
  }

  // Update ghosts
  for (const player of next.players) {
    if (!player.ghostActive) continue;
    player.ghostTimer++;
    player.ghostX += Math.sin(player.ghostTimer * 0.05) * 0.3;
    player.ghostY += Math.cos(player.ghostTimer * 0.03) * 0.2;
  }

  // Check battle end
  if (next.phase === 'playing') {
    const alivePlayers = next.players.filter(p => p.alive);
    if (alivePlayers.length <= 1) {
      const winner = alivePlayers.length === 1 ? alivePlayers[0].id : null;
      if (winner !== null) {
        next.phase = 'battle_end';
        const winnerPlayer = next.players[winner];
        if (winnerPlayer) {
          winnerPlayer.score++;
        }
        events.push({ type: 'battle_won', winner });

        // Check war end
        const warWinner = next.players.find(p => p.score >= next.battlesToWin);
        if (warWinner) {
          next.phase = 'game_over';
          next.winner = warWinner.id;
          events.push({ type: 'war_won', winner: warWinner.id });
        } else {
          // Reset for next battle after a delay (handled in next tick)
          // We'll use a timer approach
          next._battleResetTick = next.tick + 120; // 2 seconds at 60fps
        }
      }
    }
  }

  // Handle battle reset
  if (next.phase === 'battle_end' && next._battleResetTick !== undefined && next.tick >= next._battleResetTick) {
    delete next._battleResetTick;
    for (const player of next.players) {
      player.alive = true;
      player.castle = createCastleForPlayer(player.id);
      player.shield.angle = 0;
      player.ghostActive = false;
      player.ghostTimer = 0;
    }
    next.balls = [];
    next.phase = 'dragon';
    next.dragonTimer = 0;
    next.battleNumber++;
    events.push({ type: 'battle_start', battleNumber: next.battleNumber });
  }

  return { state: next, events };
}

export function isGameOver(state: WarlordsState): boolean {
  return state.phase === 'game_over';
}

export function getWinner(state: WarlordsState): PlayerId | null {
  if (state.players.length === 1) return state.players[0].id;
  if (state.winner !== null) return state.winner;
  // Fallback: highest score
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  if (sorted[0].score === sorted[1]?.score) return null;
  return sorted[0].id;
}

// AI adapter
export const aiAdapter = {
  computeInput(state: WarlordsState, playerId: PlayerId): WarlordsInput {
    return aiComputeInput(state, playerId);
  },
};
