/**
 * World layer entry point. Owner: TERRAIN agent.
 * Add new world modules to the returned array; `src/main.ts` consumes it.
 */

import type { GameModule } from '@/core/contracts';
import { TerrainModule } from './terrain';
import { PropsModule } from './props';
import { StructuresModule } from './structures';
import { EditorModule } from './editor';

export function createWorldModules(): GameModule[] {
  const terrain = new TerrainModule();
  const props = new PropsModule();
  const modules: GameModule[] = [terrain, new StructuresModule(), props];

  // Authoring tool, opt-in with `?edit=1`. Absent from a normal session, so it
  // costs nothing and cannot alter a played match.
  if (new URLSearchParams(location.search).has('edit')) {
    modules.push(new EditorModule(terrain, props));
  }
  return modules;
}

export { TerrainModule, PropsModule, StructuresModule, EditorModule };
export { LABELLED_LANDMARKS, pickStructure, type StructureHit } from './structures';
