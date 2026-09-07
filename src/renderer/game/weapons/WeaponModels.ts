import * as THREE from 'three';
import type { Weapon, WeaponType } from '../../../shared/types';
import { RARITY_HEX } from '../../../shared/constants';

/**
 * Procedural gun models, shared by the first-person viewmodel and ground loot.
 *
 * Every gun is assembled from a handful of shared primitives (unit box, cylinder,
 * torus) so no external assets are needed, and the silhouette changes per weapon
 * type. Rolled modifiers are also made visible: an extended magazine, a muzzle
 * brake, an optic, a bipod or a second barrel can all be read at a glance, which
 * is what makes a drop legible before you pick it up.
 *
 * Convention: the gun points down -Z, the grip sits near the origin, up is +Y.
 */

export type OpticKind = 'none' | 'red-dot' | 'optic' | 'scope';

export interface GunModelOptions {
  /** 'high' for the viewmodel, 'low' for ground drops and previews. */
  detail?: 'high' | 'low';
  /** Attach stylised gloved hands; viewmodel only. */
  hands?: boolean;
  /** Archetype plate colour for the gloves and forearms, so the arms read as yours. */
  armorColor?: number;
  /** Archetype trim colour echoed on the forearm lamps. */
  armorAccent?: number;
}

export interface GunModel {
  group: THREE.Group;
  /** Muzzle anchor in gun space; already positioned at the barrel tip. */
  muzzle: THREE.Object3D;
  /**
   * Optical centre in gun space: the point that must land on the crosshair when
   * aiming. Iron sights use the line between post and notch, optics the lens.
   */
  sights: THREE.Object3D;
  /** Optic fitted to this archetype, driving the HUD overlay while aiming. */
  optics: OpticKind;
  /** Parts driven by reload/inspect animation. */
  magazine: THREE.Object3D | null;
  bolt: THREE.Object3D | null;
  slide: THREE.Object3D | null;
  /** Muzzle-brake / rail emissive, pulsed by firing. */
  setGlow(intensity: number): void;
  dispose(): void;
}

const boxGeo = new THREE.BoxGeometry(1, 1, 1);
const cylGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
const torusGeo = new THREE.TorusGeometry(1, 0.14, 6, 14);

const COLOR_DARK = 0x23272e;
const COLOR_RAIL = 0x3d434c;
const COLOR_GRIP = 0x2b241c;
const COLOR_HAND = 0x6a4f3a;

/** Lightens a hex colour toward white by `amount` (0..1). */
function mixChannel(color: number, amount: number): number {
  const mix = (channel: number) => Math.round(channel + (255 - channel) * amount);
  return (mix((color >> 16) & 0xff) << 16) | (mix((color >> 8) & 0xff) << 8) | mix(color & 0xff);
}

/** Layout parameters that make each archetype read differently in the hand. */
interface Layout {
  receiver: [number, number, number];
  receiverY: number;
  receiverZ: number;
  barrelRadius: number;
  barrelLength: number;
  barrelY: number;
  hasStock: boolean;
  stockLength: number;
  stockDrop: number;
  magazineLength: number;
  magazineWidth: number;
  magazineRake: number;
  magazineZ: number;
  gripLength: number;
  foregrip: boolean;
  scope: OpticKind;
  pump: boolean;
  sideBySide: boolean;
  overallLength: number;
}

