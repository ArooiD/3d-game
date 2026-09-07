#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Headless smoke test for the built Electron app.
 *
 * Boots `dist/` under xvfb with `--headless=new` and a Chromium remote
 * debugging port, then drives the real menu flow over CDP: Runtime.evaluate to
 * inspect the renderer, Input.dispatchMouseEvent to click, and asserts the game
 * reaches MAIN_MENU -> CHARACTER_SELECT -> LOADING -> PLAYING with a live
 * player, HUD and render loop.
 *
 * Reading `states.state` needs no product changes and no private field names:
 * GameApp.frame() calls reportDebug(), which pushes `state: states.state` into
 * DebugOverlay.update(). Wrapping that one method and invoking reportDebug()
 * on demand hands us the real state machine value on demand.
 *
 * Node built-ins only (Node >= 22 for the global WebSocket).
 *
 *   node scripts/headless-test.mjs
 *
 * Env overrides:
 *   HEADLESS_TEST_TIMEOUT_MS   overall budget, default 30000
 *   HEADLESS_TEST_PORT         CDP port, default 9222
 *   HEADLESS_TEST_HEADED=1     drop --headless=new (windowed, for debugging)
 *   HEADLESS_TEST_VERBOSE=1    echo electron output while it runs
 */

const ROOT = resolve(import.meta.dirname, '..');
const ELECTRON_BIN = join(ROOT, 'node_modules', 'electron', 'dist', 'electron');
const PORT = Number(process.env.HEADLESS_TEST_PORT ?? 9222);
const USE_HEADLESS_FLAG = process.env.HEADLESS_TEST_HEADED !== '1';
const BUDGET_MS = Number(process.env.HEADLESS_TEST_TIMEOUT_MS ?? 30_000);
const DEADLINE = Date.now() + BUDGET_MS;

/** Full-screen panels from index.html, used to record screen transitions. */
const SCREENS = ['ui-menu', 'ui-select', 'ui-loading', 'ui-pause', 'ui-settings', 'ui-gameover', 'ui-victory', 'ui-error'];

/** Thrown when the flow cannot continue; the run ends as a hard FAIL. */
class Abort extends Error {}

let app = null;
let client = null;

// ----------------------------------------------------------------- reporting

const checks = [];
const notes = [];

