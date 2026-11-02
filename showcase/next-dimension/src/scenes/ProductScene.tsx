import { Canvas } from '@react-three/fiber';
import { Environment, Lightformer, PerformanceMonitor } from '@react-three/drei';
import { Bloom, EffectComposer, Noise, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';
import SmartphoneModel from '../components/SmartphoneModel';
import { HotspotProjector } from '../components/FeatureHotspots';
import { useUI, type Quality } from '../lib/store';
import { CameraRig, PhoneRig } from './Rigs';
import LightingRig from './LightingRig';
import ParticleField from './ParticleField';
import { Architecture, LightBeam, StudioFloor } from './Architecture';

const particleCount: Record<Quality, number> = { high: 1800, medium: 1000, low: 520 };
const dprRange: Record<Quality, [number, number]> = { high: [1, 1.8], medium: [1, 1.5], low: [0.85, 1.25] };

/** Procedural studio reflections — no HDR download required. */
function StudioEnvironment() {
  return (
    <Environment resolution={256} frames={1}>
      <color attach="background" args={['#050506']} />
      <Lightformer form="rect" intensity={2.4} position={[0, 5, 2]} rotation-x={Math.PI / 2} scale={[8, 2, 1]} />
      <Lightformer form="rect" intensity={3} position={[-5, 1, 1]} rotation-y={Math.PI / 2} scale={[0.6, 8, 1]} />
      <Lightformer form="rect" intensity={2.2} position={[5, 1, -1]} rotation-y={-Math.PI / 2} scale={[0.4, 8, 1]} />
      <Lightformer form="rect" intensity={1.6} color="#5aa9ff" position={[-3, -1, -5]} scale={[6, 0.4, 1]} />
      <Lightformer form="ring" intensity={1.2} position={[2, 2, 6]} scale={1.6} />
      <Lightformer form="rect" intensity={0.8} position={[0, -4, 0]} rotation-x={-Math.PI / 2} scale={[10, 10, 1]} color="#1a1c22" />
    </Environment>
  );
}

export default function ProductScene() {
  const quality = useUI((s) => s.quality);
  const setQuality = useUI((s) => s.setQuality);

  return (
    <Canvas
      dpr={dprRange[quality]}
      camera={{ fov: 35, near: 0.1, far: 80, position: [0, 0, 15] }}
      gl={{ antialias: quality !== 'low', powerPreference: 'high-performance', alpha: false }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.05;
      }}
      aria-hidden="true"
    >
      <color attach="background" args={['#040405']} />
      <fogExp2 attach="fog" args={['#040405', 0.045]} />

      <PerformanceMonitor
        flipflops={2}
        onDecline={() => setQuality(quality === 'high' ? 'medium' : 'low')}
      />

      {/* order matters: the camera rig samples the keyframes first each frame */}
      <CameraRig />
      <LightingRig />
      <StudioEnvironment />

      <ParticleField count={particleCount[quality]} />
      <Architecture />
      <StudioFloor />
      <LightBeam />

      <PhoneRig>
        <SmartphoneModel />
        <HotspotProjector />
      </PhoneRig>

      {quality === 'high' && (
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur luminanceThreshold={0.72} luminanceSmoothing={0.2} intensity={0.55} radius={0.7} />
          <Vignette offset={0.28} darkness={0.72} />
          <Noise opacity={0.028} premultiply />
        </EffectComposer>
      )}
    </Canvas>
  );
}
