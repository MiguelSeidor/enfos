/**
 * Bootstrap. Owner: architecture lead.
 *
 * Flow: boot → engine starts with the world already rendering → title screen
 * over the live scene on a slow camera orbit → player enters → HUD.
 *
 * Module registration order is authoritative: simulation modules (order < 800)
 * run before presentation modules. Subsystem agents register their module here
 * and nowhere else.
 */

import * as THREE from 'three';
import { Engine, createMatchState } from '@/core/engine';
import { RenderModule } from '@/render/renderer';
import { RtsCamera } from '@/render/camera';
import {
  createWorldModules,
  pickStructure,
  StructuresModule,
  type StructureHit,
} from '@/world';
import { createUnitModules } from '@/units';
import { SHOWCASE_ORIGIN } from '@/units/showcase';
import {
  createGameplay,
  issueOrder,
  soloSetup,
  teamSign,
  xpToNext,
  WAVES_TOTAL,
  HEROES,
  ABILITIES,
  type AbilityDef,
  type AbilityTarget,
  type Command,
  type GameplayBundle,
  type MatchSetup,
} from '@/gameplay';
import type { NetSession } from '@/net/session';
import { TargetingOverlay } from '@/ui/targeting';
import { installWorldGestures, prefersReducedMotion } from '@/ui/touch';
import { Lobby } from '@/ui/lobby';
import { HERO_KEYS, type WaitingPlayer } from '@/net/protocol';
import { loadResume, clearResume, markResync } from '@/net/resume';
import { NetOverlay } from '@/ui/netOverlay';
import { playback } from '@/core/playback';
import { createVfxModules } from '@/vfx';
import { AudioModule } from '@/audio/audio';
import { prepareImportedCharacters } from '@/units/build/importedCharacter';
import { preloadParts } from '@/units/build/parts';
import { HeroSelect, type HeroCard, type CommandSlot } from '@/ui';
import { LevelPanel } from '@/ui/levelPanel';
import { T1_STOCK, SABOTAGE_ITEMS } from '@/economy/items';
import { landmark, type LandmarkKind } from '@/world/layout';
import { TerrainKey, RenderKey, UiKey, CombatKey } from '@/core/services';
import { UnitKind } from '@/core/contracts';
import {
  createUiRoot,
  createHudModel,
  installUiScaling,
  HudModule,
  TitleScreen,
  OptionsPanel,
} from '@/ui';

const TITLE = 'NÚCLEO ETERNO';
const SUBTITLE = 'Supervivencia de héroes · 60 oleadas';
const VERSION = 'Vertical slice · build de desarrollo';

const boot = document.getElementById('boot')!;
const bootBar = boot.querySelector('#boot-bar > i') as HTMLElement;
const bootLabel = document.getElementById('boot-label')!;

