import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { humanLimb, humanTorso, addHumanFace, disposeHumanResources } from './HumanGeometry';
import type { CharacterId } from '../../../shared/types';
import { CHARACTERS } from '../../data/characters/characters';
import { Skeleton, type BoneName } from '../anim/Rig';

/** Anatomically contoured operators with exposed faces and fitted field equipment.
 * Shared geometry, existing animation joints, feet at y=0 and forward -Z. */

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
    spine: 0.13, chest: 0.25, neck: 0.06, head: 0.05,
    pelvisW: 0.39, pelvisD: 0.28, torsoW: 0.38, torsoD: 0.27,
    chestW: 0.49, chestD: 0.30, chestH: 0.34,
    shoulderW: 0.49, armThickness: 0.17, upperArm: 0.30, forearm: 0.30,
    hipDrop: 0.05, thigh: 0.42, shin: 0.40, legThickness: 0.21, footHeight: 0.10,
    headSize: 0.25, hunch: 7,
  },
  // Lean and tall: built to stand on a ridgeline and take a long shot.
  ranger: {
    spine: 0.12, chest: 0.25, neck: 0.06, head: 0.06,
    pelvisW: 0.34, pelvisD: 0.24, torsoW: 0.32, torsoD: 0.23,
    chestW: 0.40, chestD: 0.26, chestH: 0.32,
    shoulderW: 0.42, armThickness: 0.115, upperArm: 0.33, forearm: 0.33,
    hipDrop: 0.06, thigh: 0.44, shin: 0.42, legThickness: 0.14, footHeight: 0.085,
    headSize: 0.24, hunch: 3,
  },
  // Compact: a shield cell and a drone rig carried on the back.
  engineer: {
    spine: 0.12, chest: 0.24, neck: 0.06, head: 0.05,
    pelvisW: 0.36, pelvisD: 0.26, torsoW: 0.35, torsoD: 0.25,
    chestW: 0.44, chestD: 0.28, chestH: 0.30,
    shoulderW: 0.46, armThickness: 0.14, upperArm: 0.30, forearm: 0.30,
    hipDrop: 0.05, thigh: 0.42, shin: 0.40, legThickness: 0.17, footHeight: 0.09,
    headSize: 0.24, hunch: 5,
  },
};

/** Stance the preview and the in-world body both rest in. */
const HOLD_ARM = 54;
const HOLD_ELBOW = -46;

