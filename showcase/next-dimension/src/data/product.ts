/**
 * MOHAMED — THE NEXT DIMENSION
 * ------------------------------------------------------------
 * Every piece of visible copy, finish and hotspot lives here so the
 * experience can be re-written without touching any component.
 *
 * Content rules for this project:
 *  - The phone is an ORIGINAL procedural concept model inspired by the
 *    Galaxy Ultra design language. It is not an exact replica.
 *  - No prices, no official specs, no endorsements, no offers.
 *  - Finishes are visual concept finishes, not availability claims.
 */

export type Vec3 = [number, number, number];

export const brand = {
  name: 'MOHAMED',
  project: 'THE NEXT DIMENSION',
  tagline: 'BEYOND THE SCREEN.',
  statement: 'TECHNOLOGY, REIMAGINED IN ANOTHER DIMENSION.',
  product: 'Galaxy Ultra',
  productLabel: 'Inspired by the Samsung Galaxy Ultra design language',
  conceptLabel: 'Original procedural 3D concept model — not an exact product replica.',
  disclaimer: 'Independent concept experience by MOHAMED. Not affiliated with or endorsed by Samsung.',
  year: new Date().getFullYear(),
};

export const intro = {
  lineOne: 'THE FUTURE IS CLOSER THAN YOU THINK.',
  lineTwo: 'MEET THE NEXT DIMENSION.',
  cta: 'EXPLORE EXPERIENCE',
  skip: 'SKIP INTRO',
};

export const hero = {
  eyebrow: 'MOHAMED · THE NEXT DIMENSION',
  headline: ['POWER.', 'PRECISION.', 'PRESENCE.'],
  sub: 'Discover the smartphone from a different perspective.',
  primary: 'EXPLORE IN 3D',
  secondary: 'DISCOVER FEATURES',
  hint: 'DRAG TO EXPLORE · SCROLL TO DISCOVER',
};

export type NavItem = { label: string; target: string };
export const navigation: NavItem[] = [
  { label: 'EXPERIENCE', target: 'hero' },
  { label: 'DESIGN', target: 'materials' },
  { label: 'FEATURES', target: 'camera' },
  { label: 'ABOUT', target: 'creator' },
];

export type StoryChapter = {
  id: string;
  index: string;
  kicker: string;
  headline: string;
  body: string;
  note?: string;
  align: 'left' | 'right' | 'center';
  ghost: string;
};

export const story: Record<string, StoryChapter> = {
  silhouette: {
    id: 'silhouette',
    index: '01',
    kicker: 'THE SILHOUETTE',
    headline: 'ENGINEERED TO STAND APART.',
    body: 'A single beam of light traces the outline — flat, decisive edges, a calm rectangular stance and a frame that catches light the way architecture does.',
    align: 'left',
    ghost: 'FORM',
  },
  display: {
    id: 'display',
    index: '02',
    kicker: 'THE DISPLAY',
    headline: 'EVERY DETAIL HAS A DIMENSION.',
    body: 'Fluid light, depth and colour moving across a near edge-to-edge canvas. The screen becomes a window rather than a surface.',
    note: 'Visual concept demonstration rendered in real time. It does not represent measured display specifications.',
    align: 'right',
    ghost: 'LIGHT',
  },
  camera: {
    id: 'camera',
    index: '03',
    kicker: 'THE CAMERA SYSTEM',
    headline: 'SEE BEYOND THE OBVIOUS.',
    body: 'Individually ringed lenses, arranged as a vertical column. Tap the points of light to explore what each element of a multi-lens system can contribute.',
    note: 'Conceptual feature highlights. Exact sensor and zoom specifications vary by model and are intentionally not stated here.',
    align: 'left',
    ghost: 'OPTICS',
  },
  materials: {
    id: 'materials',
    index: '04',
    kicker: 'THE MATERIALS',
    headline: 'PRECISION IN EVERY MILLIMETER.',
    body: 'Brushed metal frame, softly frosted rear glass, machined lens rings. Move closer — every surface was built to be looked at.',
    align: 'right',
    ghost: 'METAL',
  },
  studio: {
    id: 'studio',
    index: '05',
    kicker: 'THE COLOR STUDIO',
    headline: 'CHOOSE YOUR LIGHT.',
    body: 'Select a finish. The object, the reflections and the studio lighting all respond — your viewing angle stays exactly where you left it.',
    note: 'Visual concept finishes. Not a statement of colour availability for any specific model.',
    align: 'left',
    ghost: 'FINISH',
  },
  reveal: {
    id: 'reveal',
    index: '06',
    kicker: 'THE FULL REVEAL',
    headline: 'TECHNOLOGY IS ONLY THE BEGINNING.',
    body: 'An independent digital product experience imagined by MOHAMED.',
    align: 'center',
    ghost: 'SPACE',
  },
};

export const materialsDetails = [
  { id: 'frame', label: 'FRAME', text: 'Satin metal side rails with polished chamfers catch a continuous line of light.' },
  { id: 'rings', label: 'LENS RINGS', text: 'Each lens sits in its own machined ring — layered, deliberate, jewellery-like.' },
  { id: 'glass', label: 'REAR GLASS', text: 'A softly frosted surface diffuses reflections into a quiet, even glow.' },
];

