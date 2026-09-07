import * as THREE from 'three';
import type { EnemyDefinition } from '../../../shared/types';
import { MAX_ENEMY_LEVEL_SCALE } from '../../data/enemies/enemies';
import { enemyLevelScale } from '../../../shared/constants';

/**
 * Low-poly enemy bodies built from primitives, plus pooled health bars.
 * One shared geometry set per behaviour keeps draw calls and memory flat no
 * matter how many enemies are alive.
 */

interface RigParts {
  root: THREE.Group;
  torso: THREE.Mesh;
  head: THREE.Mesh;
  legL: THREE.Mesh;
  legR: THREE.Mesh;
  armL: THREE.Mesh;
  armR: THREE.Mesh;
  visor: THREE.Mesh;
  barrel: THREE.Mesh | null;
  shieldRing: THREE.Mesh | null;
}

const shared = {
  torso: new THREE.BoxGeometry(0.82, 1.0, 0.5),
  head: new THREE.BoxGeometry(0.46, 0.44, 0.46),
  visor: new THREE.BoxGeometry(0.4, 0.12, 0.06),
  leg: new THREE.BoxGeometry(0.24, 0.8, 0.24),
  arm: new THREE.BoxGeometry(0.2, 0.72, 0.2),
  barrel: new THREE.BoxGeometry(0.14, 0.14, 0.9),
  pack: new THREE.BoxGeometry(0.5, 0.55, 0.3),
  shoulder: new THREE.BoxGeometry(0.3, 0.28, 0.42),
  ring: new THREE.TorusGeometry(0.95, 0.07, 6, 18),
  bossTorso: new THREE.BoxGeometry(3.2, 3.0, 2.2),
  bossHead: new THREE.BoxGeometry(1.3, 1.1, 1.2),
  bossArm: new THREE.BoxGeometry(0.9, 2.4, 0.9),
  bossLeg: new THREE.BoxGeometry(1.1, 2.2, 1.1),
  bossCannon: new THREE.CylinderGeometry(0.42, 0.5, 2.8, 8),
  bossMissile: new THREE.BoxGeometry(1.2, 0.9, 1.6),
  bossPlate: new THREE.BoxGeometry(3.6, 0.5, 2.6),
};

export class EnemyFactory {
  private materialCache = new Map<string, THREE.MeshLambertMaterial>();

  create(def: EnemyDefinition): { rig: RigParts; meshes: THREE.Mesh[]; dispose: () => void } {
    const isBoss = def.behavior === 'boss';
    const body = this.material(`body-${def.id}`, def.colorHex, def);
    const accent = this.material(`accent-${def.id}`, def.accentHex, def, true);
    const dark = this.material('dark', 0x2b2f38, def);
    const meshes: THREE.Mesh[] = [];
    const root = new THREE.Group();
    root.name = `enemy-${def.id}`;

    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      root.add(mesh);
      meshes.push(mesh);
      return mesh;
    };

    if (isBoss) {
      const torso = mk(shared.bossTorso, body, 0, 3.6, 0);
      const head = mk(shared.bossHead, dark, 0, 5.5, 0.2);
      mk(shared.visor, accent, 0, 5.55, 0.83);
      mk(shared.bossPlate, dark, 0, 4.6, 0);
      const legL = mk(shared.bossLeg, dark, -0.95, 1.1, 0);
      const legR = mk(shared.bossLeg, dark, 0.95, 1.1, 0);
      const armL = mk(shared.bossArm, body, -2.2, 3.7, 0);
      const armR = mk(shared.bossArm, body, 2.2, 3.7, 0);
      const barrel = mk(shared.bossCannon, dark, -2.2, 3.4, 1.6);
      barrel.rotation.x = Math.PI / 2;
      mk(shared.bossMissile, accent, 2.2, 4.6, 0.4);
      const shieldRing = mk(shared.ring, accent, 0, 3.6, 0);
      shieldRing.rotation.x = Math.PI / 2;
      shieldRing.scale.setScalar(1.9);
      return {
        rig: { root, torso, head, legL, legR, armL, armR, visor: head, barrel, shieldRing },
        meshes,
        dispose: () => this.releaseMeshes(meshes),
      };
    }

    const scale = def.height / 1.8;
    const torso = mk(shared.torso, body, 0, 1.25 * scale, 0);
    const head = mk(shared.head, dark, 0, 1.98 * scale, 0);
    const visor = mk(shared.visor, accent, 0, 2.0 * scale, 0.24);
    const legL = mk(shared.leg, dark, -0.2 * scale, 0.42 * scale, 0);
    const legR = mk(shared.leg, dark, 0.2 * scale, 0.42 * scale, 0);
    const armL = mk(shared.arm, body, -0.55 * scale, 1.28 * scale, 0);
    const armR = mk(shared.arm, body, 0.55 * scale, 1.28 * scale, 0);
    mk(shared.pack, dark, 0, 1.35 * scale, -0.4 * scale);

    if (def.behavior === 'heavy') {
      mk(shared.shoulder, accent, -0.62 * scale, 1.72 * scale, 0);
      mk(shared.shoulder, accent, 0.62 * scale, 1.72 * scale, 0);
    }

