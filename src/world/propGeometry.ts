/**
 * Geometry for the editor's placeable props. Owner: TERRAIN.
 *
 * One builder per `PropKind`, each returning geometry in local space with its
 * base at y=0, so the placer only has to translate to the terrain height.
 *
 * Kept apart from `props.ts` because that module's job is placement and
 * batching; this one's is shape. Everything here is deliberately blocky: these
 * read at an RTS camera distance, where a chamfer is a pixel and a bevel is
 * nothing.
 */

import * as THREE from 'three';

/** Parts and the material slot each belongs to. */
export interface PropParts {
  /** Lit stone/wood geometry. */
  solid: THREE.BufferGeometry[];
  /** Additive, unlit geometry — flame, glow. Empty for most props. */
  emissive: THREE.BufferGeometry[];
}

function torch(): PropParts {
  const post = new THREE.CylinderGeometry(0.1, 0.16, 2.4, 6);
  post.translate(0, 1.2, 0);
  const head = new THREE.CylinderGeometry(0.26, 0.14, 0.42, 8);
  head.translate(0, 2.5, 0);

  // Two crossed quads: a single billboard vanishes when seen edge-on, and the
  // RTS camera does rotate.
  const flames: THREE.BufferGeometry[] = [];
  for (const rot of [0, Math.PI / 2]) {
    const q = new THREE.PlaneGeometry(0.85, 1.15);
    q.rotateY(rot);
    q.translate(0, 3.15, 0);
    flames.push(q);
  }
  return { solid: [post, head], emissive: flames };
}

function brazier(): PropParts {
  const foot = new THREE.CylinderGeometry(0.5, 0.62, 0.28, 8);
  foot.translate(0, 0.14, 0);
  const shaft = new THREE.CylinderGeometry(0.24, 0.36, 1.1, 6);
  shaft.translate(0, 0.83, 0);
  const bowl = new THREE.CylinderGeometry(0.62, 0.3, 0.44, 10);
  bowl.translate(0, 1.6, 0);
  const rim = new THREE.TorusGeometry(0.62, 0.08, 5, 12);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, 1.82, 0);

  const flames: THREE.BufferGeometry[] = [];
  for (const rot of [0, Math.PI / 2]) {
    const q = new THREE.PlaneGeometry(1.35, 1.8);
    q.rotateY(rot);
    q.translate(0, 2.65, 0);
    flames.push(q);
  }
  return { solid: [foot, shaft, bowl, rim], emissive: flames };
}

function rock(): PropParts {
  // Three overlapping low-poly boulders at different sizes, so a placed rock
  // reads as an outcrop rather than as one repeated ball.
  const parts: THREE.BufferGeometry[] = [];
  const sizes: [number, number, number, number][] = [
    [0.85, 0, 0, 0],
    [0.55, 0.7, -0.15, 0.35],
    [0.42, -0.6, -0.2, -0.3],
  ];
  for (const [r, dx, dy, dz] of sizes) {
    const g = new THREE.DodecahedronGeometry(r, 0);
    g.scale(1, 0.75, 1);
    g.translate(dx, r * 0.6 + dy, dz);
    parts.push(g);
  }
  return { solid: parts, emissive: [] };
}

function pillar(): PropParts {
  const plinth = new THREE.BoxGeometry(1.1, 0.35, 1.1);
  plinth.translate(0, 0.175, 0);
  const shaft = new THREE.CylinderGeometry(0.32, 0.4, 3.2, 8);
  shaft.translate(0, 1.95, 0);
  const capital = new THREE.BoxGeometry(0.9, 0.3, 0.9);
  capital.translate(0, 3.7, 0);
  // Broken top: the pillar is a ruin, not scaffolding.
  const broken = new THREE.CylinderGeometry(0.22, 0.3, 0.5, 8);
  broken.rotateZ(0.22);
  broken.translate(0.1, 4.05, 0);
  return { solid: [plinth, shaft, capital, broken], emissive: [] };
}

function banner(): PropParts {
  const pole = new THREE.CylinderGeometry(0.07, 0.09, 3.6, 6);
  pole.translate(0, 1.8, 0);
  const arm = new THREE.BoxGeometry(0.9, 0.08, 0.08);
  arm.translate(0.42, 3.4, 0);
  const cloth = new THREE.PlaneGeometry(0.8, 1.6);
  cloth.translate(0.42, 2.55, 0);
  return { solid: [pole, arm, cloth], emissive: [] };
}

export const PROP_GEOMETRY: Record<string, () => PropParts> = {
  torch,
  brazier,
  rock,
  pillar,
  banner,
};