function setBootProgress(done: number, total: number, label: string): void {
  bootBar.style.width = `${Math.round((done / total) * 100)}%`;
  bootLabel.textContent = label;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // SMAA runs in the composer
    powerPreference: 'high-performance',
    stencil: false,
    depth: true,
    alpha: false,
  });
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  const scene = new THREE.Scene();
  const rtsCamera = new RtsCamera(window.innerWidth / window.innerHeight);

  const params = new URLSearchParams(location.search);
  const seed = Number(params.get('seed') ?? 20260812);
  const isQa = params.get('qa') === '1';
  /** Authoring mode: the map is loaded but no match is started. */
  const isEdit = params.has('edit');
  const showStats = params.get('stats') === '1';
  // The showcase is the character line-up used for art review. It is off by
  // default now that real waves populate the map; `?showcase=1` brings it back.
  const showcase = params.get('showcase') === '1';
  const heroKey = params.get('hero') ?? 'bulwark';
  const match = createMatchState(seed, '1v1');

  const renderModule = new RenderModule(renderer, scene, rtsCamera.camera);
  const uiRoot = createUiRoot();

  /**
   * Pause plate and its button.
   *
   * Built here rather than in the HUD module because pause is a *session*
   * concern, not a match one: it has to exist before a match starts and survive
   * a HUD rebuild. The engine already supported pausing (`setPaused` zeroes the
   * frame delta while still drawing), so this is only the surface for it.
   */
  const pauseOverlay = document.createElement('div');
  pauseOverlay.className = 'pause-overlay is-hidden';
  pauseOverlay.innerHTML =
    '<div class="pause-plate"><b>PAUSA</b><i>Espacio para continuar</i></div>';
  uiRoot.appendChild(pauseOverlay);

  const pauseButton = document.createElement('button');
  // Hidden until a match exists: on the title screen there is nothing to pause.
  pauseButton.className = 'pause-button is-hidden';
  pauseButton.title = 'Pausar (Espacio)';
  pauseButton.textContent = '❚❚';
  uiRoot.appendChild(pauseButton);

  /**
   * Surrender, and the plate that asks whether the player means it.
   *
   * Conceding is a `forfeit` command like any other, so online it reaches every
   * machine on the same tick and the match ends the same way everywhere. The
   * confirmation is not ceremony: the button sits next to pause, and a match
   * thrown away by a misclick cannot be taken back.
   */
  const surrenderButton = document.createElement('button');
  surrenderButton.className = 'pause-button surrender-button is-hidden';
  surrenderButton.title = 'Rendirse';
  surrenderButton.textContent = '⚑';
  uiRoot.appendChild(surrenderButton);

  const surrenderOverlay = document.createElement('div');
  surrenderOverlay.className = 'pause-overlay is-hidden';
  surrenderOverlay.innerHTML =
    '<div class="pause-plate"><b>¿RENDIRSE?</b>' +
    '<i>Tu Núcleo caerá y perderás la partida</i>' +
    '<div class="pause-actions">' +
    '<button class="menu-btn is-compact is-danger" data-act="yes">Rendirse</button>' +
    '<button class="menu-btn is-compact" data-act="no">Seguir jugando</button>' +
    '</div></div>';
  uiRoot.appendChild(surrenderOverlay);

  const closeSurrender = (): void => surrenderOverlay.classList.add('is-hidden');
  surrenderButton.addEventListener('click', () => surrenderOverlay.classList.remove('is-hidden'));
  surrenderOverlay.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).dataset.act;
    // A click on the scrim itself backs out, like every other plate here.
    if (act === 'no' || e.target === surrenderOverlay) return closeSurrender();
    if (act !== 'yes') return;
    closeSurrender();
    sendCommand({ kind: 'forfeit' });
  });
  const netOverlay = new NetOverlay();
  uiRoot.appendChild(netOverlay.root);
  installUiScaling();

  const hudModel = createHudModel();
  seedDemoHud(hudModel);

  const engine = new Engine({
    scene,
    camera: rtsCamera.camera,
    renderer,
    match,
    seed,
    present: (alpha, dt) => renderModule.render(alpha, dt),
  });

  const hudModule = new HudModule({
    mount: uiRoot,
    model: hudModel,
    showStats,
    statsSource: () => ({
      fps: engine.stats.fps,
      drawCalls: engine.stats.drawCalls,
      triangles: engine.stats.triangles,
    }),
    playerHeroId: () => gameplay?.match.playerHero?.id ?? null,
    localTeam: () => gameplay?.match.localTeam ?? 0,
    selectedUnitId: () => selectedUnit,
    hoveredUnitId: () => hoveredUnit,
    minimap: {
      onSeek: (pos) => {
        rtsCamera.follow(null);
        rtsCamera.setFocus(pos, false);
      },
      getView: () => ({
        focus: { x: rtsCamera.focus.x, z: rtsCamera.focus.z },
        // Half-height of the view where it meets the ground plane. Close enough
        // for a viewport box, and it costs nothing to compute.
        extent:
          rtsCamera.camera.position.distanceTo(rtsCamera.focus) *
          Math.tan((rtsCamera.camera.fov * Math.PI) / 360),
        yaw: rtsCamera.yawAngle,
      }),
    },
    useItem: (itemId) => sendCommand({ kind: 'use', itemId }),
    command: (id) => {
      if (id === 'match.leave') {
        // A clean slate: every module, the server connection and the room go
        // with the page, so nothing from this match can leak into the next.
        net?.leave();
        location.reload();
        return;
      }
      const h = gameplay?.match.playerHero;
      if (!h) return;
      const ui = engine.ctx.services.get(UiKey);

      if (id === 'shop.close') {
        closeShop();
        // Focus returns to the hero: the camera follows again and the hero is
        // the selection, so the very next order goes to them rather than to
        // whatever the shop click left selected.
        selectedUnit = null;
        rtsCamera.follow(h.id);
        return;
      }
      if (id.startsWith('buy.')) {
        // Refusals (no gold, full bag) come back from the simulation as a
        // message addressed to this player.
        sendCommand({ kind: 'buy', itemId: id.slice(4) });
        return;
      }
      if (id.startsWith('ability.')) {
        // Same path the QWER keys take, so a clicked ability and a pressed one
        // cannot diverge — an aimed one arms the cursor either way.
        beginCast(Number(id.slice(8)));
        return;
      }
      if (id === 'levelup') {
        levelPanel.open();
        return;
      }
      if (id === 'order.stop' || id === 'order.hold') {
        // Dropping the hero's order is the stop: movement reads `heroOrders`,
        // so no order leaves the hero standing where it is.
        sendCommand({ kind: 'stop' });
        selectedUnit = null;
        ui.notify(id === 'order.hold' ? 'Manteniendo posición' : 'Detenido', 'info');
        return;
      }
      if (id === 'order.attack') {
        ui.notify('Clic derecho sobre un enemigo para atacar', 'info');
      }
    },
  });

  // Gameplay cannot be built until a hero is chosen, so it joins the engine
  // after the title screen resolves. Everything below is null-guarded until then.
  let gameplay: GameplayBundle | null = null;
  /** The online session, while an online match is being played. */
  let net: NetSession | null = null;
  /** The most recent command any input produced. Read by the QA harness only. */
  let lastCommand: Command | null = null;
  /** True while the server is holding the clock for somebody's pause. */
  let netPaused = false;
  /** Whether that pause is this player's, and so theirs to lift. */
  let netPausedByMe = false;

  /**
   * Every player action that changes the match goes through here, and only
   * here. Solo, it is booked for the next tick; online, it is sent to the
   * server, which folds it into a turn every machine plays at the same tick.
   */
  const sendCommand = (cmd: Command): void => {
    if (!gameplay) return;
    // Kept only so automated input tests can read what an input aimed at,
    // rather than inferring it from where the hero ends up. A hero walks for
    // seconds and stops short of its destination by the arrival radius, so its
    // position answers "did it get there yet", not "where was it sent" - and
    // the two look identical when a test samples on a fixed timer.
    lastCommand = cmd;
    if (net) {
      // Orders given during a pause would all land on the tick play resumes,
      // firing as a burst nobody meant. Leaving is always allowed.
      if (netPaused && cmd.kind !== 'forfeit') return;
      net.send(cmd);
      return;
    }
    const { commands, match: m } = gameplay;
    commands.book(commands.nextTick, [{ slot: m.setup.localSlot, cmd }]);
  };

  // Registration order does not matter; Engine sorts by `order`.
  for (const module of createWorldModules()) engine.add(module);
  for (const module of createUnitModules(showcase)) engine.add(module);
  for (const module of createVfxModules()) engine.add(module);
  engine.add(renderModule);
  engine.add(hudModule);
  const audio = new AudioModule({
    playerHeroId: () => gameplay?.match.playerHero?.id ?? null,
    inMatch: () => gameplay !== null,
    localTeam: () => gameplay?.match.localTeam ?? 0,
  });
  engine.add(audio);

  // Before initAll, not after: module init builds characters (the showcase does
  // it immediately), character building is synchronous, and a rigid part that
  // arrives late is simply absent from a mesh that has already been assembled
  // and, for creeps, baked into a VAT texture.
  await preloadParts();

  await engine.initAll(setBootProgress);

  // Bind any imported meshes to their rigs before a unit can spawn. Doing it
  // here rather than lazily keeps the cost at boot, where a pause is expected,
  // instead of on the frame a wave appears.
  bootLabel.textContent = 'Preparando personajes';
  await prepareImportedCharacters((id, ok) => {
    if (!ok) console.warn(`[boot] ${id}: no imported mesh, using procedural build`);
  });

  // Camera reads terrain height so it never clips into cliffs.
  const terrain = engine.ctx.services.get(TerrainKey);
  rtsCamera.setHeightSampler((x, z) => terrain.heightAt(x, z));
  rtsCamera.setLimits({ minX: -105, maxX: 105, minZ: -105, maxZ: 105 });

  // The title orbits the Core plateau; the hero spawns there once chosen.
  const coreLane = terrain.lanePath(0, 0);
  const menuFocus = coreLane.length > 0
    ? { x: coreLane[coreLane.length - 1]!.x, z: coreLane[coreLane.length - 1]!.z }
    : { x: SHOWCASE_ORIGIN.x, z: SHOWCASE_ORIGIN.z + 6 };
  rtsCamera.poseImmediate(menuFocus, 0.24, 0);

  // A finished match has no seat to come back to: a reload after the end
  // screen should land on the title, not try to rejoin.
  engine.ctx.bus.on('match:end', () => {
    if (net) clearResume();
    // Nothing left to concede or pause once the end screen is up.
    surrenderButton.classList.add('is-hidden');
    surrenderOverlay.classList.add('is-hidden');
    pauseButton.classList.add('is-hidden');
  });

  engine.ctx.bus.on('camera:shake', ({ intensity, duration, team }) => {
    if (playback.fastForward) return;
    // A shake addressed to a team belongs to that team's screens only: the
    // rival's Core being hit must not rattle this player's camera.
    if (team !== undefined && gameplay && team !== gameplay.match.localTeam) return;
    rtsCamera.shake(intensity, duration);
  });

  /** -1 or +1: which half of the mirrored map is the local player's. */
  const homeSign = (): -1 | 1 => (gameplay ? teamSign(gameplay.match.localTeam) : -1);

  const centreOnHero = (): void => {
    const h = gameplay?.match.playerHero;
    if (!h) return;
    rtsCamera.setFocus({ x: h.pos.x, z: h.pos.z }, false);
    rtsCamera.follow(h.id);
  };

  /**
   * Attack-move: armed by A, consumed by the next click.
   *
   * Held here rather than inside `setupOrders` because both the keyboard and
   * the pointer need it, and the cursor has to reflect it — three consumers,
   * so it belongs to the scope that owns them all.
   */
  let attackMove = false;
  const setAttackMove = (on: boolean): void => {
    attackMove = on;
    // The sword cursor is the whole feedback: without it there is nothing on
    // screen saying the next click means something different.
    document.body.classList.toggle('is-attack-move', on);
  };

  /**
   * Aiming: armed by an aimed ability's key or button, consumed by the next
   * left click, cancelled by right click, Esc, or arming something else.
   *
   * Self-cast abilities never arm it — they fire on the press, as before.
   */
  let aiming: { index: number; targeting: 'unit' | 'point' } | null = null;
  const targetingOverlay = new TargetingOverlay(scene, (x, z) => terrain.heightAt(x, z));
  const cancelAim = (): void => {
    aiming = null;
    document.body.classList.remove('is-aiming');
    targetingOverlay.hide();
  };
  const beginCast = (index: number): void => {
    const h = gameplay?.match.playerHero;
    if (!gameplay || !h || !h.alive) return;
    const def = gameplay.abilities.abilitiesFor(h.defId)[index];
    if (!def) return;
    if (def.targeting === 'self') {
      cancelAim();
      sendCommand({ kind: 'cast', index, target: { kind: 'self' } });
      return;
    }
    // Refuse up front rather than arm a cursor for a spell that cannot fire:
    // aiming, clicking and only then hearing "not ready" wastes the player's
    // attention twice.
    const ui = engine.ctx.services.get(UiKey);
    if (gameplay.abilities.cooldownLeft(h.id, def.id) > 0) {
      ui.notify(`${def.name} aún no está lista`, 'warn');
      return;
    }
    if (h.mana < def.manaCost) {
      ui.notify('Maná insuficiente', 'warn');
      return;
    }
    setAttackMove(false);
    aiming = { index, targeting: def.targeting };
    document.body.classList.add('is-aiming');
    targetingOverlay.show(def.targeting === 'point' ? def.radius : 0, def.range);
  };
  const commitAim = (target: AbilityTarget): void => {
    if (aiming) sendCommand({ kind: 'cast', index: aiming.index, target });
    cancelAim();
  };

  // Where the cursor meets the ground, found by marching the view ray over the
  // heightfield. Used every frame while aiming, where a mesh raycast against the
  // whole terrain would cost more than the rest of the frame's input handling.
  const aimRay = new THREE.Raycaster();
  const aimNdc = new THREE.Vector2();
  const pointer = { x: 0, y: 0, inside: false };
  const trackPointer = (e: PointerEvent): void => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.inside = true;
  };
  window.addEventListener('pointermove', trackPointer);
  // Also on the way down: a finger has not moved anywhere when it lands, so
  // without this the targeting decal for an armed ability would still be
  // sitting wherever the last gesture left it at the moment of the press.
  window.addEventListener('pointerdown', trackPointer);
  const groundUnderPointer = (): { x: number; z: number } | null => {
    if (!pointer.inside) return null;
    aimNdc.set((pointer.x / window.innerWidth) * 2 - 1, -(pointer.y / window.innerHeight) * 2 + 1);
    aimRay.setFromCamera(aimNdc, rtsCamera.camera);
    const { origin: o, direction: d } = aimRay.ray;
    for (let t = 1; t < 420; t += 1) {
      if (o.y + d.y * t > terrain.heightAt(o.x + d.x * t, o.z + d.z * t)) continue;
      let lo = t - 1;
      let hi = t;
      for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) * 0.5;
        if (o.y + d.y * mid > terrain.heightAt(o.x + d.x * mid, o.z + d.z * mid)) lo = mid;
        else hi = mid;
      }
      return { x: o.x + d.x * hi, z: o.z + d.z * hi };
    }
    return null;
  };
  engine.add({
    id: 'aiming',
    order: 855,
    init: () => {},
    update: () => {
      if (!aiming) return;
      const h = gameplay?.match.playerHero;
      if (!h || !h.alive) {
        cancelAim();
        return;
      }
      targetingOverlay.update(h.pos, aiming.targeting === 'point' ? groundUnderPointer() : null);
    },
  });

  const togglePause = (): void => {
    if (!gameplay) return;
    // Online the clock belongs to the server: ask it to stop for everyone
    // rather than freezing this machine while the rest keep playing. The plate
    // and the button follow the server's answer, in `watchSession`.
    if (net) {
      if (netPaused && !netPausedByMe) {
        engine.ctx.services.get(UiKey).notify('Solo quien ha pausado puede reanudar', 'warn');
        return;
      }
      net.setPaused(!netPaused);
      return;
    }
    engine.setPaused(!engine.isPaused);
    audio.setPaused(engine.isPaused);
    pauseOverlay.classList.toggle('is-hidden', !engine.isPaused);
    pauseButton.textContent = engine.isPaused ? '▶' : '❚❚';
    pauseButton.title = engine.isPaused ? 'Reanudar (Espacio)' : 'Pausar (Espacio)';
  };
  pauseButton.addEventListener('click', togglePause);
  // Clicking the plate itself resumes, which is what a player tries first.
  pauseOverlay.addEventListener('click', () => {
    if (engine.isPaused) togglePause();
  });

  setupInput(
    rtsCamera,
    centreOnHero,
    beginCast,
    togglePause,
    (on) => {
      const next = on ?? !attackMove;
      if (next) cancelAim();
      setAttackMove(next);
    },
    () => attackMove,
    () => aiming !== null,
    cancelAim,
  );
  let selectedUnit: number | null = null;
  let hoveredUnit: number | null = null;
  /** Set once the shop module is registered; clicking a shop calls it. */
  let requestShopOpen: () => void = () => {};
  const worldPointer = setupOrders(
    engine,
    rtsCamera,
    scene,
    () => gameplay?.match.playerHero?.id ?? null,
    (id) => {
      selectedUnit = id;
    },
    (id) => {
      hoveredUnit = id;
    },
    (ground) => {
      // Clicking a shop building opens it, provided the hero is close enough —
      // the range check lives in the economy module, this only reports the click.
      const t1 = landmark('shopProgression');
      const t2 = landmark('shopSabotage');
      const sign = homeSign();
      // Matches the economy's own range check, so a click that opens the card
      // can never be one the economy then refuses to serve.
      const near = (l: { u: number; v: number }): boolean =>
        Math.hypot(ground.x - sign * l.u, ground.z - l.v) < 10;
      if (near(t1) || near(t2)) requestShopOpen();
    },
    (pos) => hudModule.markMoveOrder(pos),
    (kind, sign) => {
      // Only the local player's half is usable: the mirrored site belongs to
      // the other team, and clicking it must not open their shop.
      if (sign !== homeSign()) return false;
      if (kind !== 'shopProgression' && kind !== 'shopSabotage') return false;
      requestShopOpen();
      return true;
    },
    (hit) => {
      const structures = engine.getModule('structures') as StructuresModule | undefined;
      structures?.setHighlight(hit && hit.sign === homeSign() ? hit.root : null);
    },
    () => attackMove,
    () => setAttackMove(false),
    sendCommand,
    {
      active: () => aiming?.targeting ?? null,
      commit: commitAim,
      cancel: cancelAim,
    },
  );

  setupTouch(
    canvas,
    rtsCamera,
    worldPointer,
    (x, z) => terrain.heightAt(x, z),
    () => {
      // One short pulse when an order is actually booked, and nothing else.
      // Vibration is the only feedback a finger gets for a hit it is covering
      // with its own hand; anything longer than a tick reads as a malfunction,
      // and most desktop browsers and every iOS browser simply do not have it.
      try {
        navigator.vibrate?.(12);
      } catch {
        // Some browsers throw here when the page has no user activation yet.
      }
    },
  );

  // Slow orbit behind the title screen, cancelled the moment play begins.
  let orbiting = true;
  engine.add({
    id: 'camera',
    order: 850,
    init: () => {},
    update: (dt) => {
      if (orbiting) rtsCamera.rotateBy(dt * 0.06);
      rtsCamera.update(dt, gameplay?.match.playerHero?.pos);
    },
  });

  // Mirrors simulation state into the HUD model once per frame. Kept separate
  // from the HUD itself so the UI layer never reaches into gameplay.
  engine.add({
    id: 'hudSync',
    order: 860,
    init: () => {},
    update: () => {
      if (!gameplay) return;
      const h = gameplay.match.playerHero;
      const localTeam = gameplay.match.localTeam;
      const core = match.cores.find((c) => c.team === localTeam);
      hudModel.wave = match.wave;
      hudModel.waveTotal = WAVES_TOTAL;
      hudModel.countdown = gameplay.waves.countdown;
      // 'victory' means some team won; whether that is this player is decided
      // here, from the winner, because every machine shares the same phase.
      hudModel.defeated =
        match.phase === 'defeat' || (match.phase === 'victory' && match.winner !== localTeam);
      hudModel.victorious = match.phase === 'victory' && match.winner === localTeam;
      hudModel.versus = gameplay.match.setup.players.length > 1;
      hudModel.endCause = gameplay.match.endCause;
      hudModel.sabotage = gameplay.sabotage.active().map((s) => ({
        name: s.name,
        against: s.team === localTeam,
        seconds: s.secondsLeft,
      }));
      if (core) {
        hudModel.coreLives = core.lives;
        hudModel.coreMaxLives = core.maxLives;
      }
      if (!h) return;
      const def = HEROES[h.defId];
      hudModel.heroName = def ? `${def.name}, ${def.title}` : h.defId;
      hudModel.level = h.level;
      hudModel.health = Math.max(0, h.health);
      hudModel.maxHealth = h.stats.maxHealth;
      hudModel.mana = h.mana;
      hudModel.maxMana = h.stats.maxMana;
      hudModel.xp = h.xp;
      hudModel.xpToNext = xpToNext(h.level);
      hudModel.gold = h.gold;
      hudModel.influence = h.influence;
      hudModel.reviveCountdown = gameplay.match.reviveCountdown;
      hudModel.inventory = gameplay.economy
        .inventory(h)
        .map(({ item, count }) => ({ name: item.name, icon: item.icon, count, itemId: item.id }));

      // Read from the resolved block, not from the base: this has to include
      // items and active buffs or the panel would contradict what the hero
      // actually hits for.
      hudModel.stats.attackDamage = h.stats.attackDamage;
      hudModel.stats.attackSpeed = h.stats.attackSpeed;
      hudModel.stats.armor = h.stats.armor;
      hudModel.stats.spellPower = h.stats.spellPower;
      hudModel.stats.moveSpeed = h.stats.moveSpeed;
      // Everything modifiers added: resolved minus base. Attribute points count
      // as bonus too — they are spent, not innate — which is why this is taken
      // against `baseStats` rather than against the level-1 block.
      hudModel.statBonus.attackDamage = h.stats.attackDamage - h.baseStats.attackDamage;
      hudModel.statBonus.attackSpeed = h.stats.attackSpeed - h.baseStats.attackSpeed;
      hudModel.statBonus.armor = h.stats.armor - h.baseStats.armor;
      hudModel.statBonus.spellPower = h.stats.spellPower - h.baseStats.spellPower;
      hudModel.statBonus.moveSpeed = h.stats.moveSpeed - h.baseStats.moveSpeed;
      const allocated = gameplay.progression.allocated(h.id);
      hudModel.attributes.power = allocated.power;
      hudModel.attributes.vitality = allocated.vitality;
      hudModel.attributes.focus = allocated.focus;
      hudModel.attributePoints = gameplay.progression.unspent(h.id);

      const defs = gameplay.abilities.abilitiesFor(h.defId);
      // Rebuild only when the ability set itself changes; the HUD compares by
      // key+icon, so mutating cooldowns in place avoids a DOM rebuild per frame.
      if (hudModel.abilities.length !== defs.length) {
        hudModel.abilities = defs.map((a) => ({
          key: a.key,
          name: `${a.name} — ${a.description}`,
          icon: a.icon,
          cooldown: a.cooldown,
          cooldownLeft: 0,
        }));
      }
      for (let i = 0; i < defs.length; i++) {
        hudModel.abilities[i]!.cooldownLeft = gameplay.abilities.cooldownLeft(h.id, defs[i]!.id);
      }

      // ── Command card: the shop's stock when one is open, the hero's orders
      //    otherwise. Rebuilt into the same array each tick; the HUD diffs by
      //    slot id and only touches the DOM when the set actually changes.
      const slots: CommandSlot[] = [];
      if (openShopKind !== null) {
        const stock = openShopKind === 'hero' ? T1_STOCK : SABOTAGE_ITEMS;
        hudModel.command.title =
          openShopKind === 'hero' ? 'T1 · Pertrechos' : 'T2 · Sabotaje';
        // First slot, not last: the card scrolls, and a close button that
        // scrolls out of reach is not a close button.
        slots.push({
          id: 'shop.close',
          kind: 'order',
          label: 'Cerrar tienda',
          icon: 'close',
          tooltip: 'Vuelve a las órdenes del héroe.',
        });
        for (const item of stock) {
          const purse = item.currency === 'gold' ? h.gold : h.influence;
          const held = gameplay.economy.owned(h, item.id);
          // Gear is unique, so an owned piece reads as owned rather than as
          // merely unaffordable — those are different reasons to grey out.
          const owned = item.kind === 'gear' && held > 0;
          // A sabotage needs someone to sabotage: solo, the shop explains
          // that instead of taking the influence for nothing.
          const noRival = item.kind === 'action' && gameplay.match.rivalsOf(gameplay.match.localTeam).length === 0;
          const counterplay = 'counterplay' in item ? ` Contramedida: ${String(item.counterplay)}` : '';
          slots.push({
            id: `buy.${item.id}`,
            kind: 'item',
            label: item.name,
            icon: item.icon,
            tooltip: item.description + counterplay,
            cost: item.cost,
            currency: item.currency,
            disabled: owned || noRival || purse < item.cost,
            reason: owned
              ? 'Ya lo llevas'
              : noRival
                ? 'Solo en partidas contra un rival'
                : `Te faltan ${Math.ceil(item.cost - purse)} de ${item.currency === 'influence' ? 'influencia' : 'oro'}`,
            highlight: owned,
          });
        }
      } else {
        hudModel.command.title = 'Órdenes';
        for (let i = 0; i < defs.length; i++) {
          const a = defs[i]!;
          slots.push({
            // Index, not id: `AbilityModule.request` is index-based.
            id: `ability.${i}`,
            kind: 'ability',
            label: a.name,
            icon: a.icon,
            // Description only. The tooltip renders `label` as its heading, so
            // prefixing the name here printed it twice.
            tooltip: a.description,
            hotkey: a.key,
            cooldown: a.cooldown,
            cooldownLeft: gameplay.abilities.cooldownLeft(h.id, a.id),
            manaCost: a.manaCost,
            aim: aimLabel(a),
            // Lit while its cursor is armed or the hero is walking in to cast
            // it, so the player can see which spell the next click belongs to.
            highlight: aiming?.index === i || gameplay.abilities.pendingCast(h.id) === i,
            // Not enough mana is a different refusal from being on cooldown,
            // and the button has to say which.
            disabled: h.mana < a.manaCost,
            reason: `Necesitas ${Math.ceil(a.manaCost - h.mana)} de maná más`,
          });
        }
        // The yellow cross. Present always so the card's shape does not jump,
        // but only lit and clickable when there is something to spend.
        const unspent = gameplay.progression.unspent(h.id);
        slots.push({
          id: 'levelup',
          kind: 'levelup',
          label: 'Subir atributo',
          icon: 'plus',
          tooltip:
            unspent > 0
              ? `Tienes ${unspent} punto(s) sin repartir. Clic para abrir la ventana de atributos.`
              : 'Sube de nivel para ganar puntos de atributo.',
          disabled: unspent === 0,
          reason: 'Sin puntos que repartir',
          highlight: unspent > 0,
        });
        slots.push(
          { id: 'order.attack', kind: 'order', label: 'Atacar', icon: 'sword', hotkey: 'A',
            tooltip: 'Atacar — clic derecho sobre un enemigo' },
          { id: 'order.stop', kind: 'order', label: 'Detener', icon: 'stop', hotkey: 'S',
            tooltip: 'Detener — cancela la orden actual' },
          { id: 'order.hold', kind: 'order', label: 'Mantener posición', icon: 'shield', hotkey: 'H',
            tooltip: 'Mantener posición — no persigue objetivos' },
        );
      }
      hudModel.command.slots = slots;
    },
  });

  const onResize = (): void => {
    engine.ctx.services.get(RenderKey).resize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);
  onResize();

  engine.start();

  boot.classList.add('hidden');
  setTimeout(() => boot.remove(), 600);

  /** Builds the match for the chosen hero and hands control to the player. */
  /**
   * Builds the match and hands control to the player.
   *
   * A hero key starts a solo match; a `MatchSetup` with a session starts an
   * online one. Either way the simulation is reset to tick 0 with the match's
   * seed and held still while the modules initialise: `addAndInit` awaits, and
   * a frame that simulated a half-built match would put this machine a tick
   * ahead of every other one before the match had even begun.
   */
  const startMatch = async (arg: string | MatchSetup, session: NetSession | null = null): Promise<void> => {
    if (gameplay) return;
    const setup = typeof arg === 'string' ? soloSetup(HEROES[arg] ? arg : 'bulwark', seed) : arg;
    engine.setStepLimit(0);
    engine.resetSimulation(setup.seed);
    match.mode = setup.mode;
    net = session;
    gameplay = createGameplay(setup);
    for (const module of gameplay.modules) await engine.addAndInit(module);
    hudModule.setHomeTeam(gameplay.match.localTeam);
    if (session) {
      watchSession(session);
      session.begin(engine, gameplay.commands);
    } else {
      engine.setStepLimit(Infinity);
    }

    orbiting = false;
    title.hide();
    hudModule.show();
    pauseButton.classList.remove('is-hidden');
    surrenderButton.classList.remove('is-hidden');

    const h = gameplay.match.playerHero;
    // Zoomed in close on the hero so the player can actually see who they are
    // playing, and following so they do not lose them on the first pan.
    if (h) {
      rtsCamera.poseImmediate({ x: h.pos.x, z: h.pos.z }, 0.12, 0);
      rtsCamera.follow(h.id);
    } else {
      rtsCamera.poseImmediate(menuFocus, 0.3, 0);
    }

    engine.ctx.services
      .get(UiKey)
      .notify('Clic derecho para mover · la primera oleada se acerca', 'info');
  };

  /**
   * Shows what the network is doing while it stops play: a rival who dropped,
   * this client reconnecting, or a rejoin replaying the match. Toasts mark the
   * moments a rival drops and comes back.
   */
  const watchSession = (session: NetSession): void => {
    const ui = engine.ctx.services.get(UiKey);
    const toMenu = { label: 'Volver al menú', run: () => { session.leave(); location.reload(); } };
    let waitingOn = new Map<number, string>();
    let selfState: 'ok' | 'lost' | 'catchingUp' = 'ok';
    let lastWaiting: WaitingPlayer[] = [];

    const render = (): void => {
      if (selfState !== 'ok') return;
      const others = lastWaiting.filter((p) => p.slot !== session.setup.localSlot);
      const away = others.find((p) => p.reason === 'disconnected');
      const loading = others.find((p) => p.reason === 'loading');
      // A pause stops the match for everyone, so it is shown to everyone —
      // with the button only on the plate of whoever called it.
      const paused = lastWaiting.find((p) => p.reason === 'paused');
      netPaused = paused !== undefined;
      netPausedByMe = paused?.slot === session.setup.localSlot;
      audio.setPaused(netPaused);
      pauseButton.textContent = netPaused ? '▶' : '❚❚';
      // The very first wait — everyone building the match — is too short to
      // be worth a plate; only waits after play has begun are shown. A
      // disconnect outranks a pause: it is the one with a deadline.
      if (away) {
        const s = Math.max(0, away.secondsLeft);
        netOverlay.show(
          `ESPERANDO A ${away.name.toUpperCase()}`,
          `Se ha desconectado · pierde la partida si no vuelve en ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`,
        );
      } else if (loading && session.turn > 0) {
        netOverlay.show(`${loading.name.toUpperCase()} VUELVE`, 'Se ha reconectado y se está poniendo al día…');
      } else if (paused) {
        const s = Math.max(0, paused.secondsLeft);
        const clock = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        const mine = paused.slot === session.setup.localSlot;
        netOverlay.show(
          'PAUSA',
          mine
            ? `Has pausado la partida · se reanuda sola en ${clock}`
            : `${paused.name} ha pausado la partida · ${clock}`,
          mine ? { action: { label: 'Reanudar', run: () => session.setPaused(false) } } : {},
        );
      } else {
        netOverlay.hide();
      }
    };

    session.events = {
      onWaiting: (players) => {
        lastWaiting = players;
        const now = new Map<number, string>();
        for (const p of players) {
          if (p.reason === 'disconnected' && p.slot !== session.setup.localSlot) now.set(p.slot, p.name);
        }
        for (const [slot, name] of now) if (!waitingOn.has(slot)) ui.notify(`${name} se ha desconectado`, 'danger');
        for (const [slot, name] of waitingOn) if (!now.has(slot)) ui.notify(`${name} ha vuelto a la partida`, 'reward');
        waitingOn = now;
        render();
      },
      onConnectionLost: (attempt) => {
        selfState = 'lost';
        netOverlay.show('CONEXIÓN PERDIDA', `Reconectando con el servidor… (intento ${attempt})`, { action: toMenu });
      },
      onReconnected: () => {
        selfState = 'ok';
        ui.notify('Conexión recuperada', 'reward');
        render();
      },
      onReconnectFailed: (reason) => {
        selfState = 'lost';
        netOverlay.show('NO SE PUDO RECONECTAR', reason, { action: toMenu });
      },
      onCatchUp: (progress) => {
        if (progress >= 1) {
          selfState = 'ok';
          render();
          return;
        }
        selfState = 'catchingUp';
        netOverlay.show('VOLVIENDO A LA PARTIDA', 'Recuperando lo que ha pasado mientras no estabas…', { progress });
      },
      onPlayerLeft: (name) => ui.notify(`${name} ha abandonado la partida`, 'warn'),
      onPaused: ({ slot, name, paused }) => {
        if (slot === session.setup.localSlot) return;
        ui.notify(paused ? `${name} ha pausado la partida` : `${name} ha reanudado la partida`, 'info');
      },
      onResync: ({ tick, mine, attempt }) => {
        console.warn(`[net] resync at tick ${tick} (attempt ${attempt}, mine: ${mine})`);
        if (!mine) {
          ui.notify('Un jugador se ha desincronizado · recuperando', 'warn');
          return;
        }
        selfState = 'catchingUp';
        netOverlay.show('RESINCRONIZANDO', 'Tu partida se había desviado · recuperándola desde el último punto común');
        // The seat token stays — it is what gets this player their hero back —
        // and the flag tells the rejoin to start from the last state every
        // machine agreed on, not from this browser's newest one.
        markResync();
        window.setTimeout(() => location.reload(), 600);
      },
      onDesync: (tick) => {
        console.error(`[net] desync at tick ${tick}`);
        selfState = 'lost';
        netOverlay.show(
          'PARTIDA DESINCRONIZADA',
          'Las máquinas dejaron de calcular la misma partida y no se ha podido recuperar',
          { action: toMenu },
        );
      },
    };
  };

  /** Which shop's stock the command card is showing, or null for hero orders. */
  let openShopKind: 'hero' | 'sabotage' | null = null;

  // The shop opens only when the player clicks the building, and closes on its
  // own when the hero walks out of range. Opening on proximity alone popped the
  // panel open the instant the match started, because the hero spawns on the
  // base terrace next to T1.
  //
  // "Open" now means the command card switches to the shop's stock rather than
  // a list panel appearing: a scrolling list of rows is a menu, and this is an
  // RTS — stock belongs in the same grid the hero's orders use.
  let shopRequested = false;
  engine.add({
    id: 'shopSync',
    order: 865,
    init: () => {},
    update: () => {
      if (!gameplay) return;
      const kind = gameplay.economy.shopInRange(gameplay.match.playerHero);
      if (kind === null) shopRequested = false;
      openShopKind = shopRequested ? kind : null;
    },
  });
  requestShopOpen = () => {
    shopRequested = true;
  };
  /** Shared by the card's close button and by walking out of range. */
  const closeShop = (): void => {
    shopRequested = false;
    openShopKind = null;
  };

  const levelPanel = new LevelPanel({
    unspent: () => {
      const h = gameplay?.match.playerHero;
      return h ? gameplay!.progression.unspent(h.id) : 0;
    },
    allocated: () => {
      const h = gameplay?.match.playerHero;
      return h
        ? gameplay!.progression.allocated(h.id)
        : { power: 0, vitality: 0, focus: 0 };
    },
    spend: (attribute) => {
      // Applied by the simulation on the next tick; the panel refreshes itself
      // from the real point count, so reporting success here is only a hint.
      if (!gameplay?.match.playerHero) return false;
      sendCommand({ kind: 'attribute', attribute });
      return true;
    },
    level: () => gameplay?.match.playerHero?.level ?? 1,
  });
  uiRoot.appendChild(levelPanel.root);

  engine.add({
    id: 'levelSync',
    order: 866,
    init: () => {},
    update: () => levelPanel.refresh(),
  });

  // The server validates hero picks against the protocol's list. A hero added
  // to the game but not to that list could never be picked online; one removed
  // from the game but left there would crash every client at match start.
  const heroKeys = Object.keys(HEROES).sort().join(',');
  if (heroKeys !== [...HERO_KEYS].sort().join(',')) {
    console.error(`[net] HERO_KEYS (${HERO_KEYS.join(',')}) out of sync with HEROES (${heroKeys})`);
  }

  const heroCards = buildHeroCards();
  const heroSelect = new HeroSelect(heroCards);
  heroSelect.root.classList.add('is-hidden');
  uiRoot.appendChild(heroSelect.root);

  // Every control in here drives something below; see options.ts.
  const options = new OptionsPanel((s) => {
    engine.ctx.services.get(RenderKey).setQuality(s.quality);
    rtsCamera.edgeScrollEnabled = s.edgeScroll;
    rtsCamera.panSpeed = s.panSpeed;
    hudModule.applySettings({ minimap: s.minimap, damageNumbers: s.damageNumbers });
    audio.setLevels({
      master: s.masterVolume,
      sfx: s.sfxVolume,
      ambient: s.ambientVolume,
      music: s.musicVolume,
    });
  });
  uiRoot.appendChild(options.root);
  options.apply();

  const lobby = new Lobby(heroCards, {
    onStart: (setup, session) => {
      title.setHidden(true);
      void startMatch(setup, session);
    },
    onBack: () => title.setHidden(false),
  });
  uiRoot.appendChild(lobby.root);

  const title = new TitleScreen(TITLE, SUBTITLE, VERSION);
  title.on('online', () => {
    title.setHidden(true);
    lobby.open();
  });
  title.on('play', () => {
    // The title has to step aside, not just sit behind: both screens are full
    // -bleed overlays and the menu would otherwise render over the hero cards.
    title.setHidden(true);
    void heroSelect.open().then((chosen) => startMatch(chosen));
  });
  title.on('options', () => {
    title.setHidden(true);
    options.open();
  });
  // Reached from the title, so closing goes back to it — but only while the
  // match has not started; mid-match the options are opened with Esc and
  // closing must return to the game, not raise a menu over it.
  options.onClose = () => {
    if (!gameplay) title.setHidden(false);
  };
  heroSelect.onCancel = () => title.setHidden(false);
  uiRoot.appendChild(title.root);

  window.addEventListener('keydown', (e) => {
    // A handled Escape already meant "cancel the armed spell or attack-move";
    // opening the options on top of that would answer one keypress twice.
    if (e.key !== 'Escape' || !gameplay || e.defaultPrevented) return;
    if (options.isOpen) options.close();
    else options.open();
  });

  // QA captures must never be blocked by a menu waiting for a click.
  if (isQa) await startMatch(heroKey);

  // An online match this browser was in and never finished — the page was
  // reloaded, or the window closed. Take the seat back before showing the menu.
  const pendingRejoin = !isQa && !isEdit ? loadResume() : null;
  if (pendingRejoin) {
    title.setHidden(true);
    netOverlay.show('VOLVIENDO A LA PARTIDA', 'Conectando con el servidor…');
    lobby.rejoin(pendingRejoin).catch((error: Error) => {
      netOverlay.hide();
      title.setHidden(false);
      engine.ctx.services.get(UiKey).notify(`No se pudo volver a la partida: ${error.message}`, 'warn');
    });
  }

  // Editing needs the map, not the game. The title screen is a full-bleed
  // overlay that swallows every click, and the camera stays in its slow menu
  // orbit until a match begins — so with the editor open and no match, the
  // panel appeared but nothing could be clicked or navigated. Drop straight to
  // a free camera over the base and leave the simulation unstarted.
  if (isEdit) {
    title.hide();
    orbiting = false;
    rtsCamera.follow(null);
    // High and pulled back: an author wants to see what they are editing, and
    // the gameplay zoom frames a hero, not a region.
    rtsCamera.poseImmediate({ x: -48, z: 30 }, 0.85, 0);
    engine.ctx.services.get(UiKey).notify('Modo editor — la partida no se inicia', 'info');
  }

  // Exposed for automated visual QA and the review loop.
  (window as unknown as { __GAME__: unknown }).__GAME__ = {
    engine,
    camera: rtsCamera,
    renderer,
    scene,
    stats: engine.stats,
    hudModel,
    startMatch,
    // Exposed for automated movement/pathing tests: without an order entry
    // point a headless test can only teleport units, which proves nothing about
    // whether the terrain actually blocks them.
    issueOrder,
    /** Sends a command exactly as the input handlers do: booked solo, or to the server online. */
    send: sendCommand,
    /** What the last input aimed at. See `sendCommand`. */
    get lastCommand() {
      return lastCommand;
    },
    get net() {
      return net;
    },
    audio,
    get gameplay() {
      return gameplay;
    },
  };
}

