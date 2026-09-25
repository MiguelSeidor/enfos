/**
 * Landing page behaviour. Owner: UI.
 *
 * Deliberately tiny: this file exists so the page can reveal sections as they
 * arrive and so it can warm the game up before the player asks for it. Anything
 * heavier belongs in the game bundle, which this page never loads.
 */

/**
 * Marks the document as scripted. Every reveal rule is scoped under `.js`, so
 * a page with JavaScript blocked shows all of its content instead of a column
 * of invisible sections waiting for an observer that will never run.
 */
document.documentElement.classList.add('js');

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if (reduceMotion) {
  for (const el of document.querySelectorAll('.reveal')) el.classList.add('is-in');
} else {
  // IntersectionObserver rather than a scroll listener: the browser batches it
  // off the main thread, and a scroll handler on a page with large images is
  // exactly where jank comes from.
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        // Siblings that enter together are staggered by their position in the
        // group. Short delays only: past about 80 ms per item the cascade stops
        // reading as rhythm and starts reading as lag.
        const group = el.parentElement ? [...el.parentElement.children].filter((c) => c.classList.contains('reveal')) : [el];
        const index = Math.max(0, group.indexOf(el));
        el.style.transitionDelay = `${Math.min(index, 4) * 60}ms`;
        el.classList.add('is-in');
        observer.unobserve(el);
      }
    },
    // Fires a little before the element is fully on screen, so the movement is
    // finishing as the reader's eye arrives rather than starting then.
    { rootMargin: '0px 0px -12% 0px', threshold: 0.15 },
  );

  for (const el of document.querySelectorAll('.reveal')) observer.observe(el);
}

/**
 * Starts fetching the game the moment the player shows intent, so the click on
 * "Jugar" lands on a page that is already on its way. Pointer-down rather than
 * click: on a phone that is a couple of hundred milliseconds of head start.
 */
let warmed = false;
const warm = (): void => {
  if (warmed) return;
  warmed = true;
  const link = document.createElement('link');
  link.rel = 'prefetch';
  link.as = 'document';
  link.href = '/play/';
  document.head.appendChild(link);
};

for (const cta of document.querySelectorAll('a[href="/play/"]')) {
  cta.addEventListener('pointerenter', warm, { once: true });
  cta.addEventListener('pointerdown', warm, { once: true });
}
