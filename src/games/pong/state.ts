import type { BaseGameState, BasePlayer, GameConfig, PlayerColor } from '../../framework/shared/types';
import { CANVAS_WIDTH, CANVAS_HEIGHT } from '../../framework/shared/constants';
import { BALL_SPEED_INITIAL, PADDLE_X, SPEED_INCREASE_PCT_DEFAULT } from './constants';

export interface PongPlayer extends BasePlayer {
  paddleY: number;
}

export interface PongBall {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface PongState extends BaseGameState {
  phase: 'playing' | 'game_over';
  players: PongPlayer[];
  ball: PongBall;
  hitCount: number;
  speedIncreasePct: number;
}

export function createInitialState(config: GameConfig): PongState {
  return {
    tick: 0,
    phase: 'playing',
    hitCount: 0,
    speedIncreasePct: typeof config.settings.speedIncreasePct === 'number'
      ? config.settings.speedIncreasePct
      : SPEED_INCREASE_PCT_DEFAULT,
    ball: {
      x: CANVAS_WIDTH / 2,
      y: CANVAS_HEIGHT / 2,
      vx: BALL_SPEED_INITIAL,
      vy: BALL_SPEED_INITIAL * 0.3,
    },
    players: config.playerIds.map((id, i) => ({
      id,
      name: config.playerNames[i],
      color: config.playerColors[i] as PlayerColor,
      score: 0,
      isAI: config.aiSlots.includes(id),
      connected: true,
      paddleY: CANVAS_HEIGHT / 2,
    })),
  };
}
