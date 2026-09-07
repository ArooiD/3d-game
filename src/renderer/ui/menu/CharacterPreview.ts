import * as THREE from 'three';
import type { CharacterId } from '../../../shared/types';
import { buildCharacterModel, type BuiltCharacter } from '../../game/player/CharacterModels';

/**
 * Turntable previews for the character-select cards.
 *
 * Deliberately separate from the game renderer: its own scene, camera and
 * lights, nothing allocated until the select screen opens, everything released
 * when it closes. One WebGL context serves every card by swapping which one is
 * drawn, so opening the screen never stacks a context next to the main one. The
 * frame is blitted into each card's 2D canvas, which leaves layout to the DOM.
 */

export const PREVIEW_SIZE = 240;

interface Slot {
  context: CanvasRenderingContext2D | null;
  character: BuiltCharacter;
}

const BACKDROP_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const BACKDROP_FRAGMENT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vec3 color = mix(vec3(0.03, 0.04, 0.06), vec3(0.11, 0.13, 0.18), smoothstep(0.0, 1.0, vUv.y));
    // Soft pool of light where the operator stands.
    vec2 p = (vUv - vec2(0.5, 0.17)) * vec2(1.0, 2.1);
    color += vec3(0.18, 0.15, 0.10) * (1.0 - smoothstep(0.08, 0.3, length(p))) * 0.6;
    gl_FragColor = vec4(color, 1.0);
  }
`;

export class CharacterPreview {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(24, 1, 0.1, 30);
  private renderer: THREE.WebGLRenderer | null = null;
  private backdrop: THREE.Mesh | null = null;
  private unavailable = false;
  private slots = new Map<HTMLCanvasElement, Slot>();
  private active: Slot | null = null;
  private spin = 0;
  private clock = new THREE.Clock(false);

  constructor() {
    this.camera.position.set(0, 1.4, 4.4);
    this.camera.lookAt(0, 0.95, 0);

    const key = new THREE.DirectionalLight(0xfff0d8, 2.2);
    key.position.set(2.4, 4.2, 3.1);
    const rim = new THREE.DirectionalLight(0x6fa8ff, 1.2);
    rim.position.set(-3.2, 2.0, -2.6);
    this.scene.add(key, rim, new THREE.HemisphereLight(0xbfd4ff, 0x30281e, 0.9));
  }

  /** Builds one card's body. Geometry only, so this stays cheap. */
  addSlot(canvas: HTMLCanvasElement, characterId: CharacterId): void {
    if (this.slots.has(canvas)) return;
    const character = buildCharacterModel(characterId, { holdWeapon: true, name: `preview-${characterId}` });
    this.slots.set(canvas, { context: canvas.getContext('2d'), character });
  }

  /** Only the visible card is drawn; null pauses rendering entirely. */
  setActive(canvas: HTMLCanvasElement | null): void {
    const next = canvas ? this.slots.get(canvas) ?? null : null;
    if (next === this.active) return;
    if (this.active) this.scene.remove(this.active.character.root);
    this.active = next;
    if (next) {
      this.scene.add(next.character.root);
      this.clock.getDelta();
    }
  }

  /** Draws the active card into its 2D canvas. No-op without WebGL. */
  render(): void {
    const slot = this.active;
    if (!slot?.context || this.unavailable) return;
    if (!this.renderer) {
      try {
        this.renderer = this.createRenderer();
      } catch {
        // Headless or context-limited: the card keeps its CSS backdrop.
        this.unavailable = true;
        return;
      }
    }

    this.spin += this.clock.getDelta() * 0.55;
    slot.character.root.rotation.y = Math.sin(this.spin) * 0.6;

    this.renderer.render(this.scene, this.camera);
    slot.context.clearRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
    slot.context.drawImage(this.renderer.domElement, 0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
  }

  private createRenderer(): THREE.WebGLRenderer {
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(1);
    renderer.setSize(PREVIEW_SIZE, PREVIEW_SIZE, false);
    // Big enough to cover the frame wherever the camera points: unlit, unculled
    // and drawn first, so it acts as a clear pass with a gradient.
    const backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(14, 14),
      new THREE.ShaderMaterial({ vertexShader: BACKDROP_VERTEX, fragmentShader: BACKDROP_FRAGMENT, depthWrite: false }),
    );
    backdrop.position.set(0, 1.2, -3);
    backdrop.frustumCulled = false;
    backdrop.renderOrder = -1;
    this.scene.add(backdrop);
    this.backdrop = backdrop;
    return renderer;
  }

  dispose(): void {
    this.setActive(null);
    for (const slot of this.slots.values()) {
      slot.character.dispose();
      slot.context?.clearRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
    }
    this.slots.clear();
    if (this.backdrop) {
      this.scene.remove(this.backdrop);
      this.backdrop.geometry.dispose();
      (this.backdrop.material as THREE.Material).dispose();
      this.backdrop = null;
    }
    this.renderer?.dispose();
    this.renderer = null;
    this.unavailable = false;
  }
}
