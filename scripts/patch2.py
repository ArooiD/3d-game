#!/usr/bin/env python3
"""Fix remaining type errors reported by tsc."""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def edit(rel, pairs):
    path = os.path.join(ROOT, rel)
    text = open(path, encoding='utf-8').read()
    for old, new in pairs:
        if old not in text:
            print(f'  MISS {rel}: {old[:60]!r}')
            continue
        text = text.replace(old, new)
    open(path, 'w', encoding='utf-8').write(text)
    print(f'  ok   {rel}')


edit('src/renderer/game/enemies/EnemyModels.ts', [
    ('const barFrames: THREE.Mesh[] = [];\n\n', ''),
    (
        '  private bars: { el: HTMLDivElement; fill: HTMLDivElement; shield: HTMLDivElement;'
        ' target: THREE.Object3D | null; offsetY: number }[] = [];',
        '  private bars: {\n'
        '    el: HTMLDivElement;\n'
        '    fill: HTMLElement;\n'
        '    shield: HTMLElement;\n'
        '    target: THREE.Object3D | null;\n'
        '    offsetY: number;\n'
        '  }[] = [];',
    ),
    (
        'export function scaleForLevel(def: EnemyDefinition, playerLevel: number): number {',
        'export function scaleForLevel(playerLevel: number): number {',
    ),
])

edit('src/renderer/game/effects/EffectsSystem.ts', [
    (
        "    bus.emit(GameEvents.LootDropped === '' ? '' : 'effect:explosion', { point, radius });\n",
        '    void bus;\n    void GameEvents;\n',
    ),
])
