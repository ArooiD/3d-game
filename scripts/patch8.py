"""Repairs the UI/App layer after the scaffold pass: missing helpers, null
narrowing in closures, and typed element accessors."""

# ------------------------------------------------------------------ GameApp
p = 'src/renderer/app/GameApp.ts'
s = open(p).read()

s = s.replace(
    "  private abilityQ: AbilityState = { id: 'frag_burst', remaining: 0, cooldown: 0, cooldownTotal: FRAG.cooldown };",
    "  private abilityQ: AbilityState = { id: 'frag_burst', remaining: 0, cooldown: 0, cooldownTotal: 16 };",
)

s = s.replace(
    """  private updateAbilities(dt: number): void {
    const cooldownMult = this.player.stats.cooldownMult;
    this.tickAbility(this.abilityF, dt, () => this.resetBuffs());
    this.tickAbility(this.abilityQ, dt);
    for (let i = this.buffTimers.length - 1; i >= 0; i--) {
      const timer = this.buffTimers[i];
      if (!timer) continue;
      if (timer <= 0) this.buffTimers.splice(i, 1);
    }
    void cooldownMult;
  }""",
    """  private updateAbilities(dt: number): void {
    this.tickAbility(this.abilityF, dt, () => this.resetBuffs());
    this.tickAbility(this.abilityQ, dt);
  }""",
)

if 'private buildLights' not in s:
    s = s.replace(
        "  private buildLights(): void {",
        "  private buildLights(): THREE.DirectionalLight {",
    )
if 'private buildLights(): THREE.DirectionalLight {' not in s:
    s = s.replace(
        "  private dispose(): void {",
        """  private buildLights(): THREE.DirectionalLight {
    this.scene.add(new THREE.HemisphereLight(0xffd9a0, 0x5d3a22, 0.95));
    const sun = new THREE.DirectionalLight(0xffe2b0, 1.15);
    sun.position.set(-90, 120, 60);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 20;
    sun.shadow.camera.far = 460;
    const span = 130;
    sun.shadow.camera.left = -span;
    sun.shadow.camera.right = span;
    sun.shadow.camera.top = span;
    sun.shadow.camera.bottom = -span;
    sun.shadow.bias = -0.0012;
    this.scene.add(sun);
    this.scene.fog = new THREE.Fog(0xc99a63, 95, 330);
    return sun;
  }

  private dispose(): void {""",
        1,
    )

open(p, 'w').write(s)

# ---------------------------------------------------------------------- Hud
p = 'src/renderer/ui/hud/Hud.ts'
s = open(p).read()
s = s.replace(
    """    if (!this.hitmarker) return;
    this.hitmarker.classList.add('on');
    this.hitmarker.classList.toggle('crit', critical);
    window.clearTimeout(this.hitTimeout);
    this.hitTimeout = window.setTimeout(() => {
      this.hitmarker.classList.remove('on', 'crit');
    }, 110);""",
    """    const marker = this.hitmarker;
    if (!marker) return;
    marker.classList.add('on');
    marker.classList.toggle('crit', critical);
    window.clearTimeout(this.hitTimeout);
    this.hitTimeout = window.setTimeout(() => {
      marker.classList.remove('on', 'crit');
    }, 110);""",
)
s = s.replace(
    """    if (!this.levelUpBanner) return;
    if (this.levelUpLevel)""",
    """    const banner = this.levelUpBanner;
    if (!banner) return;
    if (this.levelUpLevel)""",
)
s = s.replace(
    """    show(this.levelUpBanner, true);
    window.setTimeout(() => show(this.levelUpBanner, false), 3200);""",
    """    show(banner, true);
    window.setTimeout(() => show(banner, false), 3200);""",
)
s = s.replace(
    """    const node = make('div', `note ${options.tone ?? 'default'}`);""",
    """    const layer = this.notifications;
    if (!layer) return;
    const node = make('div', `note ${options.tone ?? 'default'}`);""",
)
s = s.replace(
    """    if (!this.notifications) return;
    const layer = this.notifications;
    if (!layer) return;""",
    """    const layer = this.notifications;
    if (!layer) return;""",
)
s = s.replace("    this.notifications.append(node);", "    layer.append(node);")
s = s.replace(
    """  private flashDamage(): void {
    if (!this.damageFlash) return;
    this.damageFlash.classList.add('on');
    window.clearTimeout(this.flashTimeout);
    this.flashTimeout = window.setTimeout(() => this.damageFlash?.classList.remove('on'), 130);
  }""",
    """  private flashDamage(): void {
    const flash = this.damageFlash;
    if (!flash) return;
    flash.classList.add('on');
    window.clearTimeout(this.flashTimeout);
    this.flashTimeout = window.setTimeout(() => flash.classList.remove('on'), 130);
  }""",
)
s = s.replace(
    """    if (!this.slotsRow) return;
    const slots = this.weapons.slots;""",
    """    const row = this.slotsRow;
    if (!row) return;
    const slots = this.weapons.slots;""",
)
s = s.replace(
    """    clear(this.slotsRow);
    this.slotCards = [];""",
    """    clear(row);
    this.slotCards = [];""",
)
s = s.replace("      this.slotsRow?.append(card);", "      row.append(card);")
open(p, 'w').write(s)

# ---------------------------------------------------------------- Inventory
p = 'src/renderer/ui/inventory/InventoryUI.ts'
s = open(p).read()
s = s.replace(
    "import type { LootSystem } from '../../game/loot/LootSystem';",
    "import { LootSystem } from '../../game/loot/LootSystem';",
)
open(p, 'w').write(s)

# ------------------------------------------------------------------ Screens
p = 'src/renderer/ui/menu/ScreensUI.ts'
s = open(p).read()
s = s.replace(
    "  private continueButton = byId('btn-continue');",
    "  private continueButton = byId<HTMLButtonElement>('btn-continue');",
)
s = s.replace(
    "  private selectConfirm = byId('btn-select-confirm');",
    "  private selectConfirm = byId<HTMLButtonElement>('btn-select-confirm');",
)
s = s.replace(
    """    if (this.select) show(this.select, true);
    this.chosen = null;
    if (this.selectConfirm) this.selectConfirm.disabled = true;
    for (const card of this.selectGrid?.querySelectorAll('.char-card') ?? []) {
      card.classList.remove('sel');
    }""",
    """    if (this.select) show(this.select, true);
    this.chosen = null;
    if (this.selectConfirm) this.selectConfirm.disabled = true;
    for (const card of Array.from(this.selectGrid?.querySelectorAll('.char-card') ?? [])) {
      card.classList.remove('sel');
    }""",
)
s = s.replace(
    """    if (this.settings) show(this.settings, true);
    this.settings.dataset.returnTo = returnTo;
    this.renderSettings();""",
    """    const panel = this.settings;
    if (panel) {
      show(panel, true);
      panel.dataset.returnTo = returnTo;
    }
    this.renderSettings();""",
)
s = s.replace(
    """        for (const other of this.selectGrid?.querySelectorAll('.char-card') ?? []) {
          other.classList.toggle('sel', other === card);
        }""",
    """        for (const other of Array.from(this.selectGrid?.querySelectorAll('.char-card') ?? [])) {
          other.classList.toggle('sel', other === card);
        }""",
)
open(p, 'w').write(s)

print('patch8 applied')
