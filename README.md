# Dustfall Outpost

A single-player 3D looter-shooter vertical slice: one desert sci-fi outpost, one
clear loop. Shoot, kill, loot, compare, equip, level up, unlock skills, push on to
the mini-boss.

Built with Electron + TypeScript + Three.js + Vite. No game engine, no third-party
art assets — the whole location is procedural geometry and primitive meshes.

## Quick start

```bash
npm install
npm run dev
```

`npm run dev` bundles the Electron main/preload processes with esbuild, starts the
Vite dev server for the renderer (TypeScript + hot reload straight out of
`src/renderer`), waits for the server to answer, then opens the Electron window
against it. Stop everything with Ctrl+C.

## Other commands

```bash
npm run build        # typecheck, then bundle main/preload/renderer into dist/
npm start            # build + run the packaged app from dist/
npm test             # physics, projectile, navigation and AI regression tests
npm run typecheck    # tsc --noEmit only
npm run test:headless # build, then drive the real app under xvfb over CDP
```

The headless test boots `dist/` in a headless Electron, walks the real menu flow
(main menu → character select → deploy → playing) and asserts the player, HUD,
weapon and render loop are live. It needs `xvfb-run` on Linux.

## Controls

| Key | Action | Key | Action |
| --- | --- | --- | --- |
| `W A S D` | Move | `Tab` | Inventory |
| `Mouse` | Look | `K` | Skill tree |
| `Left Click` | Fire | `Esc` | Pause |
| `Right Click` | Aim | `R` | Reload |
| `Space` | Jump | `E` | Interact / pick up loot |
| `Shift` | Sprint | `F` / `Q` | Active skills |
| `1` `2` `3` | Switch weapon | `F3` | Debug overlay |

The mouse is pointer-locked while playing.

## The loop

```
Explore → fight → loot (procedural weapon) → compare → equip
        → XP → level up → spend a skill point → tougher enemies → mini-boss
```

- **Three operators** — Vanguard, Ranger, Engineer — differing in stats and active
  skill (Overdrive / Focus / Combat Drone).
- **Five weapon classes** — pistol, AR, shotgun, sniper, SMG — rolled from
  `base + level + rarity + random modifiers`. Rarity (Common → Legendary) drives
  both the modifier count and the UI colour. Names are generated from
  prefix / base / suffix tables.
- **Four enemy types** (Raider, Rusher, Heavy, Sniper) driven by a small state
  machine, plus the **Scrap Titan** mini-boss with an enrage phase at 50% HP.
- **One quest chain** — "Clear the Outpost" — with five objectives across five
  zones: Drop Pad, Scrap Camp, Rust Canyon, Slag Refinery, Titan Arena.
- **Autosave** on level-up, loot pickup, boss kill and return-to-menu.

## Saves

Saves and settings are written through the Electron main process into the app's
`userData` directory (JSON, atomic writes):

```
<userData>/saves/save_slot_1.json
<userData>/settings.json
```

The save records the character, level/XP, skill ranks, inventory, equipped weapons,
quest stage and player position, so `CONTINUE` restores the run.

## Project layout

```
src/
  main/        Electron main process: window, IPC handlers, save store
  preload.ts   Typed contextBridge — the only surface Node gives the renderer
  shared/      Types and constants shared across processes
  renderer/
    main.ts    Renderer entry, boots GameApp
    app/       GameApp: composition root, frame loop, state transitions
    game/      core (event bus, state machine, director, save), world, player,
               enemies, weapons, combat, loot, skills, progression, audio, effects
    ui/        HUD, loot tooltip, inventory, skill tree, menus, debug overlay
    data/      Data-driven content: weapons, enemies, characters, skills, quests
```

Game content lives in `src/renderer/data/**` as plain data. Balance changes — weapon
base stats, enemy HP, skill values, quest steps — are edited there, not in the
systems that read them.

## Development mode

The cheats (`F5` spawn enemy, `F6` spawn loot, `F7` add XP, `F8` heal, `F9` give a
Legendary weapon) only respond when the app runs in dev mode; they are inert in a
packaged build.

## Notes and limits

- Audio is procedural (placeholder synth cues generated at runtime). The game does
  not depend on audio files being present.
- Single slot for now (`save_slot_1.json`); the save store supports multiple files.
- Scope deliberately excludes multiplayer, crafting, cloud saves and procedural
  worlds — this is a vertical slice of one outpost.

## Physics and simulation

- Gameplay advances at a fixed 60 Hz, with at most eight catch-up ticks per frame.
  Input edges survive render-only frames and are consumed once per simulation tick.
- The static collision world uses spatially indexed AABBs. Character movement uses
  conservative cylinder bounds and displacement substeps, wall sliding, supported
  step-up, ceiling stops and gravity. Crouching cannot be released under a low roof;
  jumps have 120 ms buffering and 100 ms ledge grace. Landing retains horizontal speed.
- Projectiles sweep their full travel segment against expanded world/body bounds,
  choose the nearest hit, honor their individual gravity, and damage the opposing
  side. Cover blocks bullets and splash. Grenades detonate on impact or fuse expiry.
- Enemies pursue the last visible location and abandon the search after six seconds.
  A bounded local A* search checks routes with the character collision solver;
  route requests are throttled. Gravity and knockback run in every living AI state.
- Target bounds occupy all intersected grid cells. The target index rebuilds after
  enemy movement, instead of on every pellet query. Effects advance during play.

This is a focused game physics layer, not a general rigid-body engine: movable
crates, joints, ragdolls, triangle-mesh slopes and dynamic character-to-character
contacts are not implemented. Navigation uses a bounded local search and does not
promise routes through arbitrary mazes. `npm test` runs without Electron or a display;
`npm run test:headless` additionally requires Xvfb and Electron's Linux libraries.
