import type { TickResult, PlayerId, GameEvent } from '../../framework/shared/types';
import { CANVAS_WIDTH, CANVAS_HEIGHT } from '../../framework/shared/constants';
import { clamp, seededRandom } from '../../framework/shared/utils';
import type { PongState, PongBall } from './state';
import type { PongInput } from './input';
import {
  PADDLE_WIDTH, PADDLE_HEIGHT, BALL_SIZE,
  PADDLE_SPEED, BALL_SPEED_INITIAL, BALL_SPEED_MAX,
  WIN_SCORE, PADDLE_X,
} from './constants';

export function tick(
  state: PongState,
  inputs: Map<PlayerId, PongInput>,
  dt: number,
): TickResult<PongState> {
  const next: PongState = {
    ...state,
    tick: state.tick + 1,
    ball: { ...state.ball },
    players: state.players.map(p => ({ ...p })),
  };

  for (const player of next.players) {
    const inp = inputs.get(player.id) ?? {} as PongInput;
    if (inp.MOVE_UP)   player.paddleY -= PADDLE_SPEED * dt;
    if (inp.MOVE_DOWN) player.paddleY += PADDLE_SPEED * dt;
    player.paddleY = clamp(
      player.paddleY,
      PADDLE_HEIGHT / 2,
      CANVAS_HEIGHT - PADDLE_HEIGHT / 2,
    );
  }

  next.ball.x += next.ball.vx * dt;
  next.ball.y += next.ball.vy * dt;

  // Bounce top/bottom
  if (next.ball.y - BALL_SIZE / 2 <= 0) {
    next.ball.y = BALL_SIZE / 2;
    next.ball.vy = Math.abs(next.ball.vy);
  } else if (next.ball.y + BALL_SIZE / 2 >= CANVAS_HEIGHT) {
    next.ball.y = CANVAS_HEIGHT - BALL_SIZE / 2;
    next.ball.vy = -Math.abs(next.ball.vy);
  }

  const events: GameEvent[] = [];

  // Left paddle (player index 0)
  const leftPlayer = next.players[0];
  if (leftPlayer) {
    const px = PADDLE_X;
    const py = leftPlayer.paddleY;
    if (
      next.ball.vx < 0 &&
      next.ball.x - BALL_SIZE / 2 <= px + PADDLE_WIDTH / 2 &&
      next.ball.x + BALL_SIZE / 2 >= px - PADDLE_WIDTH / 2 &&
      next.ball.y + BALL_SIZE / 2 >= py - PADDLE_HEIGHT / 2 &&
      next.ball.y - BALL_SIZE / 2 <= py + PADDLE_HEIGHT / 2
    ) {
      next.ball.x = px + PADDLE_WIDTH / 2 + BALL_SIZE / 2;
      const rel = clamp((next.ball.y - py) / (PADDLE_HEIGHT / 2), -1, 1);
      const speed = Math.min(speedOf(next.ball) * (1 + next.speedIncreasePct / 100), BALL_SPEED_MAX);
      next.ball.vx = speed * Math.cos(rel * 0.7);
      next.ball.vy = speed * Math.sin(rel * 0.7);
      next.hitCount++;
      events.push({ type: 'paddle_hit', paddleIndex: 0 });
    }
  }

  // Right paddle (player index 1)
  const rightPlayer = next.players[1];
  if (rightPlayer) {
    const px = CANVAS_WIDTH - PADDLE_X;
    const py = rightPlayer.paddleY;
    if (
      next.ball.vx > 0 &&
      next.ball.x + BALL_SIZE / 2 >= px - PADDLE_WIDTH / 2 &&
      next.ball.x - BALL_SIZE / 2 <= px + PADDLE_WIDTH / 2 &&
      next.ball.y + BALL_SIZE / 2 >= py - PADDLE_HEIGHT / 2 &&
      next.ball.y - BALL_SIZE / 2 <= py + PADDLE_HEIGHT / 2
    ) {
      next.ball.x = px - PADDLE_WIDTH / 2 - BALL_SIZE / 2;
      const rel = clamp((next.ball.y - py) / (PADDLE_HEIGHT / 2), -1, 1);
      const speed = Math.min(speedOf(next.ball) * (1 + next.speedIncreasePct / 100), BALL_SPEED_MAX);
      next.ball.vx = -speed * Math.cos(rel * 0.7);
      next.ball.vy = speed * Math.sin(rel * 0.7);
      next.hitCount++;
      events.push({ type: 'paddle_hit', paddleIndex: 1 });
    }
  }

  // Scoring
  if (next.ball.x < -BALL_SIZE) {
    if (next.players[1]) next.players[1].score++;
    events.push({ type: 'score', scorer: 1 });
    resetBall(next, 1); // serve toward left (player 0)
  } else if (next.ball.x > CANVAS_WIDTH + BALL_SIZE) {
    if (next.players[0]) next.players[0].score++;
    events.push({ type: 'score', scorer: 0 });
    resetBall(next, -1); // serve toward right (player 1)
  }

  for (const player of next.players) {
    if (player.score >= WIN_SCORE) {
      next.phase = 'game_over';
      break;
    }
  }

  return { state: next, events };
}

function speedOf(ball: PongBall): number {
  return Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
}

function resetBall(state: PongState, direction: 1 | -1): void {
  const rng = seededRandom(state.tick);
  const angle = (rng - 0.5) * 0.8; // ±0.4 radians ≈ ±23°
  const speed = BALL_SPEED_INITIAL;
  state.ball = {
    x: CANVAS_WIDTH / 2,
    y: CANVAS_HEIGHT / 2,
    vx: direction * speed * Math.cos(angle),
    vy: speed * Math.sin(angle),
  };
  state.hitCount = 0;
}

export function isGameOver(state: PongState): boolean {
  return state.phase === 'game_over';
}

export function getWinner(state: PongState): PlayerId | null {
  if (state.players.length < 2) return state.players[0]?.id ?? null;
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  if (sorted[0].score === sorted[1].score) return null;
  return sorted[0].id;
}
