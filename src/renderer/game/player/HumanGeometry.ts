import * as THREE from 'three';

/**
 * Smooth elliptical body sections: [height, half width, half depth, depth offset].
 *
 * These meshes are shared by players and enemies, so spend a few more vertices
 * here instead of trying to hide angular silhouettes with lots of tiny prop
 * meshes. The previous 32-sided / four-row interpolation was already smooth at a
 * distance, but close enemies still exposed visible shoulders, elbows and head
 * facets. Forty-eight radial samples and six rows between authored sections keep
 * the silhouette round without making every actor a unique high-poly asset.
 */
export function humanSurface(rings: number[][], sides = 48, rowsPerSection = 6): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(
    rings.map((r) => new THREE.Vector3(r[1]!, r[2]!, r[3] ?? 0)),
    false,
    'catmullrom',
    0.18,
  );
  const positions: number[] = [];
  const indices: number[] = [];
  const rows = (rings.length - 1) * rowsPerSection;

  for (let j = 0; j <= rows; j++) {
    const t = j / rows;
    const at = t * (rings.length - 1);
    const i = Math.min(rings.length - 2, Math.floor(at));
    const local = at - i;
    // Smoothstep the authored vertical spacing as well as the radius. This keeps
    // biceps, calves, jaw and clavicles from reading as stacked cones.
    const s = local * local * (3 - 2 * local);
    const y = THREE.MathUtils.lerp(rings[i]![0]!, rings[i + 1]![0]!, s);
    const radius = curve.getPoint(t);

    for (let k = 0; k <= sides; k++) {
      const angle = (k / sides) * Math.PI * 2;
      const sx = Math.sin(angle);
      const cz = Math.cos(angle);
      // Human cross-sections are a little flatter on the back and fuller at the
      // front than a perfect ellipse. The subtle term is enough to avoid the
      // inflatable-tube look while preserving the simple shared geometry.
      const frontBias = cz < 0 ? 1.035 : 0.975;
      positions.push(
        sx * radius.x,
        y,
        cz * radius.y * frontBias + radius.z,
      );
      if (j < rows && k < sides) {
        const a = j * (sides + 1) + k;
        const b = a + sides + 1;
        indices.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  // Weld the duplicated UV seam normals so specular/directional lighting cannot
  // reveal a vertical line along the actor's side.
  const normals = geo.getAttribute('normal');
  for (let j = 0; j <= rows; j++) {
    const a = j * (sides + 1);
    const b = a + sides;
    const v = new THREE.Vector3(
      normals.getX(a) + normals.getX(b),
      normals.getY(a) + normals.getY(b),
      normals.getZ(a) + normals.getZ(b),
    ).normalize();
    normals.setXYZ(a, v.x, v.y, v.z);
    normals.setXYZ(b, v.x, v.y, v.z);
  }
  normals.needsUpdate = true;
  return geo;
}

/**
 * Organic limb profile. Both arm and leg builders scale this shape, so the
 * centre carries muscle mass while wrist/ankle ends remain visibly narrower.
 */
export const humanLimb = humanSurface([
  [-.50, .22, .24, 0],
  [-.45, .28, .30, 0],
  [-.34, .38, .39, .008],
  [-.17, .47, .46, .018],
  [.02, .51, .49, .025],
  [.20, .48, .46, .016],
  [.35, .39, .39, .006],
  [.45, .29, .30, 0],
  [.50, .23, .24, 0],
]);

/** Waist -> abdomen -> rib cage -> clavicle, with a slight forward chest bias. */
export const humanTorso = humanSurface([
  [-.50, .33, .35, .015],
  [-.42, .38, .39, .010],
  [-.28, .40, .42, 0],
  [-.12, .43, .45, -.012],
  [.06, .49, .50, -.030],
  [.22, .54, .51, -.038],
  [.36, .50, .46, -.020],
  [.46, .39, .36, .004],
  [.50, .27, .28, .012],
]);

/** Jaw -> cheekbone -> temple -> rounded cranium. */
export const humanHead = humanSurface([
  [0, .22, .18, -.045],
  [.07, .28, .23, -.045],
  [.17, .34, .31, -.030],
  [.31, .41, .37, -.005],
  [.48, .45, .41, .018],
  [.66, .45, .42, .035],
  [.82, .41, .40, .045],
  [.93, .31, .31, .050],
  [1, .001, .001, .050],
]);

/** Rounded palm/fist used by procedural rigs instead of a cuboid hand. */
export const humanHand = humanSurface([
  [-.50, .29, .22, 0],
  [-.34, .44, .34, -.015],
  [-.05, .51, .40, -.025],
  [.25, .46, .36, -.012],
  [.44, .31, .25, 0],
  [.50, .20, .18, 0],
], 40, 5);

/** Smooth joint cap for elbows and knees; deliberately slightly flattened. */
export const humanJoint = new THREE.SphereGeometry(.5, 32, 24);

const detail = new THREE.SphereGeometry(.5, 32, 24);
const skinMaterials = new Map<number, THREE.MeshLambertMaterial>();

function skin(color: number): THREE.MeshLambertMaterial {
  if (!skinMaterials.has(color)) {
    skinMaterials.set(color, new THREE.MeshLambertMaterial({ color, flatShading: false }));
  }
  return skinMaterials.get(color)!;
}

/**
 * Stylized but recognisably human face facing -Z. The features overlap the head
 * surface by only a few millimetres so they read as one face rather than a stack
 * of spheres when an enemy gets close to the camera.
 */
export function addHumanFace(
  parent: THREE.Object3D,
  size: number,
  color: number,
  meshes: THREE.Mesh[],
  y = 0,
): THREE.Mesh {
  const flesh = skin(color);
  const hair = skin(0x302720);
  const lips = skin(0x89594f);
  const socket = skin(0x765b52);
  const white = skin(0xe2ddd3);
  const iris = skin(0x343e37);

  const part = (
    name: string,
    mat: THREE.Material,
    x: number,
    yy: number,
    z: number,
    w: number,
    h: number,
    d: number,
    geo: THREE.BufferGeometry = detail,
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.position.set(x * size, y + yy * size, z * size);
    mesh.scale.set(w * size, h * size, d * size);
    mesh.castShadow = true;
    parent.add(mesh);
    meshes.push(mesh);
    return mesh;
  };

  const head = part('human-face', flesh, 0, 0, 0, 1, 1, 1, humanHead);

  // Jaw/chin provide a continuous lower-face silhouette rather than a spherical
  // head ending directly at the neck.
  part('jaw', flesh, 0, .18, -.16, .60, .28, .42);
  part('chin', flesh, 0, .09, -.31, .30, .16, .18);

  // Nose uses bridge + tip + small alar volumes, enough to retain shape from side
  // views without turning the face into a blocky mask.
  part('nose-bridge', flesh, 0, .48, -.39, .10, .29, .13);
  part('nose-tip', flesh, 0, .35, -.47, .16, .11, .15);
  for (const side of [-1, 1] as const) {
    part('nostril-wing', flesh, side * .075, .34, -.445, .075, .065, .07);
  }

  part('upper-lip', lips, 0, .235, -.356, .23, .032, .038);
  part('lower-lip', lips, 0, .202, -.348, .20, .038, .041);

  for (const side of [-1, 1] as const) {
    part('ear', flesh, side * .445, .45, .018, .13, .22, .10);
    part('cheek', flesh, side * .245, .37, -.285, .20, .15, .10);
    part('eye-socket', socket, side * .18, .555, -.34, .235, .115, .075);
    part('eye', white, side * .18, .56, -.392, .16, .054, .045);
    part('iris', iris, side * .18, .56, -.419, .050, .050, .012);
    const brow = part('eyebrow', hair, side * .18, .642, -.365, .225, .035, .055);
    brow.rotation.z = side * .08;
  }

  // Hair cap hugs the cranium and is deliberately shallower than the old sphere,
  // so it no longer gives every actor a helmet-like cuboid silhouette.
  part('hair', hair, 0, .80, .07, .86, .29, .76);
  part('hair-crown', hair, 0, .91, .10, .67, .16, .56);
  return head;
}

export function disposeHumanResources(): void {
  for (const geo of [humanLimb, humanTorso, humanHead, humanHand, humanJoint, detail]) geo.dispose();
  for (const mat of skinMaterials.values()) mat.dispose();
  skinMaterials.clear();
}
