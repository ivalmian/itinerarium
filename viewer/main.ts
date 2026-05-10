/**
 * Viewer entrypoint — bootstraps the PixiJS app on DOMContentLoaded.
 *
 * No top-level await: Vite serves this as an ES module, so the boot is just
 * an async function we kick off. Errors are surfaced into the page so the
 * dev server doesn't silently render a blank canvas.
 */

import { bootViewer } from './app.js';

const showError = (err: unknown): void => {
  const msg = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err);
  // eslint-disable-next-line no-console
  console.error('Viewer boot failed:', err);
  const host = document.body;
  const div = document.createElement('pre');
  div.style.cssText =
    'position:fixed;inset:0;background:#1f1b15;color:#e9e2d2;padding:24px;font-family:ui-monospace,monospace;white-space:pre-wrap;overflow:auto;z-index:1000;';
  div.textContent = `Viewer boot failed:\n\n${msg}`;
  host.appendChild(div);
};

const start = async (): Promise<void> => {
  try {
    await bootViewer();
  } catch (e) {
    showError(e);
  }
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void start());
} else {
  void start();
}
