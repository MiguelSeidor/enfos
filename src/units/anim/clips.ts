/**
 * Procedural animation clips. Owner: CHARACTERS agent.
 *
 * Every clip is a function of time, not a baked curve set, so one authoring pass
 * covers every archetype and the timing profile does the differentiating: a
 * tank's idle breathes at 5.2 s with a wide braced stance, an assassin's at
 * 2.1 s with a twitchy weight shift. Same code, different creature.
 *
 * Rules followed throughout:
 *  - Attacks have anticipation, a fast contact frame and follow-through past the
 *    contact pose. A pose that goes straight from A to B reads as a robot.
 *  - Legs are solved with IK to planted targets whose ground speed matches the
 *    root's forward speed exactly, so nothing skates.
 *  - Secondary chains (cape, tail, orbiting shards) get a travelling phase
 *    offset so they lag the body instead of moving with it.
 */

import * as THREE from 'three';
import { Poser } from './pose';
import { B, capeBone, orbitBone, tailBone, type Side } from '../rig/rig';

export type ClipId = 'idle' | 'walk' | 'run' | 'attack' | 'cast' | 'hit' | 'death';

export const CLIP_IDS: readonly ClipId[] = ['idle', 'walk', 'run', 'attack', 'cast', 'hit', 'death'];

export type AttackStyle = 'overhead' | 'cleave' | 'thrust' | 'shoot' | 'claw' | 'slam';
export type CastStyle = 'channel' | 'hurl' | 'summon';

export interface AnimProfile {
  idlePeriod: number;
  /** Breathing amplitude. Big lungs on big creatures. */
  breath: number;
  /** Multiplier on the rest hip separation when standing. */
  stanceWidth: number;
  /** 0 = straight-legged, 1 = deeply braced. */
  crouch: number;
  /** Resting arm splay; heavy silhouettes carry their arms far off the body. */
  armSplay: number;
  walkSpeed: number;
  runSpeed: number;
  /** Ground distance covered by one step. Drives cycle rate — the anti-skate. */
  stride: number;
  /** Fraction of the cycle a foot spends planted. < 0.5 implies a flight phase. */
  stanceFraction: number;
  bob: number;
  lean: number;
  armSwing: number;
  footLift: number;
  attackDuration: number;
  attackStyle: AttackStyle;
  castDuration: number;
  castStyle: CastStyle;
  /** 0 = floaty, 1 = heavy. Scales overshoot, settle time and impact recoil. */
  weight: number;
  /** Floats rather than walks; legs are never solved. */
  hover: boolean;
  /** Which hand carries the primary weapon. */
  mainHand: Side;
  capeSegments: number;
  tailSegments: number;
  orbitCount: number;
  orbitRadius: number;
}

export const DEFAULT_PROFILE: AnimProfile = {
  idlePeriod: 3.4,
  breath: 1,
  stanceWidth: 1.15,
  crouch: 0.25,
  armSplay: 0.18,
  walkSpeed: 3.4,
  runSpeed: 6.2,
  stride: 1.15,
  stanceFraction: 0.6,
  bob: 0.055,
  lean: 0.1,
  armSwing: 0.55,
  footLift: 0.16,
  attackDuration: 1.0,
  attackStyle: 'overhead',
  castDuration: 1.6,
  castStyle: 'channel',
  weight: 0.5,
  hover: false,
  mainHand: 'R',
  capeSegments: 0,
  tailSegments: 0,
  orbitCount: 0,
  orbitRadius: 0.5,
};

