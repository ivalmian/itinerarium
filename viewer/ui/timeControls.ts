/**
 * Play / pause / speed-cycle / reset buttons.
 *
 * Speed ladder (docs/16-viewer §"Time controls"): 1×, 4×, 16×, 64×.
 * The cycle button steps through the ladder; the reset button is wired by the
 * sidebar caller (it re-seeds the world and rebuilds layers).
 */

import type { ViewerState } from '../state/viewerState.js';

export interface TimeControls {
  refresh(): void;
}

export interface TimeControlsOpts {
  readonly host: HTMLElement;
  readonly state: ViewerState;
  readonly onPlayPause: () => void;
  readonly onSpeedCycle: () => void;
  readonly onReset: () => void;
}

export const createTimeControls = (opts: TimeControlsOpts): TimeControls => {
  const { host, state } = opts;
  const wrapper = document.createElement('div');
  wrapper.className = 'time-controls';

  const playBtn = document.createElement('button');
  playBtn.textContent = '▶';
  playBtn.title = 'Play';
  playBtn.addEventListener('click', opts.onPlayPause);

  const pauseBtn = document.createElement('button');
  pauseBtn.textContent = '⏸';
  pauseBtn.title = 'Pause';
  pauseBtn.addEventListener('click', opts.onPlayPause);

  const fastBtn = document.createElement('button');
  fastBtn.textContent = '⏩';
  fastBtn.title = 'Cycle speed';
  fastBtn.addEventListener('click', opts.onSpeedCycle);

  const resetBtn = document.createElement('button');
  resetBtn.textContent = '⏹';
  resetBtn.title = 'Reset (re-seed)';
  resetBtn.addEventListener('click', opts.onReset);

  wrapper.appendChild(playBtn);
  wrapper.appendChild(pauseBtn);
  wrapper.appendChild(fastBtn);
  wrapper.appendChild(resetBtn);

  const speed = document.createElement('span');
  speed.className = 'speed-display';
  wrapper.appendChild(speed);

  host.appendChild(wrapper);

  const refresh = (): void => {
    if (state.paused) {
      playBtn.classList.remove('active');
      pauseBtn.classList.add('active');
      speed.textContent = `paused (${state.lastNonZeroSpeed}×)`;
    } else {
      playBtn.classList.add('active');
      pauseBtn.classList.remove('active');
      speed.textContent = `${state.speed}×`;
    }
  };
  refresh();

  return { refresh };
};