function check(name, passed, detail = '') {
  checks.push({ name, passed: Boolean(passed), detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  return Boolean(passed);
}

function note(message) {
  notes.push(message);
  console.log(`  · ${message}`);
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
/** Clamp a step timeout to whatever is left in the global budget. */
const cap = (ms) => Math.max(500, Math.min(DEADLINE - Date.now() - 2500, ms));

// ------------------------------------------------------------------- CDP client

class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.ws = null;
  }

  async connect(timeoutMs) {
    this.ws = new WebSocket(this.url);
    this.ws.binaryType = 'arraybuffer';
    await new Promise((open, fail) => {
      const timer = setTimeout(() => fail(new Error(`CDP connect timed out after ${timeoutMs}ms`)), timeoutMs);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        open();
      });
      this.ws.addEventListener('error', (event) => {
        clearTimeout(timer);
        fail(new Error(`CDP websocket error: ${event.message ?? 'unknown error'}`));
      });
    });

    this.ws.addEventListener('message', (event) => this.onMessage(event.data));
    await this.send('Runtime.enable');
    await this.send('Page.enable');
  }

  onMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
      else waiter.resolve(message.result);
      return;
    }
    if (!message.method) return;
    this.events.push(message);
    if (this.events.length > 400) this.events.shift();
  }

  send(method, params = {}, timeoutMs = 8000) {
    if (!this.ws || this.ws.readyState > WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP socket closed before ${method}`));
    }
    const id = this.nextId++;
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectSend(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend, method, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate an expression body in the renderer and return its value. */
  async evaluate(body) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(() => { ${body} })()`,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(`renderer exception: ${detail.exception?.description ?? detail.text}`);
    }
    return result.result?.value;
  }

  /** Poll an in-renderer predicate until truthy; throws Abort on timeout. */
  async waitFor(label, body, timeoutMs, intervalMs = 150) {
    const until = Date.now() + Math.max(500, timeoutMs);
    let last;
    let failures = 0;
    for (;;) {
      try {
        last = await this.evaluate(body);
        failures = 0;
      } catch (error) {
        if (++failures > 5) throw error;
        last = String(error.message ?? error);
      }
      if (last) return last;
      if (Date.now() >= until) throw new Abort(`timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
      await sleep(Math.min(intervalMs, Math.max(25, until - Date.now())));
    }
  }

  /** Real mouse click (Input.dispatchMouseEvent) at the centre of `selector`. */
  async click(selector) {
    const box = await this.evaluate(`
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      const hit = document.elementFromPoint(cx, cy);
      return { x: cx, y: cy, w: Math.round(r.width), h: Math.round(r.height),
               visible: r.width > 1 && r.height > 1,
               covered: Boolean(hit) && hit !== el && !el.contains(hit) };
    `);
    if (!box) throw new Abort(`no element matches ${selector}`);
    if (!box.visible) throw new Abort(`${selector} has zero size (${box.w}x${box.h})`);
    if (box.covered) throw new Abort(`${selector} is covered by another element`);

    const at = { x: box.x, y: box.y, button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { ...at, type: 'mouseMoved' });
    await this.send('Input.dispatchMouseEvent', { ...at, type: 'mousePressed', buttons: 1 });
    await this.send('Input.dispatchMouseEvent', { ...at, type: 'mouseReleased', buttons: 0 });
    return `${box.x},${box.y}`;
  }

  /** Uncaught exceptions and console.error output seen in the renderer. */
  rendererErrors() {
    const found = [];
    for (const event of this.events) {
      if (event.method === 'Runtime.exceptionThrown') {
        const detail = event.params.exceptionDetails;
        found.push(`exception: ${detail.exception?.description ?? detail.text}`);
      } else if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') {
        found.push(`console.error: ${event.params.args.map((arg) => arg.description ?? arg.value).join(' ')}`);
      }
    }
    return found;
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  }
}

// ------------------------------------------------------- renderer-side helpers

/**
 * Installs a read-only probe that captures the live `states.state` value.
 *
 * GameApp.reportDebug() builds `{ ..., state: states.state }` and hands it to
 * DebugOverlay.update(); wrapping update() and then calling reportDebug()
 * returns the current state without touching any private field by name.
 * Evaluated on every read, so it must stay idempotent.
 */
const PROBE = `
  const game = window.__game;
  const overlay = game && game.debug;
  if (!overlay || typeof game.reportDebug !== 'function') return null;
  if (!overlay.__smokeProbe) {
    const original = overlay.update.bind(overlay);
    overlay.__smokeProbe = true;
    overlay.__smokeState = null;
    overlay.update = (dt, stats) => {
      if (stats && stats.state) overlay.__smokeState = stats.state;
      return original(dt, stats);
    };
  }
  game.reportDebug();
`;

const READ_STATE = `${PROBE} return overlay.__smokeState;`;
const stateIs = (name) => `${PROBE} return overlay.__smokeState === ${JSON.stringify(name)};`;

/** Installs an observer recording every full-screen panel / HUD transition. */
const INSTALL_TRACE = `
  if (!window.__smokeTrace) {
    window.__smokeTrace = [];
    const ids = ${JSON.stringify(SCREENS)};
    window.__snap = () => {
      const visible = ids.filter((id) => {
        const node = document.getElementById(id);
        return Boolean(node) && !node.classList.contains('hidden');
      });
      const hud = document.getElementById('hud');
      if (hud && !hud.classList.contains('hidden')) visible.push('HUD');
      const sig = visible.join('+') || '(none)';
      const trace = window.__smokeTrace;
      if (!trace.length || trace[trace.length - 1].sig !== sig) trace.push({ sig, at: Math.round(performance.now()) });
      return sig;
    };
    new MutationObserver(() => window.__snap()).observe(document.body, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['class'],
    });
    const pump = () => { window.__snap(); requestAnimationFrame(pump); };
    requestAnimationFrame(pump);
  }
  return window.__snap();
`;

const TRACE_SIGS = 'return (window.__smokeTrace || []).map((entry) => entry.sig);';

const isHidden = (id) => `
  const node = document.getElementById(${JSON.stringify(id)});
  return node ? node.classList.contains('hidden') : null;
`;

// --------------------------------------------------------------------- process

function spawnApp(userDataDir) {
  const flags = [
    `--remote-debugging-port=${PORT}`,
    '--no-sandbox',
    '--disable-gpu',
    '--mute-audio',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',
    '--window-size=1440,900',
    `--user-data-dir=${userDataDir}`,
  ];
  if (USE_HEADLESS_FLAG) flags.splice(1, 0, '--headless=new');

  // `detached` puts xvfb-run and every Electron child in their own process
  // group, so teardown can signal the whole tree at once.
  const child = spawn('xvfb-run', ['-a', ELECTRON_BIN, '.', ...flags], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
    detached: true,
  });

  const log = [];
  const capture = (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      log.push(line.trimEnd());
      if (log.length > 300) log.shift();
      if (process.env.HEADLESS_TEST_VERBOSE) console.log(`  [electron] ${line.trim()}`);
    }
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.log = log;
  return child;
}

async function findPageTarget(timeoutMs) {
  const endpoint = `http://127.0.0.1:${PORT}/json/list`;
  const until = Date.now() + timeoutMs;
  let last = `${endpoint} not reachable`;
  for (;;) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !/^(chrome|devtools):/.test(t.url));
        if (page) return page;
        last = `no page target yet (have: ${targets.map((t) => t.type).join(', ') || 'nothing'})`;
      } else {
        last = `HTTP ${response.status} from ${endpoint}`;
      }
    } catch (error) {
      last = `${endpoint}: ${error.message ?? error}`;
    }
    if (Date.now() >= until) {
      if (app && app.exitCode !== null) last += ` | electron already exited with code ${app.exitCode}`;
      throw new Abort(`could not attach to a CDP page target: ${last}`);
    }
    await sleep(200);
  }
}

