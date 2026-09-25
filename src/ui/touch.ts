/**
 * Touch gesture recognition for the world view. Owner: INPUT.
 *
 * This is only the recogniser: it turns a stream of pointer events into the
 * four gestures the game understands - tap, long press, one-finger drag,
 * two-finger pinch/twist - and knows nothing about the camera, the simulation
 * or what any of them mean. What they do lives in `main.ts`, next to the mouse
 * handlers it has to agree with.
 *
 * Pointer Events, not Touch Events. A `touchmove` listener reports every point
 * on the screen in one array, so a second finger landing mid-drag silently
 * changes which entry `touches[0]` is and the camera teleports. Pointer events
 * carry an id per contact and `setPointerCapture` keeps delivering that id to
 * this element even after the finger slides off the canvas onto a HUD panel,
 * which is exactly the guarantee a drag needs.
 */

/**
 * Movement, in CSS pixels, that turns a press into a drag.
 *
 * 10 px is about half a fingertip at phone density: under it, the wobble of a
 * finger resting on glass does not cancel a tap; over it, the player has
 * visibly moved and expects the map to move with them.
 */
const DRAG_SLOP_PX = 10;

/**
 * What counts as a brisk tap, for the confirming flourish on the ring.
 *
 * Deliberately not a gate on the order itself. Any release that has not moved
 * past the slop and has not been claimed by the long press gives the order,
 * however long it took: a finger that lingers for 300 ms and lifts without
 * moving plainly meant something, and refusing it because a clock ran out is
 * how touch input earns a reputation for ignoring people.
 */
const TAP_MS = 250;

/**
 * How long a still finger must hold before the attack-move order fires.
 *
 * 450 ms is the usual platform figure and it is a compromise in both
 * directions: shorter and a slow tap arms an attack the player never asked
 * for, longer and the gesture feels broken before the ring finishes filling.
 */
const LONG_PRESS_MS = 450;

/**
 * Twist, in radians (~8 degrees), that must accumulate before the camera yaws.
 *
 * Fingers do not pinch along a perfectly stable axis - the gap between them
 * rotates by a few degrees on any real zoom - so without a gate every pinch
 * also spins the world a little, which reads as the camera being unable to
 * hold still. Past the gate the twist is applied delta by delta, so the
 * rotation stays 1:1 with the fingers once the player clearly meant it.
 */
const TWIST_GATE_RAD = 0.14;

/** Live check, because the player can change the setting while the page is open. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface WorldGestures {
  /** A finger touched the world. Feedback belongs here, not on release. */
  pressStart(x: number, y: number): void;
  /** The press ended without becoming a tap, or was taken over by another gesture. */
  pressCancel(): void;
  tap(x: number, y: number): void;
  /**
   * The finger held still long enough. Returning false declines the gesture,
   * which leaves the press alive so the eventual release still reads as a tap.
   */
  longPress(x: number, y: number): boolean;
  dragStart(x: number, y: number): void;
  dragMove(x: number, y: number): void;
  dragEnd(): void;
  /** Two fingers went down; `x`/`y` is the point between them. */
  pinchStart(x: number, y: number): void;
  /** `ratio` is the change in finger gap since the last event, `twist` in radians. */
  pinchMove(x: number, y: number, ratio: number, twist: number): void;
  pinchEnd(): void;
}

interface Contact {
  x: number;
  y: number;
  startX: number;
  startY: number;
}

/**
 * Where the gesture is:
 * - `idle`    nothing is touching the world
 * - `press`   one finger down, still undecided between tap, drag and long press
 * - `drag`    one finger past the slop, panning the camera
 * - `pinch`   two fingers, zooming/rotating/panning
 * - `spent`   the gesture is over but fingers are still down, so nothing else
 *             may start until the screen is clear again
 */
type Phase = 'idle' | 'press' | 'drag' | 'pinch' | 'spent';

