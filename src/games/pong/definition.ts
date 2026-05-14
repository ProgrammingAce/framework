import type { GameDefinition, PlayerId } from '../../framework/shared/types';
import { createInitialState } from './state';
import { tick, isGameOver, getWinner } from './engine';
import { actions, defaultActionMap } from './input';
import { renderer } from './renderer';
import type { PongState } from './state';
import type { PongInput } from './input';
import { WIN_SCORE, SPEED_INCREASE_PCT_DEFAULT } from './constants';

const definition: GameDefinition<PongState, PongInput> = {
  id: 'pong',
  name: 'Pong',
  description: 'Classic 1v1 paddle game. First to 7 wins.',
  minPlayers: 2,
  maxPlayers: 2,
  actions,
  defaultActionMap,
  createInitialState,
  tick,
  isGameOver,
  getWinner,
  renderer,
  howToPlay: `
    <h3>Objective</h3>
    <p>First player to score ${WIN_SCORE} points wins. Score by getting the ball past your opponent's paddle.</p>
    <h3>Controls</h3>
    <ul>
      <li><strong>W / ↑</strong> — Move paddle up</li>
      <li><strong>S / ↓</strong> — Move paddle down</li>
    </ul>
    <h3>Tips</h3>
    <p>Hit the ball with the edge of your paddle to add angle. The ball speeds up with each hit!</p>
  `,
  settings: [
    { key: 'winScore', label: 'Points to win', type: 'range', default: 7, min: 3, max: 15, step: 1 },
    { key: 'speedIncreasePct', label: 'Speed increase per hit (%)', type: 'range', default: SPEED_INCREASE_PCT_DEFAULT, min: 0, max: 30, step: 1 },
  ],
  aiAdapter: {
    computeInput(state: PongState, playerId: PlayerId): PongInput {
      const idx = state.players.findIndex(p => p.id === playerId);
      if (idx === -1) return { MOVE_UP: false, MOVE_DOWN: false };
      const paddle = state.players[idx];
      const ball = state.ball;
      const diff = ball.y - paddle.paddleY;
      const deadzone = 6;
      return {
        MOVE_UP:   diff < -deadzone,
        MOVE_DOWN: diff > deadzone,
      };
    },
  },
};

export default definition;