/**
 * Hero cards for the selection screen.
 *
 * Vitals and ability costs are read from the gameplay definitions rather than
 * retyped, so a balance change cannot leave the selection screen advertising
 * numbers the game no longer uses.
 */
/** "Área de 5,5 m · alcance 16 m" — how an aimed ability is placed. */
function aimLabel(a: AbilityDef): string | undefined {
  const m = (n: number): string => `${n.toLocaleString('es-ES')} m`;
  if (a.targeting === 'point') return `Área de ${m(a.radius)} · alcance ${m(a.range)}`;
  if (a.targeting === 'unit') return `Sobre un enemigo · alcance ${m(a.range)}`;
  return undefined;
}

function buildHeroCards(): HeroCard[] {
  const flavour: Record<string, { role: string; blurb: string; palette: { primary: number; accent: number } }> = {
    bulwark: {
      role: 'Tanque · Control',
      blurb:
        'Aguanta la línea y obliga a la oleada a pelear con él. Su grito arrastra la atención de los enemigos lejos del Núcleo.',
      palette: { primary: 0x2a3550, accent: 0xc8a253 },
    },
    oracle: {
      role: 'Hechicera · Control y daño de área',
      blurb:
        'Frágil pero letal a distancia. Encadena relámpagos entre enemigos, congela y aturde zonas que ella elige, y remata con un meteoro.',
      palette: { primary: 0x3b2a52, accent: 0xb98ce0 },
    },
    talon: {
      role: 'Tiradora · Daño sostenido',
      blurb:
        'Su daño sale del arco, no del maná. Atraviesa filas enteras con una sola flecha, deja trampas donde la oleada tiene que pasar, y se aparta de un paso cuando la alcanzan.',
      palette: { primary: 0x24402c, accent: 0xc9b06a },
    },
    vesper: {
      role: 'Sanadora · Apoyo y daño sagrado',
      blurb:
        'Cura peleando: la luz que arranca de un enemigo va a parar al aliado más herido. Consagra el suelo, escuda a quien aguanta la línea y, cuando todo se tuerce, rompe el alba sobre la oleada.',
      palette: { primary: 0x3a3320, accent: 0xe6c469 },
    },
  };

  return Object.entries(HEROES).map(([id, def]) => {
    const extra = flavour[id] ?? {
      role: 'Héroe',
      blurb: '',
      palette: { primary: 0x2a3550, accent: 0xc8a253 },
    };
    return {
      id,
      name: def.name,
      title: def.title,
      role: extra.role,
      blurb: extra.blurb,
      palette: extra.palette,
      vitals: {
        health: Math.round(def.stats.maxHealth),
        mana: Math.round(def.stats.maxMana),
        damage: Math.round(def.stats.attackDamage),
        armor: Math.round(def.stats.armor),
        range: Math.round(def.stats.attackRange),
      },
      abilities: (ABILITIES[id] ?? []).map((a) => ({
        key: a.key,
        name: a.name,
        description: a.description,
        icon: a.icon,
        cooldown: a.cooldown,
        manaCost: a.manaCost,
      })),
    };
  });
}

