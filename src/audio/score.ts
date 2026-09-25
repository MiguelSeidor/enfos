/**
 * The soundtrack, written out. Owner: Audio.
 *
 * Three original pieces in medieval idiom — modal melodies over drones, open
 * fifths on the lute, parallel fourths (organum) when the fighting starts:
 *
 * | Piece      | Mode      | Metre | Used for                                  |
 * | ---------- | --------- | ----- | ----------------------------------------- |
 * | `vigil`    | A aeolian | 3/4   | Title, hero select, and after a defeat    |
 * | `estampie` | D dorian  | 6/8   | The match: calm between waves, full in one|
 * | `marrow`   | D phrygian| 4/4   | Boss waves                                |
 *
 * Only the melodies are hand-written. The lute, drone and drums are generated
 * from one root per bar and a rhythm pattern, which keeps every part in the
 * same harmony by construction — change a root and all of them follow.
 *
 * Every event carries a *layer*. `base` always sounds; `battle` is faded in
 * while a wave is on, so the match music intensifies in place instead of
 * cutting to a different track.
 */

export type InstrumentId = 'lute' | 'recorder' | 'fiddle' | 'drone' | 'tabor' | 'bigDrum' | 'tambourine';
export type Layer = 'base' | 'battle';

export interface NoteEvent {
  /** Start, in beats from the top of the loop. */
  beat: number;
  /** Length in beats. */
  dur: number;
  inst: InstrumentId;
  /** MIDI note number; ignored by drums. */
  midi: number;
  /** 0..1. */
  vel: number;
  layer: Layer;
}

interface SectionDef {
  /** One root per bar, which the lute and drone build on. */
  roots: string[];
  /** `D5/2 E5/1 | r/3` — pitch/beats, `r` for a rest, `|` between bars. */
  melody: string;
}

interface FormStep {
  section: string;
  /** Instrument carrying the melody on loop 0, 1, 2…; rotates. */
  lead: InstrumentId[];
  /** Doubles the melody a fourth below on the fiddle — medieval organum. */
  organum?: boolean;
}

interface PatternStep {
  at: number;
  vel: number;
  /** Interval above the bar root, in semitones (lute only). */
  above?: number;
}

export interface PieceDef {
  id: string;
  bpm: number;
  /** Beats per bar. 6/8 is written as 6 beats of an eighth note. */
  meter: number;
  /** Tonic and mode; the organum uses it to stay inside the mode. */
  mode: { tonic: string; steps: number[] };
  sections: Record<string, SectionDef>;
  form: FormStep[];
  lute: { pattern: PatternStep[]; layer: Layer };
  drone: { layer: Layer; vel: number; battleVel?: number };
  drums?: {
    layer: Layer;
    tabor: PatternStep[];
    fill: PatternStep[];
    bigDrum?: PatternStep[];
    tambourine?: PatternStep[];
  };
  organumLayer: Layer;
}

const DORIAN = [0, 2, 3, 5, 7, 9, 10];
const AEOLIAN = [0, 2, 3, 5, 7, 8, 10];
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];

