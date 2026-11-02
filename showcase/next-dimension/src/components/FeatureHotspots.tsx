import { useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { hotspots, type Hotspot } from '../data/product';
import { hotspotElements as elements } from './hotspotRegistry';
import { frame } from '../scenes/keyframes';
import { stage } from '../scenes/Rigs';

/**
 * Hotspots are real DOM buttons (keyboard + screen-reader friendly) that are
 * projected onto anchor points of the 3D model every frame.
 *  - <HotspotProjector/> (this file) lives inside the Canvas, under the phone group.
 *  - <HotspotLayer/> (HotspotLayer.tsx) renders the buttons in the page.
 */

const sideOf = (h: Hotspot) => (h.normal[2] < 0 ? 'back' : 'front');

const tmpPos = new THREE.Vector3();
const tmpNormal = new THREE.Vector3();
const tmpView = new THREE.Vector3();
const normalMatrix = new THREE.Matrix3();

function Anchor({ hotspot }: { hotspot: Hotspot }) {
  const anchor = useRef<THREE.Group>(null);
  const visible = useRef(false);
  const { camera, size } = useThree();

  useFrame(() => {
    const a = anchor.current;
    const el = elements.get(hotspot.id);
    if (!a || !el) return;
    a.getWorldPosition(tmpPos);

    let show = stage.intro > 0.98 && stage.hold < 0.05 && frame.hotspots === sideOf(hotspot);
    if (show) {
      normalMatrix.getNormalMatrix(a.matrixWorld);
      tmpNormal.set(...hotspot.normal).applyMatrix3(normalMatrix).normalize();
      tmpView.copy(camera.position).sub(tmpPos).normalize();
      show = tmpNormal.dot(tmpView) > 0.12;
    }

    tmpPos.project(camera);
    const x = (tmpPos.x * 0.5 + 0.5) * size.width;
    const y = (-tmpPos.y * 0.5 + 0.5) * size.height;
    el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;

    if (show !== visible.current) {
      visible.current = show;
      el.dataset.visible = String(show);
      el.tabIndex = show ? 0 : -1;
      el.setAttribute('aria-hidden', String(!show));
    }
  });

  return <group ref={anchor} position={hotspot.position} />;
}

export function HotspotProjector() {
  return (
    <>
      {hotspots.map((h) => (
        <Anchor key={h.id} hotspot={h} />
      ))}
    </>
  );
}
