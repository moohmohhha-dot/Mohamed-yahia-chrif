# MOHAMED — THE NEXT DIMENSION

**Beyond the screen.** An independent, immersive 3D smartphone showcase built with React, TypeScript, Vite, Three.js, React Three Fiber, Drei and GSAP ScrollTrigger.

> Independent concept experience by MOHAMED. Not affiliated with or endorsed by Samsung.
> The phone is an **original procedural concept model** inspired by the Galaxy Ultra design language — not an exact replica. No prices, official specifications, offers or endorsements are shown.

---

## Run it

Requires Node.js 18+ (tested with Node 22).

```bash
cd showcase/next-dimension
npm install
npm run dev        # http://localhost:5173
```

Production build + local preview:

```bash
npm run build      # type-checks, then outputs static files to dist/
npm run preview    # http://localhost:4173
```

Useful URL flags:

| Flag | Effect |
| --- | --- |
| `?nogl` | Forces the HTML/CSS fallback phone (simulates a device without WebGL) |
| `?debug` | Exposes `window.__nd` (scroll story position, drag state, stage values) |

## Deploy

`dist/` is a fully static site with a relative base path (`base: './'`), so it can be served from a domain root **or** any sub-folder.

- **Vercel** — import the repo, set *Root Directory* to `showcase/next-dimension`. Framework preset: Vite. Build `npm run build`, output `dist`.
- **Netlify** — base directory `showcase/next-dimension`, build command `npm run build`, publish directory `showcase/next-dimension/dist`.
- **GitHub Pages** — run `npm run build` and publish the contents of `dist/` (e.g. with the `actions/deploy-pages` workflow or by pushing `dist/` to a `gh-pages` branch).
- **Any static host / CDN** — upload the contents of `dist/`.

## The experience

| # | Chapter | What happens |
| --- | --- | --- |
| — | Opening | Spark of light, particles rushing past, camera dolly onto the phone, MOHAMED wordmark, two title lines, *Explore Experience*. Skip button + `Esc`. |
| 00 | Hero | Interactive phone: drag (mouse / touch) with inertia, pointer parallax, hotspots, finish selector, *Reset view*. |
| 01 | Silhouette | Overhead light beam, rim-lit 3/4 view. |
| 02 | Display | Camera moves to the screen; a real-time fluid-light shader demo (clearly labelled as a visual concept). |
| 03 | Camera system | Phone turns to its back; hotspots + accessible feature chips open concept explanations. |
| 04 | Materials | Sticky macro sequence: lens rings, then the side rail and keys. |
| 05 | Color Studio | Titanium Silver / Titanium Gray / Graphite Black change the live materials and the lighting; the view angle is preserved. |
| 06 | Full reveal | Camera pulls back into an architectural hall. |
| 07 | Creator | MOHAMED editorial section. |
| 08 | Finale | Darkness, one beam, wordmark, *Replay Experience*. |

## Project structure

```
showcase/next-dimension/
├── index.html                 # title, description, OG/Twitter metadata, fonts
├── public/
│   ├── favicon.svg            # MOHAMED monogram placeholder
│   └── og-image.png           # social preview (rendered from the site)
└── src/
    ├── main.tsx               # GSAP plugin registration + React root
    ├── App.tsx                # layout, scroll story hook, DOM parallax
    ├── data/product.ts        # ALL copy, finishes, hotspots, phone dimensions
    ├── components/
    │   ├── Navigation.tsx     # wordmark, links, sound toggle, mobile menu
    │   ├── IntroSequence.tsx  # cinematic opening (GSAP timeline, skippable)
    │   ├── HeroScene.tsx      # fixed 3D stage, drag input, WebGL detection, error boundary
    │   ├── HeroCopy.tsx       # hero headline, CTAs, compact finish picker, reset
    │   ├── SmartphoneModel.tsx# procedural phone: body, glass, live screen shader, lenses, keys, ports
    │   ├── FeatureHotspots.tsx# projects hotspot anchors from 3D to screen space
    │   ├── HotspotLayer.tsx   # the hotspot DOM buttons
    │   ├── HotspotPanel.tsx   # feature explanation card
    │   ├── ColorSelector.tsx  # finish radio group (keyboard arrows supported)
    │   ├── ScrollStory.tsx    # chapters A–F with ScrollTrigger typography
    │   ├── AboutMohamed.tsx   # creator section
    │   ├── FinalReveal.tsx    # finale + footer disclaimer
    │   ├── ScrollProgress.tsx # progress hairline + chapter indicator
    │   ├── MagneticButton.tsx, CustomCursor.tsx, SplitWords.tsx
    │   ├── LoadingScreen.tsx  # tiny loader while the 3D chunk downloads
    │   └── FallbackPhone.tsx  # CSS 3D phone when WebGL is unavailable
    ├── scenes/
    │   ├── ProductScene.tsx   # <Canvas>, environment, post-processing, adaptive quality
    │   ├── keyframes.ts       # camera + product choreography per chapter
    │   ├── Rigs.tsx           # CameraRig (scroll → camera) and PhoneRig (drag, inertia, reset)
    │   ├── LightingRig.tsx    # key / rim / beam / pointer-follow lights, finish-aware
    │   ├── ParticleField.tsx  # 3-layer GPU particle field
    │   └── Architecture.tsx   # hall pillars, studio floor glow, light beam
    ├── lib/                   # store (zustand), audio (Web Audio), scroll, WebGL + motion helpers
    └── styles/globals.css     # design tokens, typography, layout, responsive rules
```

## Editing content

Everything visible — headlines, body copy, notes, navigation, finishes (colours, roughness, matching light colours), hotspot positions and text — lives in **`src/data/product.ts`**. Camera angles per chapter live in **`src/scenes/keyframes.ts`**.

## Technical notes

- **No external 3D assets.** No legally usable Galaxy Ultra model was available in the project, so the device is built procedurally (extruded bevelled body, lathe-turned lens rings, iridescent lens domes, shader-driven screen). Reflections come from a procedural Lightformer environment — nothing is downloaded at runtime except Google Fonts (with system-font fallbacks).
- **Code splitting.** The page shell (~127 kB gzip) paints first; the 3D bundle (~295 kB gzip) loads lazily behind a minimal loader.
- **Adaptive quality.** Initial tier from device signals; `PerformanceMonitor` steps down DPR, particle count and post-processing (bloom/vignette/grain are desktop-high only).
- **Fallbacks.** No WebGL or a scene error → CSS 3D phone that still rotates and changes finish. The intro can always be skipped and never blocks content.
- **Accessibility.** Reduced-motion support (no dolly, no idle motion, instant text), keyboard focus styles, skip link, ARIA labels, radio-group finishes with arrow keys, hotspot buttons are real DOM buttons plus a non-3D chip alternative, `Esc` closes panels/menus/intro.
- **Sound** is synthesised with the Web Audio API (no files), off by default, and pans with the pointer.
