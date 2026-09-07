import type { QuestState, QuestStepState } from '../../../shared/types';
import { bus, GameEvents } from '../core/EventBus';
import { QUEST_CLEAR_OUTPOST, QUEST_TEMPLATES, QUEST_XP_STEP_REWARD } from '../../data/quests/quests';

/**
 * Linear step tracker. Systems post facts to it ("player entered camp",
 * "raider killed", "prototype collected") and it decides whether the current
 * step advances, then emits quest:updated for the HUD.
 */

export interface QuestWorldContext {
  playerPosition: { x: number; z: number };
}

export class QuestSystem {
  readonly quests: Record<string, QuestState> = {};
  private listenersBound = false;

  reset(): void {
    for (const key of Object.keys(this.quests)) delete this.quests[key];
    for (const template of QUEST_TEMPLATES) {
      this.quests[template.id] = {
        id: template.id,
        name: template.name,
        currentStep: 0,
        steps: template.steps.map((step) => ({ ...step, completed: false, progress: step.progress ?? 0 })),
        completed: false,
      };
    }
    this.emitUpdate();
  }

  load(quests: Record<string, QuestState>): void {
    for (const key of Object.keys(this.quests)) delete this.quests[key];
    const templates = QUEST_TEMPLATES.map((template) => template.id);
    for (const id of templates) {
      const saved = quests?.[id];
      const template = QUEST_TEMPLATES.find((entry) => entry.id === id);
      if (!template) continue;
      if (!saved) {
        this.quests[id] = {
          id,
          name: template.name,
          currentStep: 0,
          steps: template.steps.map((step) => ({ ...step, completed: false, progress: step.progress ?? 0 })),
          completed: false,
        };
        continue;
      }
      // Merge by step id so adding steps later does not corrupt old saves.
      const steps: QuestStepState[] = template.steps.map((step) => {
        const savedStep = saved.steps.find((entry) => entry.id === step.id);
        return {
          ...step,
          completed: savedStep?.completed ?? false,
          progress: savedStep?.progress ?? step.progress ?? 0,
        };
      });
      const firstIncomplete = steps.findIndex((step) => !step.completed);
      this.quests[id] = {
        id,
        name: template.name,
        currentStep: firstIncomplete === -1 ? steps.length : firstIncomplete,
        steps,
        completed: saved.completed ?? firstIncomplete === -1,
      };
    }
    this.emitUpdate();
  }

  get active(): QuestState | null {
    for (const id of Object.keys(this.quests)) {
      const quest = this.quests[id];
      if (quest && !quest.completed) return quest;
    }
    return null;
  }

  get currentStep(): QuestStepState | null {
    const quest = this.active;
    if (!quest) return null;
    return quest.steps[quest.currentStep] ?? null;
  }

  /** Text shown in the HUD tracker. */
  get objectiveText(): string {
    const quest = this.active;
    if (!quest) return 'Outpost cleared';
    const step = this.currentStep;
    if (!step) return quest.name;
    if (step.type === 'kill' && step.required) {
      return `${step.text} (${Math.min(step.progress ?? 0, step.required)}/${step.required})`;
    }
    return step.text;
  }

  get progressText(): string {
    const quest = this.active;
    if (!quest) return '';
    return `${Math.min(quest.currentStep + (quest.completed ? 0 : 1), quest.steps.length)} / ${quest.steps.length}`;
  }

  isStepComplete(stepId: string): boolean {
    const quest = this.quests[QUEST_CLEAR_OUTPOST];
    if (!quest) return false;
    return quest.steps.some((step) => step.id === stepId && step.completed);
  }

  /** Returns true when the given step id is the one currently being tracked. */
  isCurrentStep(stepId: string): boolean {
    const step = this.currentStep;
    return step?.id === stepId;
  }

  private emitUpdate(): void {
    bus.emit(GameEvents.QuestUpdated, {
      objective: this.objectiveText,
      progress: this.progressText,
      stepId: this.currentStep?.id ?? null,
      completed: !this.active,
    });
  }

  private advance(quest: QuestState): void {
    const step = quest.steps[quest.currentStep];
    if (!step) return;
    step.completed = true;
    quest.currentStep += 1;
    bus.emit(GameEvents.ObjectiveReached, { questId: quest.id, stepId: step.id, text: step.text });
    bus.emit(GameEvents.Autosave, { reason: 'quest' });
    if (quest.currentStep >= quest.steps.length) {
      quest.completed = true;
      bus.emit(GameEvents.QuestCompleted, { questId: quest.id, name: quest.name });
    }
    this.emitUpdate();
  }

  /** Attempts to complete the current step when it matches `type`/`target`. */
  private satisfy(matcher: (step: QuestStepState) => boolean, onPartial?: (step: QuestStepState) => void): boolean {
    const quest = this.active;
    if (!quest) return false;
    const step = quest.steps[quest.currentStep];
    if (!step || step.completed) return false;
    if (!matcher(step)) return false;
    if (step.type === 'kill' && step.required && (step.progress ?? 0) < step.required) {
      onPartial?.(step);
      this.emitUpdate();
      return false;
    }
    this.advance(quest);
    return true;
  }

  notifyZoneEntered(zoneId: string): void {
    this.satisfy((step) => step.type === 'goto' && step.target === zoneId);
  }

  notifyKill(definitionId: string, isBossMinion = false): void {
    const quest = this.active;
    if (!quest) return;
    const step = quest.steps[quest.currentStep];
    if (!step || step.type !== 'kill' || step.target !== definitionId) return;
    // Minions summoned by the boss still count toward the raider tally.
    step.progress = Math.min(step.required ?? 1, (step.progress ?? 0) + (isBossMinion ? 0 : 1));
    if ((step.progress ?? 0) >= (step.required ?? 1)) {
      this.advance(quest);
    } else {
      bus.emit(GameEvents.QuestUpdated, {
        objective: this.objectiveText,
        progress: this.progressText,
        stepId: step.id,
        completed: false,
      });
    }
  }

  notifyCollect(targetId: string): void {
    this.satisfy((step) => step.type === 'collect' && step.target === targetId);
  }

  /** Called every frame for proximity objectives. */
  update(context: QuestWorldContext): void {
    const step = this.currentStep;
    if (!step || step.type !== 'goto' || !step.target) return;
    const position = this.zonePosition(step.target);
    if (!position) return;
    const radius = step.radius ?? 25;
    const dx = context.playerPosition.x - position.x;
    const dz = context.playerPosition.z - position.z;
    if (dx * dx + dz * dz <= radius * radius) {
      this.notifyZoneEntered(step.target);
      bus.emit(GameEvents.Autosave, { reason: 'objective' });
    }
    void QUEST_XP_STEP_REWARD;
  }

  /** Anchor positions come from the world; injected to keep this data-driven. */
  private zoneAnchor: Record<string, { x: number; z: number }> = {};

  configureAnchors(anchors: Record<string, { x: number; z: number }>): void {
    this.zoneAnchor = anchors;
  }

  private zonePosition(zoneId: string): { x: number; z: number } | null {
    return this.zoneAnchor[zoneId] ?? null;
  }

  /** Objective marker for the compass, if any. */
  get markerPosition(): { x: number; z: number } | null {
    const step = this.currentStep;
    if (!step || step.type !== 'goto' || !step.target) return null;
    return this.zonePosition(step.target);
  }

  bind(): void {
    if (this.listenersBound) return;
    this.listenersBound = true;
  }
}
