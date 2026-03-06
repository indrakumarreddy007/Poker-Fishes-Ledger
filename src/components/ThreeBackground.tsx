import React, { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Float, PerspectiveCamera, Environment, Stars } from '@react-three/drei';
import * as THREE from 'three';

function PokerChips() {
  const chipsRef = useRef<THREE.Group>(null!);

  const chips = useMemo(() => {
    return Array.from({ length: 15 }).map((_, i) => ({
      position: [
        (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 10
      ] as [number, number, number],
      rotation: [Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI] as [number, number, number],
      scale: 0.2 + Math.random() * 0.3,
      color: i % 3 === 0 ? '#ef4444' : i % 3 === 1 ? '#10b981' : '#3b82f6'
    }));
  }, []);

  useFrame((state) => {
    if (chipsRef.current) {
      chipsRef.current.rotation.y += 0.001;
      chipsRef.current.rotation.x += 0.0005;
    }
  });

  return (
    <group ref={chipsRef}>
      {chips.map((chip, i) => (
        <Float key={i} speed={2} rotationIntensity={1} floatIntensity={1} position={chip.position}>
          <mesh rotation={chip.rotation} scale={[chip.scale, chip.scale, chip.scale * 0.2]}>
            <cylinderGeometry args={[1, 1, 0.5, 32]} />
            <meshStandardMaterial color={chip.color} roughness={0.1} metalness={0.8} />
          </mesh>
        </Float>
      ))}
    </group>
  );
}

export default function ThreeBackground() {
  return (
    <div className="fixed inset-0 -z-10 bg-[#050505] pointer-events-none">
      <Canvas dpr={[1, 2]} style={{ pointerEvents: 'none' }}>
        <PerspectiveCamera makeDefault position={[0, 0, 8]} fov={50} />
        <ambientLight intensity={0.2} />
        <pointLight position={[10, 10, 10]} intensity={1.5} color="#ffffff" />
        <pointLight position={[-10, -10, -10]} intensity={0.5} color="#4f46e5" />
        <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />
        <PokerChips />
        <Environment preset="city" />
      </Canvas>
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[#050505]/50 to-[#050505] pointer-events-none" />
    </div>
  );
}
