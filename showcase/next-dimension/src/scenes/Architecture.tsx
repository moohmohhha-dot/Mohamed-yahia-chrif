import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { finishes } from '../data/product';
import { useUI } from '../lib/store';
import { frame } from './keyframes';
import { stage } from './Rigs';

const FLOOR_Y = -1.25;

/* -------------------------- the vast architectural hall -------------------------- */

export function Architecture() {
  const pillars = useRef<THREE.InstancedMesh>(null);
  const strips = useRef<THREE.InstancedMesh>(null);
  const group = useRef<THREE.Group>(null);

  const rows = 11;
  const pillarMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#16171a', roughness: 0.55, metalness: 0.6, transparent: true, opacity: 0 }),
    [],
  );
  const stripMat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: '#cfdcf2', transparent: true, opacity: 0, toneMapped: false }),
    [],
  );
  useEffect(() => () => { pillarMat.dispose(); stripMat.dispose(); }, [pillarMat, stripMat]);

  useLayoutEffect(() => {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (let i = 0; i < rows; i++) {
      const z = 3 - i * 4;
      for (let side = 0; side < 2; side++) {
        const x = side ? 6.5 : -6.5;
        p.set(x, 5, z);
        s.set(0.38, 14, 0.38);
        m.compose(p, q, s);
        pillars.current?.setMatrixAt(i * 2 + side, m);
        // vertical light seam on each pillar's inner face
        p.set(x + (side ? -0.2 : 0.2), 4.5, z);
        s.set(0.012, 12, 0.012);
        m.compose(p, q, s);
        strips.current?.setMatrixAt(i * 2 + side, m);
      }
      // ceiling light bar spanning the hall
      p.set(0, 9.5, z - 2);
      s.set(13, 0.03, 0.06);
      m.compose(p, q, s);
      strips.current?.setMatrixAt(rows * 2 + i, m);
    }
    if (pillars.current) pillars.current.instanceMatrix.needsUpdate = true;
    if (strips.current) strips.current.instanceMatrix.needsUpdate = true;
  }, []);

  useFrame(() => {
    const a = frame.arch * stage.intro;
    pillarMat.opacity = a;
    stripMat.opacity = a * 0.55;
    if (group.current) group.current.visible = a > 0.01;
  });

  return (
    <group ref={group} position={[0, FLOOR_Y + 0.0, 0]}>
      <instancedMesh ref={pillars} args={[undefined, undefined, rows * 2]} material={pillarMat} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>
      <instancedMesh ref={strips} args={[undefined, undefined, rows * 3]} material={stripMat} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>
    </group>
  );
}

/* ------------------------------ glowing studio floor ------------------------------ */

const floorVertex = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const floorFragment = /* glsl */ `
  uniform float uOpacity;
  uniform vec3 uColor;
  uniform vec2 uCenter;
  uniform float uGrid;
  varying vec3 vWorld;
  void main() {
    vec2 p = vWorld.xz - uCenter;
    float r = length(p);
    float pool = exp(-r * r * 0.9) * 0.55;
    float halo = exp(-r * 0.35) * 0.08;
    // faint architectural grid receding into the dark
    vec2 g = abs(fract(vWorld.xz * 0.5) - 0.5);
    float line = 1.0 - smoothstep(0.0, 0.015, min(g.x, g.y));
    float gridFade = exp(-r * 0.12) * uGrid;
    vec3 col = uColor * (pool + halo) + vec3(0.55, 0.65, 0.8) * line * gridFade * 0.08;
    float alpha = clamp(pool + halo + line * gridFade * 0.1, 0.0, 1.0) * uOpacity;
    gl_FragColor = vec4(col, alpha);
  }
`;

export function StudioFloor() {
  const finishId = useUI((s) => s.finishId);
  const finish = finishes.find((f) => f.id === finishId) ?? finishes[0];
  const target = useMemo(() => new THREE.Color(), []);
  useEffect(() => {
    target.set(finish.rim).lerp(new THREE.Color(finish.key), 0.55);
  }, [finish, target]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: floorVertex,
        fragmentShader: floorFragment,
        uniforms: {
          uOpacity: { value: 0 },
          uColor: { value: new THREE.Color('#8fb8ff') },
          uCenter: { value: new THREE.Vector2() },
          uGrid: { value: 0 },
        },
        transparent: true,
        depthWrite: false,
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);

  useFrame((_, dt) => {
    const u = material.uniforms;
    u.uOpacity.value = frame.floor * stage.intro;
    u.uGrid.value = frame.arch;
    u.uCenter.value.set(stage.phone.x, stage.phone.z);
    u.uColor.value.lerp(target, 1 - Math.exp(-dt * 2.5));
  });

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, FLOOR_Y, -6]} material={material} renderOrder={-1}>
      <planeGeometry args={[60, 60]} />
    </mesh>
  );
}

/* --------------------------- narrow overhead light beam --------------------------- */

const beamVertex = /* glsl */ `
  varying float vY;
  varying vec3 vNormalV;
  varying vec3 vView;
  void main() {
    vY = uv.y;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormalV = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const beamFragment = /* glsl */ `
  uniform float uOpacity;
  varying float vY;
  varying vec3 vNormalV;
  varying vec3 vView;
  void main() {
    float facing = abs(dot(normalize(vNormalV), normalize(vView)));
    float soft = pow(facing, 2.2);
    float fade = smoothstep(0.0, 0.35, vY) * (1.0 - smoothstep(0.85, 1.0, vY));
    gl_FragColor = vec4(vec3(0.82, 0.88, 1.0), soft * fade * uOpacity * 0.16);
  }
`;

export function LightBeam() {
  const mesh = useRef<THREE.Mesh>(null);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: beamVertex,
        fragmentShader: beamFragment,
        uniforms: { uOpacity: { value: 0 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);

  useFrame(() => {
    material.uniforms.uOpacity.value = frame.beam * stage.intro;
    if (mesh.current) {
      mesh.current.visible = frame.beam > 0.01;
      mesh.current.position.x = stage.phone.x;
    }
  });

  return (
    <mesh ref={mesh} position={[0, 2.1, 0]} material={material} renderOrder={5}>
      <cylinderGeometry args={[0.06, 1.25, 7, 48, 1, true]} />
    </mesh>
  );
}
