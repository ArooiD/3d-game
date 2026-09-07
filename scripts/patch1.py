#!/usr/bin/env python3
"""Apply a batch of exact-string replacements to source files."""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

EDITS = [
    ('src/renderer/data/skills/skills.ts', 'DROP_GENERIC_ROWS', ''),
    ('src/renderer/game/core/StateManager.ts',
     "import { bus, GameEvents } from './EventBus';",
     "import { bus } from './EventBus';"),
    ('src/renderer/game/physics/CollisionWorld.ts', 'COLLISION_FIX', ''),
    ('src/renderer/game/world/World.ts', 'ANCHOR_TYPES', ''),
]


def apply(root, rel, old, new):
    path = os.path.join(root, rel)
    text = open(path, encoding='utf-8').read()
    if old == 'DROP_GENERIC_ROWS':
        start = text.index('const OFFENSE_GENERIC')
        end = text.index('const BRANCHES')
        text = text[:start] + text[end:]
    elif old == 'COLLISION_FIX':
        text = text.replace('  private flatGroundY = 0;', '  private groundY = 0;')
        text = text.replace(
            '  setFlatGround(y: number): void {\n    this.flatGroundY = y;\n  }\n\n'
            '  get flatGroundY(): number {\n    return this.flatGroundY;\n  }',
            '  setFlatGround(y: number): void {\n    this.groundY = y;\n  }\n\n'
            '  getFlatGround(): number {\n    return this.groundY;\n  }')
        text = text.replace('this.flatGroundY', 'this.groundY')
    elif old == 'ANCHOR_TYPES':
        text = text.replace(
            '  outpost: { x: number; z: number };\n'
            '  camp: { x: number; z: number };\n'
            '  canyonEntry: { x: number; z: number };\n'
            '  refinery: { x: number; z: number };\n'
            '  bossArena: { x: number; z: number };',
            '  outpost: Vec3;\n'
            '  camp: Vec3;\n'
            '  canyonEntry: Vec3;\n'
            '  refinery: Vec3;\n'
            '  bossArena: Vec3;')
        text = text.replace('export interface WorldAnchors {',
                            'interface Vec3 {\n  x: number;\n  y: number;\n  z: number;\n}\n\n'
                            'export interface WorldAnchors {')
        text = text.replace('outpost: { x: -104, y: 104 },', 'outpost: { x: -104, y: 0.4, z: 104 },')
        text = text.replace('camp: { x: -46, y: 52 },', 'camp: { x: -46, y: 0.2, z: 52 },')
        text = text.replace('canyonEntry: { x: -8, y: 20 },', 'canyonEntry: { x: -8, y: 0.3, z: 20 },')
        text = text.replace('refinery: { x: 40, y: -32 },', 'refinery: { x: 40, y: 0.4, z: -32 },')
        text = text.replace('bossArena: { x: 96, y: -96 },', 'bossArena: { x: 96, y: 0.6, z: -96 },')
    else:
        if old not in text:
            print(f'  MISS {rel}: pattern not found')
            return False
        text = text.replace(old, new)
    open(path, 'w', encoding='utf-8').write(text)
    print(f'  ok   {rel}')
    return True


for rel, old, new in EDITS:
    apply(ROOT, rel, old, new)
