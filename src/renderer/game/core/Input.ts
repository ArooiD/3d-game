import { bus } from './EventBus';

/**
 * Keyboard + mouse input with pointer lock.
 *
 * Movement keys are sampled continuously (held state); action keys are exposed
 * as one-frame "pressed" edges so gameplay code never double-fires.
 */

export const ActionKey = {
  Reload: 'KeyR',
  Interact: 'KeyE',
  SkillF: 'KeyF',
  SkillQ: 'KeyQ',
  Inventory: 'Tab',
  Skills: 'KeyK',
  Pause: 'Escape',
  Debug: 'F3',
  Slot1: 'Digit1',
  Slot2: 'Digit2',
  Slot3: 'Digit3',
  Cheats: 'F5',
} as const;

const MOVEMENT_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'Space',
  'ShiftLeft',
  'ShiftRight',
  'KeyC',
]);

/** Keys the browser should not act on while playing. */
const SWALLOWED = new Set([
  'Tab',
  'Space',
  'F3',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F12',
  'Slash',
  'Quote',
  ...MOVEMENT_KEYS,
]);

class InputManager {
  private held = new Set<string>();
  private pressedThisFrame = new Set<string>();
  private releasedThisFrame = new Set<string>();
  private mouseButtons = new Set<number>();
  private mousePressed = new Set<number>();
  private mouseReleased = new Set<number>();

  /** Accumulated mouse delta in radians, consumed once per frame. */
  lookDeltaX = 0;
  lookDeltaY = 0;

  wheelDelta = 0;
  pointerLocked = false;
  enabled = true;
  private attached = false;
  private canvas: HTMLElement | null = null;

  /** Callbacks the app layer registers for global hotkeys. */
  private hotkeys = new Map<string, () => void>();

  attach(canvas: HTMLElement): void {
    this.canvas = canvas;
    if (this.attached) return;
    this.attached = true;

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('wheel', this.onWheel, { passive: true });
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('contextmenu', this.onContextMenu);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('contextmenu', this.onContextMenu);
    this.clearAll();
  }

  private clearAll(): void {
    this.held.clear();
    this.mouseButtons.clear();
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
    this.mousePressed.clear();
    this.mouseReleased.clear();
    this.lookDeltaX = 0;
    this.lookDeltaY = 0;
  }

  private onContextMenu = (event: Event): void => {
    // Right button is aim-down-sights, never the browser menu.
    event.preventDefault();
  };

  private onBlur = (): void => {
    this.clearAll();
  };

  private onPointerLockChange = (): void => {
    const locked = document.pointerLockElement === this.canvas;
    if (locked === this.pointerLocked) return;
    this.pointerLocked = locked;
    bus.emit('input:pointerlock', locked);
    if (!locked) this.clearAll();
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) {
      if (SWALLOWED.has(event.code)) event.preventDefault();
      return;
    }
    if (SWALLOWED.has(event.code)) event.preventDefault();

    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable)) {
      return;
    }

    this.held.add(event.code);
    this.pressedThisFrame.add(event.code);

    const hotkey = this.hotkeys.get(event.code);
    if (hotkey) hotkey();
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.held.delete(event.code);
    this.releasedThisFrame.add(event.code);
  };

  private onMouseMove = (event: MouseEvent): void => {
    if (!this.pointerLocked) return;
    this.lookDeltaX += event.movementX;
    this.lookDeltaY += event.movementY;
  };

  private onMouseDown = (event: MouseEvent): void => {
    if (!this.pointerLocked) return;
    if (!this.mouseButtons.has(event.button)) {
      this.mouseButtons.add(event.button);
      this.mousePressed.add(event.button);
    }
  };

  private onMouseUp = (event: MouseEvent): void => {
    if (this.mouseButtons.delete(event.button)) {
      this.mouseReleased.add(event.button);
    }
  };

  private onWheel = (event: WheelEvent): void => {
    if (!this.pointerLocked) return;
    this.wheelDelta += Math.sign(event.deltaY);
  };

  requestPointerLock(): void {
    if (!this.canvas || this.pointerLocked) return;
    void this.canvas.requestPointerLock();
  }

  exitPointerLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  registerHotkey(code: string, handler: () => void): void {
    this.hotkeys.set(code, handler);
  }

  clearHotkeys(): void {
    this.hotkeys.clear();
  }

  isDown(code: string): boolean {
    return this.enabled && this.held.has(code);
  }

  /** True only on the frame the key went down. */
  wasPressed(code: string): boolean {
    return this.enabled && this.pressedThisFrame.has(code);
  }

  wasReleased(code: string): boolean {
    return this.releasedThisFrame.has(code);
  }

  get forward(): number {
    return (this.isDown('KeyW') ? 1 : 0) - (this.isDown('KeyS') ? 1 : 0);
  }

  get strafe(): number {
    return (this.isDown('KeyD') ? 1 : 0) - (this.isDown('KeyA') ? 1 : 0);
  }

  get jumping(): boolean {
    return this.isDown('Space');
  }

  get sprinting(): boolean {
    return this.isDown('ShiftLeft') || this.isDown('ShiftRight');
  }

  get crouching(): boolean {
    return this.isDown('KeyC');
  }

  get firing(): boolean {
    return this.enabled && this.mouseButtons.has(0);
  }

  get aiming(): boolean {
    return this.enabled && this.mouseButtons.has(2);
  }

  get firePressed(): boolean {
    return this.enabled && this.mousePressed.has(0);
  }

  /** Call once per frame after reading input. */
  endFrame(): void {
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
    this.mousePressed.clear();
    this.mouseReleased.clear();
    this.lookDeltaX = 0;
    this.lookDeltaY = 0;
    this.wheelDelta = 0;
  }
}

export const input = new InputManager();
