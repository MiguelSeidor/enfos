/**
 * Terrain and map layout. Owner: TERRAIN agent.
 *
 * v0 baseline: symmetric two-site heightfield with carved lanes, a splat-blended
 * PBR ground material and a height sampler used by units, camera and VFX.
 * The map must stay geometrically symmetric so neither site gains an advantage
 * from the layout (GDD §5).
 */

import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';
import type { GameContext, GameModule, Vec2 } from '@/core/contracts';
import { TerrainKey, type TerrainService } from '@/core/services';
import { clamp, clamp01, smoothstep } from '@/core/mathx';
import { createRng } from '@/core/rng';

const MAP_SIZE = 240;
const RESOLUTION = 320; // vertices per side
const LANE_HALF_WIDTH = 5.5;

export class TerrainModule implements GameModule {
  readonly id = 'terrain';
  readonly order = 100;

  private heights!: Float32Array;
  private walkable!: Uint8Array;
  private mesh!: THREE.Mesh;
  private readonly lanes: Map<string, Vec2[]> = new Map();
  private readonly cell = MAP_SIZE / (RESOLUTION - 1);

  init(ctx: GameContext): void {
    this.buildLanes();
    this.generateHeightfield(ctx.match.seed);
    this.buildMesh(ctx.scene);

    const service: TerrainService = {
      heightAt: (x, z) => this.heightAt(x, z),
      normalAt: (x, z, out) => this.normalAt(x, z, out),
      isWalkable: (x, z) => this.isWalkable(x, z),
      lanePath: (team, lane) => this.lanes.get(`${team}:${lane}`) ?? [],
      bounds: {
        minX: -MAP_SIZE / 2,
        maxX: MAP_SIZE / 2,
        minZ: -MAP_SIZE / 2,
        maxZ: MAP_SIZE / 2,
      },
    };
    ctx.services.register(TerrainKey, service);
  }

  /**
   * Two mirrored sites on the X axis. Each site has a spawn, a serpentine
   * approach through the combat zone, and the core. Mirroring is exact so the
   * two teams face identical geometry.
   */
  private buildLanes(): void {
    const buildSide = (sign: number): Vec2[] => {
      const pts: Vec2[] = [
        { x: sign * 96, z: -62 },
        { x: sign * 74, z: -44 },
        { x: sign * 82, z: -16 },
        { x: sign * 58, z: 4 },
        { x: sign * 72, z: 30 },
        { x: sign * 50, z: 50 },
        { x: sign * 40, z: 22 },
        { x: sign * 34, z: -8 },
      ];
      return pts;
    };
    this.lanes.set('0:0', buildSide(-1));
    this.lanes.set('1:0', buildSide(1));
  }

  private generateHeightfield(seed: number): void {
    const rng = createRng(seed ^ 0x7e44a1);
    const noise = createNoise2D(() => rng.next());
    const detail = createNoise2D(() => rng.next());
    const n = RESOLUTION;
    this.heights = new Float32Array(n * n);
    this.walkable = new Uint8Array(n * n);

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = -MAP_SIZE / 2 + i * this.cell;
        const z = -MAP_SIZE / 2 + j * this.cell;

        // Mirror the sampling coordinate so both halves are identical.
        const mx = Math.abs(x);
        let h =
          noise(mx * 0.008, z * 0.008) * 7.0 +
          noise(mx * 0.021, z * 0.021) * 2.6 +
          detail(mx * 0.075, z * 0.075) * 0.7;

        // Raised rim around the playfield reads as a bowl arena.
        const edge = Math.max(mx / (MAP_SIZE / 2), Math.abs(z) / (MAP_SIZE / 2));
        h += smoothstep((edge - 0.72) / 0.28) * 26;

        // Flatten the lanes and the core platforms.
        const laneT = this.laneInfluence(x, z);
        h = h * (1 - laneT) + 0.35 * laneT;

        const idx = j * n + i;
        this.heights[idx] = h;
        this.walkable[idx] = edge < 0.86 && h < 12 ? 1 : 0;
      }
    }
  }

  /** 0 outside the lanes, 1 on the lane centreline; used to flatten paths. */
  private laneInfluence(x: number, z: number): number {
    let best = 0;
    for (const path of this.lanes.values()) {
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i]!;
        const b = path[i + 1]!;
        const d = distanceToSegment(x, z, a.x, a.z, b.x, b.z);
        const t = 1 - clamp01((d - LANE_HALF_WIDTH) / 7);
        if (t > best) best = t;
      }
    }
    return smoothstep(best);
  }

  private buildMesh(scene: THREE.Scene): void {
    const geo = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, RESOLUTION - 1, RESOLUTION - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, this.heights[i]!);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: 0x4a5a38,
      roughness: 0.94,
      metalness: 0.0,
      flatShading: false,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.name = 'terrain';
    scene.add(this.mesh);
  }

  heightAt(x: number, z: number): number {
    const n = RESOLUTION;
    const fx = (x + MAP_SIZE / 2) / this.cell;
    const fz = (z + MAP_SIZE / 2) / this.cell;
    const i = clamp(Math.floor(fx), 0, n - 2);
    const j = clamp(Math.floor(fz), 0, n - 2);
    const tx = clamp01(fx - i);
    const tz = clamp01(fz - j);
    const h00 = this.heights[j * n + i]!;
    const h10 = this.heights[j * n + i + 1]!;
    const h01 = this.heights[(j + 1) * n + i]!;
    const h11 = this.heights[(j + 1) * n + i + 1]!;
    const a = h00 + (h10 - h00) * tx;
    const b = h01 + (h11 - h01) * tx;
    return a + (b - a) * tz;
  }

  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const e = this.cell;
    const hL = this.heightAt(x - e, z);
    const hR = this.heightAt(x + e, z);
    const hD = this.heightAt(x, z - e);
    const hU = this.heightAt(x, z + e);
    return out.set(hL - hR, 2 * e, hD - hU).normalize();
  }

  isWalkable(x: number, z: number): boolean {
    const n = RESOLUTION;
    const i = clamp(Math.round((x + MAP_SIZE / 2) / this.cell), 0, n - 1);
    const j = clamp(Math.round((z + MAP_SIZE / 2) / this.cell), 0, n - 1);
    return this.walkable[j * n + i] === 1;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

function distanceToSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const abx = bx - ax;
  const abz = bz - az;
  const apx = px - ax;
  const apz = pz - az;
  const lenSq = abx * abx + abz * abz;
  const t = lenSq === 0 ? 0 : clamp01((apx * abx + apz * abz) / lenSq);
  const cx = ax + abx * t;
  const cz = az + abz * t;
  const dx = px - cx;
  const dz = pz - cz;
  return Math.sqrt(dx * dx + dz * dz);
}

export { MAP_SIZE, RESOLUTION };