export interface Clip {
  id: ClipId;
  duration: number;
  loop: boolean;
  evaluate(p: Poser, time: number, prof: AnimProfile): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Easing / tracks
// ─────────────────────────────────────────────────────────────────────────────

type Ease = 'linear' | 'smooth' | 'in' | 'out' | 'snap' | 'back';

function applyEase(t: number, ease: Ease): number {
  switch (ease) {
    case 'linear':
      return t;
    case 'in':
      return t * t * t;
    case 'out':
      return 1 - Math.pow(1 - t, 3);
    case 'snap':
      return 1 - Math.pow(1 - t, 6);
    case 'back': {
      const c = 1.9;
      return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
    }
    default:
      return t * t * (3 - 2 * t);
  }
}

type Stop = [number, number] | [number, number, Ease];

/** Piecewise eased curve. The ease belongs to the segment ending at that stop. */
function track(t: number, stops: Stop[]): number {
  const n = stops.length;
  if (n === 0) return 0;
  if (t <= stops[0]![0]) return stops[0]![1];
  for (let i = 1; i < n; i++) {
    const a = stops[i - 1]!;
    const b = stops[i]!;
    if (t <= b[0]) {
      const span = b[0] - a[0];
      const u = span <= 1e-6 ? 1 : (t - a[0]) / span;
      return a[1] + (b[1] - a[1]) * applyEase(u, (b[2] as Ease) ?? 'smooth');
    }
  }
  return stops[n - 1]![1];
}

const TAU = Math.PI * 2;

// ─────────────────────────────────────────────────────────────────────────────
// Shared pose construction
// ─────────────────────────────────────────────────────────────────────────────

const _target = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

interface Stand {
  /** Extra pelvis drop beyond the profile crouch. */
  drop: number;
  sway: number;
  roll: number;
  yaw: number;
  push: number;
}

function hipWorld(p: Poser, side: Side): { x: number; y: number } {
  const i = p.rig.index[`hip.${side}`]!;
  return { x: p.rig.restWorld[i * 3]!, y: p.rig.restWorld[i * 3 + 1]! };
}

function ankleRestY(p: Poser, side: Side): number {
  const i = p.rig.index[`ankle.${side}`];
  if (i === undefined) return 0;
  return p.rig.restWorld[i * 3 + 1]!;
}

/**
 * Places the pelvis and solves both legs to explicit ground targets. Every
 * locomotion clip funnels through here, which is why feet never slide: the
 * caller states where the foot *is*, not how the leg is bent.
 */
function solveLegs(
  p: Poser,
  prof: AnimProfile,
  st: Stand,
  footL: { x: number; y: number; z: number; pitch: number; roll: number },
  footR: { x: number; y: number; z: number; pitch: number; roll: number },
): void {
  const pelvisIdx = p.rig.index[B.pelvis]!;
  const pelvisRestY = p.rig.restWorld[pelvisIdx * 3 + 1]!;
  const drop = prof.crouch * pelvisRestY * 0.1 + st.drop;
  p.move(B.pelvis, st.sway, -drop, st.push);
  p.rot(B.pelvis, 0, st.yaw, st.roll);

  if (prof.hover || p.rig.index[B.hipL] === undefined) return;

  for (const side of ['L', 'R'] as Side[]) {
    const f = side === 'L' ? footL : footR;
    const hip = hipWorld(p, side);
    _target.set(hip.x + f.x, ankleRestY(p, side) + f.y, f.z);
    _pole.set(side === 'L' ? 0.28 : -0.28, 0, 1).normalize();
    p.ik2(`hip.${side}`, `knee.${side}`, `ankle.${side}`, _target, _pole);
    _e.set(f.pitch, 0, f.roll, 'XYZ');
    _q.setFromEuler(_e);
    p.setWorldRotation(`ankle.${side}`, _q);
  }
}

/** Neutral upper body: splayed arms, slight elbow bend, level head. */
function baseUpper(p: Poser, prof: AnimProfile): void {
  const splay = prof.armSplay;
  p.rot(B.shoulderL, -0.14, 0, -splay);
  p.rot(B.shoulderR, -0.14, 0, splay);
  p.rot(B.elbowL, -0.32, 0, -0.06);
  p.rot(B.elbowR, -0.32, 0, 0.06);
  p.rot(B.wristL, -0.1, 0, 0);
  p.rot(B.wristR, -0.1, 0, 0);
  p.rot(B.spine, 0, 0, 0);
  p.rot(B.chest, 0, 0, 0);
  p.rot(B.neck, 0, 0, 0);
  p.rot(B.head, 0, 0, 0);
}

/**
 * Cape / tail / skirt travelling wave. Each segment lags the one above it, which
 * is what sells cloth: the tip is always a quarter-cycle behind the shoulders.
 */
function secondary(p: Poser, prof: AnimProfile, time: number, energy: number, drag: number): void {
  for (let i = 0; i < prof.capeSegments; i++) {
    const lag = i * 0.55;
    const swing = Math.sin(time * 1.9 - lag) * (0.045 + 0.09 * energy) * (0.6 + i * 0.24);
    const side = Math.sin(time * 1.31 - lag * 0.8) * (0.03 + 0.06 * energy);
    p.rot(capeBone(i), 0.05 + drag * (0.16 + i * 0.05) + swing, side * 0.6, side);
  }
  for (let i = 0; i < prof.tailSegments; i++) {
    const lag = i * 0.7;
    const swing = Math.sin(time * 2.4 - lag) * (0.09 + 0.16 * energy);
    p.rot(tailBone(i), 0.07 - drag * 0.1, swing, Math.sin(time * 1.7 - lag) * 0.05);
  }
  for (let i = 0; i < prof.orbitCount; i++) {
    const a = time * (0.9 + 0.55 * energy) + (i / prof.orbitCount) * TAU;
    const r = prof.orbitRadius;
    p.setPos(orbitBone(i), Math.sin(a) * r, Math.sin(a * 1.7 + i) * r * 0.35 + r * 0.4, Math.cos(a) * r);
    p.rot(orbitBone(i), a * 1.6, a * 0.9, a * 0.4);
  }
  for (let i = 0; i < 3; i++) {
    const name = `skirt${i}`;
    if (!p.has(name)) break;
    const lag = i * 0.6;
    p.rot(
      name,
      Math.sin(time * 1.4 - lag) * (0.03 + 0.05 * energy) - drag * 0.12,
      0,
      Math.sin(time * 1.1 - lag * 1.3) * (0.03 + 0.05 * energy),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Locomotion
// ─────────────────────────────────────────────────────────────────────────────

interface FootState {
  x: number;
  y: number;
  z: number;
  pitch: number;
  roll: number;
}

/**
 * One foot's trajectory. During stance the foot travels backwards at exactly the
 * root's forward speed, so contact with the ground is real rather than implied.
 */
function footCycle(phase: number, prof: AnimProfile, stride: number, out: FootState, running: boolean): void {
  const sf = prof.stanceFraction;
  const ph = phase - Math.floor(phase);
  const half = stride * 0.5;
  if (ph < sf) {
    const s = ph / sf;
    out.z = half - stride * s;
    out.y = 0;
    // Heel strike rolls into a flat foot, then the heel lifts for toe-off.
    out.pitch = track(s, [
      [0, running ? -0.34 : -0.26, 'out'],
      [0.18, 0, 'out'],
      [0.72, 0.02],
      [1, running ? 0.62 : 0.45, 'in'],
    ]);
    out.roll = 0;
  } else {
    const s = (ph - sf) / (1 - sf);
    out.z = -half + stride * applyEase(s, 'smooth');
    out.y = prof.footLift * Math.sin(Math.PI * s) * (running ? 1.5 : 1);
    out.pitch = track(s, [
      [0, running ? 0.62 : 0.45, 'out'],
      [0.45, running ? -0.25 : -0.1],
      [1, running ? -0.34 : -0.26],
    ]);
    out.roll = 0;
  }
  out.x = 0;
}

const _footL: FootState = { x: 0, y: 0, z: 0, pitch: 0, roll: 0 };
const _footR: FootState = { x: 0, y: 0, z: 0, pitch: 0, roll: 0 };
const _stand: Stand = { drop: 0, sway: 0, roll: 0, yaw: 0, push: 0 };

function locomotion(p: Poser, time: number, prof: AnimProfile, running: boolean): void {
  const speed = running ? prof.runSpeed : prof.walkSpeed;
  const stride = prof.stride * (running ? 1.5 : 1);
  const cycle = stride / Math.max(0.4, prof.stanceFraction * speed);
  const phase = time / cycle;
  const half = prof.stanceWidth;

  footCycle(phase, prof, stride, _footL, running);
  footCycle(phase + 0.5, prof, stride, _footR, running);

  const hipL = hipWorld(p, 'L');
  const hipR = hipWorld(p, 'R');
  _footL.x = hipL.x * (half - 1);
  _footR.x = hipR.x * (half - 1);

  const bobPhase = Math.cos(phase * TAU * 2);
  const swayPhase = Math.sin(phase * TAU);
  const amp = running ? 1.85 : 1;

  _stand.drop = prof.bob * amp * (0.5 - 0.5 * bobPhase);
  _stand.sway = swayPhase * 0.028 * amp;
  _stand.roll = -swayPhase * (running ? 0.1 : 0.06);
  _stand.yaw = -swayPhase * (running ? 0.16 : 0.09);
  _stand.push = running ? 0.03 : 0;

  baseUpper(p, prof);
  solveLegs(p, prof, _stand, _footL, _footR);

  const lean = prof.lean * (running ? 2.5 : 1);
  p.rot(B.spine, -lean * 0.5, swayPhase * 0.08, -_stand.roll * 0.4);
  p.rot(B.chest, -lean * 0.5, swayPhase * (running ? 0.2 : 0.13), 0);
  p.rot(B.neck, lean * 0.5, 0, 0);
  p.rot(B.head, lean * 0.4 + bobPhase * 0.03, -swayPhase * 0.1, swayPhase * 0.05);

  const swing = prof.armSwing * (running ? 1.5 : 1);
  const bend = running ? -1.25 : -0.42;
  const splay = prof.armSplay + (running ? 0.1 : 0.02);
  p.rot(B.shoulderL, -0.1 - swing * swayPhase, 0, -splay);
  p.rot(B.shoulderR, -0.1 + swing * swayPhase, 0, splay);
  p.rot(B.elbowL, bend - Math.max(0, -swayPhase) * 0.5, 0, -0.06);
  p.rot(B.elbowR, bend - Math.max(0, swayPhase) * 0.5, 0, 0.06);

  secondary(p, prof, time, running ? 1 : 0.55, running ? 0.9 : 0.45);
}

// ─────────────────────────────────────────────────────────────────────────────
// Clips
// ─────────────────────────────────────────────────────────────────────────────

function idleClip(p: Poser, time: number, prof: AnimProfile): void {
  const t = time / prof.idlePeriod;
  const breath = Math.sin(t * TAU);
  const shift = Math.sin(t * Math.PI); // half rate: weight rocks side to side
  const settle = Math.sin(t * TAU * 2) * 0.25;

  baseUpper(p, prof);

  if (prof.hover) {
    _stand.drop = -Math.sin(t * TAU) * 0.07 - 0.02;
    _stand.sway = shift * 0.03;
    _stand.roll = shift * 0.04;
    _stand.yaw = shift * 0.06;
    _stand.push = 0;
    solveLegs(p, prof, _stand, _footL, _footR);
  } else {
    const w = prof.stanceWidth;
    const hipL = hipWorld(p, 'L');
    const hipR = hipWorld(p, 'R');
    _footL.x = hipL.x * (w - 1);
    _footL.y = 0;
    _footL.z = 0.04;
    _footL.pitch = 0;
    _footL.roll = -0.04;
    _footR.x = hipR.x * (w - 1);
    _footR.y = 0;
    _footR.z = -0.05;
    _footR.pitch = 0;
    _footR.roll = 0.04;
    _stand.drop = breath * prof.breath * 0.012 + Math.abs(shift) * 0.012;
    _stand.sway = shift * 0.035;
    _stand.roll = shift * 0.055;
    _stand.yaw = shift * 0.05;
    _stand.push = 0;
    solveLegs(p, prof, _stand, _footL, _footR);
  }

  const b = breath * prof.breath;
  p.rot(B.spine, -b * 0.03, -shift * 0.05, -shift * 0.03);
  p.rot(B.chest, -b * 0.045 + settle * 0.01, -shift * 0.07, 0);
  p.rot(B.neck, b * 0.02, shift * 0.06, 0);
  p.rot(B.head, b * 0.025 - 0.03, shift * 0.14, -shift * 0.03);

  const sway = Math.sin(t * TAU - 0.6) * prof.breath;
  p.rot(B.shoulderL, -0.14 - sway * 0.055, 0, -prof.armSplay - b * 0.03);
  p.rot(B.shoulderR, -0.14 + sway * 0.04, 0, prof.armSplay + b * 0.03);
  p.rot(B.elbowL, -0.32 - sway * 0.05, 0, -0.06);
  p.rot(B.elbowR, -0.32 + sway * 0.04, 0, 0.06);

  secondary(p, prof, time, 0.12, 0.05);
}

function attackClip(p: Poser, time: number, prof: AnimProfile): void {
  const t = Math.min(1, time / prof.attackDuration);
  const main = prof.mainHand;
  const off: Side = main === 'L' ? 'R' : 'L';
  const sign = main === 'L' ? -1 : 1;
  const w = 0.6 + prof.weight * 0.7;

  // Neutral stance first; the style below overrides what it needs.
  idleBase(p, prof, time);

  let step = 0;
  let torsoYaw = 0;
  let torsoPitch = 0;

  switch (prof.attackStyle) {
    case 'overhead':
    case 'slam': {
      const armX = track(t, [
        [0, -0.14],
        [0.3, -2.65, 'out'],
        [0.4, -2.72],
        [0.52, -0.55, 'in'],
        [0.6, -0.3, 'out'],
        [0.78, -0.45, 'back'],
        [1, -0.14],
      ]);
      torsoPitch = track(t, [
        [0, 0],
        [0.32, -0.32, 'out'],
        [0.52, 0.42, 'in'],
        [0.64, 0.5],
        [1, 0],
      ]);
      step = track(t, [
        [0, 0],
        [0.3, -0.06, 'out'],
        [0.52, 0.18, 'in'],
        [0.75, 0.14],
        [1, 0],
      ]);
      p.rot(`shoulder.${main}`, armX, sign * 0.12, sign * (prof.armSplay * 0.4));
      p.rot(`elbow.${main}`, track(t, [
        [0, -0.32],
        [0.3, -1.35, 'out'],
        [0.52, -0.12, 'in'],
        [0.72, -0.5],
        [1, -0.32],
      ]), 0, 0);
      p.rot(`shoulder.${off}`, track(t, [
        [0, -0.14],
        [0.32, -0.9, 'out'],
        [0.55, 0.25, 'in'],
        [1, -0.14],
      ]), 0, -sign * prof.armSplay);
      p.rot(`elbow.${off}`, -0.7, 0, 0);
      break;
    }
    case 'cleave': {
      torsoYaw = track(t, [
        [0, 0],
        [0.3, sign * 1.05, 'out'],
        [0.52, -sign * 1.15, 'in'],
        [0.66, -sign * 1.3, 'out'],
        [1, 0],
      ]);
      torsoPitch = track(t, [
        [0, 0],
        [0.3, -0.12],
        [0.55, 0.3, 'in'],
        [1, 0],
      ]);
      step = track(t, [
        [0, 0],
        [0.32, -0.05],
        [0.55, 0.2, 'in'],
        [1, 0],
      ]);
      p.rot(`shoulder.${main}`, track(t, [
        [0, -0.14],
        [0.3, -0.55, 'out'],
        [0.55, -1.35, 'in'],
        [0.7, -1.2],
        [1, -0.14],
      ]), sign * track(t, [[0, 0], [0.3, 0.7, 'out'], [0.55, -0.8, 'in'], [1, 0]]), sign * 0.55);
      p.rot(`elbow.${main}`, track(t, [
        [0, -0.32],
        [0.3, -1.5, 'out'],
        [0.55, -0.25, 'in'],
        [0.72, -0.6],
        [1, -0.32],
      ]), 0, 0);
      p.rot(`shoulder.${off}`, -0.5, 0, -sign * 0.5);
      p.rot(`elbow.${off}`, -1.1, 0, 0);
      break;
    }
    case 'thrust': {
      const ext = track(t, [
        [0, -0.14],
        [0.34, 0.35, 'out'],
        [0.48, -1.62, 'in'],
        [0.62, -1.5],
        [1, -0.14],
      ]);
      step = track(t, [
        [0, 0],
        [0.34, -0.1, 'out'],
        [0.48, 0.3, 'in'],
        [0.72, 0.24],
        [1, 0],
      ]);
      torsoPitch = track(t, [[0, 0], [0.34, -0.18], [0.5, 0.24, 'in'], [1, 0]]);
      torsoYaw = sign * track(t, [[0, 0], [0.34, 0.35], [0.5, -0.3, 'in'], [1, 0]]);
      p.rot(`shoulder.${main}`, ext, 0, sign * 0.14);
      p.rot(`elbow.${main}`, track(t, [
        [0, -0.32],
        [0.34, -1.9, 'out'],
        [0.5, -0.05, 'in'],
        [1, -0.32],
      ]), 0, 0);
      p.rot(`shoulder.${off}`, -0.3, 0, -sign * 0.7);
      p.rot(`elbow.${off}`, -1.4, 0, 0);
      break;
    }
    case 'shoot': {
      // Draw, settle, release, recoil. The hold is what makes it read as aiming.
      const draw = track(t, [
        [0, -0.14],
        [0.3, -1.52, 'out'],
        [0.55, -1.55],
        [0.62, -1.4, 'snap'],
        [1, -0.14],
      ]);
      p.rot(`shoulder.${off}`, draw, 0, -sign * 0.42);
      p.rot(`elbow.${off}`, -0.12, 0, 0);
      p.rot(`shoulder.${main}`, track(t, [
        [0, -0.14],
        [0.3, -1.35, 'out'],
        [0.55, -1.3],
        [0.63, -0.75, 'snap'],
        [1, -0.14],
      ]), sign * 0.5, sign * 0.75);
      p.rot(`elbow.${main}`, track(t, [
        [0, -0.32],
        [0.3, -2.1, 'out'],
        [0.55, -2.2],
        [0.63, -1.1, 'snap'],
        [1, -0.32],
      ]), 0, 0);
      torsoYaw = sign * track(t, [[0, 0], [0.3, 0.42, 'out'], [0.62, 0.34], [0.7, 0.12, 'snap'], [1, 0]]);
      torsoPitch = track(t, [[0, 0], [0.3, -0.08], [0.63, -0.05], [0.7, 0.12, 'snap'], [1, 0]]);
      step = track(t, [[0, 0], [0.3, -0.04], [0.66, -0.02], [0.74, -0.09, 'snap'], [1, 0]]);
      break;
    }
    case 'claw': {
      // Two alternating slashes inside one clip: fast, light, no wind-down.
      const slash = (u: number): number =>
        track(u, [
          [0, -0.14],
          [0.22, -1.9, 'out'],
          [0.42, 0.35, 'in'],
          [0.6, 0.15],
          [1, -0.14],
        ]);
      const a = slash(Math.min(1, t / 0.55));
      const b = slash(Math.max(0, (t - 0.45) / 0.55));
      p.rot(`shoulder.${main}`, a, sign * 0.5, sign * 0.6);
      p.rot(`elbow.${main}`, -0.9 - a * 0.4, 0, 0);
      p.rot(`shoulder.${off}`, b, -sign * 0.5, -sign * 0.6);
      p.rot(`elbow.${off}`, -0.9 - b * 0.4, 0, 0);
      torsoYaw = track(t, [[0, 0], [0.28, sign * 0.5, 'out'], [0.6, -sign * 0.5, 'in'], [1, 0]]);
      torsoPitch = track(t, [[0, 0], [0.25, -0.2], [0.45, 0.35, 'in'], [1, 0]]);
      step = track(t, [[0, 0], [0.3, 0.16, 'in'], [0.7, 0.2], [1, 0]]);
      break;
    }
  }

  p.rot(B.spine, torsoPitch * 0.45, torsoYaw * 0.35, 0);
  p.rot(B.chest, torsoPitch * 0.55, torsoYaw * 0.65, 0);
  p.rot(B.head, -torsoPitch * 0.35, torsoYaw * 0.2, 0);
  _stand.drop = Math.max(0, torsoPitch) * 0.06 * w;
  _stand.sway = 0;
  _stand.roll = 0;
  _stand.yaw = torsoYaw * 0.25;
  _stand.push = step;
  planted(p, prof, step);
  secondary(p, prof, time, 0.8, torsoPitch * 0.6 + step * 0.5);
}

function castClip(p: Poser, time: number, prof: AnimProfile): void {
  const t = Math.min(1, time / prof.castDuration);
  const main = prof.mainHand;
  const off: Side = main === 'L' ? 'R' : 'L';
  const sign = main === 'L' ? -1 : 1;

  idleBase(p, prof, time);

  const gather = track(t, [
    [0, 0],
    [0.42, 1, 'out'],
    [0.62, 1],
    [0.72, 0, 'in'],
    [1, 0],
  ]);
  const release = track(t, [
    [0, 0],
    [0.66, 0],
    [0.76, 1, 'snap'],
    [1, 0.15, 'out'],
  ]);

  if (prof.castStyle === 'channel') {
    p.rot(`shoulder.${main}`, -0.5 - gather * 1.9 + release * 0.5, sign * 0.2, sign * (0.3 + gather * 0.5));
    p.rot(`elbow.${main}`, -0.5 - gather * 0.5, 0, 0);
    p.rot(`shoulder.${off}`, -0.35 - gather * 1.5 + release * 0.4, -sign * 0.2, -sign * (0.35 + gather * 0.6));
    p.rot(`elbow.${off}`, -0.7 - gather * 0.35, 0, 0);
    p.rot(B.spine, -gather * 0.22 + release * 0.3, 0, 0);
    p.rot(B.chest, -gather * 0.26 + release * 0.34, 0, 0);
    p.rot(B.head, -gather * 0.32 + release * 0.5, 0, 0);
    _stand.drop = -gather * 0.05 + release * 0.07;
  } else if (prof.castStyle === 'hurl') {
    p.rot(`shoulder.${main}`, -0.2 + gather * 0.9 - release * 2.2, sign * (0.3 - gather * 0.5), sign * 0.3);
    p.rot(`elbow.${main}`, -0.4 - gather * 1.6 + release * 1.5, 0, 0);
    p.rot(`shoulder.${off}`, -0.4 - gather * 0.7 - release * 0.4, 0, -sign * 0.4);
    p.rot(`elbow.${off}`, -1.0 - gather * 0.5, 0, 0);
    p.rot(B.spine, gather * 0.2 - release * 0.35, sign * gather * 0.4 - sign * release * 0.7, 0);
    p.rot(B.chest, gather * 0.2 - release * 0.3, sign * gather * 0.5 - sign * release * 0.9, 0);
    _stand.drop = gather * 0.05;
  } else {
    p.rot(`shoulder.${main}`, -1.5 + gather * 0.5 + release * 1.2, sign * 0.4, sign * 0.5);
    p.rot(`elbow.${main}`, -1.5 - gather * 0.4, 0, 0);
    p.rot(`shoulder.${off}`, -1.5 + gather * 0.5 + release * 1.2, -sign * 0.4, -sign * 0.5);
    p.rot(`elbow.${off}`, -1.5 - gather * 0.4, 0, 0);
    p.rot(B.spine, -0.1 - gather * 0.1, 0, 0);
    p.rot(B.chest, -0.12 - gather * 0.12, 0, 0);
    _stand.drop = -gather * 0.03 + release * 0.05;
  }

  _stand.sway = 0;
  _stand.roll = 0;
  _stand.yaw = 0;
  _stand.push = 0;
  planted(p, prof, 0);
  secondary(p, prof, time, 0.4 + gather * 0.9 + release, gather * 0.2);
}

function hitClip(p: Poser, time: number, prof: AnimProfile): void {
  const dur = 0.42 + prof.weight * 0.22;
  const t = Math.min(1, time / dur);
  idleBase(p, prof, time);

  const recoil = track(t, [
    [0, 0],
    [0.13, 1, 'snap'],
    [0.42, -0.28, 'out'],
    [0.7, 0.08],
    [1, 0],
  ]);
  p.rot(B.spine, recoil * 0.3, recoil * 0.12, recoil * 0.1);
  p.rot(B.chest, recoil * 0.36, recoil * 0.16, recoil * 0.12);
  p.rot(B.neck, recoil * 0.22, 0, 0);
  p.rot(B.head, recoil * 0.55, -recoil * 0.2, recoil * 0.18);
  p.rot(B.shoulderL, -0.14 + recoil * 0.55, 0, -prof.armSplay - recoil * 0.35);
  p.rot(B.shoulderR, -0.14 + recoil * 0.45, 0, prof.armSplay + recoil * 0.4);
  p.rot(B.elbowL, -0.32 - recoil * 0.5, 0, 0);
  p.rot(B.elbowR, -0.32 - recoil * 0.45, 0, 0);

  _stand.drop = recoil * 0.06 * (0.5 + prof.weight);
  _stand.sway = -recoil * 0.03;
  _stand.roll = recoil * 0.06;
  _stand.yaw = recoil * 0.08;
  _stand.push = -recoil * 0.12 * (1.2 - prof.weight * 0.6);
  planted(p, prof, _stand.push);
  secondary(p, prof, time, 1.4, -recoil * 0.5);
}

function deathClip(p: Poser, time: number, prof: AnimProfile): void {
  const dur = 1.25 + prof.weight * 0.55;
  const t = Math.min(1, time / dur);
  idleBase(p, prof, time);

  const buckle = track(t, [
    [0, 0],
    [0.16, -0.45, 'snap'],
    [0.34, 0.55, 'in'],
    [0.62, 1],
    [1, 1],
  ]);
  const fall = track(t, [
    [0, 0],
    [0.36, 0, 'linear'],
    [0.78, 1, 'in'],
    [0.9, 1.06, 'out'],
    [1, 1],
  ]);

  const pelvisIdx = p.rig.index[B.pelvis]!;
  const hipY = p.rig.restWorld[pelvisIdx * 3 + 1]!;

  p.rot(B.root, -fall * Math.PI * 0.5, 0, 0);
  p.move(B.root, 0, fall * 0.05, -fall * hipY * 0.55);
  p.rot(B.spine, buckle * 0.3 - fall * 0.35, buckle * 0.12, buckle * 0.1);
  p.rot(B.chest, buckle * 0.35 - fall * 0.3, buckle * 0.18, buckle * 0.14);
  p.rot(B.neck, buckle * 0.3 - fall * 0.2, 0, 0);
  p.rot(B.head, buckle * 0.5 - fall * 0.55, -buckle * 0.25, buckle * 0.2);

  p.rot(B.shoulderL, -0.14 + buckle * 0.5 - fall * 1.1, 0, -prof.armSplay - buckle * 0.4 - fall * 0.5);
  p.rot(B.shoulderR, -0.14 + buckle * 0.4 - fall * 1.0, 0, prof.armSplay + buckle * 0.45 + fall * 0.5);
  p.rot(B.elbowL, -0.32 - buckle * 0.6 + fall * 0.3, 0, 0);
  p.rot(B.elbowR, -0.32 - buckle * 0.5 + fall * 0.25, 0, 0);

  _stand.drop = buckle * hipY * 0.42;
  _stand.sway = buckle * 0.05;
  _stand.roll = buckle * 0.1;
  _stand.yaw = buckle * 0.12;
  _stand.push = -buckle * 0.1;

  if (!prof.hover && p.rig.index[B.hipL] !== undefined) {
    const hipL = hipWorld(p, 'L');
    const hipR = hipWorld(p, 'R');
    _footL.x = hipL.x * (prof.stanceWidth - 1) - buckle * 0.12;
    _footL.y = fall * 0.05;
    _footL.z = 0.05 - buckle * 0.14;
    _footL.pitch = buckle * 0.5;
    _footL.roll = -0.05 - buckle * 0.2;
    _footR.x = hipR.x * (prof.stanceWidth - 1) + buckle * 0.1;
    _footR.y = fall * 0.03;
    _footR.z = -0.06 + buckle * 0.2;
    _footR.pitch = buckle * 0.3;
    _footR.roll = 0.05 + buckle * 0.18;
    solveLegs(p, prof, _stand, _footL, _footR);
  } else {
    solveLegs(p, prof, _stand, _footL, _footR);
  }
  secondary(p, prof, time, 0.9, buckle * 0.4 + fall * 0.6);
}

/** Neutral standing base used by the non-locomotion clips. */
function idleBase(p: Poser, prof: AnimProfile, time: number): void {
  baseUpper(p, prof);
  const b = Math.sin((time / prof.idlePeriod) * TAU) * prof.breath;
  p.rot(B.chest, -b * 0.02, 0, 0);
}

/** Re-plants both feet after a clip has moved the pelvis forward or back. */
function planted(p: Poser, prof: AnimProfile, push: number): void {
  const w = prof.stanceWidth;
  if (prof.hover || p.rig.index[B.hipL] === undefined) {
    solveLegs(p, prof, _stand, _footL, _footR);
    return;
  }
  const hipL = hipWorld(p, 'L');
  const hipR = hipWorld(p, 'R');
  const lead = prof.mainHand === 'R' ? 'L' : 'R';
  _footL.x = hipL.x * (w - 1);
  _footL.y = 0;
  _footL.z = (lead === 'L' ? 0.16 : -0.14) + Math.max(0, push) * 0.5;
  _footL.pitch = 0;
  _footL.roll = -0.04;
  _footR.x = hipR.x * (w - 1);
  _footR.y = 0;
  _footR.z = (lead === 'R' ? 0.16 : -0.14) + Math.max(0, push) * 0.5;
  _footR.pitch = 0;
  _footR.roll = 0.04;
  solveLegs(p, prof, _stand, _footL, _footR);
}

// ─────────────────────────────────────────────────────────────────────────────

export function buildClips(prof: AnimProfile): Record<ClipId, Clip> {
  const walkCycle = prof.stride / Math.max(0.4, prof.stanceFraction * prof.walkSpeed);
  const runCycle = (prof.stride * 1.5) / Math.max(0.4, prof.stanceFraction * prof.runSpeed);
  return {
    idle: {
      id: 'idle',
      duration: prof.idlePeriod * 2,
      loop: true,
      evaluate: idleClip,
    },
    walk: {
      id: 'walk',
      duration: walkCycle,
      loop: true,
      evaluate: (p, t, pr) => locomotion(p, t, pr, false),
    },
    run: {
      id: 'run',
      duration: runCycle,
      loop: true,
      evaluate: (p, t, pr) => locomotion(p, t, pr, true),
    },
    attack: { id: 'attack', duration: prof.attackDuration, loop: false, evaluate: attackClip },
    cast: { id: 'cast', duration: prof.castDuration, loop: false, evaluate: castClip },
    hit: { id: 'hit', duration: 0.42 + prof.weight * 0.22, loop: false, evaluate: hitClip },
    death: { id: 'death', duration: 1.25 + prof.weight * 0.55, loop: false, evaluate: deathClip },
  };
}