export type Finish = {
  id: string;
  name: string;
  /** frame metal colour */
  frame: string;
  /** rear glass colour */
  back: string;
  /** studio key light colour that complements the finish */
  key: string;
  /** rim / accent light colour */
  rim: string;
  /** frame roughness */
  roughness: number;
  swatch: string;
};

export const finishes: Finish[] = [
  {
    id: 'titanium-silver',
    name: 'Titanium Silver',
    frame: '#cfd2d7',
    back: '#c3c6cc',
    key: '#ffffff',
    rim: '#9fc8ff',
    roughness: 0.26,
    swatch: 'linear-gradient(135deg,#f3f4f6 0%,#b9bdc4 55%,#8e939b 100%)',
  },
  {
    id: 'titanium-gray',
    name: 'Titanium Gray',
    frame: '#8a8d93',
    back: '#6f7277',
    key: '#e8eef8',
    rim: '#5aa9ff',
    roughness: 0.3,
    swatch: 'linear-gradient(135deg,#a9adb3 0%,#6d7076 55%,#4a4d52 100%)',
  },
  {
    id: 'graphite-black',
    name: 'Graphite Black',
    frame: '#3a3c40',
    back: '#1d1e21',
    key: '#dfe6f2',
    rim: '#3d8bff',
    roughness: 0.34,
    swatch: 'linear-gradient(135deg,#55585e 0%,#26272a 55%,#0d0d0f 100%)',
  },
];

export type Hotspot = {
  id: string;
  label: string;
  title: string;
  body: string;
  /** position in phone-local space (units ≈ 10 cm) */
  position: Vec3;
  /** outward surface normal in phone-local space, used to hide hotspots facing away */
  normal: Vec3;
};

/* Phone dimensions shared by the model and the hotspot layout. */
export const PHONE = {
  width: 0.79,
  height: 1.62,
  depth: 0.086,
};

const FRONT = PHONE.depth / 2 + 0.01;
const BACK = -PHONE.depth / 2 - 0.03;

export const hotspots: Hotspot[] = [
  {
    id: 'display',
    label: 'Display',
    title: 'An edge-to-edge canvas',
    body: 'A flat, near-borderless front surface designed to let content dominate. The animated visuals here are a real-time concept render, not a specification.',
    position: [-0.14, 0.02, FRONT],
    normal: [0, 0, 1],
  },
  {
    id: 'frame',
    label: 'Frame',
    title: 'A sharper silhouette',
    body: 'Flat side rails and tight corners give the object a precise, architectural stance with a continuous metallic highlight.',
    position: [PHONE.width / 2 + 0.01, -0.28, 0],
    normal: [1, 0, 0],
  },
  {
    id: 'controls',
    label: 'Controls',
    title: 'Tactile controls',
    body: 'Physical keys sit flush on the side rail, finished to match the frame.',
    position: [PHONE.width / 2 + 0.01, 0.34, 0],
    normal: [1, 0, 0],
  },
  {
    id: 'camera-array',
    label: 'Camera array',
    title: 'A multi-lens system',
    body: 'Several lenses with different focal lengths can work together, so the phone can move between wide, standard and telephoto framing.',
    position: [0.225, 0.465, BACK],
    normal: [0, 0, -1],
  },
  {
    id: 'zoom',
    label: 'Zoom optics',
    title: 'Reaching further',
    body: 'Telephoto lenses on modern flagship phones combine optical and digital zoom to bring distant subjects closer. Ranges differ by model.',
    position: [0.085, 0.62, BACK],
    normal: [0, 0, -1],
  },
  {
    id: 'computational',
    label: 'Computational imaging',
    title: 'Light, processed',
    body: 'Multi-frame processing can merge several exposures into one image — balancing highlights, recovering shadows and reducing noise in low light.',
    position: [0.225, 0.31, BACK],
    normal: [0, 0, -1],
  },
];

export const creator = {
  kicker: 'THE CREATOR',
  headline: 'CREATED TO EXPLORE WHAT DIGITAL EXPERIENCES CAN BECOME.',
  body: 'MOHAMED is an experimental showcase combining 3D web development, creative direction and interactive storytelling. Everything you see is rendered live in your browser — the object, the light and the space around it.',
  pillars: [
    { title: '3D Web Development', text: 'Real-time rendering with Three.js and React Three Fiber. Procedural geometry, physical materials and adaptive quality.' },
    { title: 'Creative Direction', text: 'A restrained palette of obsidian, platinum and controlled electric blue, with editorial typography and cinematic light.' },
    { title: 'Interactive Storytelling', text: 'A scroll-driven narrative where the camera, the object and the words move as one continuous sequence.' },
  ],
};

export const finale = {
  lineOne: 'BEYOND THE SCREEN.',
  lineTwo: 'ENTER A NEW DIMENSION.',
  replay: 'REPLAY EXPERIENCE',
};
