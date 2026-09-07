import * as THREE from 'three';
import type { EnemyBehavior, EnemyDefinition } from '../../../shared/types';
import { MAX_ENEMY_LEVEL_SCALE } from '../../data/enemies/enemies';
import { enemyLevelScale } from '../../../shared/constants';
import { Skeleton, type BoneName } from '../anim/Rig';
import { EnemyAnimator } from '../anim/EnemyAnimator';

/**
 * Procedural enemy bodies: a segmented skeleton with rigid low-poly shells
 * parented to the bones, so the animation layer can drive real joints instead of
 * rotating whole meshes.
 *
 * Geometry is one shared unit box (plus a cylinder and a torus) scaled per part,
 * and materials are cached per definition, so N enemies of a type add no buffers
 * and no new materials.
 */

interface Proportions {
  hipHeight: number;
  torsoHeight: number;
  torsoWidth: number;
  torsoDepth: number;
  shoulderWidth: number;
  upperArm: number;
  forearm: number;
  limbThickness: number;
  thigh: number;
  shin: number;
  legThickness: number;
  headSize: number;
  /** Forward lean baked into the bind pose, in degrees. */
  hunch: number;
  neckLength: number;
}

const PROPORTIONS: Record<EnemyBehavior, Proportions> = {
  raider: {
    hipHeight: 0.5, torsoHeight: 0.62, torsoWidth: 0.52, torsoDepth: 0.32,
    shoulderWidth: 0.62, upperArm: 0.3, forearm: 0.28, limbThickness: 0.13,
    thigh: 0.46, shin: 0.44, legThickness: 0.17, headSize: 0.3, hunch: 6, neckLength: 0.08,
  },
  rusher: {
    hipHeight: 0.46, torsoHeight: 0.5, torsoWidth: 0.46, torsoDepth: 0.3,
    shoulderWidth: 0.66, upperArm: 0.34, forearm: 0.34, limbThickness: 0.12,
    thigh: 0.4, shin: 0.42, legThickness: 0.15, headSize: 0.26, hunch: 22, neckLength: 0.05,
  },
  heavy: {
    hipHeight: 0.46, torsoHeight: 0.72, torsoWidth: 0.86, torsoDepth: 0.5,
    shoulderWidth: 1.05, upperArm: 0.34, forearm: 0.3, limbThickness: 0.24,
    thigh: 0.4, shin: 0.38, legThickness: 0.28, headSize: 0.3, hunch: 4, neckLength: 0.02,
  },
  sniper: {
    hipHeight: 0.53, torsoHeight: 0.6, torsoWidth: 0.46, torsoDepth: 0.28,
    shoulderWidth: 0.56, upperArm: 0.32, forearm: 0.32, limbThickness: 0.11,
    thigh: 0.5, shin: 0.48, legThickness: 0.14, headSize: 0.28, hunch: 3, neckLength: 0.1,
  },
  boss: {
    hipHeight: 0.44, torsoHeight: 0.5, torsoWidth: 0.78, torsoDepth: 0.56,
    shoulderWidth: 1.5, upperArm: 0.4, forearm: 0.36, limbThickness: 0.3,
    thigh: 0.44, shin: 0.42, legThickness: 0.36, headSize: 0.26, hunch: 10, neckLength: 0.04,
  },
};

const unit = new THREE.BoxGeometry(1, 1, 1);
const cylinder = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
const ring = new THREE.TorusGeometry(1, 0.06, 6, 20);

export interface BuiltEnemy {
  skeleton: Skeleton;
  animator: EnemyAnimator;
  meshes: THREE.Mesh[];
  /** Shells that flash when the enemy is hit. */
  flashable: THREE.Mesh[];
  head: THREE.Mesh;
  /** Visor lamp: per-instance material used for state + hit feedback. */
  indicator: THREE.MeshLambertMaterial;
  barrel: THREE.Mesh | null;
  shieldRing: THREE.Mesh | null;
  /** Local-space muzzle anchor parented to the weapon arm. */
  muzzle: THREE.Object3D;
  dispose: () => void;
}

export class EnemyFactory {
  private materials = new Map<string, THREE.MeshLambertMaterial>();