const LAYOUTS: Record<WeaponType, Layout> = {
  pistol: {
    receiver: [0.075, 0.1, 0.26], receiverY: 0.045, receiverZ: -0.1,
    barrelRadius: 0.017, barrelLength: 0.05, barrelY: 0.045,
    hasStock: false, stockLength: 0, stockDrop: 0,
    magazineLength: 0.13, magazineWidth: 0.055, magazineRake: 0.1, magazineZ: 0.02,
    gripLength: 0.15, foregrip: false, scope: 'none', pump: false, sideBySide: false,
    overallLength: 0.34,
  },
  assault_rifle: {
    receiver: [0.07, 0.085, 0.46], receiverY: 0.03, receiverZ: -0.16,
    barrelRadius: 0.018, barrelLength: 0.3, barrelY: 0.035,
    hasStock: true, stockLength: 0.2, stockDrop: 0.015,
    magazineLength: 0.21, magazineWidth: 0.05, magazineRake: 0.22, magazineZ: -0.1,
    gripLength: 0.13, foregrip: true, scope: 'red-dot', pump: false, sideBySide: false,
    overallLength: 0.8,
  },
  shotgun: {
    receiver: [0.085, 0.1, 0.4], receiverY: 0.03, receiverZ: -0.14,
    barrelRadius: 0.028, barrelLength: 0.46, barrelY: 0.055,
    hasStock: true, stockLength: 0.28, stockDrop: 0.045,
    magazineLength: 0.12, magazineWidth: 0.06, magazineRake: 0.05, magazineZ: -0.12,
    gripLength: 0.14, foregrip: false, scope: 'none', pump: true, sideBySide: false,
    overallLength: 0.95,
  },
  sniper_rifle: {
    receiver: [0.062, 0.078, 0.52], receiverY: 0.02, receiverZ: -0.2,
    barrelRadius: 0.016, barrelLength: 0.62, barrelY: 0.026,
    hasStock: true, stockLength: 0.3, stockDrop: 0.03,
    magazineLength: 0.11, magazineWidth: 0.05, magazineRake: 0.05, magazineZ: -0.14,
    gripLength: 0.13, foregrip: false, scope: 'scope', pump: false, sideBySide: false,
    overallLength: 1.2,
  },
  smg: {
    receiver: [0.062, 0.08, 0.3], receiverY: 0.03, receiverZ: -0.1,
    barrelRadius: 0.015, barrelLength: 0.14, barrelY: 0.032,
    hasStock: true, stockLength: 0.15, stockDrop: 0.005,
    magazineLength: 0.24, magazineWidth: 0.048, magazineRake: 0.08, magazineZ: -0.06,
    gripLength: 0.12, foregrip: true, scope: 'optic', pump: false, sideBySide: false,
    overallLength: 0.56,
  },
};

/** A modifier bonus worth showing as a physical part. */
function boosted(weapon: Weapon, stat: string, threshold: number): boolean {
  for (const modifier of weapon.modifiers) {
    if (modifier.stat === stat && modifier.value >= threshold) return true;
  }
  return false;
}

function flatProjectiles(weapon: Weapon): number {
  let extra = 0;
  for (const modifier of weapon.modifiers) {
    if (modifier.stat === 'projectiles') extra += Math.round(modifier.value);
  }
  return extra;
}

