import React, { useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Environment, Float, Lightformer, Line, SpotLight } from '@react-three/drei';
import * as THREE from 'three';

const RING_RADIUS = 2.3;
const RING_NODES = 14;

/**
 * Build the vertex ring for the orbiting node network. Each ring is a circle
 * of points in the XZ plane, tilted by the given Euler angles so multiple
 * rings cross each other in a network-mesh composition.
 */
function buildRing(tiltY: number, tiltZ: number): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  const euler = new THREE.Euler(tiltY, 0, tiltZ);
  for (let i = 0; i < RING_NODES; i++) {
    const angle = (i / RING_NODES) * Math.PI * 2;
    const p = new THREE.Vector3(
      Math.cos(angle) * RING_RADIUS,
      0,
      Math.sin(angle) * RING_RADIUS,
    );
    p.applyEuler(euler);
    points.push(p);
  }
  return points;
}

/** A slowly-orbiting ring of glowing nodes connected by a hairline. */
function NodeRing({ tiltY, tiltZ, speed }: { tiltY: number; tiltZ: number; speed: number }) {
  const group = useRef<THREE.Group>(null);
  const points = useMemo(() => buildRing(tiltY, tiltZ), [tiltY, tiltZ]);
  const closed = useMemo(() => [...points, points[0]], [points]);

  useFrame((_, delta) => {
    if (group.current) group.current.rotation.y += delta * speed;
  });

  return (
    <group ref={group}>
      <Line points={closed} color="#38bdf8" lineWidth={1} transparent opacity={0.45} />
      {points.map((p, i) => (
        <mesh key={i} position={p}>
          <sphereGeometry args={[0.075, 16, 16]} />
          <meshStandardMaterial
            color="#0e7490"
            emissive="#22d3ee"
            emissiveIntensity={2.4}
            roughness={0.25}
            metalness={0.4}
          />
        </mesh>
      ))}
    </group>
  );
}

/** The glossy, high-speed core — a clearcoated container node wrapped in a wireframe shell. */
function Core() {
  return (
    <Float speed={1.6} rotationIntensity={0.55} floatIntensity={1.15}>
      <mesh>
        <icosahedronGeometry args={[1.15, 0]} />
        <meshPhysicalMaterial
          color="#0ea5e9"
          metalness={0.85}
          roughness={0.18}
          clearcoat={1}
          clearcoatRoughness={0.12}
          envMapIntensity={1.4}
        />
      </mesh>
      <mesh scale={1.55}>
        <icosahedronGeometry args={[1.15, 0]} />
        <meshBasicMaterial wireframe color="#7dd3fc" transparent opacity={0.22} />
      </mesh>
    </Float>
  );
}

/** The full 3D subject: glossy core + two intersecting orbiting rings, slowly rotating. */
function Subject() {
  const group = useRef<THREE.Group>(null);

  useFrame((_, delta) => {
    if (group.current) group.current.rotation.y += delta * 0.12;
  });

  return (
    <group ref={group}>
      <Core />
      <NodeRing tiltY={0.55} tiltZ={0.35} speed={0.18} />
      <NodeRing tiltY={-0.7} tiltZ={-0.22} speed={-0.13} />
    </group>
  );
}

/**
 * Parallax rig — gently eases the camera toward the cursor position so the
 * scene feels responsive without swinging enough to cause motion sickness.
 */
function CameraRig() {
  useFrame((state, delta) => {
    const { camera, pointer } = state;
    camera.position.x = THREE.MathUtils.damp(camera.position.x, pointer.x * 0.9, 2.2, delta);
    camera.position.y = THREE.MathUtils.damp(camera.position.y, 0.4 - pointer.y * 0.55, 2.2, delta);
    camera.lookAt(0, 0, 0);
  });
  return null;
}

/**
 * Cinematic full-viewport 3D backdrop for the FleexBid landing page.
 * Fully procedural (no network assets) — reflections come from an
 * in-scene Environment built from Lightformers.
 */
export default function HeroScene() {
  return (
    <Canvas
      className="fixed inset-0"
      style={{ position: 'fixed', inset: 0, zIndex: 0 }}
      dpr={[1, 1.75]}
      camera={{ position: [0, 0.4, 6.5], fov: 42 }}
      gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
      resize={{ scroll: false }}
    >
      <color attach="background" args={['#020617']} />
      <fog attach="fog" args={['#020617', 9, 22]} />

      {/* Cinematic pop-art lighting: low ambient + hot key spotlight + indigo rim */}
      <ambientLight intensity={0.25} color="#334155" />
      <SpotLight
        position={[4.5, 6, 4]}
        angle={0.38}
        penumbra={1}
        intensity={180}
        distance={25}
        attenuation={4}
        anglePower={5}
        color="#7dd3fc"
      />
      <pointLight position={[-5, 2.5, -3]} intensity={45} color="#6366f1" />

      {/* Procedural environment map for glossy reflections — no network fetch */}
      <Environment resolution={64} frames={1}>
        <Lightformer intensity={2.5} position={[0, 5, -9]} scale={[10, 10, 1]} color="#38bdf8" />
        <Lightformer
          intensity={2}
          position={[-6, 1, 2]}
          rotation-y={Math.PI / 2}
          scale={[12, 1.5, 1]}
          color="#6366f1"
        />
        <Lightformer
          intensity={1.5}
          position={[6, -1, 1]}
          rotation-y={-Math.PI / 2}
          scale={[12, 1.5, 1]}
          color="#0ea5e9"
        />
      </Environment>

      <Subject />
      <CameraRig />
    </Canvas>
  );
}