  create(def: EnemyDefinition): BuiltEnemy {
    const p = PROPORTIONS[def.behavior] ?? PROPORTIONS.raider;
    const height = def.height;
    // Per-instance materials for anything that flashes on hit; shared ones are
    // cached per definition and never tinted.
    const body = new THREE.MeshLambertMaterial({ color: def.colorHex, flatShading: true });
    const dark = new THREE.MeshLambertMaterial({ color: 0x2b2f38, flatShading: true });
    const accent = this.material('accent', def.accentHex, def, true);
    const trim = this.material('trim', 0x1b1e24, def);

    const skeleton = new Skeleton(`enemy-${def.id}`);
    const meshes: THREE.Mesh[] = [];
    const flashable: THREE.Mesh[] = [];

    /** Box shell sized in metres, hung off a bone. */
    const shell = (
      parent: THREE.Object3D,
      w: number,
      h: number,
      d: number,
      x: number,
      y: number,
      z: number,
      material: THREE.Material,
      flash = true,
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(unit, material);
      mesh.scale.set(w, h, d);
      mesh.position.set(x, y, z);
      parent.add(mesh);
      meshes.push(mesh);
      if (flash && (material === body || material === dark)) flashable.push(mesh);
      return mesh;
    };

    const tube = (
      parent: THREE.Object3D,
      radius: number,
      length: number,
      x: number,
      y: number,
      z: number,
      material: THREE.Material,
      flash = true,
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(cylinder, material);
      mesh.scale.set(radius * 2, length, radius * 2);
      mesh.position.set(x, y, z);
      parent.add(mesh);
      meshes.push(mesh);
      if (flash && (material === body || material === dark)) flashable.push(mesh);
      return mesh;
    };

    // ------------------------------------------------------------ skeleton
    const hips = skeleton.bone('hips', null, 0, height * p.hipHeight, 0);
    const spine = skeleton.bone('spine', hips, 0, height * 0.1, 0);
    const chest = skeleton.bone('chest', spine, 0, height * p.torsoHeight * 0.55, 0);
    const neck = skeleton.bone('neck', chest, 0, height * p.torsoHeight * 0.42, 0);
    const head = skeleton.bone('head', neck, 0, height * p.neckLength, 0);

    skeleton.setBind('hips', p.hunch * 0.25);
    skeleton.setBind('spine', p.hunch * 0.45);
    skeleton.setBind('chest', p.hunch * 0.3);
    skeleton.setBind('neck', -p.hunch * 0.5);
    const flatBones: BoneName[] = ['head', 'shoulderL', 'shoulderR', 'armL', 'armR', 'forearmL', 'forearmR'];
    for (const name of flatBones) skeleton.setBind(name);

    const shoulderY = height * p.torsoHeight * 0.42;
    const armHang = def.behavior === 'rusher' ? -6 : -2;
    for (const side of [-1, 1] as const) {
      const tag = side < 0 ? 'L' : 'R';
      skeleton.bone(`shoulder${tag}`, chest, side * p.shoulderWidth * 0.5, shoulderY, 0);
      skeleton.setBind(`shoulder${tag}`, 0, 0, side * 4);
      skeleton.bone(`arm${tag}`, skeleton.bones.get(`shoulder${tag}`)!, 0, -height * 0.02, 0);
      skeleton.setBind(`arm${tag}`, armHang, 0, side * 6);
      skeleton.bone(`forearm${tag}`, skeleton.bones.get(`arm${tag}`)!, 0, -height * p.upperArm, 0);
      skeleton.setBind(`forearm${tag}`, def.behavior === 'rusher' ? -18 : -12);

      skeleton.bone(`thigh${tag}`, hips, side * p.torsoWidth * 0.28, -height * 0.02, 0);
      skeleton.setBind(`thigh${tag}`, 0, 0, side * 2);
      skeleton.bone(`shin${tag}`, skeleton.bones.get(`thigh${tag}`)!, 0, -height * p.thigh, 0);
      skeleton.setBind(`shin${tag}`, 3);
      skeleton.bone(`foot${tag}`, skeleton.bones.get(`shin${tag}`)!, 0, -height * p.shin, 0);
      skeleton.setBind(`foot${tag}`, -3);
    }

    // --------------------------------------------------------------- shells
    const torsoW = p.torsoWidth * height;
    const torsoH = p.torsoHeight * height;
    const torsoD = p.torsoDepth * height;
    const limb = p.limbThickness * height;
    const leg = p.legThickness * height;

    shell(hips, torsoW * 0.92, torsoH * 0.3, torsoD * 0.9, 0, torsoH * 0.02, 0, dark);
    shell(spine, torsoW * 0.98, torsoH * 0.5, torsoD * 0.95, 0, torsoH * 0.22, 0, body);
    shell(chest, torsoW, torsoH * 0.52, torsoD, 0, torsoH * 0.16, 0, body);
    shell(chest, torsoW * 0.72, torsoH * 0.22, torsoD * 0.42, 0, torsoH * 0.34, -torsoD * 0.55, trim);

    const headSize = p.headSize * height;
    const headShell = shell(head, headSize, headSize * 0.92, headSize, 0, headSize * 0.44, 0, dark);
    // The visor owns a per-instance material: it is the state/headshot lamp.
    const indicatorMaterial = (accent as THREE.MeshLambertMaterial).clone();
    const indicatorShell = new THREE.Mesh(unit, indicatorMaterial);
    indicatorShell.scale.set(headSize * 0.86, headSize * 0.2, headSize * 0.14);
    indicatorShell.position.set(0, headSize * 0.5, -headSize * 0.48);
    head.add(indicatorShell);
    meshes.push(indicatorShell);
    shell(head, headSize * 0.7, headSize * 0.22, headSize * 0.3, 0, headSize * 0.18, -headSize * 0.3, trim, false);

    for (const side of [-1, 1] as const) {
      const tag = side < 0 ? 'L' : 'R';
      const shoulderBone = skeleton.bones.get(`shoulder${tag}`)!;
      const armBone = skeleton.bones.get(`arm${tag}`)!;
      const forearmBone = skeleton.bones.get(`forearm${tag}`)!;
      const thighBone = skeleton.bones.get(`thigh${tag}`)!;
      const shinBone = skeleton.bones.get(`shin${tag}`)!;
      const footBone = skeleton.bones.get(`foot${tag}`)!;

      shell(shoulderBone, limb * 1.5, limb * 1.2, limb * 1.5, 0, limb * 0.4, 0, body);
      shell(armBone, limb, p.upperArm * height, limb, 0, -p.upperArm * height * 0.5, 0, body);
      shell(forearmBone, limb * 0.9, p.forearm * height, limb * 0.9, 0, -p.forearm * height * 0.5, 0, dark);
      shell(forearmBone, limb * 1.1, limb * 0.7, limb * 1.1, 0, -p.forearm * height * 0.94, 0, trim, false);

      shell(thighBone, leg, p.thigh * height, leg, 0, -p.thigh * height * 0.5, 0, dark);
      shell(shinBone, leg * 0.88, p.shin * height, leg * 0.88, 0, -p.shin * height * 0.5, 0, dark);
      // Boot, wider and pushed forward so the stance reads from the side.
      shell(footBone, leg * 1.05, leg * 0.45, leg * 1.9, 0, -leg * 0.18, -leg * 0.4, trim);
    }

    // ------------------------------------------------------- archetype props
    let barrel: THREE.Mesh | null = null;
    let shieldRing: THREE.Mesh | null = null;
    const muzzle = new THREE.Object3D();
    muzzle.name = 'muzzle';
    const forearmLength = p.forearm * height;

    if (def.behavior === 'raider' || def.behavior === 'sniper' || def.behavior === 'heavy') {
      const gunRoot = skeleton.bones.get('forearmR')!;
      const gunLength = def.behavior === 'sniper' ? height * 1.15 : def.behavior === 'heavy' ? height * 0.72 : height * 0.55;
      const gunBody = def.behavior === 'heavy' ? limb * 1.5 : limb * 0.7;
      shell(gunRoot, gunBody, gunBody * 0.8, gunLength * 0.6, 0, -forearmLength * 0.98, -gunLength * 0.2, trim);
      barrel = shell(gunRoot, gunBody * 0.45, gunBody * 0.45, gunLength, 0, -forearmLength * 0.98, -gunLength * 0.62, dark, false);
      if (def.behavior === 'sniper') {
        shell(gunRoot, gunBody * 0.5, gunBody * 0.5, gunLength * 0.34, 0, -forearmLength * 0.98 + gunBody * 0.8, -gunLength * 0.45, accent, false);
      }
      if (def.behavior === 'heavy') {
        tube(gunRoot, gunBody * 0.42, gunLength * 0.5, gunBody * 0.5, -forearmLength * 0.98, -gunLength * 0.55, dark, false);
        tube(gunRoot, gunBody * 0.42, gunLength * 0.5, -gunBody * 0.5, -forearmLength * 0.98, -gunLength * 0.55, dark, false);
      }
      // Support hand resting on the foregrip.
      shell(skeleton.bones.get('forearmL')!, limb * 1.1, limb, limb * 1.1, 0, -forearmLength * 0.9, -gunLength * 0.3, trim, false);
      muzzle.position.set(0, -forearmLength * 0.98, -gunLength * 1.12);
      gunRoot.add(muzzle);
    }

    if (def.behavior === 'rusher') {
      for (const side of [-1, 1] as const) {
        const tag = side < 0 ? 'L' : 'R';
        const shoulderBone = skeleton.bones.get(`shoulder${tag}`)!;
        const forearmBone = skeleton.bones.get(`forearm${tag}`)!;
        const spike = shell(shoulderBone, limb * 0.5, limb * 1.5, limb * 0.5, side * p.shoulderWidth * height * 0.16, limb * 0.9, 0, accent, false);
        spike.rotation.z = side * 0.5;
        for (let i = 0; i < 3; i++) {
          const claw = shell(forearmBone, limb * 0.22, limb * 1.5, limb * 0.22, (i - 1) * limb * 0.5, -forearmLength * 1.35, -limb * 0.35, dark, false);
          claw.rotation.x = -0.45;
        }
      }
      shell(chest, torsoW * 0.5, torsoH * 0.3, torsoD * 0.3, 0, torsoH * 0.1, torsoD * 0.52, accent, false);
      muzzle.position.set(0, -forearmLength * 1.2, -limb * 1.5);
      skeleton.bones.get('forearmR')!.add(muzzle);
    }

    if (def.behavior === 'heavy') {
      shell(chest, torsoW * 1.16, torsoH * 0.42, torsoD * 1.14, 0, torsoH * 0.2, 0, accent, false);
      for (const side of [-1, 1] as const) {
        const shoulderBone = skeleton.bones.get(side < 0 ? 'shoulderL' : 'shoulderR')!;
        shell(shoulderBone, limb * 2.5, limb * 1.5, limb * 2.2, 0, limb * 0.5, 0, body);
      }
      shell(spine, torsoW * 0.7, torsoH * 0.6, torsoD * 0.55, 0, torsoH * 0.1, torsoD * 0.62, trim, false);
      tube(spine, torsoW * 0.22, torsoH * 0.5, 0, torsoH * 0.1, torsoD * 0.62, accent, false);
    }

    if (def.behavior === 'sniper') {
      shell(spine, torsoW * 0.6, torsoH * 0.22, torsoD * 0.5, 0, torsoH * 0.02, torsoD * 0.6, trim, false);
      const antenna = tube(chest, height * 0.008, height * 0.5, p.shoulderWidth * height * 0.3, height * 0.24, torsoD * 0.2, dark, false);
      antenna.rotation.z = -0.2;
    }

    if (def.behavior === 'raider') {
      shell(hips, torsoW * 0.4, torsoH * 0.2, torsoD * 0.5, -torsoW * 0.4, -torsoH * 0.02, 0, trim, false);
      shell(spine, torsoW * 0.62, torsoH * 0.44, torsoD * 0.4, 0, torsoH * 0.16, torsoD * 0.6, trim, false);
    }

    if (def.behavior === 'boss') {
      // Scrap Titan: welded plate stack, rotary cannon, missile rack.
      shell(chest, torsoW * 1.1, torsoH * 0.55, torsoD, 0, torsoH * 0.2, 0, body);
      for (let i = 0; i < 3; i++) {
        shell(chest, torsoW * (1.12 - i * 0.08), torsoH * 0.1, torsoD * 1.12, 0, torsoH * (0.32 - i * 0.16), -torsoD * 0.06, dark, false);
      }
      shell(spine, torsoW * 0.9, torsoH * 0.5, torsoD * 0.9, 0, torsoH * 0.16, 0, trim);
      for (const side of [-1, 1] as const) {
        const stack = tube(spine, height * 0.05, height * 0.34, side * torsoW * 0.3, torsoH * 0.34, torsoD * 0.6, dark, false);
        stack.rotation.x = 0.25;
      }
      shell(spine, torsoW * 0.3, torsoH * 0.26, torsoD * 0.24, 0, torsoH * 0.18, torsoD * 0.56, accent, false);
      for (const side of [-1, 1] as const) {
        const shoulderBone = skeleton.bones.get(side < 0 ? 'shoulderL' : 'shoulderR')!;
        shell(shoulderBone, limb * 2.6, limb * 1.9, limb * 2.4, 0, limb * 0.6, 0, body);
        shell(shoulderBone, limb * 2.7, limb * 0.3, limb * 2.5, 0, limb * 0.1, 0, accent, false);
      }
      const armR = skeleton.bones.get('forearmR')!;
      const cannon = tube(armR, limb * 0.6, height * 0.5, 0, -forearmLength, -height * 0.16, dark, false);
      cannon.rotation.x = Math.PI / 2;
      for (let i = 0; i < 4; i++) {
        const barrelMesh = tube(
          armR,
          limb * 0.16,
          height * 0.42,
          Math.cos((i / 4) * Math.PI * 2) * limb * 0.3,
          -forearmLength,
          -height * 0.42,
          trim,
          false,
        );
        barrelMesh.rotation.x = Math.PI / 2;
      }
      muzzle.position.set(0, -forearmLength, -height * 0.66);
      armR.add(muzzle);
      const armL = skeleton.bones.get('forearmL')!;
      shell(armL, limb * 2, limb * 1.6, limb * 2.4, 0, -forearmLength, -limb, dark, false);
      for (let i = 0; i < 4; i++) {
        const pod = tube(
          armL,
          limb * 0.3,
          limb * 1.4,
          ((i % 2) - 0.5) * limb * 0.9,
          -forearmLength + (i < 2 ? limb * 0.45 : -limb * 0.45),
          -limb * 2,
          accent,
          false,
        );
        pod.rotation.x = Math.PI / 2;
      }
      for (const side of [-1, 1] as const) {
        const shinBone = skeleton.bones.get(side < 0 ? 'shinL' : 'shinR')!;
        shell(shinBone, leg * 1.25, p.shin * height * 0.7, leg * 1.3, 0, -p.shin * height * 0.45, -leg * 0.12, body, false);
      }
      shell(head, headSize * 1.3, headSize * 0.7, headSize, 0, headSize * 0.4, 0, trim, false);
    }

    if (def.isElite) {
      // Crown so players can pick the reward target out of a crowd.
      shell(head, headSize * 1.2, headSize * 0.14, headSize * 1.2, 0, headSize * 0.86, 0, accent, false);
    }

    if (def.shield > 0) {
      const shieldMaterial = (accent as THREE.MeshLambertMaterial).clone();
      shieldMaterial.transparent = true;
      shieldMaterial.opacity = 0.4;
      const shieldMesh = new THREE.Mesh(ring, shieldMaterial);
      shieldMesh.scale.setScalar(Math.max(torsoW, torsoD) * 1.15);
      shieldMesh.rotation.x = Math.PI / 2;
      chest.add(shieldMesh);
      meshes.push(shieldMesh);
      shieldRing = shieldMesh;
    }

    return {
      skeleton,
      animator: new EnemyAnimator(skeleton),
      meshes,
      flashable,
      head: headShell,
      indicator: indicatorMaterial,
      barrel,
      shieldRing,
      muzzle,
      dispose: () => {
        for (const mesh of meshes) mesh.parent?.remove(mesh);
        meshes.length = 0;
        flashable.length = 0;
        // Only instance-owned materials are disposed; shared ones stay cached.
        indicatorMaterial.dispose();
        if (shieldRing) (shieldRing.material as THREE.Material).dispose();
        skeleton.dispose();
      },
    };
  }