/** SIGTERM the whole process group, escalate to SIGKILL, then confirm. */
async function killApp(child) {
  if (!child || (child.exitCode !== null || child.signalCode)) return;
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  };
  signalGroup('SIGTERM');
  for (let i = 0; i < 15 && child.exitCode === null && !child.signalCode; i++) await sleep(200);
  if (child.exitCode === null && !child.signalCode) signalGroup('SIGKILL');
  for (let i = 0; i < 15 && child.exitCode === null && !child.signalCode; i++) await sleep(200);
}

// ----------------------------------------------------------------------- flow

async function run() {
  if (!existsSync(ELECTRON_BIN)) throw new Abort(`electron binary not found at ${ELECTRON_BIN} - run npm install`);
  for (const artifact of ['dist/electron/main.js', 'dist/electron/preload.js', 'dist/renderer/index.html', 'dist/renderer/main.js']) {
    if (!existsSync(join(ROOT, artifact))) throw new Abort(`${artifact} is missing - run \`node scripts/build.mjs --dev\` first`);
  }

  const userDataDir = mkdtempSync(join(tmpdir(), 'dustfall-smoke-'));
  try {
    note(`launching electron: ${USE_HEADLESS_FLAG ? '--headless=new ' : ''}--remote-debugging-port=${PORT} --no-sandbox (under xvfb-run -a)`);
    app = spawnApp(userDataDir);

    const target = await findPageTarget(cap(20_000));
    client = new Cdp(target.webSocketDebuggerUrl);
    await client.connect(cap(10_000));
    note(`attached to renderer target ${target.id} -> ${target.url}`);

    // ---- boot -----------------------------------------------------------
    await client.waitFor('window.__game to be defined', 'return window.__game ? true : null;', cap(15_000));
    check('boot: window.__game is defined', true);

    const fatal = await client.evaluate(`
      const panel = document.getElementById('ui-error');
      if (!panel || panel.classList.contains('hidden')) return null;
      return (document.getElementById('ui-error-text') || {}).textContent || 'error panel is visible';
    `);
    if (fatal) throw new Abort(`renderer reported a fatal boot error: ${String(fatal).slice(0, 500)}`);

    const identity = await client.evaluate(`
      const g = window.__game;
      return { ctor: (g && g.constructor && g.constructor.name) || null,
               screens: Boolean(g && g.screens), player: Boolean(g && g.player), controller: Boolean(g && g.controller) };
    `);
    check(
      'boot: __game is a GameApp exposing screens/player/controller',
      identity.ctor === 'GameApp' && identity.screens && identity.player && identity.controller,
      JSON.stringify(identity),
    );

    const initialState = await client.waitFor('the state manager to report a state', READ_STATE, cap(8000));
    check("state: state manager reports 'MainMenu' after boot", initialState === 'MAIN_MENU', `states.state=${initialState}`);

    const bootScreens = await client.evaluate(INSTALL_TRACE);
    check('menu: main menu screen is visible', bootScreens === 'ui-menu', `visible panels: ${bootScreens}`);
    check('hud: #hud hidden while in the main menu', (await client.evaluate(isHidden('hud'))) === true);

    // ---- character select ----------------------------------------------
    const menuClick = await client.click('[data-action="new-game"]');
    await client.waitFor("state 'CharacterSelect'", stateIs('CHARACTER_SELECT'), cap(8000));
    check('nav: clicking NEW GAME (Input.dispatchMouseEvent) reaches CHARACTER_SELECT', true, `clicked at ${menuClick}`);
    check(
      'nav: operator select panel is visible',
      (await client.evaluate(isHidden('ui-select'))) === false,
      `character cards rendered: ${await client.evaluate('return document.querySelectorAll("#select-grid .char-card").length;')}`,
    );

    // ---- pick Vanguard --------------------------------------------------
    const cardClick = await client.click('[data-character="vanguard"]');
    const picked = await client.waitFor('the Vanguard card to select and enable DEPLOY', `
      const card = document.querySelector('[data-character="vanguard"]');
      const confirm = document.getElementById('btn-select-confirm');
      if (!card || !card.classList.contains('sel') || !confirm || confirm.disabled) return null;
      return (card.querySelector('h3') || {}).textContent || 'vanguard';
    `, cap(6000));
    check('select: Vanguard card selection enables DEPLOY', true, `card="${String(picked).trim()}" clicked at ${cardClick}`);

    // ---- deploy ---------------------------------------------------------
    const traceMark = (await client.evaluate(TRACE_SIGS)).length;
    const deployClick = await client.click('#btn-select-confirm');
    const loadingStep = await client.waitFor('the LOADING screen', `
      const panel = document.getElementById('ui-loading');
      if (!panel || panel.classList.contains('hidden')) return null;
      return (document.getElementById('loading-step') || {}).textContent || 'loading';
    `, cap(8000));
    check('deploy: LOADING screen shown after DEPLOY', true, `loading step "${String(loadingStep).trim()}" (clicked at ${deployClick})`);

    const reachedPlaying = await client.waitFor("state 'Playing'", stateIs('PLAYING'), cap(12_000), 100);
    check('deploy: state manager reaches PLAYING', reachedPlaying === true, `states.state=${await client.evaluate(READ_STATE)}`);

    check(
      'hud: #hud is visible once PLAYING',
      (await client.waitFor('#hud to be visible', `
        const hud = document.getElementById('hud');
        return hud && !hud.classList.contains('hidden') ? true : null;
      `, cap(6000))) === true,
    );

    const player = await client.evaluate(`
      const g = window.__game;
      const pos = g.controller && g.controller.position;
      return { level: g.player.level, characterId: g.player.characterId, health: Math.round(g.player.health),
               pos: pos ? [+pos.x.toFixed(2), +pos.y.toFixed(2), +pos.z.toFixed(2)] : null,
               lengthSq: pos ? Number(pos.lengthSq().toFixed(3)) : null };
    `);
    check('player: PlayerState.level === 1', player.level === 1, `level=${player.level} operator=${player.characterId} hp=${player.health}`);
    check('player: controller.position.length() > 0', typeof player.lengthSq === 'number' && player.lengthSq > 0, `position=[${player.pos}] lengthSq=${player.lengthSq}`);

    // HUD text is written by the per-frame update, so allow a few frames.
    const hudText = await client.waitFor('the HUD weapon name to fill in', `
      const name = ((document.getElementById('weapon-name') || {}).textContent || '').trim();
      const mag = ((document.getElementById('ammo-mag') || {}).textContent || '').trim();
      if (!name || !mag) return null;
      return { name, mag, type: ((document.getElementById('weapon-type') || {}).textContent || '').trim() };
    `, cap(6000));
    check('hud: weapon name is populated', String(hudText.name).length > 0, `weapon="${hudText.name}" (${hudText.type}) ammo=${hudText.mag}`);

    // ---- transitions + engine liveness ----------------------------------
    const trace = (await client.evaluate(TRACE_SIGS)).slice(Math.max(0, traceMark - 1));
    const end = await client.evaluate(INSTALL_TRACE);
    check('trace: LOADING observed between CHARACTER_SELECT and PLAYING', trace.includes('ui-loading'), `trace=${JSON.stringify(trace)}`);
    check('trace: all full-screen panels hidden while playing', end === 'HUD', `visible panels now: ${end}`);

    const frames = await client.waitFor('the render loop to keep ticking', `
      const started = performance.now();
      return new Promise((done) => {
        let n = 0;
        const tick = () => {
          n += 1;
          if (n >= 10) done(true);
          else if (performance.now() - started > 2500) done(false);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    `, cap(6000));
    check('engine: requestAnimationFrame loop is running', frames === true);

    const stateNow = await client.evaluate('const g = window.__game; g.reportDebug(); return g.debug.__smokeState;');
    check("engine: state manager still reports 'PLAYING'", stateNow === 'PLAYING', `states.state=${stateNow}`);

    const errors = client.rendererErrors();
    check('runtime: no uncaught renderer exceptions', errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 400));
  } finally {
    client?.close();
    if (app) {
      await killApp(app);
      note(`electron stopped (code=${app.exitCode} signal=${app.signalCode ?? 'none'})`);
    }
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ diagnostics

function dumpDiagnostics(reason) {
  console.log('='.repeat(72));
  console.log(`ABORTED: ${reason}`);
  if (app && app.log && app.log.length) {
    console.log('--- tail of electron output ---');
    for (const line of app.log.slice(-20)) console.log(`  ${line}`);
  }
  const errors = (client && client.rendererErrors()) || [];
  if (errors.length) {
    console.log('--- renderer console errors ---');
    for (const entry of errors.slice(-8)) console.log(`  ${entry}`);
  }
}

function summarize() {
  const failed = checks.filter((entry) => !entry.passed);
  console.log('='.repeat(72));
  console.log(`RESULT: ${checks.length - failed.length}/${checks.length} checks passed`);
  for (const entry of failed) console.log(`  FAILED: ${entry.name}${entry.detail ? ` -> ${entry.detail}` : ''}`);
  console.log('='.repeat(72));
  return failed.length === 0 && checks.length > 0 ? 0 : 1;
}

// ---------------------------------------------------------------------- driver

let finished = false;

async function finish(reason) {
  if (finished) return;
  finished = true;
  if (reason) {
    dumpDiagnostics(reason);
    clearTimeout(watchdog);
  }
  const status = summarize();
  client?.close();
  if (app) await killApp(app);
  process.exit(status);
}

const watchdog = setTimeout(() => {
  void finish(`overall timeout of ${BUDGET_MS}ms exceeded`);
}, BUDGET_MS);

try {
  await run();
  await finish();
} catch (error) {
  const isAbort = error instanceof Abort;
  const reason = isAbort ? error.message : (error instanceof Error ? (error.stack ?? error.message) : String(error));
  if (!isAbort) check('smoke flow completed without aborting', false, reason.split('\n')[0]);
  await finish(reason);
}
