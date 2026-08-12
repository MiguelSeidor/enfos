/**
 * Units layer entry point. Owner: CHARACTERS agent.
 * Add new presentation modules to the returned array; `src/main.ts` consumes it.
 */

import type { GameModule } from '@/core/contracts';
import { UnitViewModule } from './unitView';
import { ShowcaseModule } from './showcase';

export function createUnitModules(showcase: boolean): GameModule[] {
  const modules: GameModule[] = [new UnitViewModule()];
  if (showcase) modules.push(new ShowcaseModule());
  return modules;
}

export { UnitViewModule, ShowcaseModule };
export { SHOWCASE_ORIGIN, SHOWCASE_SPACING } from './showcase';
