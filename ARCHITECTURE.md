# Architecture — Hero Survival (ENFOS-inspired, original IP)

Read this before touching code. It defines who owns what, the contracts between
subsystems, and the rules that keep eleven parallel workstreams from colliding.

Source of truth for design: `GDD_Hero_Survival_ENFOS_Inspired_v1.0.md`.

## Stack and why

| Choice | Reason |
| --- | --- |
| **Three.js r180 + TypeScript + Vite** | Requested target. WebGL2 gives PBR, MRT, instancing and float render targets — everything the visual bar needs. Vite gives sub-second HMR, which matters when the review loop iterates dozens of times. |
| **`postprocessing` (pmndrs) + `n8ao`** | Higher quality than three's built-in composer: proper HDR chain, AgX/ACES tone mapping, SMAA, and a GTAO implementation that holds up at 1080p on the target GPU. |
| **No third-party art assets** | GDD legal note. Every texture, mesh and sound is generated procedurally at load time. This is a hard constraint, not a preference. |
| **Fixed-timestep simulation at 30 Hz, render uncapped** | Determinism for seeded QA (GDD §7) and cheap CPU with 1000+ units (§18), while the camera and VFX still run at display rate. |

**Performance target:** 60 fps at 1920×1080 with 300 active units on a GTX 970
(4 GB, Maxwell) — the machine this project is being reviewed on. Budget:
≤ 12 ms CPU, ≤ 14 ms GPU, ≤ 700 draw calls, ≤ 2.4 GB VRAM.

## Layering

```
core/      engine loop, contracts, RNG, events, pooling, spatial hash, registry
  ↑ imported by everything, imports nothing from the layers below
art/       procedural textures + material library
render/    pipeline, lighting, post-processing, camera
world/     terrain, cliffs, water, props, vegetation, map layout
units/     mesh construction, rigs, animation, unit views
vfx/       particles, spell effects, decals, damage feedback
gameplay/  combat, spawning, AI, pathing, waves, match flow
heroes/    hero definitions, abilities, infinite progression, talents
enemies/   bestiary, behaviours, bosses
economy/   gold/influence, shops, items, sabotage
ui/        HUD, shops, tooltips, health bars
audio/     synthesis, music, SFX
```

**Import rule:** a layer may import from `core`, `art`, and its own folder.
Cross-subsystem access goes through the **service locator**, never a direct
import. This is what lets subsystems be built and reviewed independently.

## The two contracts

### 1. `src/core/contracts.ts` — data shapes

Every `*Definition` type lives here. Content is data; code reads data. Nothing in
this file declares a level cap, and nothing may add one (GDD §9).

### 2. `src/core/services.ts` — runtime surfaces

Each subsystem publishes an interface and a `ServiceKey`. To use another
subsystem: `ctx.services.get(CombatKey)`. To be used: register in `init()`.

Both files are owned by the architecture lead. **Subsystem agents may append a
new key + interface, but must not change an existing signature.** If you need a
signature changed, say so in your report instead of changing it.

## Module lifecycle

```ts
export class MySubsystem implements GameModule {
  readonly id = 'mySubsystem';
  readonly order = 300;              // < 800 simulation, 800+ presentation
  init(ctx: GameContext) { /* register services, build scene content */ }
  fixedUpdate(step: number, ctx: GameContext) { /* deterministic, 30 Hz */ }
  update(dt: number, ctx: GameContext) { /* presentation, per frame */ }
  dispose() { /* release GPU resources */ }
}
```

**Order values:**

| Range | Purpose |
| --- | --- |
| 100–199 | World / terrain |
| 200–299 | Spawning, unit lifecycle |
| 300–399 | AI, movement, pathing |
| 400–499 | Combat, abilities, statuses |
| 500–599 | Waves, match flow, economy |
| 600–699 | Progression, sabotage |
| 800–849 | Unit views, VFX |
| 850–899 | Camera |
| 900+ | Render pipeline |

## Determinism rules

- **Never** call `Math.random()` inside `fixedUpdate`. Use `ctx.rng`, or a forked
  stream via `ctx.rng.fork('mySubsystem')`.
- Presentation-only randomness uses `visualRng` from `core/rng.ts`. It cannot
  desync the simulation because nothing in `fixedUpdate` reads it.
- Iteration order over `Map`s is insertion order in JS — that is stable, but do
  not rely on object key order anywhere.

## Performance rules (GDD §18)

- Pool everything that spawns more than once per second: projectiles, particles,
  damage numbers, corpses. Use `core/pool.ts`.
- Enemies render through `InstancedMesh` batched by definition id. A per-unit
  `THREE.Mesh` is only acceptable for heroes and bosses.
- Broad-phase queries go through `CombatService.spatial` (a shared
  `SpatialHash`). Never write an O(n²) loop over units.
- AI runs on a budget: split units into N buckets and update one bucket per tick.
- Every `update()` must be allocation-free in steady state. Reuse vectors.

## File ownership

One agent per folder. Do not edit another agent's folder; if you need something
from it, request it through a service.

| Folder | Owner |
| --- | --- |
| `src/core/**`, `src/main.ts`, `src/modules.ts` | Architecture lead |
| `src/art/**` | MATERIALS |
| `src/render/**` | RENDER |
| `src/world/**` | TERRAIN |
| `src/units/**` | CHARACTERS |
| `src/vfx/**` | VFX |
| `src/gameplay/**` | GAMEPLAY |
| `src/heroes/**` | HEROES |
| `src/enemies/**` | ENEMIES |
| `src/economy/**` | ECONOMY |
| `src/ui/**` | UI |
| `src/audio/**` | AUDIO |
| `tools/**`, `qa/**` | QA |

## Registering your module

Export a factory from your folder's entry file:

```ts
// src/world/index.ts
export const createTerrainModule = () => new TerrainModule();
```

Then tell the architecture lead. **Do not edit `src/main.ts` yourself** — that
file is the single point where parallel work would conflict.

## Definition of Done (GDD §21)

A subsystem is done when: it typechecks (`npm run typecheck`), it renders without
console errors under `node tools/capture.mjs`, it holds the frame budget under
`--stress 300`, its content passes `ContentService.validate()`, and a reviewer
agent has signed off against `qa/REVIEW_RUBRIC.md`.

Compiling is not finishing.
