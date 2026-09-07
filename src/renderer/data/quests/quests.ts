import type { QuestState } from '../../../shared/types';

/**
 * The single MVP quest. Steps are declarative so the quest system, HUD tracker
 * and GameDirector all read the same definition.
 */

export const QUEST_CLEAR_OUTPOST = 'clear_outpost';

export interface QuestTemplate {
  id: string;
  name: string;
  description: string;
  steps: QuestState['steps'];
}

export const QUEST_TEMPLATES: QuestTemplate[] = [
  {
    id: QUEST_CLEAR_OUTPOST,
    name: 'Clear the Outpost',
    description: 'Work the wreck trail east to the Titan arena and take the prototype.',
    steps: [
      {
        id: 'reach_outpost',
        text: 'Reach the outpost',
        type: 'goto',
        target: 'camp',
        radius: 34,
        completed: false,
      },
      {
        id: 'kill_raiders',
        text: 'Defeat Raiders',
        type: 'kill',
        target: 'raider',
        required: 8,
        progress: 0,
        completed: false,
      },
      {
        id: 'enter_refinery',
        text: 'Enter the refinery',
        type: 'goto',
        target: 'refinery',
        radius: 30,
        completed: false,
      },
      {
        id: 'kill_boss',
        text: 'Defeat the Scrap Titan',
        type: 'kill',
        target: 'scrap_titan',
        required: 1,
        progress: 0,
        completed: false,
      },
      {
        id: 'collect_prototype',
        text: 'Collect the prototype weapon',
        type: 'collect',
        target: 'prototype',
        completed: false,
      },
    ],
  },
];

export const QUEST_XP_REWARD = 120;
export const QUEST_XP_STEP_REWARD = 45;

/** XP-eligible kill targets, used to avoid counting boss minions twice. */
export const PROTOTYPE_WEAPON_NAME = 'Prototype Hand-Cannon';
