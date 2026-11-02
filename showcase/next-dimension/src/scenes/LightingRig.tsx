import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { finishes } from '../data/product';
import { motion, useUI } from '../lib/store';
import { frame } from './keyframes';
import { stage } from './Rigs';

/**
 * Studio lighting: key, two rims, an overhead beam and a small light that
 * follows the visitor's pointer. Colours ease towards the selected finish.
 */
export default function LightingRig() {
  const finishId = useUI((s) => s.finishId);
  const finish = useMemo(() => finishes.find((f) => f.id === finishId) ?? finishes[0], [finishId]);

  const ambient = useRef<THREE.AmbientLight>(null);
  const key = useRef<THREE.DirectionalLight>(null);
  const rimA = useRef<THREE.DirectionalLight>(null);
  const rimB = useRef<THREE.DirectionalLight>(null);
  const follow = useRef<THREE.PointLight>(null);
  const beam = useRef<THREE.SpotLight>(null);

  const targets = useMemo(() => ({ key: new THREE.Color(), rim: new THREE.Color() }), []);
  useEffect(() => {
    targets.key.set(finish.key);
    targets.rim.set(finish.rim);
  }, [finish, targets]);

  // light "pulse" when the finish changes
  const pulse = useRef(0);
  useEffect(() => {
    pulse.current = 1;
  }, [finishId]);

  useFrame((_, dt) => {
    const k = 1 - Math.exp(-dt * 2.5);
    const lv = frame.light * stage.intro;
    pulse.current = Math.max(0, pulse.current - dt * 0.9);
    const p = Math.sin(pulse.current * Math.PI) * 0.6;

    if (ambient.current) ambient.current.intensity = 0.12 * lv;
    if (key.current) {
      key.current.color.lerp(targets.key, k);
      key.current.intensity = 2.1 * lv * (1 + p);
    }
    if (rimA.current) {
      rimA.current.color.lerp(targets.rim, k);
      rimA.current.intensity = (2.4 + frame.beam * 1.5) * Math.max(lv, 0.35 * stage.intro) * (1 + p * 0.5);
    }
    if (rimB.current) rimB.current.intensity = 2.2 * Math.max(lv, 0.4 * stage.intro);
    if (follow.current) {
      follow.current.position.set(
        stage.phone.x + motion.pointerSmooth.x * 2.4,
        motion.pointerSmooth.y * 1.6 + 0.4,
        2.2,
      );
      follow.current.intensity = 2.2 * stage.intro * (0.4 + lv * 0.6);
    }
    if (beam.current) {
      beam.current.position.set(stage.phone.x, 5.5, 0.6);
      beam.current.target.position.set(stage.phone.x, 0, 0);
      beam.current.target.updateMatrixWorld();
      beam.current.intensity = 80 * frame.beam * stage.intro;
    }
  });

  return (
    <>
      <ambientLight ref={ambient} intensity={0.1} />
      <directionalLight ref={key} position={[3, 4, 5]} intensity={2} />
      <directionalLight ref={rimA} position={[-5, 1.5, -3]} intensity={2.5} color="#5aa9ff" />
      <directionalLight ref={rimB} position={[5, 2.5, -3.5]} intensity={2} color="#f2f5fa" />
      <pointLight ref={follow} position={[0, 0, 2.2]} intensity={2} distance={7} decay={2} color="#cfe0ff" />
      <spotLight ref={beam} position={[0, 5.5, 0.6]} angle={0.2} penumbra={0.7} intensity={0} distance={14} decay={1.6} color="#eef3ff" />
    </>
  );
}
