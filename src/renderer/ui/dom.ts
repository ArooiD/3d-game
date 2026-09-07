/** Tiny DOM helpers — no framework, no dependencies. */

export function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export function must<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

export function show(node: HTMLElement, isVisible = true): void {
  node.classList.toggle('hidden', !isVisible);
}

export function isVisible(node: HTMLElement): boolean {
  return !node.classList.contains('hidden');
}

export function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function clear(node: HTMLElement): void {
  node.textContent = '';
}

export function on<K extends keyof HTMLElementEventMap>(
  node: EventTarget,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
): void {
  node.addEventListener(type, handler as EventListener);
}

export function signed(value: number, digits = 0): string {
  const fixed = digits === 0 ? Math.round(value).toString() : value.toFixed(digits);
  return value > 0 ? `+${fixed}` : fixed;
}

export function percent(value: number, digits = 0): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${rest.toString().padStart(2, '0')}`;
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Sets a bar fill width and optional label in one call. */
export function setBar(bar: HTMLElement | null, label: HTMLElement | null, ratio: number, text?: string): void {
  if (bar) bar.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  if (label && text !== undefined) label.textContent = text;
}
