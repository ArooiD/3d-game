import { GameApp } from './app/GameApp';

/**
 * Renderer entry point. Boots the game application and, if anything throws
 * during construction, surfaces the failure on the error screen instead of
 * leaving a black window.
 */

function reportFatal(error: unknown): void {
  const message = error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error);
  console.error('[boot] fatal', error);
  const panel = document.getElementById('ui-error');
  const text = document.getElementById('ui-error-text');
  if (panel && text) {
    text.textContent = message;
    panel.classList.remove('hidden');
    for (const node of document.querySelectorAll('.screen')) node.classList.add('hidden');
  } else {
    document.body.innerHTML = `<pre style="color:#fff;background:#140d08;padding:24px;margin:0;height:100vh;overflow:auto;font:12px/1.5 monospace;white-space:pre-wrap">${message}</pre>`;
  }
}

async function main(): Promise<void> {
  try {
    const app = new GameApp();
    (window as unknown as { __game?: GameApp }).__game = app;
    window.addEventListener('beforeunload', () => app.dispose());
    await app.boot();
  } catch (error) {
    reportFatal(error);
  }
}

void main();
