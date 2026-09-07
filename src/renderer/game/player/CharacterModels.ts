import * as THREE from 'three';
import type { CharacterId } from '../../../shared/types';
import { CHARACTERS } from '../../data/characters/characters';
import { Skeleton, type BoneName } from '../anim/Rig';

/**
 * Procedural operator bodies.
 *
 * The three archetypes share one humanoid skeleton (`anim/Rig`, the same bones
 * the enemies use, so the existing clips drive them for free) and differ in
 * proportions, armour and headgear. Everything is built from a unit box and a
 * unit cylinder scaled per part, matching EnemyModels: no external assets, no
 * per-instance buffers.
 *
 * Proportions are absolute metres, not fractions of an arbitrary height, and
 * the hip height is derived from the leg chain so the feet always land exactly
 * on y = 0 where the game places the root.
 */

interface Proportions {
  spine: number;
  chest: number;
  neck: number;
  head: number;
  pelvisW: number;
  pelvisD: number;
  torsoW: number;
  torsoD: number;
  chestW: number;
  chestD: number;
  chestH: number;
  shoulderW: number;
  armThickness: number;
  upperArm: number;
  forearm: number;
  hipDrop: number;
  thigh: number;
  shin: number;
  legThickness: number;
  footHeight: number;
  headSize: number;
  /** Forward lean baked into the bind pose, in degrees. */
  hunch: number;
}

const PROPORTIONS: Record<CharacterId, Proportions> = {
  // Bulky: plated for a fight at shotgun range, stands ground-level solid.
  vanguard: {
    spine: 0.13, chest: 0.25, neck: 0.19, head: 0.05,
    pelvisW: 0.58, pelvisD: 0.38, torsoW: 0.62, torsoD: 0.40,
    chestW: 0.70, chestD: 0.44, chestH: 0.34,
    shoulderW: 0.76, armThickness: 0.17, upperArm: 0.30, forearm: 0.30,
    hipDrop: 0.05, thigh: 0.42, shin: 0.40, legThickness: 0.21, footHeight: 0.10,
    headSize: 0.29, hunch: 7,
  },
  // Lean and tall: built to stand on a ridgeline and take a long shot.
  ranger: {
    spine: 0.12, chest: 0.25, neck: 0.20, head: 0.06,
    pelvisW: 0.42, pelvisD: 0.27, torsoW: 0.46, torsoD: 0.29,
    chestW: 0.52, chestD: 0.32, chestH: 0.32,
    shoulderW: 0.55, armThickness: 0.115, upperArm: 0.33, forearm: 0.33,
    hipDrop: 0.06, thigh: 0.44, shin: 0.42, legThickness: 0.14, footHeight: 0.085,
    headSize: 0.26, hunch: 3,
  },
  // Compact: a shield cell and a drone rig carried on the back.
  engineer: {
    spine: 0.12, chest: 0.24, neck: 0.17, head: 0.05,
    pelvisW: 0.48, pelvisD: 0.31, torsoW: 0.52, torsoD: 0.33,
    chestW: 0.57, chestD: 0.37, chestH: 0.30,
    shoulderW: 0.60, armThickness: 0.14, upperArm: 0.30, forearm: 0.30,
    hipDrop: 0.05, thigh: 0.42, shin: 0.40, legThickness: 0.17, footHeight: 0.09,
    headSize: 0.27, hunch: 5,
  },
};

/** Stance the preview and the in-world body both rest in. */
const HOLD_ARM = 54;
const HOLD_ELBOW = -46;

const unitBox = new THREE.BoxGeometry(1, 1, 1);
const unitCylinder = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
const unitSphere = new THREE.SphereGeometry(0.5, 10, 8);
const sharedMaterials = new Map<string, THREE.MeshLambertMaterial>();

/** Cached per colour so N previews and one viewmodel share the same materials. */
function material(key: string, color: number, emissive = 0): THREE.MeshLambertMaterial {
  const cacheKey = `${key}:${color}:${emissive}`;
  const cached = sharedMaterials.get(cacheKey);
  if (cached) return cached;
  const mat = new THREE.MeshLambertMaterial({
    color,
    flatShading: true,
    emissive: emissive > 0 ? color : 0x000000,
    emissiveIntensity: emissive,
  });
  sharedMaterials.set(cacheKey, mat);
  return mat;
}

export interface BuiltCharacter {
  /** Feet at the origin, facing -Z like every other rig in the game. */
  root: THREE.Group;
  skeleton: Skeleton;
  meshes: THREE.Mesh[];
  dispose: () => void;
}

export function characterPalette(characterId: CharacterId): { body: number; accent: number } {
  const definition = CHARACTERS[characterId] ?? CHARACTERS.vanguard;
  const body = definition.colorHex;
  // Lift the archetype colour toward white for lamps and emissive trim.
  const mix = (channel: number) => Math.min(255, Math.round(channel + (255 - channel) * 0.55));
  const accent =
    (mix((body >> 16) & 0xff) << 16) | (mix((body >> 8) & 0xff) << 8) | mix(body & 0xff);
  return { body, accent };
}

