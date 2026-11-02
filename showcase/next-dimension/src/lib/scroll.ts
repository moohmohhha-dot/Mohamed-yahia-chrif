/**
 * Scrolls so the section's 3D keyframe marker sits at the viewport centre,
 * which is exactly where the scene reaches that chapter's authored pose.
 */
export function scrollToSection(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const marker = el.hasAttribute('data-kf') ? el : el.querySelector<HTMLElement>('[data-kf]');
  const ref = marker ?? el;
  const r = ref.getBoundingClientRect();
  const markerCentre = window.scrollY + r.top + r.height / 2;
  const top = id === 'hero' ? 0 : Math.max(0, markerCentre - window.innerHeight / 2);
  window.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' });
  // move focus for keyboard / screen reader users without re-scrolling
  const focusTarget = el.querySelector<HTMLElement>('h1, h2') ?? el;
  if (!focusTarget.hasAttribute('tabindex')) focusTarget.setAttribute('tabindex', '-1');
  focusTarget.focus({ preventScroll: true });
}