export const PIECES: Record<string, PieceDef> = {
  vigil: {
    id: 'vigil',
    bpm: 72,
    meter: 3,
    mode: { tonic: 'A', steps: AEOLIAN },
    sections: {
      A: {
        roots: ['A2', 'A2', 'C3', 'D3', 'C3', 'G2', 'C3', 'A2'],
        melody:
          'E5/2 D5/1 | C5/1.5 B4/.5 A4/1 | C5/1 D5/1 E5/1 | D5/3 | E5/1 G5/1 E5/1 | D5/1.5 C5/.5 B4/1 | C5/1 B4/1 G4/1 | A4/3',
      },
      B: {
        roots: ['A2', 'D3', 'C3', 'E3', 'C3', 'D3', 'G2', 'A2'],
        melody:
          'A5/2 G5/1 | F5/1 E5/1 D5/1 | E5/2 C5/1 | B4/3 | C5/1 D5/1 E5/1 | F5/1.5 E5/.5 D5/1 | C5/1 B4/1 G4/1 | A4/3',
      },
    },
    form: [
      { section: 'A', lead: ['lute', 'recorder'] },
      { section: 'B', lead: ['recorder', 'fiddle'] },
      { section: 'A', lead: ['recorder', 'fiddle'] },
      { section: 'B', lead: ['fiddle', 'lute'] },
    ],
    lute: {
      layer: 'base',
      pattern: [
        { at: 0, above: 0, vel: 0.9 },
        { at: 0.5, above: 7, vel: 0.45 },
        { at: 1, above: 12, vel: 0.5 },
        { at: 1.5, above: 19, vel: 0.38 },
        { at: 2, above: 12, vel: 0.45 },
        { at: 2.5, above: 7, vel: 0.35 },
      ],
    },
    drone: { layer: 'base', vel: 0.5 },
    organumLayer: 'battle',
  },

  estampie: {
    id: 'estampie',
    bpm: 200,
    meter: 6,
    mode: { tonic: 'D', steps: DORIAN },
    sections: {
      A: {
        roots: ['D3', 'D3', 'F3', 'C3', 'D3', 'C3', 'F3', 'D3'],
        melody:
          'D5/2 E5/1 F5/2 E5/1 | D5/2 C5/1 A4/3 | F4/1 G4/1 A4/1 C5/2 A4/1 | G4/2 F4/1 E4/3 | ' +
          'D4/2 F4/1 A4/2 D5/1 | C5/2 A4/1 G4/2 E4/1 | F4/2 G4/1 A4/1 G4/1 F4/1 | E4/2 E4/1 D4/3',
      },
      B: {
        roots: ['F3', 'D3', 'C3', 'D3', 'D3', 'C3', 'G3', 'D3'],
        melody:
          'A5/2 G5/1 F5/2 G5/1 | A5/3 D5/3 | C5/2 D5/1 E5/2 C5/1 | D5/3 A4/3 | ' +
          'F5/1 E5/1 D5/1 E5/2 F5/1 | G5/2 F5/1 E5/2 C5/1 | D5/1 C5/1 A4/1 C5/1 B4/1 G4/1 | A4/2 E4/1 D4/3',
      },
      C: {
        roots: ['D3', 'C3', 'D3', 'A2'],
        melody: 'r/6 | r/6 | r/6 | r/3 A4/1 C5/1 E5/1',
      },
    },
    form: [
      { section: 'C', lead: ['lute'] },
      { section: 'A', lead: ['recorder', 'fiddle', 'lute'] },
      { section: 'B', lead: ['recorder', 'recorder', 'fiddle'], organum: true },
      { section: 'A', lead: ['fiddle', 'recorder', 'recorder'], organum: true },
    ],
    lute: {
      layer: 'base',
      pattern: [
        { at: 0, above: 0, vel: 1 },
        { at: 1, above: 7, vel: 0.5 },
        { at: 2, above: 12, vel: 0.55 },
        { at: 3, above: 7, vel: 0.8 },
        { at: 4, above: 12, vel: 0.5 },
        { at: 5, above: 7, vel: 0.45 },
      ],
    },
    drone: { layer: 'base', vel: 0.35, battleVel: 0.6 },
    drums: {
      layer: 'battle',
      tabor: [
        { at: 0, vel: 1 },
        { at: 2, vel: 0.35 },
        { at: 3, vel: 0.7 },
        { at: 5, vel: 0.4 },
      ],
      fill: [
        { at: 0, vel: 1 },
        { at: 2, vel: 0.45 },
        { at: 3, vel: 0.8 },
        { at: 4, vel: 0.6 },
        { at: 5, vel: 0.85 },
      ],
      tambourine: [
        { at: 1, vel: 0.35 },
        { at: 4, vel: 0.5 },
      ],
    },
    organumLayer: 'battle',
  },

  marrow: {
    id: 'marrow',
    bpm: 132,
    meter: 4,
    mode: { tonic: 'D', steps: PHRYGIAN },
    sections: {
      A: {
        roots: ['D2', 'D2', 'A#1', 'D2', 'D#2', 'D#2', 'C2', 'D2'],
        melody:
          'D4/1 Eb4/1 D4/1 C4/1 | D4/2 r/1 A3/1 | Bb3/1 C4/1 D4/1 Eb4/1 | F4/1 Eb4/1 D4/2 | ' +
          'G4/1 F4/1 Eb4/1 F4/1 | G4/2 A4/1 G4/1 | F4/1 Eb4/1 D4/1 C4/1 | D4/4',
      },
      B: {
        roots: ['D2', 'C2', 'F2', 'C2', 'D2', 'D#2', 'C2', 'D2'],
        melody:
          'A4/2 Bb4/1 A4/1 | G4/1 F4/1 G4/2 | A4/1 C5/1 Bb4/1 A4/1 | G4/3 r/1 | ' +
          'F4/1 G4/1 A4/1 F4/1 | Eb4/2 D4/1 Eb4/1 | F4/1 Eb4/1 D4/1 C4/1 | D4/2 D3/2',
      },
    },
    form: [
      { section: 'A', lead: ['fiddle'], organum: true },
      { section: 'B', lead: ['fiddle'], organum: true },
      { section: 'A', lead: ['recorder', 'fiddle'], organum: true },
      { section: 'B', lead: ['fiddle'], organum: true },
    ],
    lute: {
      layer: 'base',
      pattern: [
        { at: 0, above: 0, vel: 1 },
        { at: 0.5, above: 0, vel: 0.45 },
        { at: 1, above: 7, vel: 0.6 },
        { at: 1.5, above: 0, vel: 0.5 },
        { at: 2, above: 0, vel: 0.9 },
        { at: 2.5, above: 0, vel: 0.45 },
        { at: 3, above: 7, vel: 0.7 },
        { at: 3.5, above: 12, vel: 0.5 },
      ],
    },
    drone: { layer: 'base', vel: 0.7 },
    drums: {
      layer: 'base',
      tabor: [
        { at: 0, vel: 1 },
        { at: 0.5, vel: 0.3 },
        { at: 1, vel: 0.5 },
        { at: 1.5, vel: 0.6 },
        { at: 2, vel: 0.9 },
        { at: 2.5, vel: 0.3 },
        { at: 3, vel: 0.6 },
        { at: 3.5, vel: 0.5 },
      ],
      fill: [0, 0.5, 1, 1.5, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75].map((at, i) => ({ at, vel: 0.45 + i * 0.045 })),
      bigDrum: [
        { at: 0, vel: 1 },
        { at: 2, vel: 0.75 },
      ],
    },
    organumLayer: 'base',
  },
};

