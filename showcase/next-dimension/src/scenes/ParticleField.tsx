import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { motion } from '../lib/store';
import { stage } from './Rigs';

const vertex = /* glsl */ `
  attribute float aScale;
  attribute float aLayer;
  attribute float aSeed;
  uniform float uTime;
  uniform float uFlow;
  uniform vec2 uPointer;
  uniform float uPixelRatio;
  varying float vAlpha;
  varying float vLayer;

  void main() {
    vec3 p = position;
    // slow upward drift, wrapped
    p.y = mod(p.y + uTime * (0.05 + aSeed * 0.08) + 7.0, 14.0) - 7.0;
    p.x += sin(uTime * 0.2 + aSeed * 30.0) * 0.15;
    // forward flow (fast during the intro), wrapped in depth
    p.z = mod(p.z + uFlow + 20.0, 24.0) - 20.0;
    // depth-layer parallax
    p.xy += uPointer * (0.25 + aLayer * 0.9);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aScale * uPixelRatio * (34.0 / -mv.z);
    float near = smoothstep(0.4, 2.5, -mv.z);
    float far = 1.0 - smoothstep(14.0, 24.0, -mv.z);
    vAlpha = near * far * (0.35 + aSeed * 0.65);
    vLayer = aLayer;
  }
`;

const fragment = /* glsl */ `
  uniform float uOpacity;
  varying float vAlpha;
  varying float vLayer;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);
    a *= a;
    vec3 col = mix(vec3(0.85, 0.88, 0.94), vec3(0.42, 0.68, 1.0), vLayer * 0.7);
    gl_FragColor = vec4(col, a * vAlpha * uOpacity);
  }
`;

export default function ParticleField({ count }: { count: number }) {
  const { gl } = useThree();
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const scale = new Float32Array(count);
    const layer = new Float32Array(count);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 24;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 14;
      pos[i * 3 + 2] = -20 + Math.random() * 24;
      const l = Math.floor(Math.random() * 3) / 2; // three depth layers
      layer[i] = l;
      scale[i] = 0.6 + Math.random() * 1.6 + l * 0.8;
      seed[i] = Math.random();
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aScale', new THREE.BufferAttribute(scale, 1));
    g.setAttribute('aLayer', new THREE.BufferAttribute(layer, 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    return g;
  }, [count]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: vertex,
        fragmentShader: fragment,
        uniforms: {
          uTime: { value: 0 },
          uFlow: { value: 0 },
          uPointer: { value: new THREE.Vector2() },
          uPixelRatio: { value: Math.min(gl.getPixelRatio(), 2) },
          uOpacity: { value: 1 },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [gl],
  );

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  const flow = useRef(0);
  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const reduced = motion.reducedMotion;
    const u = material.uniforms;
    if (!reduced) u.uTime.value += dt;
    // particles rush toward the viewer during the intro, then settle to a slow drift
    const speed = reduced ? 0 : 0.12 + (1 - stage.intro) * 5;
    flow.current += dt * speed;
    u.uFlow.value = flow.current;
    u.uPointer.value.set(motion.pointerSmooth.x * 0.6, motion.pointerSmooth.y * 0.4);
    u.uOpacity.value = 0.25 + motion.intro * 0.75;
  });

  return <points geometry={geometry} material={material} frustumCulled={false} />;
}
