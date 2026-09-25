/**
 * Playback state shared by presentation. Owner: architecture.
 *
 * When a player rejoins an online match, their client replays every turn it
 * missed as fast as it can — thousands of ticks in a few seconds. The
 * simulation must run all of them, but sounds, particles, damage numbers and
 * camera shakes for events that happened minutes ago are noise at best, and at
 * that density a pool-exhausting, ear-splitting burst at worst.
 *
 * Presentation modules check `fastForward` and skip their work while it is on.
 * The simulation never reads it.
 */
export const playback = {
  fastForward: false,
};
