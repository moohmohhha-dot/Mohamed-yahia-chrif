/** Returns true when the browser can create a WebGL context. `?nogl` forces the fallback for testing. */
export function hasWebGL(): boolean {
  if (typeof window === 'undefined') return false;
  if (new URLSearchParams(window.location.search).has('nogl')) return false;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return false;
    (gl as WebGLRenderingContext).getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** Rough device tier used to pick initial render quality. */
export function initialQuality(): 'high' | 'medium' | 'low' {
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency || 4;
  const small = Math.min(window.innerWidth, window.innerHeight) < 600;
  if (coarse && (small || cores <= 4)) return 'low';
  if (coarse || cores <= 4) return 'medium';
  return 'high';
}