/** Plate colour the viewmodel gloves take for an archetype. */
export function characterArmorColor(characterId: CharacterId): number {
  return characterPalette(PROPORTIONS[characterId] ? characterId : 'vanguard').body;
}

/**
 * Builds the full operator body for an archetype. `holdWeapon` poses the arms as
 * if shouldering a rifle, which is what the character-select preview wants.
 */
export function buildCharacterModel(
  characterId: CharacterId,
  options: { holdWeapon?: boolean; name?: string } = {},
): BuiltCharacter {
  const p = PROPORTIONS[characterId] ?? PROPORTIONS.vanguard;
  const hold = options.holdWeapon ?? true;
  const { body, accent } = characterPalette(characterId);

  const plating = material(`plate-${characterId}`, body);
  const suit = material(`suit-${characterId}`, 0x2b2f38);
  const trim = material('trim', 0x1b1e24);
  const rubber = material('rubber', 0x15181d);
  const glow = material(`glow-${characterId}`, accent, 0.85);

  const skeleton = new Skeleton(options.name ?? `operator-${characterId}`);
  const meshes: THREE.Mesh[] = [];

  const shell = (
    parent: THREE.Object3D,
    geo: THREE.BufferGeometry,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    mat: THREE.Material,
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.scale.set(w, h, d);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    meshes.push(mesh);
    return mesh;
  };

  // The foot shell hangs 0.7 of its height below the ankle bone; stacking the
  // leg chain on top of that plants the sole exactly on the root plane.
  const hipY = p.hipDrop + p.thigh + p.shin + p.footHeight * 0.7;

  // ------------------------------------------------------------- skeleton
  const hips = skeleton.bone('hips', null, 0, hipY, 0);
  const spine = skeleton.bone('spine', hips, 0, p.spine, 0);
  const chest = skeleton.bone('chest', spine, 0, p.chest, 0);
  const neck = skeleton.bone('neck', chest, 0, p.chestH * 0.55, 0);
  const head = skeleton.bone('head', neck, 0, p.neck, 0);

  skeleton.setBind('hips', p.hunch * 0.25);
  skeleton.setBind('spine', p.hunch * 0.45);
  skeleton.setBind('chest', p.hunch * 0.3);
  skeleton.setBind('neck', -p.hunch * 0.5);
  for (const name of ['head', 'shoulderL', 'shoulderR'] as BoneName[]) skeleton.setBind(name);

  const shoulderY = p.chestH * 0.38;
  for (const side of [-1, 1] as const) {
    const tag = side < 0 ? 'L' : 'R';
    const shoulder = skeleton.bone(`shoulder${tag}`, chest, side * p.shoulderW * 0.5, shoulderY, 0);
    skeleton.setBind(`shoulder${tag}`, 0, 0, side * 5);
    const arm = skeleton.bone(`arm${tag}`, shoulder, 0, -0.04, 0);
    skeleton.setBind(`arm${tag}`, hold ? HOLD_ARM : -3, 0, side * 7);
    skeleton.bone(`forearm${tag}`, arm, 0, -p.upperArm, 0);
    // The gun is held across the body, so the support arm bends further.
    skeleton.setBind(`forearm${tag}`, hold ? HOLD_ELBOW + side * 8 : -14);

    const thigh = skeleton.bone(`thigh${tag}`, hips, side * p.pelvisW * 0.28, -p.hipDrop, 0);
    skeleton.setBind(`thigh${tag}`, 0, 0, side * 2.5);
    const shin = skeleton.bone(`shin${tag}`, thigh, 0, -p.thigh, 0);
    skeleton.setBind(`shin${tag}`, 3);
    skeleton.bone(`foot${tag}`, shin, 0, -p.shin, 0);
    skeleton.setBind(`foot${tag}`, -3);
  }

  // --------------------------------------------------------------- shells
  shell(hips, unitBox, p.pelvisW, p.chestH * 0.52, p.pelvisD, 0, 0.02, 0, suit);
  shell(hips, unitBox, p.pelvisW * 1.02, 0.06, p.pelvisD * 1.02, 0, -0.06, 0, trim);
  shell(spine, unitBox, p.torsoW, p.chest + 0.10, p.torsoD, 0, p.chest * 0.45, 0, suit);
  shell(chest, unitBox, p.chestW, p.chestH, p.chestD, 0, 0.02, 0, plating);
  // Chest rig + collar so the front plate does not read as a plain box.
  shell(chest, unitBox, p.chestW * 0.5, p.chestH * 0.55, 0.06, 0, 0.02, -p.chestD * 0.55, trim);
  shell(chest, unitBox, p.chestW * 0.88, 0.07, p.chestD * 0.5, 0, p.chestH * 0.42, 0, trim);
  shell(chest, unitBox, 0.10, 0.045, 0.10, p.chestW * 0.24, 0.06, -p.chestD * 0.6, glow);

  const hs = p.headSize;
  shell(head, unitBox, hs, hs * 0.94, hs, 0, hs * 0.46, 0, suit);
  shell(head, unitBox, hs * 0.88, hs * 0.3, hs * 0.18, 0, hs * 0.5, -hs * 0.45, glow);

  for (const side of [-1, 1] as const) {
    const tag = side < 0 ? 'L' : 'R';
    const shoulder = skeleton.bones.get(`shoulder${tag}`)!;
    const arm = skeleton.bones.get(`arm${tag}`)!;
    const forearm = skeleton.bones.get(`forearm${tag}`)!;
    const thigh = skeleton.bones.get(`thigh${tag}`)!;
    const shin = skeleton.bones.get(`shin${tag}`)!;
    const foot = skeleton.bones.get(`foot${tag}`)!;
    const at = p.armThickness;
    const lg = p.legThickness;

    shell(shoulder, unitBox, at * 1.9, at * 1.4, at * 1.8, side * at * 0.3, 0, 0, plating);
    shell(arm, unitBox, at, p.upperArm, at, 0, -p.upperArm * 0.5, 0, suit);
    shell(forearm, unitBox, at * 0.94, p.forearm, at * 0.94, 0, -p.forearm * 0.5, 0, plating);
    shell(forearm, unitBox, at * 1.05, at * 0.5, at * 1.05, 0, -p.forearm, 0, rubber);

    shell(thigh, unitBox, lg, p.thigh, lg, 0, -p.thigh * 0.5, 0, suit);
    shell(shin, unitBox, lg * 0.92, p.shin, lg * 0.92, 0, -p.shin * 0.5, 0, plating);
    shell(foot, unitBox, lg * 1.05, p.footHeight, lg * 1.7, 0, -p.footHeight * 0.2, -lg * 0.28, rubber);
  }

  // ------------------------------------------------------ archetype gear
  if (characterId === 'vanguard') {
    // Slab shoulders, a brow-crest helmet and a hip-mounted ammo drum.
    for (const side of [-1, 1] as const) {
      const shoulder = skeleton.bones.get(side < 0 ? 'shoulderL' : 'shoulderR')!;
      shell(shoulder, unitBox, p.armThickness * 2.7, p.armThickness * 1.1, p.armThickness * 2.3, side * p.armThickness * 0.8, p.armThickness * 0.5, 0, plating);
    }
    shell(head, unitBox, hs * 1.08, hs * 0.28, hs * 1.08, 0, hs * 0.86, 0, plating);
    shell(head, unitBox, hs * 0.22, hs * 0.4, hs * 0.22, 0, hs * 1.06, 0, trim);
    shell(hips, unitCylinder, 0.22, 0.24, 0.22, -p.pelvisW * 0.54, 0, p.pelvisD * 0.2, trim);
    shell(hips, unitBox, p.pelvisW * 0.7, 0.26, 0.1, 0, 0.06, p.pelvisD * 0.58, plating);
  } else if (characterId === 'ranger') {
    // Snub antenna, a long scope canted over the visor and a slim pack.
    shell(head, unitBox, hs * 1.02, hs * 0.24, hs * 1.1, 0, hs * 0.74, hs * 0.06, plating);
    shell(head, unitBox, 0.05, 0.05, hs * 1.15, hs * 0.3, hs * 0.98, -hs * 0.1, trim).rotation.x = 0.35;
    shell(head, unitBox, 0.045, hs * 0.7, 0.045, -hs * 0.44, hs * 1.06, hs * 0.18, trim);
    shell(chest, unitBox, p.chestW * 0.6, p.chestH * 0.8, 0.14, 0, 0.02, p.chestD * 0.62, suit);
    shell(chest, unitBox, 0.06, 0.05, 0.06, p.chestW * 0.2, p.chestH * 0.3, p.chestD * 0.72, glow);
  } else {
    // Engineer: shield cell on the back and a folded drone pod on the shoulder.
    shell(chest, unitBox, p.chestW * 0.74, p.chestH * 0.9, 0.15, 0, 0.02, p.chestD * 0.62, trim);
    shell(chest, unitCylinder, 0.2, 0.26, 0.2, 0, 0.02, p.chestD * 0.82, glow);
    shell(skeleton.bones.get('shoulderR')!, unitBox, p.armThickness * 2.4, p.armThickness * 1.2, p.armThickness * 2, p.armThickness * 0.6, p.armThickness * 0.9, p.armThickness * 0.2, plating);
    shell(skeleton.bones.get('shoulderR')!, unitSphere, 0.16, 0.16, 0.16, p.armThickness * 1.4, p.armThickness * 1.6, 0, glow);
    shell(head, unitBox, hs * 1.04, hs * 0.2, hs * 1.04, 0, hs * 0.82, 0, plating);
    shell(head, unitBox, hs * 0.2, hs * 0.16, hs * 0.5, hs * 0.5, hs * 0.5, -hs * 0.2, glow);
  }

  return {
    root: skeleton.root,
    skeleton,
    meshes,
    dispose: () => {
      for (const mesh of meshes) mesh.removeFromParent();
      meshes.length = 0;
      skeleton.dispose();
    },
  };
}

/** Frees the module-level buffers; called from the app teardown. */
export function disposeSharedCharacterResources(): void {
  unitBox.dispose();
  unitCylinder.dispose();
  unitSphere.dispose();
  for (const mat of sharedMaterials.values()) mat.dispose();
  sharedMaterials.clear();
}