export function installWorldGestures(canvas: HTMLElement, gestures: WorldGestures): void {
  // The browser's own gestures have to be off before the first touch, not
  // after: one scroll or double-tap zoom on a canvas that fills the viewport
  // and the player is looking at a page they cannot get back. `touch-action`
  // is the only one of these that cannot be done after the fact from a
  // handler, because by then the browser has already claimed the sequence.
  canvas.style.touchAction = 'none';
  canvas.style.userSelect = 'none';
  // Safari-only, and the three properties that stop a long press from selecting
  // the page, raising the callout menu, or painting a grey flash over the frame.
  canvas.style.setProperty('-webkit-user-select', 'none');
  canvas.style.setProperty('-webkit-touch-callout', 'none');
  canvas.style.setProperty('-webkit-tap-highlight-color', 'transparent');
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('selectstart', (e) => e.preventDefault());
  // Safari's pinch-zoom events, which `touch-action` does not cover on iOS.
  for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
    canvas.addEventListener(name, (e) => e.preventDefault());
  }

  const contacts = new Map<number, Contact>();
  const ring = createPressRing();
  let phase: Phase = 'idle';
  let primaryId = -1;
  let secondaryId = -1;
  let pressAt = 0;
  let pressStamp = 0;
  let longPressTimer = 0;
  let lastGap = 0;
  let lastAngle = 0;
  let twistTotal = 0;
  let twisting = false;

  /**
   * Capture keeps a finger's events coming to the canvas even after it slides
   * onto a HUD panel, which is what lets a drag start near the ability bar and
   * finish across the map. It throws when the pointer is already gone - a
   * cancelled contact, a synthetic event from the test harness - and a gesture
   * must not be taken down by a failure to ask for something it can live
   * without.
   */
  const capture = (id: number): void => {
    try {
      canvas.setPointerCapture(id);
    } catch {
      // Nothing to capture; events still arrive from the element itself.
    }
  };

  const clearLongPress = (): void => {
    if (longPressTimer) window.clearTimeout(longPressTimer);
    longPressTimer = 0;
  };

  /**
   * How long the press lasted, from the events' own timestamps.
   *
   * `performance.now()` read inside a handler measures when the browser got
   * round to running that handler, which after a frame that overran is long
   * after the finger actually lifted. A pointer event's `timeStamp` is set when
   * the input was generated, so the difference between two of them is the real
   * duration whatever the main thread was doing in between. Some automation
   * paths deliver 0 there, which is what the fallback is for.
   */
  const heldMs = (e: PointerEvent): number =>
    e.timeStamp > 0 && pressStamp > 0 ? e.timeStamp - pressStamp : performance.now() - pressAt;

  const twoFingerFrame = (): { x: number; y: number; gap: number; angle: number } | null => {
    const a = contacts.get(primaryId);
    const b = contacts.get(secondaryId);
    if (!a || !b) return null;
    return {
      x: (a.x + b.x) * 0.5,
      y: (a.y + b.y) * 0.5,
      gap: Math.hypot(b.x - a.x, b.y - a.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    };
  };

  canvas.addEventListener('pointerdown', (e) => {
    // The mouse keeps its own handlers, untouched. A pen is close enough to a
    // finger - no hover, direct manipulation - that it belongs on this path.
    if (e.pointerType === 'mouse') return;
    e.preventDefault();
    contacts.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY });

    if (phase === 'idle') {
      capture(e.pointerId);
      primaryId = e.pointerId;
      phase = 'press';
      pressAt = performance.now();
      pressStamp = e.timeStamp;
      // Feedback on the way down. Waiting for the release to acknowledge a
      // touch is the single clearest tell of a port rather than a port done
      // properly, and the ring doubles as the clock the long press runs on.
      gestures.pressStart(e.clientX, e.clientY);
      ring.show(e.clientX, e.clientY, LONG_PRESS_MS);
      longPressTimer = window.setTimeout(() => {
        longPressTimer = 0;
        const c = contacts.get(primaryId);
        if (phase !== 'press' || !c) return;
        // A declined long press leaves the phase alone, so the press stays live
        // and the eventual release still reads as a tap.
        if (!gestures.longPress(c.x, c.y)) return;
        ring.confirm();
        phase = 'spent';
      }, LONG_PRESS_MS);
      return;
    }

    if (phase === 'press' || phase === 'drag') {
      capture(e.pointerId);
      secondaryId = e.pointerId;
      clearLongPress();
      ring.hide();
      // The pinch is baselined from where the fingers are *now*, and a drag in
      // progress ends with no momentum. Both exist for the same reason: the
      // second finger must add a gesture, never move the view by the distance
      // between the two contacts.
      if (phase === 'drag') gestures.dragEnd();
      else gestures.pressCancel();
      const frame = twoFingerFrame();
      if (!frame) return;
      lastGap = frame.gap;
      lastAngle = frame.angle;
      twistTotal = 0;
      twisting = false;
      phase = 'pinch';
      gestures.pinchStart(frame.x, frame.y);
      return;
    }

    // A third finger, or a finger landing after the gesture is spent. Tracked
    // so the lift bookkeeping stays right, and otherwise ignored.
  });

  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') return;
    const contact = contacts.get(e.pointerId);
    if (!contact) return;
    contact.x = e.clientX;
    contact.y = e.clientY;

    if (phase === 'press' && e.pointerId === primaryId) {
      const moved = Math.hypot(e.clientX - contact.startX, e.clientY - contact.startY);
      if (moved < DRAG_SLOP_PX) return;
      clearLongPress();
      ring.hide();
      gestures.pressCancel();
      phase = 'drag';
      // The drag is grabbed at the point the slop was crossed, not at the point
      // the finger went down: grabbing at the origin would make the map jump
      // those 10 px the instant panning began.
      gestures.dragStart(e.clientX, e.clientY);
      return;
    }

    if (phase === 'drag' && e.pointerId === primaryId) {
      gestures.dragMove(e.clientX, e.clientY);
      return;
    }

    if (phase !== 'pinch' || (e.pointerId !== primaryId && e.pointerId !== secondaryId)) return;
    const frame = twoFingerFrame();
    if (!frame || lastGap <= 0) return;
    const ratio = frame.gap / lastGap;
    // Shortest way round, so a pinch that crosses the -pi/pi seam does not
    // register as most of a full turn.
    let twist = frame.angle - lastAngle;
    if (twist > Math.PI) twist -= Math.PI * 2;
    if (twist < -Math.PI) twist += Math.PI * 2;
    lastGap = frame.gap;
    lastAngle = frame.angle;
    twistTotal += twist;
    if (!twisting && Math.abs(twistTotal) > TWIST_GATE_RAD) twisting = true;
    gestures.pinchMove(frame.x, frame.y, ratio, twisting ? twist : 0);
  });

  const release = (e: PointerEvent, cancelled: boolean): void => {
    if (e.pointerType === 'mouse') return;
    const contact = contacts.get(e.pointerId);
    contacts.delete(e.pointerId);
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);

    if (phase === 'press' && e.pointerId === primaryId && contact) {
      clearLongPress();
      const held = heldMs(e);
      const moved = Math.hypot(contact.x - contact.startX, contact.y - contact.startY);
      // No clock in this decision, deliberately. Reaching this branch at all
      // means the phase is still `press`, which means the long press did not
      // claim the gesture - so there is nothing else this release could be and
      // a second deadline can only take the order away. It used to also require
      // `held < LONG_PRESS_MS`, and that measurement is not trustworthy: a
      // frame that overruns parks the queued pointerup behind it, the press
      // then measures however long the hitch lasted, and a perfectly ordinary
      // tap silently did nothing. Three of ten taps were lost that way on a
      // software renderer.
      const tapped = !cancelled && moved < DRAG_SLOP_PX;
      // The ring flashes for a tap inside the nominal window and merely fades
      // for a slower one, so a crisp tap and a lingering release do not look
      // like the same gesture even though both give the same order.
      if (tapped && held <= TAP_MS) ring.confirm();
      else ring.hide();
      gestures.pressCancel();
      if (tapped) gestures.tap(contact.x, contact.y);
      phase = contacts.size > 0 ? 'spent' : 'idle';
      return;
    }

    if (phase === 'drag' && e.pointerId === primaryId) {
      gestures.dragEnd();
      phase = contacts.size > 0 ? 'spent' : 'idle';
      return;
    }

    if (phase === 'pinch' && (e.pointerId === primaryId || e.pointerId === secondaryId)) {
      gestures.pinchEnd();
      // Deliberately not falling back to a one-finger drag with whichever
      // finger is left: the remaining contact is wherever it happens to be, and
      // handing it the camera is the teleport this whole state machine exists
      // to avoid. Lift everything and touch down again to pan.
      phase = contacts.size > 0 ? 'spent' : 'idle';
      return;
    }

    if (contacts.size === 0) {
      phase = 'idle';
      clearLongPress();
      ring.hide();
    }
  };

  canvas.addEventListener('pointerup', (e) => release(e, false));
  canvas.addEventListener('pointercancel', (e) => release(e, true));
}

