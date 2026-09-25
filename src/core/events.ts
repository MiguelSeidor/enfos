/**
 * Typed event bus. The only sanctioned channel between simulation and
 * presentation: gameplay emits, VFX/UI/audio listen. Listeners must never mutate
 * simulation state.
 */

import type { DamageType, DefId, EntityId, Level, TeamId, Vec2 } from './contracts';

export interface GameEvents {
  'match:start': { seed: number; mode: string };
  'match:end': { winner: TeamId | null };
  'match:phase': { phase: string; previous: string };

  'wave:announce': { wave: number; modifiers: DefId[]; isBoss: boolean; sudden: boolean };
  'wave:start': { wave: number; enemyCount: number };
  /** One team emptied its side of this wave. The other may still be fighting. */
  'wave:clear': { wave: number; duration: number; team: TeamId };

  'unit:spawn': { id: EntityId; defId: DefId; pos: Vec2 };
  'unit:death': { id: EntityId; killerId: EntityId | null; pos: Vec2 };
  /**
   * A kill that paid out, with the corpse's position so the HUD can float the
   * reward over the body. Separate from `economy:gold`, which fires once per
   * hero when a creep dies unclaimed and carries no position.
   */
  'unit:bounty': { pos: Vec2; gold: number; xp: number; heroIds: EntityId[] };
  'unit:damage': {
    targetId: EntityId;
    sourceId: EntityId | null;
    amount: number;
    mitigated: number;
    type: DamageType;
    crit: boolean;
    pos: Vec2;
    /** The ability that dealt it, or null for an auto-attack. */
    abilityId: DefId | null;
  };
  'unit:heal': { targetId: EntityId; sourceId: EntityId | null; amount: number; pos: Vec2 };
  /** A physical attack was dodged. Carries no amount — nothing landed. */
  'unit:miss': { targetId: EntityId; sourceId: EntityId | null; pos: Vec2 };
  'unit:status': { targetId: EntityId; statusId: DefId; applied: boolean; stacks: number };
  'hero:levelUp': { id: EntityId; level: Level; milestone: boolean };
  'hero:xp': { id: EntityId; amount: number; total: number };
  'hero:abilityCast': { id: EntityId; abilityId: DefId; target: Vec2 | EntityId | null };
  'hero:abilityReady': { id: EntityId; abilityId: DefId };
  'hero:talentPicked': { id: EntityId; talentId: DefId; rank: number };
  'hero:itemBought': { id: EntityId; itemId: DefId; cost: number };
  /** A consumable was drunk from the inventory. */
  'hero:itemUsed': { id: EntityId; itemId: DefId };
  /** A fallen hero stood back up at the Core. */
  'hero:revive': { id: EntityId; pos: Vec2 };

  'economy:gold': { heroId: EntityId; delta: number; total: number; reason: string };
  'economy:influence': { heroId: EntityId; delta: number; total: number; reason: string };

  'sabotage:launched': { sabotageId: DefId; fromTeam: TeamId; toTeam: TeamId };
  'sabotage:resolved': { sabotageId: DefId; toTeam: TeamId };

  'core:leak': { team: TeamId; livesLeft: number; enemyDefId: DefId };
  'core:destroyed': { team: TeamId };

  /** A boss crossed a health threshold and entered a new stage. `phase` is 1-based. */
  'boss:phase': { id: EntityId; phase: number; healthFraction: number; announce: string };
  'boss:telegraph': { id: EntityId; abilityId: DefId; pos: Vec2; leadTime: number };

  'vfx:request': { vfxId: DefId; pos: Vec2; scale?: number; rotation?: number };
  'sfx:request': { sfxId: DefId; pos?: Vec2; volume?: number };
  /** `team`, when set, limits the shake to that team's players. */
  'camera:shake': { intensity: number; duration: number; team?: TeamId };

  /**
   * A message for the player. With several players in one simulation most
   * messages concern one of them: `heroId` addresses a hero's owner, `team` a
   * whole team. Neither set means everyone.
   */
  'ui:notify': {
    text: string;
    severity: 'info' | 'warn' | 'danger' | 'reward';
    heroId?: EntityId;
    team?: TeamId;
  };
  'debug:log': { channel: string; message: string; data?: unknown };
}

export type Listener<T> = (payload: T) => void;

export class EventBus<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();
  /** Events emitted during the current step, drained by presentation modules. */
  private readonly frameLog: { key: keyof Events; payload: unknown }[] = [];
  private recording = false;

  on<K extends keyof Events>(key: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener as Listener<never>);
    return () => {
      set!.delete(listener as Listener<never>);
    };
  }

  once<K extends keyof Events>(key: K, listener: Listener<Events[K]>): () => void {
    const off = this.on(key, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  emit<K extends keyof Events>(key: K, payload: Events[K]): void {
    if (this.recording) this.frameLog.push({ key, payload });
    const set = this.listeners.get(key);
    if (!set) return;
    for (const listener of set) {
      (listener as Listener<Events[K]>)(payload);
    }
  }

  /** Enable capture for replay/telemetry tooling. */
  setRecording(on: boolean): void {
    this.recording = on;
    if (!on) this.frameLog.length = 0;
  }

  drainLog(): { key: keyof Events; payload: unknown }[] {
    const out = this.frameLog.slice();
    this.frameLog.length = 0;
    return out;
  }

  clear(): void {
    this.listeners.clear();
    this.frameLog.length = 0;
  }
}