/**
 * Placeholder HUD values.
 *
 * Combat, economy and progression do not exist yet, so nothing can populate the
 * model for real. These numbers make the panels reviewable and are replaced the
 * moment those subsystems land — they are not simulated gameplay and must not be
 * read as such.
 */
function seedDemoHud(model: ReturnType<typeof createHudModel>): void {
  model.heroName = 'Bulwark, Guardián del Vado';
  model.level = 7;
  model.health = 1840;
  model.maxHealth = 2260;
  model.mana = 410;
  model.maxMana = 620;
  model.xp = 3200;
  model.xpToNext = 5400;
  model.gold = 1275;
  model.influence = 340;
  model.wave = 8;
  model.waveTotal = 60;
  model.countdown = 24;
  model.coreLives = 9;
  model.coreMaxLives = 12;
  model.abilities = [
    { key: 'Q', name: 'Embate de escudo', icon: 'shield-bash', cooldown: 8, cooldownLeft: 0 },
    { key: 'W', name: 'Grito de anclaje', icon: 'anchor-shout', cooldown: 14, cooldownLeft: 5.2 },
    { key: 'E', name: 'Muro de contención', icon: 'bulwark-wall', cooldown: 20, cooldownLeft: 0 },
    { key: 'R', name: 'Bastión inquebrantable', icon: 'unbroken', cooldown: 90, cooldownLeft: 61 },
  ];
}

