import type { SkillBranch } from '../../../shared/types';
import { BRANCH_LABELS, BRANCH_ORDER, skillsFor } from '../../data/skills/skills';
import { bus, GameEvents } from '../../game/core/EventBus';
import type { PlayerState } from '../../game/player/PlayerState';
import { byId, clear, make } from '../dom';

/**
 * Skill tree panel. Three branches of four nodes, ranks and prerequisites
 * rendered from data; clicking a node spends a point through the host.
 */

export interface SkillsHost {
  spendSkillPoint(skillId: string): boolean;
}

export class SkillsUI {
  private root = byId('ui-skills');
  private body = byId('skills-body');
  private pointsLabel = byId('skills-points');

  constructor(
    private player: PlayerState,
    private host: SkillsHost,
  ) {}

  get isOpen(): boolean {
    return this.root !== null && !this.root.classList.contains('hidden');
  }

  setVisible(isVisible: boolean): void {
    if (!this.root) return;
    this.root.classList.toggle('hidden', !isVisible);
    if (isVisible) this.render();
  }

  render(): void {
    if (!this.body) return;
    clear(this.body);
    if (this.pointsLabel) this.pointsLabel.textContent = String(this.player.skillPoints);

    const skills = skillsFor(this.player.characterId);
    for (const branch of BRANCH_ORDER) {
      this.body.append(this.renderBranch(branch, skills.filter((skill) => skill.branch === branch)));
    }
  }

  private renderBranch(branch: SkillBranch, skills: ReturnType<typeof skillsFor>): HTMLElement {
    const panel = make('div', 'branch');
    panel.append(make('h3', undefined, branch.toUpperCase()));
    panel.append(make('div', 'b-sub', BRANCH_LABELS[branch] ?? ''));

    const ordered = [...skills].sort((a, b) => a.tier - b.tier);
    for (const skill of ordered) {
      const ranks = this.player.skillRanks[skill.id] ?? 0;
      const requiresId = skill.requires;
      const requiresRank = requiresId ? (this.player.skillRanks[requiresId] ?? 0) : 1;
      const locked = requiresRank <= 0;
      const maxed = ranks >= skill.maxRanks;
      const usable = !locked && !maxed && this.player.skillPoints > 0;

      const node = make('div', `skill${maxed ? ' maxed' : ''}${locked ? ' locked' : ''}${usable ? ' usable' : ''}`);
      const bubble = make('div', 'skill-node', String(skill.tier + 1));
      const info = make('div', 'skill-info');
      info.append(make('div', 'n', skill.name));
      info.append(make('div', 'd', skill.description));

      const rankRow = make('div', 'ranks');
      for (let i = 0; i < skill.maxRanks; i++) {
        rankRow.append(make('i', i < ranks ? 'on' : undefined));
      }
      info.append(rankRow);

      node.append(bubble, info);
      node.addEventListener('click', () => {
        if (locked || maxed) return;
        if (this.host.spendSkillPoint(skill.id)) {
          this.render();
          bus.emit(GameEvents.Autosave, { reason: 'skill' });
        }
      });
      panel.append(node);
    }
    return panel;
  }

  dispose(): void {
    if (this.body) clear(this.body);
  }
}