    let barrel: THREE.Mesh | null = null;
    if (def.behavior === 'raider' || def.behavior === 'sniper' || def.behavior === 'heavy') {
      barrel = mk(def.behavior === 'sniper' ? shared.bossCannon : shared.barrel, dark, 0.55 * scale, 1.3 * scale, 0.55);
      if (def.behavior === 'sniper') barrel.rotation.x = Math.PI / 2;
    }

    let shieldRing: THREE.Mesh | null = null;
    if (def.shield > 0) {
      shieldRing = mk(shared.ring, accent, 0, 1.25 * scale, 0);
      shieldRing.rotation.x = Math.PI / 2;
      shieldRing.scale.setScalar(def.isElite ? 1.15 : 0.95);
    }

    root.scale.setScalar(def.behavior === 'heavy' ? 1.25 : def.behavior === 'rusher' ? 0.9 : 1);

    return {
      rig: { root, torso, head, legL, legR, armL, armR, visor, barrel, shieldRing },
      meshes,
      dispose: () => this.releaseMeshes(meshes),
    };
  }

  private material(
    key: string,
    color: number,
    def: EnemyDefinition,
    emissive = false,
  ): THREE.MeshLambertMaterial {
    const cacheKey = `${key}-${def.id}`;
    const existing = this.materialCache.get(cacheKey);
    if (existing) return existing;
    const mat = new THREE.MeshLambertMaterial({
      color,
      flatShading: true,
      emissive: emissive ? new THREE.Color(color).multiplyScalar(0.55) : 0x000000,
    });
    this.materialCache.set(cacheKey, mat);
    return mat;
  }

  private releaseMeshes(meshes: THREE.Mesh[]): void {
    for (const mesh of meshes) {
      mesh.parent?.remove(mesh);
    }
    meshes.length = 0;
  }

  dispose(): void {
    for (const mat of this.materialCache.values()) mat.dispose();
    this.materialCache.clear();
  }

  static disposeShared(): void {
    for (const geo of Object.values(shared)) geo.dispose();
  }
}

/** Screen-space health bar shown above damaged enemies. */
export class HealthBarPool {
  private bars: {
    el: HTMLDivElement;
    fill: HTMLElement;
    shield: HTMLElement;
    target: THREE.Object3D | null;
    offsetY: number;
  }[] = [];

  constructor(private overlay: HTMLElement, size = 18) {
    for (let i = 0; i < size; i++) {
      const el = document.createElement('div');
      el.className = 'hpbar hidden';
      const shield = document.createElement('i');
      shield.className = 'hpbar-shield';
      const fill = document.createElement('i');
      fill.className = 'hpbar-fill';
      el.appendChild(shield);
      el.appendChild(fill);
      this.overlay.appendChild(el);
      this.bars.push({ el, fill, shield, target: null, offsetY: 0 });
    }
  }

  /** Assign bars to the nearest `count` targets that are hurt. */
  assign(entries: { object: THREE.Object3D; offsetY: number }[]): void {
    for (let i = 0; i < this.bars.length; i++) {
      const bar = this.bars[i] as (typeof this.bars)[number];
      const entry = entries[i];
      if (!entry) {
        bar.target = null;
        bar.el.classList.add('hidden');
        continue;
      }
      bar.target = entry.object;
      bar.offsetY = entry.offsetY;
      bar.el.classList.remove('hidden');
    }
  }

  update(
    camera: THREE.Camera,
    healthOf: (object: THREE.Object3D) => { hp: number; maxHp: number; shield: number; maxShield: number; hidden: boolean } | null,
  ): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const scratch = new THREE.Vector3();
    for (const bar of this.bars) {
      const target = bar.target;
      if (!target) continue;
      const data = healthOf(target);
      if (!data || data.hidden) {
        bar.el.classList.add('hidden');
        continue;
      }
      scratch.setFromMatrixPosition(target.matrixWorld);
      scratch.y += bar.offsetY;
      scratch.project(camera);
      if (scratch.z > 1) {
        bar.el.classList.add('hidden');
        continue;
      }
      const x = (scratch.x * 0.5 + 0.5) * width;
      const y = (-scratch.y * 0.5 + 0.5) * height;
      bar.el.classList.remove('hidden');
      bar.el.style.transform = `translate(-50%, -50%) translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
      const hpRatio = Math.max(0, data.hp / Math.max(1, data.maxHp));
      bar.fill.style.width = `${(hpRatio * 100).toFixed(1)}%`;
      const shieldRatio = data.maxShield > 0 ? Math.max(0, data.shield / data.maxShield) : 0;
      bar.shield.style.width = `${(shieldRatio * 100).toFixed(1)}%`;
    }
  }

  dispose(): void {
    for (const bar of this.bars) bar.el.remove();
    this.bars.length = 0;
  }
}

export function scaleForLevel(playerLevel: number): number {
  return Math.min(MAX_ENEMY_LEVEL_SCALE, enemyLevelScale(playerLevel));
}
