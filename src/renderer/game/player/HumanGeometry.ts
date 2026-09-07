import * as THREE from 'three';

/** Smooth elliptical sections: [height, half width, half depth, depth offset]. */
export function humanSurface(rings: number[][]): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(rings.map(r => new THREE.Vector3(r[1]!, r[2]!, r[3] ?? 0)), false, 'catmullrom', 0.2);
  const positions: number[] = [], indices: number[] = [];
  const rows = (rings.length - 1) * 4, sides = 32;
  for (let j = 0; j <= rows; j++) {
    const t = j / rows, at = t * (rings.length - 1), i = Math.min(rings.length - 2, Math.floor(at));
    const y = THREE.MathUtils.lerp(rings[i]![0]!, rings[i + 1]![0]!, at - i);
    const radius = curve.getPoint(t);
    for (let k = 0; k <= sides; k++) {
      const angle = k / sides * Math.PI * 2;
      positions.push(Math.sin(angle) * radius.x, y, Math.cos(angle) * radius.y + radius.z);
      if (j < rows && k < sides) {
        const a = j * (sides + 1) + k, b = a + sides + 1;
        indices.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices); geo.computeVertexNormals();
  const n = geo.getAttribute('normal');
  for (let j = 0; j <= rows; j++) {
    const a = j * (sides + 1), b = a + sides;
    const v = new THREE.Vector3(n.getX(a) + n.getX(b), n.getY(a) + n.getY(b), n.getZ(a) + n.getZ(b)).normalize();
    n.setXYZ(a, v.x, v.y, v.z); n.setXYZ(b, v.x, v.y, v.z);
  }
  return geo;
}

export const humanLimb = humanSurface([
  [-.5,.27,.29,0],[-.42,.32,.34,0],[-.22,.44,.43,.015],
  [.03,.5,.48,.025],[.27,.46,.45,.01],[.43,.34,.35,0],[.5,.29,.30,0],
]);
export const humanTorso = humanSurface([
  [-.5,.38,.39,0],[-.34,.40,.42,0],[-.12,.44,.47,0],
  [.12,.5,.5,-.015],[.32,.48,.45,0],[.45,.37,.35,.01],[.5,.27,.29,0],
]);
export const humanHead = humanSurface([
  [0,.13,.18,-.03],[.08,.27,.29,-.03],[.22,.37,.35,0],
  [.4,.43,.40,.015],[.6,.44,.41,.025],[.8,.41,.39,.035],
  [.94,.28,.29,.035],[1,.001,.001,.035],
]);
const detail = new THREE.SphereGeometry(.5, 24, 16);
const skinMaterials = new Map<number, THREE.MeshLambertMaterial>();
function skin(color: number): THREE.MeshLambertMaterial {
  if (!skinMaterials.has(color)) skinMaterials.set(color, new THREE.MeshLambertMaterial({color}));
  return skinMaterials.get(color)!;
}

/** Original stylized face facing -Z, following the existing animated head joint. */
export function addHumanFace(parent: THREE.Object3D, size: number, color: number, meshes: THREE.Mesh[], y = 0): THREE.Mesh {
  const flesh = skin(color), hair = skin(0x302720), lips = skin(0x89594f), white = skin(0xd4cec1), iris = skin(0x343e37);
  const part = (name: string, mat: THREE.Material, x: number, yy: number, z: number, w: number, h: number, d: number, geo = detail as THREE.BufferGeometry) => {
    const m = new THREE.Mesh(geo, mat); m.name = name;
    m.position.set(x * size, y + yy * size, z * size); m.scale.set(w * size,h * size,d * size);
    m.castShadow = true; parent.add(m); meshes.push(m); return m;
  };
  const head = part('human-face', flesh,0,0,0,1,1,1,humanHead);
  part('nose-bridge',flesh,0,.47,-.38,.12,.29,.17);
  part('nose-tip',flesh,0,.36,-.45,.17,.12,.17);
  part('upper-lip',lips,0,.23,-.333,.25,.035,.048);
  part('lower-lip',flesh,0,.20,-.33,.22,.044,.055);
  for (const side of [-1,1]) {
    part('ear',flesh,side*.44,.44,.015,.15,.25,.13);
    part('eye-socket',lips,side*.18,.54,-.335,.25,.125,.10);
    part('eye',white,side*.18,.55,-.38,.17,.060,.055);
    part('iris',iris,side*.18,.55,-.412,.055,.055,.018);
    part('eyebrow',hair,side*.18,.63,-.355,.24,.046,.074).rotation.z=side*.1;
    part('cheek',flesh,side*.24,.38,-.28,.21,.18,.12);
  }
  part('hair',hair,0,.83,.055,.84,.37,.78);
  return head;
}

export function disposeHumanResources(): void {
  for (const geo of [humanLimb,humanTorso,humanHead,detail]) geo.dispose();
  for (const mat of skinMaterials.values()) mat.dispose(); skinMaterials.clear();
}