/**
 * The world seen through a single pointer, whatever kind of pointer it is.
 *
 * The mouse handlers below drive themselves; this is the same set of decisions
 * exposed by name so the touch gestures can reach them without a second copy of
 * the picking, the ordering rules or the armed-ability bookkeeping. Every path
 * still ends at `send`, so touch input produces commands and nothing else.
 */
interface WorldPointer {
  /**
   * A tap: commits an armed ability, spends an armed attack-move, and
   * otherwise gives the order a right click would. True if an order was sent.
   */
  tap(screenX: number, screenY: number): boolean;
  /** A long press: the attack-move order. True if an order was sent. */
  longPress(screenX: number, screenY: number): boolean;
  /** Press-down feedback: outlines whatever is under the finger. */
  preview(screenX: number, screenY: number): void;
  /** Drops that feedback. */
  clearPreview(): void;
}

/**
 * Right-click orders, RTS style: on a hostile unit it is an attack order, on
 * open ground it is a move order.
 *
 * Picking raycasts the terrain mesh for ground and does a screen-space proximity
 * test for units. Testing units by projected distance rather than by mesh
 * intersection is deliberate — creeps render through instanced VAT batches with
 * GPU-side skinning, so their CPU geometry is a bind-pose that no longer matches
 * what is on screen and a raycast against it would miss.
 */
