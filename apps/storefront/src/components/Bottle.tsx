/**
 * Product picture. Real photos are used when a merchant uploads them; until then each perfume gets a
 * drawn bottle: its colour and shape come from the product (always the same for the same perfume), so
 * the catalogue never shows an empty frame or a stock photo of another brand.
 */
export function hueOf(seed: string) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

const SHAPES = [
  // square flacon
  'M62 92 h76 a10 10 0 0 1 10 10 v104 a14 14 0 0 1 -14 14 h-68 a14 14 0 0 1 -14 -14 v-104 a10 10 0 0 1 10 -10 z',
  // rounded flask
  'M100 88 c34 0 56 26 56 62 c0 40 -24 70 -56 70 c-32 0 -56 -30 -56 -70 c0 -36 22 -62 56 -62 z',
  // tall slim
  'M76 84 h48 a8 8 0 0 1 8 8 v118 a10 10 0 0 1 -10 10 h-44 a10 10 0 0 1 -10 -10 v-118 a8 8 0 0 1 8 -8 z',
  // faceted
  'M70 90 h60 l22 24 v84 l-22 22 h-60 l-22 -22 v-84 z',
];
const CAPS = ['M84 50 h32 v38 h-32 z', 'M80 56 h40 a6 6 0 0 1 6 6 v26 h-52 v-26 a6 6 0 0 1 6 -6 z', 'M88 40 h24 v48 h-24 z', 'M78 60 l22 -22 l22 22 v28 h-44 z'];

export function Bottle({ seed, label, hue, size = 'md' }: { seed: string; label?: string | null; hue?: number; size?: 'sm' | 'md' | 'lg' }) {
  const h = hue ?? hueOf(seed);
  const shape = hueOf(`${seed}#shape`) % SHAPES.length;
  const id = `b${seed.replace(/[^a-z0-9]/gi, '')}`;
  const initials = (label ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return (
    <svg className={`bottle bottle-${size}`} viewBox="0 0 200 240" role="img" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-l`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={`hsl(${h} 62% 72%)`} />
          <stop offset="1" stopColor={`hsl(${(h + 24) % 360} 58% 42%)`} />
        </linearGradient>
        <linearGradient id={`${id}-g`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity=".55" />
          <stop offset=".35" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={`${id}-c`}>
          <path d={SHAPES[shape]} />
        </clipPath>
      </defs>
      <rect width="200" height="240" fill="var(--tile)" />
      <circle cx="100" cy="150" r="88" fill={`hsl(${h} 45% 60%)`} opacity=".12" />
      <ellipse cx="100" cy="224" rx="58" ry="6" fill="var(--shadow)" />
      <path d={CAPS[shape]} fill="var(--cap)" />
      <rect x="86" y="84" width="28" height="10" rx="2" fill="var(--cap)" opacity=".85" />
      <path d={SHAPES[shape]} fill={`url(#${id}-l)`} />
      <g clipPath={`url(#${id}-c)`}>
        <rect x="0" y="0" width="200" height="118" fill="#fff" opacity=".18" />
        <rect x="40" y="80" width="120" height="150" fill={`url(#${id}-g)`} />
      </g>
      {initials && (
        <g>
          <rect x="74" y="146" width="52" height="30" rx="3" fill="#fff" opacity=".86" />
          <text x="100" y="167" textAnchor="middle" fontSize="15" fontFamily="'Reem Kufi', serif" letterSpacing="2" fill={`hsl(${h} 40% 25%)`}>
            {initials}
          </text>
        </g>
      )}
    </svg>
  );
}