export function buildGunModel(weapon: Weapon, options: GunModelOptions = {}): GunModel {
  const detail = options.detail ?? 'high';
  const layout = LAYOUTS[weapon.weaponType] ?? LAYOUTS.assault_rifle;
  const group = new THREE.Group();
  group.name = `gun-${weapon.uid}`;

  const owned: THREE.Material[] = [];
  const meshOf = (geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return mesh;
  };

  const body = new THREE.MeshLambertMaterial({ color: weapon.modelColor, flatShading: true });
  const dark = new THREE.MeshLambertMaterial({ color: COLOR_DARK, flatShading: true });
  const rail = new THREE.MeshLambertMaterial({ color: COLOR_RAIL, flatShading: true });
  const gripMat = new THREE.MeshLambertMaterial({ color: COLOR_GRIP, flatShading: true });
  owned.push(body, dark, rail, gripMat);

  const accentColor = new THREE.Color(RARITY_HEX[weapon.rarity] ?? 0xffffff);
  const glowMat = new THREE.MeshLambertMaterial({
    color: accentColor.clone().multiplyScalar(0.5),
    emissive: accentColor.clone().multiplyScalar(0.35),
    flatShading: true,
  });
  owned.push(glowMat);

  const parts: THREE.Object3D[] = [];
  const place = (
    parent: THREE.Object3D,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    sx: number,
    sy: number,
    sz: number,
    x: number,
    y: number,
    z: number,
  ): THREE.Mesh => {
    const mesh = meshOf(geo, mat);
    mesh.scale.set(sx, sy, sz);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    parts.push(mesh);
    return mesh;
  };

  const put = (parent: THREE.Object3D, x: number, y: number, z: number): THREE.Object3D => {
    const node = new THREE.Object3D();
    node.position.set(x, y, z);
    parent.add(node);
    return node;
  };

  // ---------------------------------------------------------------- receiver
  const receiver = place(
    group, boxGeo, body,
    layout.receiver[0], layout.receiver[1], layout.receiver[2],
    0, layout.receiverY, layout.receiverZ,
  );
  receiver.name = 'receiver';

  // Top picatinny rail: a row of notches, cheap and instantly "sci-fi".
  const railLength = layout.receiver[2] * (detail === 'high' ? 0.8 : 0.6);
  place(group, boxGeo, rail, layout.receiver[0] * 0.72, 0.012, railLength,
    0, layout.receiverY + layout.receiver[1] * 0.5 + 0.006, layout.receiverZ - layout.receiver[2] * 0.06);
  if (detail === 'high') {
    const notches = 5;
    for (let i = 0; i < notches; i++) {
      place(group, boxGeo, dark, layout.receiver[0] * 0.78, 0.006, railLength / (notches * 2.2),
        0, layout.receiverY + layout.receiver[1] * 0.5 + 0.018,
        layout.receiverZ - layout.receiver[2] * 0.35 + (i * railLength) / notches);
    }
  }

  // Ejection port + charging handle on the right flank.
  if (weapon.weaponType !== 'pistol') {
    place(group, boxGeo, dark, 0.006, layout.receiver[1] * 0.34, layout.receiver[2] * 0.2,
      layout.receiver[0] * 0.5, layout.receiverY + layout.receiver[1] * 0.08, layout.receiverZ - layout.receiver[2] * 0.05);
  }

  const bolt = put(
    group,
    layout.receiver[0] * 0.55,
    layout.receiverY + layout.receiver[1] * 0.22,
    layout.receiverZ + layout.receiver[2] * 0.12,
  );
  bolt.name = 'bolt';
  if (weapon.weaponType !== 'pistol') {
    place(bolt, cylGeo, rail, 0.014, 0.05, 0.014, 0, 0, 0).rotation.x = Math.PI / 2;
  }

  // ------------------------------------------------------------------- stock
  if (layout.hasStock) {
    const stockZ = layout.receiverZ + layout.receiver[2] * 0.5 + layout.stockLength * 0.45;
    place(group, boxGeo, dark, layout.receiver[0] * 0.55, layout.receiver[1] * 0.55, layout.stockLength * 0.6,
      0, layout.receiverY - layout.stockDrop, stockZ);
    // Buffer tube tying stock to receiver.
    place(group, cylGeo, rail, layout.receiver[0] * 0.4, layout.stockLength * 0.7, layout.receiver[0] * 0.4,
      0, layout.receiverY - layout.stockDrop * 0.4, layout.receiverZ + layout.receiver[2] * 0.5 + layout.stockLength * 0.28)
      .rotation.x = Math.PI / 2;
    // Rubber butt pad.
    place(group, boxGeo, gripMat, layout.receiver[0] * 0.62, layout.receiver[1] * 0.78, 0.018,
      0, layout.receiverY - layout.stockDrop, stockZ + layout.stockLength * 0.32);
    if (weapon.weaponType === 'sniper_rifle') {
      // Thumbhole riser so the sniper stock reads as a precision rig.
      place(group, boxGeo, dark, layout.receiver[0] * 0.3, layout.receiver[1] * 0.5, layout.stockLength * 0.3,
        0, layout.receiverY - layout.stockDrop + layout.receiver[1] * 0.45, stockZ - layout.stockLength * 0.1);
    }
  }

  // -------------------------------------------------------------- barrel/shroud
  const barrelZ = layout.receiverZ - layout.receiver[2] * 0.5 - layout.barrelLength * 0.5;
  const heavyBarrel = boosted(weapon, 'damage', 0.18);
  const barrel = place(
    group, cylGeo, dark,
    layout.barrelRadius * (heavyBarrel ? 1.5 : 1), layout.barrelLength, layout.barrelRadius * (heavyBarrel ? 1.5 : 1),
    0, layout.barrelY, barrelZ,
  );
  barrel.rotation.x = Math.PI / 2;
  barrel.name = 'barrel';

  // Vented shroud over the barrel for high fire-rate rolls.
  if (boosted(weapon, 'fireRate', 0.12) && detail === 'high' && weapon.weaponType !== 'pistol') {
    const shroudLength = layout.barrelLength * 0.7;
    const shroud = place(group, cylGeo, rail, layout.barrelRadius * 2.1, shroudLength, layout.barrelRadius * 2.1,
      0, layout.barrelY, barrelZ - layout.barrelLength * 0.1);
    shroud.rotation.x = Math.PI / 2;
    for (let i = 0; i < 3; i++) {
      place(group, torusGeo, dark, layout.barrelRadius * 2.3, layout.barrelRadius * 2.3, layout.barrelRadius * 2.3,
        0, layout.barrelY, barrelZ + shroudLength * 0.3 - (i * shroudLength) / 3);
    }
  }

  const muzzleTipZ = barrelZ - layout.barrelLength * 0.5;

  // Muzzle device: a slotted brake when recoil is rolled down, a plain collar otherwise.
  if (boosted(weapon, 'recoil', 0.15)) {
    const brake = place(group, cylGeo, rail, layout.barrelRadius * 1.8, 0.05, layout.barrelRadius * 1.8,
      0, layout.barrelY, muzzleTipZ + 0.012);
    brake.rotation.x = Math.PI / 2;
    if (detail === 'high') {
      for (let i = 0; i < 2; i++) {
        place(group, boxGeo, dark, layout.barrelRadius * 3.6, layout.barrelRadius * 0.55, 0.012,
          0, layout.barrelY, muzzleTipZ + 0.026 - i * 0.018);
      }
    }
  } else {
    const collar = place(group, cylGeo, rail, layout.barrelRadius * 1.35, 0.022, layout.barrelRadius * 1.35,
      0, layout.barrelY, muzzleTipZ + 0.006);
    collar.rotation.x = Math.PI / 2;
  }

  // Split-shot barrels get a visible second tube.
  const extraBarrels = flatProjectiles(weapon);
  if (extraBarrels > 0) {
    for (let i = 0; i < Math.min(2, extraBarrels); i++) {
      const offset = (i === 0 ? -1 : 1) * layout.barrelRadius * 1.9;
      const tube = place(group, cylGeo, dark, layout.barrelRadius * 0.85, layout.barrelLength * 0.92, layout.barrelRadius * 0.85,
        offset, layout.barrelY - layout.barrelRadius * 0.4, barrelZ + layout.barrelLength * 0.04);
      tube.rotation.x = Math.PI / 2;
      place(group, cylGeo, rail, layout.barrelRadius * 1.15, 0.02, layout.barrelRadius * 1.15,
        offset, layout.barrelY - layout.barrelRadius * 0.4, muzzleTipZ - layout.barrelLength * 0.42)
        .rotation.x = Math.PI / 2;
    }
  }

  // Shield-breaker rolls glow through the barrel.
  if (weapon.shieldDamageBonus > 0) {
    const rings = detail === 'high' ? 2 : 1;
    for (let i = 0; i < rings; i++) {
      place(group, torusGeo, glowMat, layout.barrelRadius * 2.4, layout.barrelRadius * 2.4, layout.barrelRadius * 2.4,
        0, layout.barrelY, barrelZ + layout.barrelLength * 0.3 - (i * layout.barrelLength * 0.45));
    }
  }

  // ------------------------------------------------------------------ grips
  const gripZ = layout.receiverZ + layout.receiver[2] * 0.3;
  const grip = place(group, boxGeo, gripMat, layout.receiver[0] * 0.8, layout.gripLength, layout.receiver[0] * 0.8,
    0, layout.receiverY - layout.receiver[1] * 0.5 - layout.gripLength * 0.42, gripZ);
  grip.rotation.x = -0.28;

  const magazine = put(group, 0, layout.receiverY - layout.receiver[1] * 0.5, layout.receiverZ + layout.magazineZ);
  magazine.name = 'magazine';
  const extendedMag = boosted(weapon, 'magazineSize', 0.2);
  const magLength = layout.magazineLength * (extendedMag ? 1.4 : 1);
  const magMesh = place(magazine, boxGeo, rail, layout.magazineWidth, magLength, layout.magazineWidth * 1.5,
    0, -magLength * 0.5, 0);
  magMesh.rotation.x = layout.magazineRake;
  if (extendedMag) {
    place(magazine, boxGeo, dark, layout.magazineWidth * 1.15, 0.014, layout.magazineWidth * 1.65,
      0, -magLength, 0).rotation.x = layout.magazineRake;
  }
  // Mag well / release paddle.
  place(group, boxGeo, dark, layout.magazineWidth * 1.4, 0.016, layout.magazineWidth * 1.9,
    0, layout.receiverY - layout.receiver[1] * 0.5 - 0.008, layout.receiverZ + layout.magazineZ);

  if (layout.foregrip) {
    const fore = place(group, boxGeo, gripMat, layout.receiver[0] * 0.62, 0.085, layout.receiver[0] * 0.62,
      0, layout.receiverY - layout.receiver[1] * 0.5 - 0.03, layout.receiverZ - layout.receiver[2] * 0.42);
    fore.rotation.x = 0.2;
  }

  // Shotgun pump grip rides the barrel.
  let slide: THREE.Object3D | null = null;
  if (layout.pump) {
    slide = put(group, 0, layout.barrelY - layout.barrelRadius * 1.9, barrelZ + layout.barrelLength * 0.15);
    slide.name = 'pump';
    place(slide, boxGeo, gripMat, layout.receiver[0] * 1.15, 0.05, 0.11, 0, 0, 0);
    if (detail === 'high') {
      for (let i = 0; i < 4; i++) {
        place(slide, boxGeo, dark, layout.receiver[0] * 1.2, 0.008, 0.012, 0, 0.014 - i * 0.011, 0);
      }
    }
    // Tubular mag tube under the barrel.
    const tube = place(group, cylGeo, rail, layout.barrelRadius * 0.8, layout.barrelLength * 0.8, layout.barrelRadius * 0.8,
      0, layout.barrelY - layout.barrelRadius * 1.9, barrelZ + layout.barrelLength * 0.06);
    tube.rotation.x = Math.PI / 2;
  }

  // ------------------------------------------------------------------ sights
  const sightBaseY = layout.receiverY + layout.receiver[1] * 0.5 + 0.018;
  if (layout.scope === 'scope') {
    const scopeLength = weapon.range > 250 ? 0.26 : 0.2;
    const scopeR = 0.032;
    const bodyMesh = place(group, cylGeo, dark, scopeR, scopeLength, scopeR,
      0, sightBaseY + scopeR * 1.3, layout.receiverZ - layout.receiver[2] * 0.05);
    bodyMesh.rotation.x = Math.PI / 2;
    // Objective bell, eyepiece and two rings.
    const bell = place(group, cylGeo, rail, scopeR * 1.35, 0.03, scopeR * 1.35,
      0, sightBaseY + scopeR * 1.3, layout.receiverZ - layout.receiver[2] * 0.05 - scopeLength * 0.5);
    bell.rotation.x = Math.PI / 2;
    const eye = place(group, cylGeo, rail, scopeR * 1.15, 0.025, scopeR * 1.15,
      0, sightBaseY + scopeR * 1.3, layout.receiverZ - layout.receiver[2] * 0.05 + scopeLength * 0.5);
    eye.rotation.x = Math.PI / 2;
    // Glowing lens so snipers read as scoped at a glance.
    place(group, cylGeo, glowMat, scopeR * 0.95, 0.004, scopeR * 0.95,
      0, sightBaseY + scopeR * 1.3, layout.receiverZ - layout.receiver[2] * 0.05 - scopeLength * 0.5 - 0.016)
      .rotation.x = Math.PI / 2;
    for (let i = 0; i < 2; i++) {
      place(group, torusGeo, rail, scopeR * 1.2, scopeR * 1.2, scopeR * 1.2,
        0, sightBaseY + scopeR * 1.3, layout.receiverZ - layout.receiver[2] * 0.05 + (i - 0.5) * scopeLength * 0.55);
      place(group, boxGeo, dark, 0.012, scopeR * 0.9, scopeR * 0.5,
        0, sightBaseY + scopeR * 0.45, layout.receiverZ - layout.receiver[2] * 0.05 + (i - 0.5) * scopeLength * 0.55);
    }
    // Turret knobs.
    place(group, cylGeo, rail, 0.012, 0.02, 0.012, 0, sightBaseY + scopeR * 2.5, layout.receiverZ - layout.receiver[2] * 0.05);
    place(group, cylGeo, rail, 0.011, 0.018, 0.011, layout.receiver[0] * 0.6, sightBaseY + scopeR * 1.3, layout.receiverZ - layout.receiver[2] * 0.05)
      .rotation.z = Math.PI / 2;
    void bell;
    void eye;
  } else if (layout.scope === 'red-dot' || layout.scope === 'optic') {
    const housingZ = layout.receiverZ - layout.receiver[2] * 0.12;
    place(group, boxGeo, dark, 0.03, 0.036, layout.scope === 'optic' ? 0.07 : 0.05,
      0, sightBaseY + 0.02, housingZ);
    // Emissive dot / retainer glass.
    place(group, boxGeo, glowMat, 0.022, 0.02, 0.004, 0, sightBaseY + 0.022, housingZ - (layout.scope === 'optic' ? 0.037 : 0.026));
    if (layout.scope === 'optic') {
      place(group, boxGeo, rail, 0.034, 0.008, 0.02, 0, sightBaseY + 0.042, housingZ);
    }
  } else if (detail === 'high') {
    // Iron sights: front post plus rear notch.
    place(group, boxGeo, rail, 0.006, 0.024, 0.006, 0, sightBaseY + 0.01, layout.receiverZ - layout.receiver[2] * 0.42);
    place(group, boxGeo, rail, 0.026, 0.016, 0.006, 0, sightBaseY + 0.006, layout.receiverZ + layout.receiver[2] * 0.28);
  }

  // Bipod on long-range rolls.
  if (boosted(weapon, 'accuracy', 0.12) && (weapon.weaponType === 'sniper_rifle' || weapon.weaponType === 'assault_rifle') && detail === 'high') {
    const bipodZ = layout.receiverZ - layout.receiver[2] * 0.55;
    for (const side of [-1, 1] as const) {
      const leg = place(group, cylGeo, rail, 0.006, 0.1, 0.006, side * 0.02, layout.receiverY - 0.05, bipodZ);
      leg.rotation.z = side * 0.5;
      leg.rotation.x = -0.2;
    }
  }

  // Rarity stripe along the receiver flank: instant loot tier read.
  place(group, boxGeo, glowMat, 0.004, layout.receiver[1] * 0.18, layout.receiver[2] * 0.55,
    layout.receiver[0] * 0.52, layout.receiverY - layout.receiver[1] * 0.16, layout.receiverZ - layout.receiver[2] * 0.05);
  place(group, boxGeo, glowMat, 0.004, layout.receiver[1] * 0.18, layout.receiver[2] * 0.55,
    -layout.receiver[0] * 0.52, layout.receiverY - layout.receiver[1] * 0.16, layout.receiverZ - layout.receiver[2] * 0.05);

  // ------------------------------------------------------------------- hands
  if (options.hands) {
    const plate = options.armorColor ?? COLOR_HAND;
    const glove = new THREE.MeshLambertMaterial({ color: mixChannel(plate, 0.4), flatShading: true });
    const sleeve = new THREE.MeshLambertMaterial({ color: plate, flatShading: true });
    owned.push(glove, sleeve);

    /**
     * Forearm running back off-screen from a glove. `side` is only used to bias
     * the trim: the arms themselves are placed apart in X and Y and yawed toward
     * the weapon, which is what stops the pair reading as one flat cutout.
     */
    const gauntlet = (hand: THREE.Group, side: number, length: number): void => {
      place(hand, boxGeo, sleeve, 0.062, 0.05, 0.045, 0.004 * side, -0.05, 0.055).rotation.x = 0.5;
      place(hand, boxGeo, glove, 0.076, 0.074, length, 0, -0.056 - length * 0.46, 0.02 + length * 0.44)
        .rotation.x = Math.atan2(0.62, 1);
      if (options.armorAccent !== undefined) {
        const lamp = new THREE.MeshLambertMaterial({
          color: options.armorAccent,
          emissive: options.armorAccent,
          emissiveIntensity: 0.7,
          flatShading: true,
        });
        owned.push(lamp);
        place(hand, boxGeo, lamp, 0.02, 0.016, length * 0.46, 0.041 * side, -0.052 - length * 0.44, 0.03 + length * 0.45)
          .rotation.x = Math.atan2(0.62, 1);
      }
    };

    /**
     * Both hands sit where a shooter actually holds a weapon: the firing hand on
     * the grip to the right and high, the support hand forward, left and low.
     * Each forearm then yaws back toward its own shoulder, so on screen the arms
     * form a V into the weapon. Offsetting both hands only along the barrel axis
     * collapsed them into one flat silhouette.
     */
    const hand = (
      grip: THREE.Vector3,
      side: number,
      opts: { length: number; roll: number; yaw: number },
    ): THREE.Group => {
      const node = new THREE.Group();
      node.position.copy(grip);
      node.rotation.set(0.12, opts.yaw, opts.roll);
      group.add(node);
      // Palm, wrapped around whatever it is holding.
      place(node, boxGeo, glove, 0.055, 0.068, 0.072, 0, 0, 0);
      // Four fingers curling over the front face of the grip.
      for (let i = 0; i < 4; i++) {
        place(node, boxGeo, glove, 0.013, 0.048, 0.017, -0.029 + i * 0.017, 0.005, -0.04).rotation.x = -0.35;
      }
      // Thumb on the near flank, knuckle toward the camera.
      place(node, boxGeo, glove, 0.017, 0.02, 0.05, 0.031 * side, 0.02, -0.014).rotation.x = -0.5;
      gauntlet(node, side, opts.length);
      return node;
    };

    const gripTopY = layout.receiverY - layout.receiver[1] * 0.5 - layout.gripLength * 0.42;

    // Firing hand: on the grip, rolled in so the knuckles read against the light.
    hand(new THREE.Vector3(0.026, gripTopY - 0.01, gripZ + 0.022), 1, { length: 0.3, roll: -0.3, yaw: 0.34 });

    // Support hand: forward and under the barrel, reaching in from the left.
    const support = new THREE.Vector3();
    if (layout.pump && slide) {
      support.copy(slide.position).add(new THREE.Vector3(-0.03, -0.012, 0.005));
    } else if (layout.foregrip) {
      support.set(-0.034, layout.receiverY - layout.receiver[1] * 0.5 - 0.062,
        layout.receiverZ - layout.receiver[2] * 0.42 + 0.03);
    } else {
      // Cupping the grip from beneath, the way a two-handed grip actually works.
      support.set(-0.03, layout.receiverY - layout.receiver[1] * 0.5 - 0.055,
        layout.receiverZ + layout.magazineZ - 0.03);
    }
    hand(support, -1, { length: 0.27, roll: 0.36, yaw: -0.5 });
  }

  // Sighting anchor. Aiming parks this point on the view axis, so every archetype
  // - iron sights included - ends up pointing exactly where the crosshair is.
  const sights = new THREE.Object3D();
  sights.name = 'sights';
  const sightAnchorY = layout.receiverY + layout.receiver[1] * 0.5 + 0.018;
  if (layout.scope === 'scope') {
    sights.position.set(0, sightAnchorY + 0.032 * 1.3, layout.receiverZ - layout.receiver[2] * 0.05);
  } else if (layout.scope === 'red-dot' || layout.scope === 'optic') {
    const depth = layout.scope === 'optic' ? 0.037 : 0.026;
    sights.position.set(0, sightAnchorY + 0.022, layout.receiverZ - layout.receiver[2] * 0.12 - depth);
  } else {
    // Iron sights: weighted toward the rear notch, at post/notch height.
    const frontZ = layout.receiverZ - layout.receiver[2] * 0.42;
    const rearZ = layout.receiverZ + layout.receiver[2] * 0.28;
    sights.position.set(0, sightAnchorY + 0.011, frontZ * 0.35 + rearZ * 0.65);
  }
  group.add(sights);

  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.set(0, layout.barrelY, muzzleTipZ - layout.barrelLength * 0.02);
  group.add(muzzle);

  return {
    group,
    muzzle,
    sights,
    optics: layout.scope,
    magazine,
    bolt,
    slide,
    setGlow(intensity: number): void {
      glowMat.emissive.copy(accentColor).multiplyScalar(0.3 + intensity * 0.7);
    },
    dispose(): void {
      for (const mat of owned) mat.dispose();
      owned.length = 0;
      parts.length = 0;
      group.clear();
    },
  };
}

/**
 * Fits a gun model to a target overall length in metres, so the same builder
 * serves the viewmodel, ground drops and menu previews.
 */
export function fitGunLength(model: GunModel, targetLength: number): void {
  const bounds = new THREE.Box3().setFromObject(model.group);
  const size = new THREE.Vector3();
  bounds.getSize(size);
  model.group.scale.setScalar(targetLength / Math.max(0.001, size.z));
}

/** Overall length used when sizing a gun for a given context. */
export function lengthFor(type: WeaponType): number {
  const layout = LAYOUTS[type] ?? LAYOUTS.assault_rifle;
  return layout.overallLength;
}

/** The colour a gun's rarity will glow with, shared with loot beams. */
export function rarityAccent(rarity: string): THREE.Color {
  return new THREE.Color(RARITY_HEX[rarity] ?? 0xffffff);
}

export function disposeSharedWeaponGeometries(): void {
  boxGeo.dispose();
  cylGeo.dispose();
  torusGeo.dispose();
}

/** Convenience for previews: a gun at a fixed display length. */
export function buildGunPreview(weapon: Weapon, targetLength = 0.9): GunModel {
  const model = buildGunModel(weapon, { detail: 'high' });
  fitGunLength(model, targetLength);
  return model;
}