interface PressRing {
  show(x: number, y: number, holdMs: number): void;
  confirm(): void;
  hide(): void;
}

/**
 * The ring under the finger.
 *
 * It is the acknowledgement on press-down and the clock for the long press in
 * one mark: it takes exactly `LONG_PRESS_MS` to close, so the player can see
 * the attack-move coming and lift before it fires. Built here with inline
 * styles rather than a stylesheet because it is one element with three states
 * and it must not become something the HUD has to know about.
 *
 * Transform and opacity only, and under reduced motion it appears and
 * disappears without the scale animation.
 */
function createPressRing(): PressRing {
  const el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = [
    'position:fixed',
    'left:0',
    'top:0',
    'width:64px',
    'height:64px',
    'margin:-32px 0 0 -32px',
    'border-radius:50%',
    'border:2px solid rgba(200,162,83,0.9)',
    'box-shadow:0 0 12px rgba(200,162,83,0.35)',
    'pointer-events:none',
    // Under the HUD (z-index 10) and over the canvas: a press mark must never
    // be what a finger hits instead of a button.
    'z-index:9',
    'opacity:0',
    'transform:translate3d(-100px,-100px,0) scale(0.3)',
  ].join(';');
  document.body.appendChild(el);

  let frame = 0;
  const cancelFrame = (): void => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };

  return {
    show(x, y, holdMs) {
      cancelFrame();
      const reduced = prefersReducedMotion();
      el.style.transition = 'none';
      el.style.transform = `translate3d(${x}px,${y}px,0) scale(${reduced ? 0.7 : 1.15})`;
      el.style.opacity = '0.85';
      if (reduced) return;
      // Two frames: one to land the starting transform without a transition,
      // one to start the shrink. A single frame gets coalesced and the ring
      // simply appears at its end state.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          frame = 0;
          el.style.transition = `transform ${holdMs}ms linear`;
          el.style.transform = `translate3d(${x}px,${y}px,0) scale(0.55)`;
        });
      });
    },
    confirm() {
      cancelFrame();
      const current = el.style.transform.replace(/scale\([^)]*\)/, 'scale(1.5)');
      el.style.transition = prefersReducedMotion()
        ? 'none'
        : 'transform 180ms ease-out, opacity 180ms ease-out';
      el.style.transform = current;
      el.style.opacity = '0';
    },
    hide() {
      cancelFrame();
      el.style.transition = prefersReducedMotion() ? 'none' : 'opacity 120ms ease-out';
      el.style.opacity = '0';
    },
  };
}
