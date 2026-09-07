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
const BUDGET_MS = Number(process.env.HEADLESS_TEST_TIMEOUT_MS ?? 75_000);
const DEADLINE = Date.now() + BUDGET_MS;

/** Full-screen panels from index.html, used to record screen transitions. */
const SCREENS = ['ui-menu', 'ui-select', 'ui-loading', 'ui-pause', 'ui-settings', 'ui-gameover', 'ui-victory', 'ui-error'];

/** Thrown when the flow cannot continue; the run ends as a hard FAIL. */
class Abort extends Error {}

let app = null;
let client = null;
let userDataDir = null;

// ----------------------------------------------------------------- reporting

const checks = [];

function check(name, passed, detail = '') {
  checks.push({ name, passed: Boolean(passed), detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  return Boolean(passed);
}

function note(message) {
  console.log(`  · ${message}`);
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
/** Clamp a step timeout to whatever is left in the global budget. */
const cap = (ms) => Math.max(300, Math.min(DEADLINE - Date.now() - 1000, ms));

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

  userDataDir = mkdtempSync(join(tmpdir(), 'dustfall-smoke-'));
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

    // ============ FULL LOOP: loot -> compare -> equip -> kill -> XP -> skills ====

    // ---- a rare weapon appears on the ground --------------------------------
    const groundCountBefore = await client.evaluate('return window.__game.loot.items.length;');
    await client.evaluate('const g = window.__game; g.director.spawnChest(g.controller.position.clone(), g.player.level, "rare"); return true;');
    const dropped = await client.waitFor('the spawned weapon to appear on the ground', `
      const items = window.__game.loot.items.filter((i) => i.kind === 'weapon' && i.weapon);
      return items.length > ${groundCountBefore} ? items[items.length - 1] : null;
    `, cap(5000));
    const ground = await client.evaluate(`
      const item = window.__game.loot.items[window.__game.loot.items.length - 1];
      return { count: window.__game.loot.items.length, rarity: item.rarity, name: item.weapon.name };
    `);
    check('loot: spawnChest drops a rare weapon on the ground', ground.rarity === 'rare',
      `ground=${ground.count} item="${ground.name}" rarity=${ground.rarity} (dropped=${Boolean(dropped)})`);

    // ---- stepping onto it raises the comparison tooltip ---------------------
    const focus = await client.waitFor('the loot tooltip to focus the dropped weapon', `
      const g = window.__game;
      const item = g.loot.items.find((i) => i.kind === 'weapon' && i.weapon);
      if (!item) return null;
      g.controller.position.set(item.position.x, g.controller.position.y, item.position.z);
      const payload = g.loot.update(0.016, g.controller.position, g.weapons.slots);
      return payload && payload.weapon ? payload : null;
    `, cap(5000));
    check('loot: tooltip compares the drop against the equipped weapon',
      Array.isArray(focus.comparison) && focus.comparison.length >= 2,
      `weapon="${focus.weapon.name}" rows=${focus.comparison.map((row) => row.label).join('/')}`);

    // ---- E picks it up: it lands in the next free slot and becomes active;
    // the starter stays equipped in slot 0 because nothing had to be displaced.
    const equippedBefore = await client.evaluate('return window.__game.weapons.slots.map((s) => s && s.name);');
    await client.evaluate('window.__game.interact(); return true;');
    const equippedAfter = await client.waitFor('the picked weapon to become the active slot', `
      const g = window.__game;
      const slot = g.weapons.slots[g.weapons.activeSlot];
      return slot && slot.name === ${JSON.stringify(focus.weapon.name)} ? slot.name : null;
    `, cap(5000));
    const groundAfterPickup = await client.evaluate('return window.__game.loot.items.filter((i) => i.kind === "weapon").length;');
    check('loot: pressing E picks the weapon up and equips it',
      equippedAfter === focus.weapon.name && groundAfterPickup < ground.count,
      `active "${equippedBefore[0]}" -> "${equippedAfter}", ground ${ground.count} -> ${groundAfterPickup}`);
    check('loot: starter weapon survives while a free slot exists',
      (await client.evaluate('return Boolean(window.__game.weapons.slots[0]);')) === true);

    // ---- fill the last free slot, then a fourth pickup must displace one ------
    await client.evaluate('const g = window.__game; g.director.spawnChest(g.controller.position.clone(), g.player.level, "epic"); return true;');
    await client.waitFor('the second drop to be focused', `
      const g = window.__game;
      const item = g.loot.items.find((i) => i.kind === 'weapon' && i.weapon && !g.weapons.slots.some((s) => s && s.name === i.weapon.name));
      if (!item) return null;
      g.controller.position.set(item.position.x, g.controller.position.y, item.position.z);
      return g.loot.update(0.016, g.controller.position, g.weapons.slots) ? true : null;
    `, cap(5000));
    await client.evaluate('window.__game.interact(); return true;');
    await client.evaluate('const g = window.__game; g.director.spawnChest(g.controller.position.clone(), g.player.level, "rare"); return true;');
    const displaced = await client.waitFor('a third pickup to displace the active weapon into the backpack', `
      const g = window.__game;
      const item = g.loot.items.find((i) => i.kind === 'weapon' && i.weapon && !g.weapons.slots.some((s) => s && s.name === i.weapon.name));
      if (!item) return null;
      g.controller.position.set(item.position.x, g.controller.position.y, item.position.z);
      const payload = g.loot.update(0.016, g.controller.position, g.weapons.slots);
      if (!payload || !payload.weapon) return null;
      const activeBefore = g.weapons.slots[g.weapons.activeSlot].name;
      g.interact();
      return g.backpack.length > 0 ? { picked: payload.weapon.name, activeBefore, backpack: g.backpack.map((w) => w.name) } : null;
    `, cap(6000));
    check('loot: a pickup with all slots full swaps out and banks the old weapon',
      displaced.backpack.includes(displaced.activeBefore),
      `picked="${displaced.picked}" banked="${displaced.backpack.join(',')}"`);

    // ---- spawn an enemy and kill it -----------------------------------------
    await client.evaluate(`
      const g = window.__game;
      if (g.enemies.enemies.length === 0) {
        const forward = g.controller.forwardVector(new (g.controller.position.constructor)(0, 0, 0)).multiplyScalar(10);
        g.enemies.spawnRandomAt(g.controller.position.clone().add(forward), g.player.level);
      }
      return true;
    `);
    const enemyCount = await client.waitFor('a spawned enemy to be alive', 'return window.__game.enemies.enemies.length || null;', cap(6000));
    check('combat: enemies spawn into the world', Number(enemyCount) >= 1, `enemies alive=${enemyCount}`);

    const xpBefore = await client.evaluate('return window.__game.player.xp;');
    await client.evaluate(`
      const g = window.__game;
      const enemy = g.enemies.enemies.find((e) => !e.dead);
      if (!enemy) return false;
      enemy.applyDamage(enemy.maxHealth + enemy.shield + 1000, {
        headshot: false, critical: false, shieldBonus: 0,
        fromPlayer: true, direction: new (g.controller.position.constructor)(0, 1, 0),
      });
      return true;
    `);
    const killOutcome = await client.waitFor('the kill to award XP', `
      const g = window.__game;
      return g.player.xp > ${xpBefore} ? { xp: g.player.xp, dead: g.enemies.enemies.filter((e) => e.dead).length } : null;
    `, cap(6000));
    check('combat: killing an enemy awards XP', Number(killOutcome.xp) > Number(xpBefore),
      `xp ${xpBefore} -> ${killOutcome.xp}, dead=${killOutcome.dead}`);

    // ---- performance: measure the cost of the animated rigs ----------------
    // The stress mob is torn down immediately after measuring: with navigation
    // live it would otherwise walk into the player and kill them mid-suite.
    const perf = await client.evaluate(`
      const g = window.__game;
      const origin = g.controller.position.clone();
      const ids = ['raider', 'rusher', 'heavy', 'sniper'];
      for (let i = 0; i < 20; i += 1) {
        g.enemies.spawn(
          { definitionId: ids[i % ids.length], x: origin.x + (i % 5) * 3, y: origin.y, z: origin.z - 12 - Math.floor(i / 5) * 3 },
          g.player.level,
        );
      }
      const alive = g.enemies.enemies.filter((e) => e.alive).length;
      let meshes = 0;
      let bones = 0;
      for (const enemy of g.enemies.enemies) {
        if (!enemy.alive) continue;
        meshes += enemy.rig.meshes.length;
        bones += enemy.rig.skeleton.bones.size;
      }
      return { alive, meshes, bones, calls: g.renderer.info.render.calls, tris: g.renderer.info.render.triangles };
    `);
    check('performance: rig cost stays bounded with 20+ enemies',
      Boolean(perf) && perf.alive >= 20 && perf.calls < 3000,
      JSON.stringify(perf));

    await client.evaluate('window.__game.enemies.clear(); return true;');


    // ---- weapon models: procedural guns must be real, distinct and finite ---
    const gunReport = await client.evaluate(`
      const dbg = window.__gameDebug;
      const Vec = dbg.THREE.Vector3;
      const stats = (node) => {
        let meshes = 0;
        let bad = 0;
        node.traverse((child) => {
          if (!child.isMesh) return;
          meshes += 1;
          const p = child.getWorldPosition(new Vec());
          if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) bad += 1;
        });
        return { meshes, bad };
      };
      const types = ['pistol', 'assault_rifle', 'shotgun', 'sniper_rifle', 'smg'];
      const rows = [];
      for (const weaponType of types) {
        const weapon = dbg.generateWeapon({ type: weaponType, level: 5, rarity: 'legendary', luck: 1 });
        const model = dbg.buildGunModel(weapon, { detail: 'high', hands: true });
        dbg.fitGunLength(model, 0.62);
        const probe = new (dbg.THREE.Group)();
        probe.add(model.group);
        probe.updateMatrixWorld(true);
        const overall = stats(probe);
        rows.push({
          type: weaponType,
          meshes: overall.meshes,
          bad: overall.bad,
          muzzle: Boolean(model.muzzle),
          mag: Boolean(model.magazine),
          bolt: Boolean(model.bolt),
          slide: Boolean(model.slide),
        });
        model.dispose();
      }
      const plain = dbg.buildGunModel(
        dbg.generateWeapon({ type: 'pistol', level: 1, rarity: 'common' }), { detail: 'high' });
      const plainProbe = new (dbg.THREE.Group)();
      plainProbe.add(plain.group);
      plainProbe.updateMatrixWorld(true);
      const plainMeshes = stats(plainProbe).meshes;
      plain.dispose();
      return { rows, plainMeshes };
    `, cap(15000));
    const gunRows = gunReport ? gunReport.rows : [];
    const gunOk = gunRows.length === 5
      && gunRows.every((row) => row.meshes >= 14 && row.bad === 0
        && row.muzzle && row.mag && row.bolt)
      && gunRows.some((row) => row.type === 'shotgun' && row.slide);
    check('weapons: every archetype builds a finite multi-part gun model', gunOk,
      JSON.stringify(gunRows.map((row) => row.type + ':' + row.meshes + (row.bad ? '/BAD' : ''))));
    const richest = gunReport ? Math.max(...gunReport.rows.map((row) => row.meshes)) : 0;
    check('weapons: rolled modifiers add visible geometry over a plain common',
      Boolean(gunReport) && richest > gunReport.plainMeshes,
      'best ' + richest + ' vs common ' + (gunReport ? gunReport.plainMeshes : 'n/a'));

    // The viewmodel must be parented to the camera, and the muzzle anchor the
    // tracers spawn from must sit on the barrel rather than at the camera.
    const muzzleReport = await client.evaluate(`
      const g = window.__game;
      const dbg = window.__gameDebug;
      const Vec = dbg.THREE.Vector3;
      let muzzleNode = null;
      let meshes = 0;
      let bad = 0;
      g.camera.traverse((child) => {
        if (child.name === 'muzzle') muzzleNode = child;
        if (!child.isMesh) return;
        meshes += 1;
        const p = child.getWorldPosition(new Vec());
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) bad += 1;
      });
      const anchor = g.weapons.muzzleWorld(new Vec());
      g.camera.updateMatrixWorld(true);
      g.weapons.update(0.001, {
        damageMultiplier: 1, fireRateMultiplier: 1, spreadMultiplier: 1,
        criticalChance: 0, criticalMultiplier: 2, reloadTimeMultiplier: 1,
      }, { fireHeld: false, firePressed: false, aiming: false });
      g.weapons.muzzleWorld(anchor);
      const muzzlePos = muzzleNode ? muzzleNode.getWorldPosition(new Vec()) : new Vec();
      const offset = anchor.clone().sub(muzzlePos);
      const forward = new Vec(0, 0, -1).applyQuaternion(g.camera.quaternion);
      const inHand = g.camera.getWorldPosition(new Vec()).distanceTo(anchor);
      return {
        muzzleNode: muzzleNode ? 1 : 0, meshes, bad,
        offsetLength: offset.length(),
        alongForward: offset.clone().normalize().dot(forward),
        inHand,
      };
    `, cap(12000));
    // Anchor is the barrel tip pushed 0.28 m down the view axis.
    check('weapons: viewmodel gun is mounted in-hand with a barrel-locked muzzle anchor',
      Boolean(muzzleReport) && muzzleReport.muzzleNode === 1 && muzzleReport.bad === 0
      && muzzleReport.meshes > 12
      && Math.abs(muzzleReport.offsetLength - 0.28) < 0.02
      && muzzleReport.alongForward > 0.99
      && muzzleReport.inHand > 0.3 && muzzleReport.inHand < 2,
      JSON.stringify(muzzleReport));

    const lootGunReport = await client.evaluate(`
      const g = window.__game;
      const dbg = window.__gameDebug;
      const Vec = g.controller.position.constructor;
      const origin = g.controller.position.clone();
      const drop = g.loot.dropWeapon(
        dbg.generateWeapon({ type: 'shotgun', level: 4, rarity: 'epic', luck: 1 }),
        new Vec(origin.x + 1.5, origin.y, origin.z - 2.5));
      let barrels = 0;
      let bad = 0;
      drop.visual.group.traverse((child) => {
        if (!child.isMesh) return;
        if (child.name === 'barrel') barrels += 1;
        const p = child.getWorldPosition(new Vec());
        if (!Number.isFinite(p.y)) bad += 1;
      });
      drop.visual.setHighlight(true);
      const spinner = Boolean(drop.visual.spinner);
      drop.visual.spinner.rotation.y += 1.0;
      drop.visual.dispose();
      return { barrels, bad, spinner, rarity: drop.rarity };
    `, cap(12000));
    check('loot: ground weapon drops render the real gun model',
      Boolean(lootGunReport) && lootGunReport.barrels >= 1 && lootGunReport.bad === 0
      && lootGunReport.spinner,
      JSON.stringify(lootGunReport));

    // A crowd of ground guns must not blow the draw-call budget.
    const lootPerf = await client.evaluate(`
      const g = window.__game;
      const dbg = window.__gameDebug;
      const Vec = g.controller.position.constructor;
      const origin = g.controller.position.clone();
      const dropped = [];
      for (let i = 0; i < 12; i += 1) {
        const type = ['pistol', 'assault_rifle', 'shotgun', 'sniper_rifle', 'smg'][i % 5];
        dropped.push(g.loot.dropWeapon(
          dbg.generateWeapon({ type, level: 3, rarity: i % 3 === 0 ? 'legendary' : 'rare', luck: 1 }),
          new Vec(origin.x + 4 + (i % 4) * 2, origin.y, origin.z - 6 - Math.floor(i / 4) * 2)));
      }
      g.renderer.render(g.scene, g.camera);
      const calls = g.renderer.info.render.calls;
      const tris = g.renderer.info.render.triangles;
      for (const item of dropped) g.loot.remove(item);
      return { calls, tris, guns: dropped.length };
    `, cap(15000));
    check('performance: a dozen ground guns stay within the draw-call budget',
      Boolean(lootPerf) && lootPerf.guns === 12 && lootPerf.calls < 3000 && lootPerf.tris < 400000,
      JSON.stringify(lootPerf));

    // Swapping slots must rebuild the viewmodel without leaking meshes.
    const swapReport = await client.evaluate(`
      const g = window.__game;
      const count = () => { let n = 0; g.camera.traverse((c) => { if (c.isMesh) n += 1; }); return n; };
      const before = count();
      const from = g.weapons.activeSlot;
      const to = from === 0 ? 1 : 0;
      const swapped = g.weapons.selectSlot(to);
      const after = count();
      return { before, after, swapped, from, to };
    `, cap(12000));
    check('weapons: switching slots disposes the old gun and mounts a new one',
      Boolean(swapReport) && swapReport.before > 12 && swapReport.after > 12,
      JSON.stringify(swapReport));
    // ---- animation layer: every archetype must pose without breaking -------
    await client.evaluate(`
      const g = window.__game;
      const origin = g.controller.position.clone();
      const ids = ['raider', 'rusher', 'heavy', 'sniper', 'scrap_titan'];
      ids.forEach((definitionId, i) => {
        g.enemies.spawn(
          { definitionId, x: origin.x + 3 + i * 2.5, y: origin.y, z: origin.z - 7 },
          g.player.level,
        );
      });
      return true;
    `);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const posed = await client.evaluate(`
      const g = window.__game;
      const Vec = g.controller.position.constructor;
      const read = (enemy) => {
        let moved = 0;
        let bad = 0;
        enemy.rig.skeleton.bones.forEach((bone) => {
          const e = bone.rotation;
          if (!Number.isFinite(e.x) || !Number.isFinite(e.y) || !Number.isFinite(e.z)) bad += 1;
          const world = bone.getWorldPosition(new Vec());
          if (!Number.isFinite(world.y)) bad += 1;
          if (Math.abs(e.x) + Math.abs(e.y) + Math.abs(e.z) > 0.05) moved += 1;
        });
        return { moved, bad };
      };
      return g.enemies.enemies.filter((enemy) => enemy.alive).slice(0, 6).map((enemy) => {
        enemy.forceAggro();
        enemy.state = 'attack';
        enemy.sinceShot = 0;
        enemy.sinceHit = 0;
        return { id: enemy.definition.id, pose: read(enemy) };
      });
    `);
    const allPosed = Array.isArray(posed) && posed.length >= 4
      && posed.every((entry) => entry.pose.moved >= 8 && entry.pose.bad === 0);
    check('animation: rigs pose on every archetype with finite bones', allPosed,
      JSON.stringify((posed || []).map((entry) => entry.id + ':' + entry.pose.moved + '/bad' + entry.pose.bad)));

    const beforeDeath = await client.evaluate(`
      const g = window.__game;
      const Vec = g.controller.position.constructor;
      const victim = g.enemies.enemies.find((enemy) => enemy.alive && enemy.definition.id !== 'scrap_titan');
      if (!victim) return null;
      const hipsBefore = victim.group.position.y;
      victim.applyDamage(victim.maxHealth + victim.shield + 500, {
        headshot: false, critical: false, shieldBonus: 0, fromPlayer: true,
        direction: new Vec(0, 1, 0),
      });
      return { hipsBefore };
    `, cap(6000));
    await new Promise((resolve) => setTimeout(resolve, 700));
    const fallen = await client.evaluate(`
      const g = window.__game;
      const Vec = g.controller.position.constructor;
      const corpses = g.enemies.enemies.filter((enemy) => !enemy.alive);
      if (!corpses.length) return null;
      let best = null;
      for (const corpse of corpses) {
        let lowest = Infinity;
        let bad = 0;
        let moved = 0;
        corpse.rig.skeleton.bones.forEach((bone) => {
          const world = bone.getWorldPosition(new Vec());
          if (!Number.isFinite(world.y)) bad += 1;
          if (world.y < lowest) lowest = world.y;
          const e = bone.rotation;
          if (Math.abs(e.x) + Math.abs(e.y) + Math.abs(e.z) > 0.05) moved += 1;
        });
        if (!best || lowest < best.lowest) best = { lowest, bad, moved };
      }
      return best;
    `, cap(6000));
    check('animation: death collapses the rig without NaN bones',
      Boolean(beforeDeath) && Boolean(fallen) && fallen.bad === 0
      && fallen.moved >= 8 && fallen.lowest < beforeDeath.hipsBefore,
      'hips ' + (beforeDeath ? beforeDeath.hipsBefore.toFixed(2) : 'n/a')
      + ' -> lowest ' + (fallen ? fallen.lowest.toFixed(2) : 'n/a')
      + ', bones moved=' + (fallen ? fallen.moved : 'n/a'));

    // ---- enough XP raises the level and grants a skill point ----------------
    await client.evaluate('window.__game.enemies.clear(); return true;');
    const leveled = await client.waitFor('the player to reach level 2', `
      const g = window.__game;
      if (g.player.level < 2) g.player.addXp(Math.max(200, g.player.xpNeeded * 2));
      return g.player.level >= 2 ? { level: g.player.level, points: g.player.skillPoints } : null;
    `, cap(8000));
    check('progression: leveling up grants a skill point', leveled.level >= 2 && leveled.points >= 1,
      `level=${leveled.level} skillPoints=${leveled.points}`);

    // ---- open the skill tree and spend the point through the UI -------------
    const spent = await client.waitFor('a skill node click to spend a point', `
      const g = window.__game;
      const body = document.getElementById('skills-body');
      const panel = document.getElementById('ui-skills');
      if (!body || !panel) return null;
      if (panel.classList.contains('hidden')) window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK', key: 'k', bubbles: true }));
      const node = body.querySelector('.skill.usable');
      if (!node) return { points: g.player.skillPoints, ranks: 0, nodes: body.querySelectorAll('.skill').length };
      node.click();
      const ranks = Object.values(g.player.skillRanks).reduce((sum, r) => sum + r, 0);
      return ranks > 0 ? { ranks, points: g.player.skillPoints } : { points: g.player.skillPoints, ranks: 0, nodes: body.querySelectorAll('.skill').length, hidden: panel.classList.contains('hidden'), dead: g.player.dead, enemies: g.enemies.enemies.filter((e) => e.alive).length };
    `, cap(8000));
    check('skills: clicking a node spends a point and stores the rank', Number(spent.ranks) >= 1,
      `ranks=${spent.ranks} pointsLeft=${spent.points} nodes=${spent.nodes ?? 'n/a'} hidden=${spent.hidden} dead=${spent.dead} enemies=${spent.enemies}`);
    await client.evaluate(`
      const panel = document.getElementById('ui-skills');
      if (panel && !panel.classList.contains('hidden')) window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK', key: 'k', bubbles: true }));
      return true;
    `);

    // ---- firing the equipped weapon burns magazine ammo ---------------------
    const fired = await client.waitFor('a shot to consume a round', `
      const g = window.__game;
      const weapon = g.weapons.current;
      if (!weapon) return null;
      const before = weapon.ammo;
      const context = { damageMultiplier: 1, fireRateMultiplier: 1, spreadMultiplier: 1,
                        criticalChance: 0, criticalMultiplier: 2, reloadTimeMultiplier: 1 };
      g.weapons.tryFire(context, true, true);
      return weapon.ammo < before ? { before, after: weapon.ammo, name: weapon.name } : null;
    `, cap(6000));
    check('gunplay: firing consumes a round from the magazine', Number(fired.after) === Number(fired.before) - 1,
      `"${fired.name}" ammo ${fired.before} -> ${fired.after}`);

    // ---- save, leave the run, and come back through CONTINUE ----------------
    const snapshot = await client.evaluate(`
      const g = window.__game;
      return { level: g.player.level, xp: g.player.xp, points: g.player.skillPoints,
               weapon: g.weapons.slots[0] && g.weapons.slots[0].name,
               backpack: g.backpack.length,
               ranks: Object.keys(g.player.skillRanks).filter((k) => g.player.skillRanks[k] > 0).length };
    `);
    await client.evaluate('window.__game.performSave("test"); return true;');
    check('save: the store reports a written save',
      (await client.waitFor('saves.hasSave to become true', 'return window.__game.saves.hasSave ? true : null;', cap(8000))) === true);

    await client.evaluate('window.__game.returnToMenu(); return true;');
    await client.waitFor("state 'MainMenu' after returnToMenu", stateIs('MAIN_MENU'), cap(12_000));
    check('menu: returnToMenu saves the run and lands in MainMenu', true);
    check('menu: CONTINUE is enabled once a save exists',
      (await client.evaluate('return !document.getElementById("btn-continue").disabled;')) === true);

    await client.click('#btn-continue');
    await client.waitFor("state 'Playing' after CONTINUE", stateIs('PLAYING'), cap(15_000));
    const restored = await client.evaluate(`
      const g = window.__game;
      return { level: g.player.level, xp: g.player.xp, points: g.player.skillPoints,
               weapon: g.weapons.slots[0] && g.weapons.slots[0].name,
               backpack: g.backpack.length,
               ranks: Object.keys(g.player.skillRanks).filter((k) => g.player.skillRanks[k] > 0).length };
    `);
    check('continue: level and XP survive save + reload',
      restored.level === snapshot.level && restored.xp === snapshot.xp,
      `level ${snapshot.level}->${restored.level}, xp ${snapshot.xp}->${restored.xp}`);
    check('continue: equipped weapon survives save + reload',
      Boolean(restored.weapon) && restored.weapon === snapshot.weapon, `weapon="${restored.weapon}"`);
    check('continue: backpack and skill ranks survive save + reload',
      restored.backpack === snapshot.backpack && restored.ranks === snapshot.ranks,
      `backpack ${snapshot.backpack}->${restored.backpack}, skillNodes ${snapshot.ranks}->${restored.ranks}`);

    const errors = client.rendererErrors();
    check('runtime: no uncaught renderer exceptions', errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 400));
  } finally {
    client?.close();
    if (app) {
      await killApp(app);
      note(`electron stopped (code=${app.exitCode} signal=${app.signalCode ?? 'none'})`);
    }
    rmSync(userDataDir, { recursive: true, force: true });
    userDataDir = null;
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

function summarize(aborted = false) {
  const failed = checks.filter((entry) => !entry.passed);
  const ok = !aborted && failed.length === 0 && checks.length > 0;
  console.log('='.repeat(72));
  console.log(`RESULT: ${checks.length - failed.length}/${checks.length} checks passed${aborted ? ' - flow ABORTED' : ''}`);
  for (const entry of failed) console.log(`  FAILED: ${entry.name}${entry.detail ? ` -> ${entry.detail}` : ''}`);
  console.log('='.repeat(72));
  return ok ? 0 : 1;
}

// ---------------------------------------------------------------------- driver

let finishing = false;

/** Kill the app, print the summary and exit; safe to call more than once. */
async function finish(passed, reason) {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  if (reason) dumpDiagnostics(reason);

  client?.close();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  if (app) await killApp(app);
  process.exit(summarize(!passed));
}

// Hard backstop: if the flow ever hangs past the budget, still make noise and
// exit non-zero rather than reporting a clean run.
const watchdog = setTimeout(() => {
  if (finishing) return;
  client?.close();
  if (app) void killApp(app);
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  console.error(`ABORTED: overall timeout of ${BUDGET_MS}ms exceeded`);
  process.exit(1);
}, BUDGET_MS);

try {
  await run();
  await finish(true);
} catch (error) {
  const isAbort = error instanceof Abort;
  const reason = isAbort ? error.message : (error instanceof Error ? (error.stack ?? error.message) : String(error));
  if (!isAbort) check('smoke flow completed without aborting', false, reason.split('\n')[0]);
  await finish(false, reason);
}
