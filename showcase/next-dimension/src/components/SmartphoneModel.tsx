import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import * as THREE from 'three';
import { PHONE, brand, finishes } from '../data/product';
import { useUI } from '../lib/store';
import { frame } from '../scenes/keyframes';

/**
 * ORIGINAL PROCEDURAL CONCEPT MODEL
 * Built entirely from Three.js geometry — no downloaded meshes.
 * Proportions follow a large, flat, sharp-cornered flagship phone;
 * it is inspired by, not an exact replica of, any shipping product.
 */

const { width: W, height: H, depth: D } = PHONE;
const BEVEL = 0.02;
const CORNER = 0.075;

function roundedRectShape(w: number, h: number, r: number) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** ShapeGeometry with UVs normalised to 0..1 across the bounding box */
function roundedPlane(w: number, h: number, r: number) {
  const g = new THREE.ShapeGeometry(roundedRectShape(w, h, r), 12);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) / w + 0.5;
    uv[i * 2 + 1] = pos.getY(i) / h + 0.5;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/* ---------------------------------- screen ---------------------------------- */

const screenVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const screenFragment = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uBright;
  uniform float uDemo;
  uniform vec2 uSize;
  uniform float uRadius;
  uniform sampler2D uText;
  uniform vec3 uAccent;

  float sdRoundBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0; float a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; }
    return v;
  }

  void main() {
    vec2 p = (vUv - 0.5) * uSize;
    float d = sdRoundBox(p, uSize * 0.5, uRadius);
    if (d > 0.0) discard;

    vec2 q = vec2(vUv.x * uSize.x / uSize.y, vUv.y) * 2.2;
    float t = uTime * 0.06;

    // lock screen — a quiet, deep aurora
    float n = fbm(q * 1.2 + vec2(t, -t * 0.6));
    vec3 deep = mix(vec3(0.004, 0.008, 0.02), vec3(0.02, 0.05, 0.12), vUv.y);
    vec3 lock = deep + uAccent * pow(n, 3.0) * 0.55 + vec3(0.6, 0.7, 0.85) * pow(n, 7.0) * 0.6;

    // display demo — domain-warped liquid light
    float t2 = uTime * 0.18;
    vec2 w = q + vec2(fbm(q + t2), fbm(q - t2 + 3.1)) * 1.6;
    float f = fbm(w * 1.3 + t2 * 0.5);
    vec3 c1 = vec3(0.01, 0.03, 0.12);
    vec3 c2 = vec3(0.10, 0.34, 0.85);
    vec3 c3 = vec3(0.80, 0.86, 0.96);
    vec3 c4 = vec3(0.26, 0.08, 0.46);
    vec3 demo = mix(c1, c2, smoothstep(0.25, 0.7, f));
    demo = mix(demo, c4, smoothstep(0.55, 0.9, fbm(w * 0.7 - t2)) * 0.6);
    demo = mix(demo, c3, smoothstep(0.72, 0.95, f));
    // fine specular ribbons travelling through the liquid
    float ribbon = smoothstep(0.015, 0.0, abs(fract(f * 6.0 - t2 * 0.6) - 0.5) - 0.47);
    demo += ribbon * vec3(0.5, 0.65, 0.9) * 0.25 * smoothstep(0.4, 0.8, f);

    vec3 col = mix(lock, demo, uDemo);

    // overlay lock-screen typography (fades out in demo mode)
    vec4 txt = texture2D(uText, vUv);
    col = mix(col, vec3(0.92, 0.94, 0.97), txt.a * (1.0 - uDemo));

    // front camera cut-out
    float hole = length(p - vec2(0.0, uSize.y * 0.5 - 0.042)) - 0.0115;
    col *= smoothstep(0.0, 0.002, hole);

    // soft edge vignette
    col *= 0.82 + 0.18 * smoothstep(0.0, -0.06, d);
    gl_FragColor = vec4(col * uBright, 1.0);
  }