// ── Compilation ──────────────────────────────────────────────────────────────

const PITCH_CLASS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** `Eb4`, `C#5`, `A2` → MIDI number. */
export function midiOf(name: string): number {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`Bad note name: ${name}`);
  const accidental = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return 12 * (Number(m[3]) + 1) + PITCH_CLASS[m[1]!]! + accidental;
}

export function frequencyOf(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

interface Parsed {
  beat: number;
  dur: number;
  midi: number | null;
}

/** Parses a melody line and checks every bar adds up to the metre. */
function parseMelody(text: string, meter: number, where: string): Parsed[] {
  const out: Parsed[] = [];
  let beat = 0;
  let bar = 0;
  let barStart = 0;
  const closeBar = (): void => {
    const length = beat - barStart;
    // A wrong bar length silently shifts every later note off the beat, which
    // sounds like a timing bug rather than a typo; catch it where it is made.
    if (Math.abs(length - meter) > 1e-6) {
      console.warn(`[score] ${where} bar ${bar + 1} is ${length} beats, expected ${meter}`);
    }
    bar++;
    barStart = beat;
  };
  for (const token of text.trim().split(/\s+/)) {
    if (token === '|') {
      closeBar();
      continue;
    }
    const [pitch, length] = token.split('/');
    const dur = Number(length);
    out.push({ beat, dur, midi: pitch === 'r' ? null : midiOf(pitch!) });
    beat += dur;
  }
  closeBar();
  return out;
}

/** A pitch moved down a fourth, or a fifth where the fourth would leave the mode. */
function organumBelow(midi: number, mode: PieceDef['mode']): number {
  const tonic = PITCH_CLASS[mode.tonic]!;
  const inMode = (m: number): boolean => mode.steps.includes((((m - tonic) % 12) + 12) % 12);
  if (inMode(midi - 5)) return midi - 5;
  return midi - 7;
}

/**
 * Every note of one pass through the piece. `loop` picks the lead instruments,
 * so consecutive passes are orchestrated differently.
 */
export function compileLoop(piece: PieceDef, loop: number): { events: NoteEvent[]; beats: number } {
  const events: NoteEvent[] = [];
  let offset = 0;

  for (const step of piece.form) {
    const section = piece.sections[step.section]!;
    const lead = step.lead[loop % step.lead.length]!;
    const bars = section.roots.length;
    const sectionBeats = bars * piece.meter;

    for (const note of parseMelody(section.melody, piece.meter, `${piece.id}.${step.section}`)) {
      if (note.midi === null) continue;
      events.push({ beat: offset + note.beat, dur: note.dur, inst: lead, midi: note.midi, vel: 0.85, layer: 'base' });
      if (step.organum && lead !== 'lute') {
        events.push({
          beat: offset + note.beat,
          dur: note.dur,
          inst: 'fiddle',
          midi: organumBelow(note.midi, piece.mode) - (lead === 'fiddle' ? 0 : 12),
          vel: 0.55,
          layer: piece.organumLayer,
        });
      }
    }

    section.roots.forEach((root, bar) => {
      const rootMidi = midiOf(root);
      const barBeat = offset + bar * piece.meter;
      for (const p of piece.lute.pattern) {
        events.push({
          beat: barBeat + p.at,
          dur: 1,
          inst: 'lute',
          midi: rootMidi + (p.above ?? 0),
          vel: p.vel * 0.7,
          layer: piece.lute.layer,
        });
      }
      const drums = piece.drums;
      if (drums) {
        const last = bar === bars - 1;
        for (const p of last ? drums.fill : drums.tabor) {
          events.push({ beat: barBeat + p.at, dur: 0.25, inst: 'tabor', midi: 0, vel: p.vel, layer: drums.layer });
        }
        for (const p of drums.bigDrum ?? []) {
          events.push({ beat: barBeat + p.at, dur: 1, inst: 'bigDrum', midi: 0, vel: p.vel, layer: drums.layer });
        }
        for (const p of drums.tambourine ?? []) {
          events.push({ beat: barBeat + p.at, dur: 0.25, inst: 'tambourine', midi: 0, vel: p.vel, layer: drums.layer });
        }
      }
    });

    // One held drone per section on the mode's tonic, the way a hurdy-gurdy
    // or bagpipe drone never follows the harmony.
    const tonic = midiOf(`${piece.mode.tonic}2`) + (piece.mode.tonic === 'A' ? 0 : 12);
    events.push({ beat: offset, dur: sectionBeats, inst: 'drone', midi: tonic, vel: piece.drone.vel, layer: piece.drone.layer });
    if (piece.drone.battleVel !== undefined) {
      events.push({
        beat: offset,
        dur: sectionBeats,
        inst: 'drone',
        midi: tonic,
        vel: piece.drone.battleVel - piece.drone.vel,
        layer: 'battle',
      });
    }

    offset += sectionBeats;
  }

  events.sort((a, b) => a.beat - b.beat);
  return { events, beats: offset };
}