function setupOrders(
  engine: Engine,
  cam: RtsCamera,
  scene: THREE.Scene,
  heroId: () => number | null,
  setSelected: (id: number | null) => void,
  setHovered: (id: number | null) => void,
  onGroundClick: (pos: { x: number; z: number }) => void,
  /** A move order was issued to this spot; the world overlay marks it. */
  onMoveOrder: (pos: { x: number; z: number }) => void,
  /**
   * A building was clicked, identified by landmark and map half. Returns true
   * if the click meant something there - only a shop on the player's own half
   * does. A finger has no second button to fall back on, so the tap needs to
   * know whether the building consumed it or whether it should still be an
   * order; the mouse has a right click for that and ignores the answer.
   */
  onStructureClick: (kind: LandmarkKind, sign: number) => boolean,
  /** The building under the cursor, or null. Drives the hover highlight. */
  onStructureHover: (hit: StructureHit | null) => void,
  /** True while attack-move is armed by the A key. */
  attackMoveArmed: () => boolean,
  /** Clears the armed state once a click has consumed it. */
  disarmAttackMove: () => void,
  /** Sends a player command into the match. */
  send: (cmd: Command) => void,
  /** An aimed ability waiting for its target. */
  aim: {
    active: () => 'unit' | 'point' | null;
    commit: (target: AbilityTarget) => void;
    cancel: () => void;
  },
): WorldPointer {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const projected = { x: 0, y: 0 };

  /**
   * Screen-space hit test against a unit's body.
   *
   * Two things here were wrong and both made the cursor miss what it was
   * plainly over:
   *
   * 1. `project` takes an **absolute** world Y, not a height above the unit.
   *    Passing a flat 1.2 anchored every hit box at sea level while the units
   *    stand on terraces 5 m and more above it, so the grab region sat below
   *    the body — on the base terrace, entirely off it.
   * 2. A fixed 46 px radius is only ever right at one zoom. Zoomed out it
   *    swallowed neighbouring creeps; zoomed in it was smaller than the model.
   *
   * The anchor is now the unit's chest (ground + 55% of its height) and the
   * radius is derived by projecting the top of its head, so the region tracks
   * the on-screen silhouette at every zoom.
   */
  const pickUnit = (screenX: number, screenY: number): number | null => {
    const render = engine.ctx.services.get(RenderKey);
    const terrain = engine.ctx.services.get(TerrainKey);
    let best: number | null = null;
    let bestScore = Infinity;
    for (const unit of engine.ctx.match.units.values()) {
      if (!unit.alive || unit.kind === UnitKind.Hero) continue;

      const ground = terrain.heightAt(unit.pos.x, unit.pos.z);
      // `radius` is the collision footprint; bodies are roughly 2.6× as tall
      // as they are wide, which matches the models the units module builds.
      const bodyHeight = unit.radius * 2.6;
      if (!render.project(unit.pos, ground + bodyHeight * 0.55, projected)) continue;
      const cx = projected.x;
      const cy = projected.y;

      // Second projection gives the body's on-screen half-height in pixels.
      if (!render.project(unit.pos, ground + bodyHeight, projected)) continue;
      const halfPx = Math.hypot(projected.x - cx, projected.y - cy);
      // Floor and ceiling: a distant creep must still be clickable, and a very
      // close one must not claim half the screen.
      const grab = Math.min(70, Math.max(14, halfPx * 1.15));

      const dx = cx - screenX;
      const dy = cy - screenY;
      const d2 = dx * dx + dy * dy;
      if (d2 > grab * grab) continue;
      // Normalised so a small creep the cursor is dead-centre on beats a large
      // one merely clipped at the edge of its box.
      const score = d2 / (grab * grab);
      if (score < bestScore) {
        bestScore = score;
        best = unit.id;
      }
    }
    return best;
  };

  /** Real-geometry hit test against the buildings. */
  const pickStructureAt = (screenX: number, screenY: number): StructureHit | null => {
    ndc.x = (screenX / window.innerWidth) * 2 - 1;
    ndc.y = -(screenY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(ndc, cam.camera);
    return pickStructure(raycaster, scene);
  };

  const pickGround = (screenX: number, screenY: number): { x: number; z: number } | null => {
    ndc.x = (screenX / window.innerWidth) * 2 - 1;
    ndc.y = -(screenY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(ndc, cam.camera);
    const ground = scene.getObjectByName('terrain.ground');
    if (!ground) return null;
    const hits = raycaster.intersectObject(ground, false);
    const hit = hits[0];
    return hit ? { x: hit.point.x, z: hit.point.z } : null;
  };

  window.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('pointerdown', (e) => {
    // Mouse only. A finger has no buttons to distinguish a select from an
    // order, so touch is recognised as gestures first and arrives through the
    // `WorldPointer` entry points below; letting it through here as well would
    // fire a move order at the start of every camera drag.
    if (e.pointerType !== 'mouse') return;
    // Clicks that land on a HUD panel belong to the HUD, not the world.
    if ((e.target as HTMLElement | null)?.closest('.ui-root *')) return;
    const id = heroId();
    if (id === null) return;

    const targetId = pickUnit(e.clientX, e.clientY);

    // An armed spell owns the click: left aims it, right calls it off. Checked
    // before everything else for the same reason attack-move is — the player
    // has already said what the next click is for.
    const aiming = aim.active();
    if (aiming !== null) {
      if (e.button === 2) {
        aim.cancel();
        return;
      }
      if (e.button !== 0) return;
      if (aiming === 'unit') {
        // A miss keeps the spell armed: clicking beside a creep should not
        // cost the player the whole gesture.
        if (targetId === null) return;
        setSelected(targetId);
        aim.commit({ kind: 'unit', id: targetId });
        return;
      }
      const ground = pickGround(e.clientX, e.clientY);
      if (ground) aim.commit({ kind: 'point', pos: ground });
      return;
    }

    if (e.button === 0) {
      // Attack-move consumes this click entirely: on a unit it is an attack, on
      // open ground it is a march that engages whatever it meets. It is checked
      // before selection and before buildings, because an armed attack-move
      // means the player has already said what this click is for.
      if (attackMoveArmed()) {
        if (targetId !== null) {
          setSelected(targetId);
          send({ kind: 'attack', targetId });
        } else {
          const ground = pickGround(e.clientX, e.clientY);
          if (ground) {
            setSelected(null);
            send({ kind: 'attackMove', pos: ground });
            onMoveOrder(ground);
          }
        }
        disarmAttackMove();
        return;
      }

      // Left click selects. Selecting an enemy also makes it the attack target,
      // so a single click is enough to pick who to hit; clicking a building
      // opens it; clicking empty ground clears the selection.
      setSelected(targetId);
      if (targetId !== null) {
        send({ kind: 'attack', targetId });
        return;
      }
      // Buildings are tested before the ground, and against their real
      // geometry. Opening a shop used to mean clicking the *terrain* within a
      // radius of the landmark, so the building itself was not a click target
      // and the ground in front of it was.
      const structure = pickStructureAt(e.clientX, e.clientY);
      if (structure) {
        onStructureClick(structure.kind, structure.sign);
        return;
      }
      const ground = pickGround(e.clientX, e.clientY);
      if (ground) onGroundClick(ground);
      return;
    }

    if (e.button !== 2) return;
    if (targetId !== null) {
      setSelected(targetId);
      send({ kind: 'attack', targetId });
      return;
    }
    const ground = pickGround(e.clientX, e.clientY);
    if (ground) {
      setSelected(null);
      send({ kind: 'move', pos: ground });
      onMoveOrder(ground);
    }
  });

  // Hover feedback goes to the world overlay as an outline, not to the cursor.
  // Swapping the pointer to a crosshair broke the interface's own language: one
  // pointer everywhere, and the *target* reacts to being hovered.
  window.addEventListener('pointermove', (e) => {
    // Hover is a mouse idea. A finger that "hovers" is a finger already
    // pressing, and touch gets its outline from `preview` on the way down.
    if (e.pointerType !== 'mouse') return;
    if ((e.target as HTMLElement | null)?.closest('.ui-root *')) {
      setHovered(null);
      onStructureHover(null);
      document.body.classList.remove('is-targeting', 'is-usable');
      return;
    }
    const hovered = pickUnit(e.clientX, e.clientY);
    setHovered(hovered);
    // Units win over buildings: a creep standing in a shop doorway is the thing
    // you meant to click.
    const structure = hovered === null ? pickStructureAt(e.clientX, e.clientY) : null;
    onStructureHover(structure);

    // Sword cursor over anything attackable, driven from the same pick the
    // outline uses so the two can never disagree. A building is not attackable,
    // so it gets the hand instead — the cursor has to say which verb applies.
    document.body.classList.toggle('is-targeting', hovered !== null);
    document.body.classList.toggle('is-usable', structure !== null);
  });

  void engine.ctx.services.tryGet(CombatKey);

  return {
    tap: (screenX, screenY) => {
      if (heroId() === null) return false;
      const targetId = pickUnit(screenX, screenY);

      // An armed spell owns the tap, exactly as it owns the next left click.
      const aiming = aim.active();
      if (aiming !== null) {
        if (aiming === 'unit') {
          // A miss keeps the spell armed, same as with the mouse: a fat-finger
          // beside a creep must not cost the player the whole cast.
          if (targetId === null) return false;
          setSelected(targetId);
          aim.commit({ kind: 'unit', id: targetId });
          return true;
        }
        const point = pickGround(screenX, screenY);
        if (!point) return false;
        aim.commit({ kind: 'point', pos: point });
        return true;
      }

      if (attackMoveArmed()) {
        disarmAttackMove();
        if (targetId !== null) {
          setSelected(targetId);
          send({ kind: 'attack', targetId });
          return true;
        }
        const point = pickGround(screenX, screenY);
        if (!point) return false;
        setSelected(null);
        send({ kind: 'attackMove', pos: point });
        onMoveOrder(point);
        return true;
      }

      // Nothing armed, so the tap is the right click: attack what it landed on,
      // otherwise walk there.
      if (targetId !== null) {
        setSelected(targetId);
        send({ kind: 'attack', targetId });
        return true;
      }
      // A shop swallows the tap because opening it is plainly what was meant.
      // Every other building falls through to the order below: the base is ringed
      // with walls, towers and the Core, and a tap that lands on one of them has
      // to still move the hero or the whole area reads as dead screen.
      const structure = pickStructureAt(screenX, screenY);
      if (structure && onStructureClick(structure.kind, structure.sign)) return false;
      const ground = pickGround(screenX, screenY);
      if (!ground) return false;
      setSelected(null);
      send({ kind: 'move', pos: ground });
      onMoveOrder(ground);
      // The shop's own doorway counts too. With no second button to spare,
      // tapping the ground in front of a shop should both walk there and open
      // it rather than make the player find the roof.
      onGroundClick(ground);
      return true;
    },

    longPress: (screenX, screenY) => {
      if (heroId() === null) return false;
      // An armed ability is already waiting for a tap; a long press on top of
      // that would be a second meaning for the same finger. Declining here
      // leaves the press alive, so the release still casts.
      if (aim.active() !== null) return false;
      const targetId = pickUnit(screenX, screenY);
      if (targetId !== null) {
        setSelected(targetId);
        send({ kind: 'attack', targetId });
        return true;
      }
      const ground = pickGround(screenX, screenY);
      if (!ground) return false;
      setSelected(null);
      send({ kind: 'attackMove', pos: ground });
      onMoveOrder(ground);
      disarmAttackMove();
      engine.ctx.services.get(UiKey).notify('Ataque en movimiento', 'info');
      return true;
    },

    preview: (screenX, screenY) => {
      const hovered = pickUnit(screenX, screenY);
      setHovered(hovered);
      onStructureHover(hovered === null ? pickStructureAt(screenX, screenY) : null);
    },

    clearPreview: () => {
      setHovered(null);
      onStructureHover(null);
    },
  };
}

/**
 * Finger control of the world.
 *
 * The gestures themselves are recognised in `ui/touch.ts`; this is what they
 * mean. Everything here is either a camera move or a call into `WorldPointer`,
 * which is the same code the mouse runs - there is no second ordering path and
 * no way for touch to reach the simulation except as a command.
 *
 * The pan is done by grabbing a point on the ground and keeping it under the
 * finger, rather than by converting pixels to a speed. It is the difference
 * between moving a map and steering a camera, and it is the only version that
 * survives the camera pitching and rotating: the arithmetic is the same at
 * every zoom because it is answered by the projection rather than by a
 * constant someone tuned.
 */
function setupTouch(
  canvas: HTMLElement,
  cam: RtsCamera,
  world: WorldPointer,
  groundHeight: (x: number, z: number) => number,
  confirmOrder: () => void,
): void {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let grabX = 0;
  let grabZ = 0;
  let grabbed = false;

  /**
   * Where a screen point meets the ground plane the camera is looking at.
   *
   * A plane and not the terrain mesh on purpose. A mesh raycast jumps from a
   * hilltop to the valley behind it as the ray crosses a ridge, which during a
   * drag is a teleport, and it can miss entirely past the map edge, which is a
   * dead finger under a live gesture.
   *
   * The plane is the one through the *current* focus, resampled every call, and
   * that detail is load-bearing. The camera's whole rig rides the terrain under
   * the focus, so raising that height raises the eye and the target together:
   * the offset from the focus to where a given pixel lands on the plane through
   * it is the same at any height. Pinning the plane at the height the gesture
   * started at breaks that invariance and closes a feedback loop instead -
   * dragging across a terrace edge moves the focus onto ground 8 m higher, the
   * eye rises, the same pixel now reaches much further across the frozen plane,
   * and the correction that follows drags the focus straight back off the edge.
   * Measured on the ridge east of the base, that loop made the camera shudder
   * between two points a full 90 px apart on every pointer event.
   */
  const planeAt = (screenX: number, screenY: number): { x: number; z: number } | null => {
    const planeY = groundHeight(cam.focus.x, cam.focus.z);
    ndc.x = (screenX / window.innerWidth) * 2 - 1;
    ndc.y = -(screenY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(ndc, cam.camera);
    const { origin: o, direction: d } = raycaster.ray;
    // This camera always looks down, but a ray running parallel to the plane
    // has no intersection and must not be divided by.
    if (d.y > -1e-4) return null;
    const t = (planeY - o.y) / d.y;
    if (t <= 0) return null;
    return { x: o.x + d.x * t, z: o.z + d.z * t };
  };

  const beginGrab = (screenX: number, screenY: number): void => {
    const point = planeAt(screenX, screenY);
    grabbed = point !== null;
    if (point) {
      grabX = point.x;
      grabZ = point.z;
    }
    // Takes the camera over from a glide still in flight, from its current
    // position: catching a moving view has to feel like catching it, not like
    // waiting for it to stop.
    cam.beginDrag();
  };

  /** Moves the camera so the grabbed world point sits under the finger again. */
  const dragToward = (screenX: number, screenY: number): void => {
    if (!grabbed) return;
    const point = planeAt(screenX, screenY);
    if (!point) return;
    cam.dragBy(grabX - point.x, grabZ - point.z);
  };

  installWorldGestures(canvas, {
    pressStart: (x, y) => {
      // A finger on the glass stops the world, before anything else is decided
      // about what the finger meant. Letting a glide run on under a press makes
      // the view feel like it is still being thrown while the player is plainly
      // holding it, and an order tapped during one lands somewhere they were
      // no longer looking.
      cam.cancelMomentum();
      world.preview(x, y);
    },
    pressCancel: () => world.clearPreview(),
    tap: (x, y) => {
      if (world.tap(x, y)) confirmOrder();
    },
    longPress: (x, y) => {
      const ordered = world.longPress(x, y);
      if (ordered) confirmOrder();
      return ordered;
    },
    dragStart: beginGrab,
    dragMove: dragToward,
    dragEnd: () => cam.endDrag({ instant: prefersReducedMotion() }),
    pinchStart: beginGrab,
    pinchMove: (x, y, ratio, twist) => {
      // Decomposed: the zoom and the twist are applied on their own axes, then
      // one translation puts the grabbed point back under the fingers. That
      // re-anchor is simultaneously what centres the pinch between the fingers
      // and what lets the pair pan while they zoom, so the two can never fight
      // over the same delta.
      cam.zoomByRatio(ratio);
      if (twist !== 0) cam.rotateBy(twist, true);
      cam.syncPose();
      dragToward(x, y);
    },
    // No momentum out of a pinch: two fingers never leave the glass together,
    // and the last few milliseconds of one-finger drift would fling the view.
    pinchEnd: () => cam.endDrag({ momentum: false }),
  });
}

/**
 * Pixels from the window edge that trigger edge-scrolling.
 *
 * 12 was too tight to hit reliably: on a maximised window the usable band is
 * only a few pixels before the cursor leaves the client area entirely.
 */
const EDGE_MARGIN = 28;

/**
 * Widened margin for the *other* axis once one axis is already scrolling.
 *
 * With a single margin, the only place a diagonal can happen is the
 * `EDGE_MARGIN × EDGE_MARGIN` square where two edges overlap — 28 px across,
 * which is effectively unhittable. Widening the perpendicular axis turns each
 * corner into a large L-shaped region: hold the top edge anywhere within
 * `CORNER_MARGIN` of the left side and you get a clean up-left diagonal.
 */
const CORNER_MARGIN = 190;

/**
 * Signed scroll strength for one axis, ramped rather than binary.
 *
 * Returns 0 outside the margin and approaches ±1 at the very edge, so the
 * camera eases in instead of snapping to full speed the instant the cursor
 * crosses a threshold.
 */
function edgeAxis(pos: number, size: number, margin: number): number {
  if (margin <= 0) return 0;
  if (pos <= margin) return -(1 - pos / margin);
  if (pos >= size - margin) return 1 - (size - pos) / margin;
  return 0;
}

const ABILITY_KEYS = ['KeyQ', 'KeyW', 'KeyE', 'KeyR'];

/**
 * The physical key, which keeps QWER in place on any layout. Some input paths
 * (remote desktops, on-screen keyboards, automation) deliver an empty `code`;
 * those fall back to the character so the hotkeys still work there.
 */
function codeOf(e: KeyboardEvent): string {
  if (e.code) return e.code;
  if (e.key === ' ') return 'Space';
  if (/^[a-z]$/i.test(e.key)) return `Key${e.key.toUpperCase()}`;
  return e.key;
}

function setupInput(
  cam: RtsCamera,
  focusHero: () => void,
  castAbility: (index: number) => void,
  togglePause: () => void,
  /** Arms or disarms attack-move. Omit the argument to flip it. */
  toggleAttackMove: (on?: boolean) => void,
  attackMoveArmed: () => boolean,
  aimArmed: () => boolean,
  cancelAim: () => void,
): void {
  const keys = new Set<string>();
  /**
   * A player typing into a field is not pressing hotkeys. Without this the
   * bindings swallow every letter that happens to be one: a four-letter room
   * code like QFVW arrives in the lobby as "V", because Q and W are abilities
   * and F recentres the camera, and all three call preventDefault before the
   * character can reach the input.
   */
  const typing = (e: Event): boolean => {
    const t = e.target as HTMLElement | null;
    if (!t) return false;
    return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA';
  };
  window.addEventListener('keydown', (e) => {
    if (e.repeat || typing(e)) return;
    const code = codeOf(e);
    keys.add(code);
    // Space pauses. It used to recentre the camera on the hero; that moved to
    // F, because pause is the binding a player reaches for without thinking and
    // recentring has no such convention.
    if (code === 'Space') {
      togglePause();
      e.preventDefault();
      return;
    }
    // The old space behaviour, kept on a key of its own: the standard RTS
    // escape hatch after panning somewhere else.
    if (code === 'KeyF') {
      focusHero();
      e.preventDefault();
      return;
    }
    // Attack-move. Arms a targeting mode; the next click either attacks what is
    // under it or, on open ground, sends the hero attacking toward that point.
    if (code === 'KeyA') {
      toggleAttackMove();
      e.preventDefault();
      return;
    }
    // Escape cancels an armed spell or attack-move before it opens the options.
    if (code === 'Escape' && aimArmed()) {
      cancelAim();
      e.preventDefault();
      return;
    }
    if (code === 'Escape' && attackMoveArmed()) {
      toggleAttackMove(false);
      e.preventDefault();
      return;
    }
    const ability = ABILITY_KEYS.indexOf(code);
    if (ability >= 0) {
      castAbility(ability);
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => keys.delete(codeOf(e)));

  // Edge scrolling. Tracked on the window rather than the canvas so it keeps
  // working while the cursor is over a HUD panel at the screen edge.
  let pointerX = -1;
  let pointerY = -1;
  let pointerTracked = false;
  window.addEventListener('pointermove', (e) => {
    // Mouse only. A finger reports a position solely while it is pressing, and
    // that position stays on record after it lifts, so a drag that ended near
    // the edge of the screen would leave the camera scrolling off the map by
    // itself, for ever. Touch pans with the drag gesture instead.
    if (e.pointerType !== 'mouse') return;
    pointerX = e.clientX;
    pointerY = e.clientY;
    pointerTracked = true;
  });
  // Deliberately NOT clearing the pointer on pointerleave. Pushing the cursor
  // against the edge of a maximised window takes it out of the client area, so
  // treating "left the page" as "stop scrolling" kills the scroll at exactly the
  // moment the player is asking for it. The last position is kept, which keeps
  // the edge held; focus loss below is what actually stops it.
  window.addEventListener('blur', () => {
    pointerTracked = false;
    keys.clear();
  });
  window.addEventListener('focus', () => {
    // Position is stale after an alt-tab; wait for a real move before resuming.
    pointerTracked = false;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pointerTracked = false;
  });
  window.addEventListener(
    'wheel',
    (e) => {
      cam.zoomBy(Math.sign(e.deltaY));
      e.preventDefault();
    },
    { passive: false },
  );

  // Middle-drag rotate. Mouse only by construction, since a finger has no
  // middle button, but stated rather than implied: touch rotates by twisting.
  let rotating = false;
  let lastX = 0;
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button === 1) {
      rotating = true;
      lastX = e.clientX;
    }
  });
  window.addEventListener('pointerup', () => {
    rotating = false;
  });
  window.addEventListener('pointermove', (e) => {
    if (!rotating) return;
    cam.rotateBy((e.clientX - lastX) * -0.006);
    lastX = e.clientX;
  });

  let last = performance.now();
  const tick = (): void => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    let dx = 0;
    let dz = 0;
    // Arrow keys only. WASD is not available for panning: Q/W/E/R are the
    // ability bar, and a key cannot both cast a spell and move the camera.
    if (keys.has('ArrowUp')) dz -= 1;
    if (keys.has('ArrowDown')) dz += 1;
    if (keys.has('ArrowLeft')) dx -= 1;
    if (keys.has('ArrowRight')) dx += 1;

    if (cam.edgeScrollEnabled && pointerTracked && dx === 0 && dz === 0) {
      // Clamping first means a cursor that has been pushed past the window edge
      // still counts as holding that edge.
      const w = window.innerWidth;
      const h = window.innerHeight;
      const px = Math.max(0, Math.min(w, pointerX));
      const py = Math.max(0, Math.min(h, pointerY));

      // Pass 1 with the narrow margin decides which axes are engaged at all.
      const baseX = edgeAxis(px, w, EDGE_MARGIN);
      const baseY = edgeAxis(py, h, EDGE_MARGIN);

      // Pass 2 widens the perpendicular axis for whichever axis is engaged, so
      // corners become large L-shaped regions instead of a 28 px square.
      dx = edgeAxis(px, w, baseY !== 0 ? CORNER_MARGIN : EDGE_MARGIN);
      dz = edgeAxis(py, h, baseX !== 0 ? CORNER_MARGIN : EDGE_MARGIN);
    }

    // Clamp the input vector to unit length so a diagonal is not sqrt(2) times
    // faster than a straight edge. Shorter vectors pass through untouched, which
    // is what keeps the ramped edge response analog.
    const magnitude = Math.hypot(dx, dz);
    if (magnitude > 1) {
      dx /= magnitude;
      dz /= magnitude;
    }

    // pan() clears follow on its own, so any manual movement detaches the
    // camera from the hero until Space re-arms it.
    if (dx !== 0 || dz !== 0) cam.pan(dx, dz, dt);
    requestAnimationFrame(tick);
  };
  tick();
}

main().catch((err: unknown) => {
  console.error('[boot] fatal', err);
  bootLabel.textContent = 'Error de arranque — ver consola';
});