`;

function useLockScreenTexture() {
  const { canvas, texture } = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 1100;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return { canvas, texture };
  }, []);

  useEffect(() => {
    const draw = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const now = new Date();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.font = '400 20px Michroma, "Inter", sans-serif';
      (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '8px';
      ctx.fillText(brand.name, 256, 170);
      (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0px';
      ctx.font = '200 128px "Inter Tight", "Inter", sans-serif';
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      ctx.fillText(`${hh}:${mm}`, 256, 330);
      ctx.font = '400 22px "Inter", sans-serif';
      ctx.globalAlpha = 0.7;
      ctx.fillText(now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }), 256, 380);
      ctx.globalAlpha = 0.55;
      ctx.font = '400 15px Michroma, "Inter", sans-serif';
      (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '5px';
      ctx.fillText('BEYOND THE SCREEN', 256, 1000);
      ctx.globalAlpha = 1;
      texture.needsUpdate = true;
    };
    draw();
    document.fonts?.ready.then(draw).catch(() => undefined);
    const id = window.setInterval(draw, 20_000);
    return () => window.clearInterval(id);
  }, [canvas, texture]);

  useEffect(() => () => texture.dispose(), [texture]);
  return texture;
}

function useBackMarkTexture() {
  return useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const texture = new THREE.CanvasTexture(canvas);
    const draw = () => {
      if (!ctx) return;
      ctx.clearRect(0, 0, 512, 128);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.font = '400 34px Michroma, "Inter", sans-serif';
      (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '14px';
      ctx.fillText(brand.name, 256, 60);
      ctx.font = '400 13px "Inter", sans-serif';
      (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '6px';
      ctx.fillText('CONCEPT · NEXT DIMENSION', 256, 104);
      texture.needsUpdate = true;
    };
    draw();
    document.fonts?.ready.then(draw).catch(() => undefined);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }, []);
}

/* ---------------------------------- lenses ---------------------------------- */

type LensProps = {
  position: [number, number, number];
  radius: number;
  ringMat: THREE.Material;
  glassMat: THREE.Material;
  baseMat: THREE.Material;
  trimMat: THREE.Material;
};

function Lens({ position, radius, ringMat, glassMat, baseMat, trimMat }: LensProps) {
  const ringGeo = useMemo(() => {
    const r0 = radius * 0.77;
    const r1 = radius;
    const h = 0.014;
    const pts = [
      new THREE.Vector2(r0, -0.002),
      new THREE.Vector2(r0, h * 0.8),
      new THREE.Vector2(r0 + 0.003, h),
      new THREE.Vector2(r1 - 0.002, h),
      new THREE.Vector2(r1, h * 0.82),
      new THREE.Vector2(r1, -0.002),
    ];
    const g = new THREE.LatheGeometry(pts, 56);
    g.rotateX(Math.PI / 2);
    return g;
  }, [radius]);

  const domeGeo = useMemo(() => {
    const base = radius * 0.55;
    const R = radius * 0.95;
    const theta = Math.asin(base / R);
    const g = new THREE.SphereGeometry(R, 40, 12, 0, Math.PI * 2, 0, theta);
    g.rotateX(Math.PI / 2);
    g.translate(0, 0, 0.011 - R);
    return g;
  }, [radius]);

  return (
    // lenses are authored facing +z, then flipped to face the rear (-z)
    <group position={position} rotation={[0, Math.PI, 0]}>
      <mesh geometry={ringGeo} material={ringMat} />
      <mesh position={[0, 0, 0.003]} material={baseMat}>
        <circleGeometry args={[radius * 0.78, 48]} />
      </mesh>
      <mesh position={[0, 0, 0.0045]} material={trimMat}>
        <torusGeometry args={[radius * 0.6, 0.0016, 8, 48]} />
      </mesh>
      <mesh geometry={domeGeo} material={glassMat} />
      <mesh position={[0, 0, 0.0115]} material={trimMat}>
        <torusGeometry args={[radius * 0.24, 0.0009, 6, 32]} />
      </mesh>
    </group>
  );
}

/* ---------------------------------- model ---------------------------------- */

export default function SmartphoneModel() {
  const finishId = useUI((s) => s.finishId);
  const target = useMemo(() => finishes.find((f) => f.id === finishId) ?? finishes[0], [finishId]);
  const screenTex = useLockScreenTexture();
  const backMark = useBackMarkTexture();

  const mats = useMemo(() => {
    const f = finishes[0];
    const frameMat = new THREE.MeshPhysicalMaterial({
      color: f.frame, metalness: 1, roughness: f.roughness, clearcoat: 0.4, clearcoatRoughness: 0.25, envMapIntensity: 1.35,
    });
    const backMat = new THREE.MeshPhysicalMaterial({
      color: f.back, metalness: 0.25, roughness: 0.42, clearcoat: 0.55, clearcoatRoughness: 0.38, envMapIntensity: 1.1,
    });
    const bezelMat = new THREE.MeshPhysicalMaterial({ color: '#020203', roughness: 0.12, metalness: 0, clearcoat: 1 });
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: '#000000', roughness: 0.05, metalness: 0, ior: 1.8, specularIntensity: 1, clearcoat: 1,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, envMapIntensity: 1.6,
    });
    const lensGlass = new THREE.MeshPhysicalMaterial({
      color: '#040508', roughness: 0.03, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.02,
      iridescence: 1, iridescenceIOR: 1.55, envMapIntensity: 2.4,
    });
    lensGlass.iridescenceThicknessRange = [180, 620];
    const lensBase = new THREE.MeshStandardMaterial({ color: '#030304', roughness: 0.35, metalness: 0.6 });
    const trim = new THREE.MeshStandardMaterial({ color: '#2a2d33', roughness: 0.25, metalness: 1 });
    const dark = new THREE.MeshStandardMaterial({ color: '#0b0b0d', roughness: 0.6, metalness: 0.3 });
    const flash = new THREE.MeshPhysicalMaterial({
      color: '#f4ead2', roughness: 0.3, transmission: 0, emissive: '#3a3528', emissiveIntensity: 0.4,
    });
    const screen = new THREE.ShaderMaterial({
      vertexShader: screenVertex,
      fragmentShader: screenFragment,
      uniforms: {
        uTime: { value: 0 },
        uBright: { value: 1 },
        uDemo: { value: 0 },
        uSize: { value: new THREE.Vector2(W - 2 * BEVEL - 0.024, H - 2 * BEVEL - 0.024) },
        uRadius: { value: CORNER - 0.03 },
        uText: { value: screenTex },
        uAccent: { value: new THREE.Color('#2d6cff') },
      },
      toneMapped: false,
    });
    const mark = new THREE.MeshBasicMaterial({ map: backMark, transparent: true, opacity: 0.32, depthWrite: false, color: '#ffffff' });
    return { frameMat, backMat, bezelMat, glassMat, lensGlass, lensBase, trim, dark, flash, screen, mark };
  }, [screenTex, backMark]);

  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);

  const geos = useMemo(() => {
    const shape = roundedRectShape(W - 2 * BEVEL, H - 2 * BEVEL, CORNER - BEVEL);
    const body = new THREE.ExtrudeGeometry(shape, {
      depth: D - 2 * BEVEL,
      bevelEnabled: true,
      bevelThickness: BEVEL,
      bevelSize: BEVEL,
      bevelSegments: 6,
      curveSegments: 14,
    });
    body.translate(0, 0, -(D - 2 * BEVEL) / 2);
    body.computeVertexNormals();
    const faceW = W - 2 * BEVEL;
    const faceH = H - 2 * BEVEL;
    return {
      body,
      bezel: roundedPlane(faceW - 0.003, faceH - 0.003, CORNER - BEVEL - 0.002),
      screen: new THREE.PlaneGeometry(faceW - 0.024, faceH - 0.024),
      glass: roundedPlane(faceW - 0.002, faceH - 0.002, CORNER - BEVEL - 0.001),
      back: roundedPlane(faceW - 0.003, faceH - 0.003, CORNER - BEVEL - 0.002),
    };
  }, []);

  useEffect(() => () => Object.values(geos).forEach((g) => g.dispose()), [geos]);

  // colour targets reused every frame
  const targets = useMemo(
    () => ({ frame: new THREE.Color(), back: new THREE.Color(), mark: new THREE.Color() }),
    [],
  );
  useEffect(() => {
    targets.frame.set(target.frame);
    targets.back.set(target.back);
    targets.mark.set(target.id === 'titanium-silver' ? '#4a4d52' : '#e6e8ec');
  }, [target, targets]);

  const time = useRef(0);
  useFrame((_, dt) => {
    const k = 1 - Math.exp(-dt * 3.2);
    mats.frameMat.color.lerp(targets.frame, k);
    mats.backMat.color.lerp(targets.back, k);
    mats.mark.color.lerp(targets.mark, k);
    mats.frameMat.roughness += (target.roughness - mats.frameMat.roughness) * k;

    time.current += dt;
    const u = mats.screen.uniforms;
    u.uTime.value = time.current;
    u.uBright.value += (frame.screen - u.uBright.value) * (1 - Math.exp(-dt * 4));
    u.uDemo.value += (frame.demo - u.uDemo.value) * (1 - Math.exp(-dt * 3));
  });

  const front = D / 2;
  const back = -D / 2;
  const lensX = W / 2 - 0.17;
  const lensX2 = lensX - 0.14;
  const big = 0.068;

  return (
    <group>
      {/* metal frame / body */}
      <mesh geometry={geos.body} material={mats.frameMat} />

      {/* front: bezel, live screen, cover glass */}
      <mesh geometry={geos.bezel} material={mats.bezelMat} position={[0, 0, front + 0.0004]} />
      <mesh geometry={geos.screen} material={mats.screen} position={[0, 0, front + 0.0009]} />
      <mesh geometry={geos.glass} material={mats.glassMat} position={[0, 0, front + 0.0016]} renderOrder={2} />

      {/* rear glass */}
      <mesh geometry={geos.back} material={mats.backMat} position={[0, 0, back - 0.0004]} rotation={[0, Math.PI, 0]} />
      <mesh position={[0, -0.42, back - 0.0012]} rotation={[0, Math.PI, 0]} material={mats.mark}>
        <planeGeometry args={[0.36, 0.09]} />
      </mesh>

      {/* camera system — individually ringed lenses */}
      {[0.62, 0.465, 0.31].map((y) => (
        <Lens
          key={y}
          position={[lensX, y, back - 0.0006]}
          radius={big}
          ringMat={mats.frameMat}
          glassMat={mats.lensGlass}
          baseMat={mats.lensBase}
          trimMat={mats.trim}
        />
      ))}
      <Lens
        position={[lensX2, 0.62, back - 0.0006]}
        radius={0.052}
        ringMat={mats.frameMat}
        glassMat={mats.lensGlass}
        baseMat={mats.lensBase}
        trimMat={mats.trim}
      />
      {/* sensor + flash */}
      <mesh position={[lensX2, 0.5, back - 0.0012]} rotation={[0, Math.PI, 0]} material={mats.lensBase}>
        <circleGeometry args={[0.017, 32]} />
      </mesh>
      <mesh position={[lensX2, 0.435, back - 0.0012]} rotation={[0, Math.PI, 0]} material={mats.flash}>
        <circleGeometry args={[0.02, 32]} />
      </mesh>

      {/* side keys (right rail) */}
      <RoundedBox args={[0.012, 0.16, 0.026]} radius={0.005} smoothness={3} position={[W / 2 + 0.002, 0.45, 0]} material={mats.frameMat} />
      <RoundedBox args={[0.012, 0.08, 0.026]} radius={0.005} smoothness={3} position={[W / 2 + 0.002, 0.24, 0]} material={mats.frameMat} />

      {/* antenna breaks */}
      {[
        [W / 2 + 0.0005, 0.68],
        [W / 2 + 0.0005, -0.66],
        [-W / 2 - 0.0005, 0.62],
        [-W / 2 - 0.0005, -0.7],
      ].map(([x, y]) => (
        <mesh key={`${x}${y}`} position={[x, y, 0]} material={mats.dark}>
          <boxGeometry args={[0.003, 0.008, D * 0.62]} />
        </mesh>
      ))}

      {/* bottom: port + speaker grille */}
      <RoundedBox args={[0.085, 0.012, 0.028]} radius={0.005} smoothness={2} position={[0, -H / 2 + 0.003, 0]} material={mats.dark} />
      {[0.1, 0.125, 0.15, 0.175, 0.2, 0.225].map((x) => (
        <mesh key={x} position={[x, -H / 2 + 0.002, 0]} rotation={[Math.PI / 2, 0, 0]} material={mats.dark}>
          <cylinderGeometry args={[0.0055, 0.0055, 0.006, 12]} />
        </mesh>
      ))}
      <RoundedBox args={[0.06, 0.008, 0.02]} radius={0.003} smoothness={2} position={[-0.25, -H / 2 + 0.002, 0]} material={mats.trim} />
    </group>
  );
}
