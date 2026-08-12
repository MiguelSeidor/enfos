/**
 * World layer entry point. Owner: TERRAIN agent.
 * Add new world modules to the returned array; `src/main.ts` consumes it.
 */

import type { GameModule } from '@/core/contracts';
import { TerrainModule } from './terrain';
import { PropsModule } from './props';

export function createWorldModules(): GameModule[] {
  return [new TerrainModule(), new PropsModule()];
}

export { TerrainModule, PropsModule };