// Bevels belong to equipment; anatomical surfaces supply the body contours.
const unitBox = new RoundedBoxGeometry(1, 1, 1, 3, .12);
const unitCylinder = new THREE.CylinderGeometry(0.5, 0.5, 1, 24);
const unitSphere = new THREE.SphereGeometry(0.5, 24, 16);
const unitPrism = new THREE.CylinderGeometry(0.5, 0.5, 1, 32);
const unitDome = new THREE.SphereGeometry(0.5, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
const sharedMaterials = new Map<string, THREE.MeshLambertMaterial>();

/** Cached per colour so N previews and one viewmodel share the same materials. */
function material(key: string, color: number, emissive = 0): THREE.MeshLambertMaterial {
  const cacheKey = `${key}:${color}:${emissive}`;
  const cached = sharedMaterials.get(cacheKey);
  if (cached) return cached;
  const mat = new THREE.MeshLambertMaterial({
    color,
    flatShading: false,
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

  /** Muscle profile overlaps the joint slightly to keep clothing continuous. */
  const limb = (
    parent: THREE.Object3D,
    thickness: number,
    length: number,
    y: number,
    mat: THREE.Material,
  ): THREE.Mesh =>
    shell(parent, humanLimb, thickness, length * 1.10, thickness, 0, y, 0, mat);

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
  // Fitted jacket contours: narrower waist, rib cage and shoulder transitions.
  shell(hips, unitPrism, p.pelvisW, p.chestH * 0.52, p.pelvisD * 1.25, 0, 0.02, 0, suit);
  shell(hips, unitPrism, p.pelvisW * 1.02, 0.06, p.pelvisD * 1.3, 0, -0.06, 0, trim);
  shell(spine, humanTorso, p.torsoW, p.chest + 0.10, p.torsoD, 0, p.chest * 0.45, 0, suit);
  shell(chest, humanTorso, p.chestW, p.chestH, p.chestD, 0, 0.02, 0, plating);
  // Chest rig + collar so the front plate does not read as a plain box.
  shell(chest, unitBox, p.chestW * 0.5, p.chestH * 0.55, 0.06, 0, 0.02, -p.chestD * 0.55, trim);
  shell(chest, unitBox, p.chestW * 0.88, 0.07, p.chestD * 0.5, 0, p.chestH * 0.42, 0, trim);
  shell(chest, unitSphere, 0.10, 0.05, 0.10, p.chestW * 0.24, 0.06, -p.chestD * 0.6, glow);

  const hs = p.headSize;
  const skin = material(`skin-${characterId}`, characterId === 'vanguard' ? 0xb17b5d : characterId === 'ranger' ? 0xc59b7b : 0x8e6149);
  shell(neck, unitCylinder, .105, p.neck + .05, .105, 0, p.neck * .45, 0, skin);
  addHumanFace(head, hs, (skin.color.getHex()), meshes);

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

    // Ball joints inside capsule segments: the shoulder, elbow, hip and knee read
    // as round articulation instead of the seams between boxes.
    shell(shoulder, unitDome, at * 1.4, at * 1.4, at * 1.5, side * at * 0.25, -at * 0.15, 0, plating);
    limb(arm, at, p.upperArm, -p.upperArm * 0.5, suit);
    shell(arm, unitSphere, at * 0.64, at * 0.64, at * 0.64, 0, -p.upperArm, 0, rubber);
    limb(forearm, at * 0.94, p.forearm, -p.forearm * 0.5, plating);
    shell(forearm, unitCylinder, at * 1.05, at * 0.5, at * 1.05, 0, -p.forearm + at * 0.25, 0, rubber);

    // Palm, four curled fingers and opposed thumb follow the weapon forearm.
    shell(forearm, unitSphere, .075, .105, .045, 0, -p.forearm-.04, -.006, rubber).name='palm';
    for (let finger=0; finger<4; finger++) {
      shell(forearm, unitSphere, .017, .055, .025, (finger-1.5)*.018, -p.forearm-.091, -.013, rubber).name='finger';
    }
    shell(forearm, unitSphere, .028, .060, .03, -side*.039, -p.forearm-.046, -.023, rubber).rotation.z=side*.45;

    limb(thigh, lg, p.thigh, -p.thigh * 0.5, suit);
    shell(thigh, unitSphere, lg * 0.62, lg * 0.62, lg * 0.62, 0, -p.thigh, 0, rubber);
    limb(shin, lg * 0.92, p.shin, -p.shin * 0.5, plating);
    shell(foot, unitPrism, lg * 1.05, p.footHeight, lg * 1.7, 0, -p.footHeight * 0.2, -lg * 0.28, rubber);
  }

  // ------------------------------------------------------ archetype gear
  if (characterId === 'vanguard') {
    // Domed pauldrons, a crested helmet cap and a hip-mounted ammo drum.
    for (const side of [-1, 1] as const) {
      const shoulder = skeleton.bones.get(side < 0 ? 'shoulderL' : 'shoulderR')!;
      shell(shoulder, unitDome, p.armThickness * 1.6, p.armThickness * 1.4, p.armThickness * 1.7, side * p.armThickness * 0.2, -p.armThickness * 0.2, 0, plating);
    }
    shell(head, unitDome, hs * 1.02, hs * 0.46, hs * 1.02, 0, hs * 0.83, 0, plating);
    shell(head, unitBox, hs * 0.22, hs * 0.4, hs * 0.22, 0, hs * 1.06, 0, trim);
    shell(hips, unitCylinder, 0.22, 0.24, 0.22, -p.pelvisW * 0.54, 0, p.pelvisD * 0.2, trim);
    shell(hips, unitBox, p.pelvisW * 0.7, 0.26, 0.1, 0, 0.06, p.pelvisD * 0.58, plating);
  } else if (characterId === 'ranger') {
    // Snub antenna, a long scope canted over the visor and a slim pack.
    shell(head, unitDome, hs * 1.06, hs * 0.5, hs * 1.08, 0, hs * 0.83, hs * 0.04, plating);
    shell(head, unitCylinder, 0.05, 0.05, hs * 1.15, hs * 0.3, hs * 0.98, -hs * 0.1, trim).rotation.x = 0.35;
    shell(head, unitCylinder, 0.045, hs * 0.7, 0.045, -hs * 0.44, hs * 1.06, hs * 0.18, trim);
    shell(chest, unitPrism, p.chestW * 0.6, p.chestH * 0.8, 0.2, 0, 0.02, p.chestD * 0.62, suit);
    shell(chest, unitSphere, 0.06, 0.05, 0.06, p.chestW * 0.2, p.chestH * 0.3, p.chestD * 0.72, glow);
  } else {
    // Engineer: shield cell on the back and a folded drone pod on the shoulder.
    shell(chest, unitPrism, p.chestW * 0.74, p.chestH * 0.9, 0.22, 0, 0.02, p.chestD * 0.62, trim);
    shell(chest, unitCylinder, 0.2, 0.26, 0.2, 0, 0.02, p.chestD * 0.82, glow);
    shell(skeleton.bones.get('shoulderR')!, unitDome, p.armThickness * 1.7, p.armThickness * 1.3, p.armThickness * 1.6, p.armThickness * 0.55, p.armThickness * 0.3, p.armThickness * 0.2, plating);
    shell(skeleton.bones.get('shoulderR')!, unitSphere, 0.16, 0.16, 0.16, p.armThickness * .7, p.armThickness * .5, 0, glow);
    shell(head, unitDome, hs * 1.08, hs * 0.46, hs * 1.08, 0, hs * 0.83, 0, plating);
    shell(head, unitSphere, hs * 0.2, hs * 0.16, hs * 0.5, hs * 0.5, hs * 0.5, -hs * 0.2, glow);
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
  for (const geo of [unitBox, unitCylinder, unitSphere, unitPrism, unitDome]) {
    geo.dispose();
  }
  for (const mat of sharedMaterials.values()) mat.dispose();
  sharedMaterials.clear();
  disposeHumanResources();
}