  private material(
    key: string,
    color: number,
    def: EnemyDefinition,
    emissive = false,
  ): THREE.MeshLambertMaterial {
    const cacheKey = `${key}-${def.id}`;
    const existing = this.materials.get(cacheKey);
    if (existing) return existing;
    const mat = new THREE.MeshLambertMaterial({
      color,
      flatShading: true,
      emissive: emissive ? new THREE.Color(color).multiplyScalar(0.55) : 0x000000,
    });
    this.materials.set(cacheKey, mat);
    return mat;
  }

  dispose(): void {
    for (const mat of this.materials.values()) mat.dispose();
    this.materials.clear();
  }

  static disposeShared(): void {
    unit.dispose();
    cylinder.dispose();
    ring.dispose();
  }
}

/** Screen-space health bar shown above damaged enemies. */
export class HealthBarPool {
  private bars: {
    el: HTMLDivElement;
    fill: HTMLElement;
    shield: HTMLElement;
    label: HTMLDivElement;
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
      // Name + level rides above the bar, so a glance identifies the target
      // before any damage has been dealt.
      const label = document.createElement('div');
      label.className = 'hpbar-label';
      el.appendChild(label);
      this.overlay.appendChild(el);
      this.bars.push({ el, fill, shield, label, target: null, offsetY: 0 });
    }
  }

  /** Assign bars to the nearest `count` targets that are hurt. */
  assign(entries: { object: THREE.Object3D; offsetY: number; label?: string; focused?: boolean }[]): void {
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
      if (bar.label.textContent !== entry.label) bar.label.textContent = entry.label ?? '';
      bar.label.classList.toggle('empty', !entry.label);
      bar.el.classList.toggle('focused', entry.focused === true);
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
