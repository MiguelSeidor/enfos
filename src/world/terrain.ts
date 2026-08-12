/**
 * Terrain and map layout. Owner: TERRAIN agent.
 *
 * The map is a terraced heightfield, not displaced noise: `field.ts` quantises
 * the authored elevation into integer levels, this module turns those levels
 * into flat plateau surfaces and generates real cliff geometry for every step
 * between them. That is what makes elevation read as authored RTS terrain —
 * you can see where a unit can and cannot walk from the silhouette alone.
 *
 * Geometry is built cell by cell rather than as one shared vertex grid, so two
 * neighbouring cells are free to sit at different heights. Cells that DO share
 * a level still weld perfectly, because every vertex adds the same continuous
 * `macro()` displacement evaluated at its world position.
 *
 * Symmetry (GDD §5) is structural: the elevation field is authored in mirrored
 * space and `field.ts` forces the +X half to copy the -X half exactly.
 */

import * as THREE from 'three';
import type { GameContext, GameModule, TeamId, Vec2 } from '@/core/contracts';
import { TerrainKey, type TerrainService } from '@/core/services';
import { clamp, lerp } from '@/core/mathx';
import {
  CELL,
  CELLS,
  LEVEL_STEP,
  MAP_HALF,
  MAP_SIZE,
  SUB,
  lanePolyline,
} from './layout';
import { TerrainFieldData } from './field';
import { createCliffMaterial, createGroundMaterial, type GroundMaterialResult } from './groundMaterial';

/** Level difference below which two cells are considered welded. */
const WALL_EPS = 0.12;

let activeField: TerrainFieldData | null = null;

/** Shared access for the other world modules (props, water, structures). */
export function getField(): TerrainFieldData {
  if (!activeField) throw new Error('terrain field not built yet');
  return activeField;
}

export class TerrainModule implements GameModule {
  readonly id = 'terrain';
  readonly order = 100;

  private field!: TerrainFieldData;
  private ground!: THREE.Mesh;
  private cliffs!: THREE.Mesh;
  private groundMat!: GroundMaterialResult;
  private cliffMat!: GroundMaterialResult;
  private readonly lanes = new Map<string, Vec2[]>();

  init(ctx: GameContext): void {
    this.field = new TerrainFieldData(ctx.match.seed);
    activeField = this.field;

    this.lanes.set('0:0', lanePolyline(-1).map((p) => ({ x: p.x, z: p.z })));
    this.lanes.set('1:0', lanePolyline(1).map((p) => ({ x: p.x, z: p.z })));

    this.groundMat = createGroundMaterial(this.field, ctx.match.seed);
    this.cliffMat = createCliffMaterial();

    this.ground = new THREE.Mesh(this.buildGroundGeometry(), this.groundMat.material);
    this.ground.name = 'terrain.ground';
    this.ground.receiveShadow = true;
    this.ground.castShadow = false;
    this.ground.matrixAutoUpdate = false;
    ctx.scene.add(this.ground);

    this.cliffs = new THREE.Mesh(this.buildCliffGeometry(), this.cliffMat.material);
    this.cliffs.name = 'terrain.cliffs';
    this.cliffs.receiveShadow = true;
    this.cliffs.castShadow = true;
    this.cliffs.matrixAutoUpdate = false;
    ctx.scene.add(this.cliffs);

    const service: TerrainService = {
      heightAt: (x, z) => this.field.heightAt(x, z),
      normalAt: (x, z, out) => this.normalAt(x, z, out),
      isWalkable: (x, z) => this.field.isWalkable(x, z),
      lanePath: (team: TeamId, lane: number) => this.lanes.get(`${team}:${lane}`) ?? [],
      bounds: {
        minX: -MAP_HALF,
        maxX: MAP_HALF,
        minZ: -MAP_HALF,
        maxZ: MAP_HALF,
      },
    };
    ctx.services.register(TerrainKey, service);
  }

  // ── Ground surface ─────────────────────────────────────────────────────────

  /**
   * One patch of `SUB × SUB` quads per coarse cell. Vertices are not shared
   * between cells, which is precisely what allows a discontinuity (a cliff)
   * at a cell boundary while flat neighbours still meet seamlessly.
   */
  private buildGroundGeometry(): THREE.BufferGeometry {
    const f = this.field;
    const perCell = (SUB + 1) * (SUB + 1);
    const cellCount = CELLS * CELLS;
    const vertCount = cellCount * perCell;

    const positions = new Float32Array(vertCount * 3);
    const normals = new Float32Array(vertCount * 3);
    const ao = new Float32Array(vertCount);
    const indices = new Uint32Array(cellCount * SUB * SUB * 6);

    const step = CELL / SUB;
    let vi = 0;
    let ii = 0;

    for (let j = 0; j < CELLS; j++) {
      for (let i = 0; i < CELLS; i++) {
        const base = vi;
        const cBase = (j * CELLS + i) * 4;
        const c0 = f.corners[cBase];
        const c1 = f.corners[cBase + 1];
        const c2 = f.corners[cBase + 2];
        const c3 = f.corners[cBase + 3];

        for (let b = 0; b <= SUB; b++) {
          const tv = b / SUB;
          for (let a = 0; a <= SUB; a++) {
            const tu = a / SUB;
            const x = -MAP_HALF + i * CELL + a * step;
            const z = -MAP_HALF + j * CELL + b * step;
            const y = f.cellSurface(i, j, tu, tv);

            // Analytic normal: terrace tilt (zero on a plateau) plus the
            // gradient of the continuous detail displacement.
            const dLx = ((c1 - c0) * (1 - tv) + (c2 - c3) * tv) / CELL;
            const dLz = ((c3 - c0) * (1 - tu) + (c2 - c1) * tu) / CELL;
            const e = 0.5;
            const dMx = (f.elevation.macro(x + e, z) - f.elevation.macro(x - e, z)) / (2 * e);
            const dMz = (f.elevation.macro(x, z + e) - f.elevation.macro(x, z - e)) / (2 * e);
            const dhx = dLx * LEVEL_STEP + dMx;
            const dhz = dLz * LEVEL_STEP + dMz;
            const inv = 1 / Math.hypot(dhx, 1, dhz);

            const o = vi * 3;
            positions[o] = x;
            positions[o + 1] = y;
            positions[o + 2] = z;
            normals[o] = -dhx * inv;
            normals[o + 1] = inv;
            normals[o + 2] = -dhz * inv;
            ao[vi] = f.aoAt(x, z);
            vi++;
          }
        }

        for (let b = 0; b < SUB; b++) {
          for (let a = 0; a < SUB; a++) {
            const v00 = base + b * (SUB + 1) + a;
            const v10 = v00 + 1;
            const v01 = v00 + (SUB + 1);
            const v11 = v01 + 1;
            indices[ii++] = v00;
            indices[ii++] = v01;
            indices[ii++] = v10;
            indices[ii++] = v10;
            indices[ii++] = v01;
            indices[ii++] = v11;
          }
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('aAo', new THREE.BufferAttribute(ao, 1));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeBoundingSphere();
    geo.name = 'terrain.ground';
    return geo;
  }

  // ── Cliff faces ────────────────────────────────────────────────────────────

  /**
   * Walls are emitted per shared cell edge, from the higher cell's corner pair
   * down to the lower one. The top row is pushed slightly out and up to form an
   * overhanging lip, which both hides the seam and gives the face a shadow line
   * along its crest instead of a clean mathematical edge.
   */
  private buildCliffGeometry(): THREE.BufferGeometry {
    const f = this.field;
    const positions: number[] = [];
    const aos: number[] = [];
    const indices: number[] = [];
    const HS = SUB;

    const emitWall = (
      // Edge endpoints in world space.
      ax: number,
      az: number,
      bx: number,
      bz: number,
      // Level values at those endpoints, high side and low side.
      hiA: number,
      hiB: number,
      loA: number,
      loB: number,
      // Outward direction (from the high cell toward the low cell).
      nx: number,
      nz: number,
      // The (span, depth) parameterisation flips handedness between the X and
      // Z edges, so the caller states which winding faces outward.
      flip: boolean,
    ): void => {
      const drop = Math.max(hiA - loA, hiB - loB) * LEVEL_STEP;
      if (drop < WALL_EPS * LEVEL_STEP) return;
      const VS = clamp(Math.round(drop / 1.4), 1, 6);
      const start = positions.length / 3;

      for (let k = 0; k <= VS; k++) {
        const kt = k / VS;
        for (let s = 0; s <= HS; s++) {
          const t = s / HS;
          const x = lerp(ax, bx, t);
          const z = lerp(az, bz, t);
          const macro = f.elevation.macro(x, z);
          const hiY = lerp(hiA, hiB, t) * LEVEL_STEP + macro;
          const loY = lerp(loA, loB, t) * LEVEL_STEP + macro;
          const y = lerp(hiY, loY, kt);

          // Rock profile: bow the middle of the face outward. The bulge is
          // forced to zero on the top and bottom rows so the wall stays exactly
          // welded to the plateau above and the terrace below.
          // Taper the bulge at the ends of the span as well, so two walls
          // meeting at an inside corner cannot interpenetrate into a sliver.
          const endTaper = Math.min(1, t / 0.18) * Math.min(1, (1 - t) / 0.18);
          const interior = Math.sin(Math.PI * kt) * endTaper;
          const n1 = f.elevation.macro(x * 2.3 + 91, z * 2.3 - 47);
          const bulge = interior * (0.3 + n1 * 0.42);
          const px = x + nx * bulge;
          const pz = z + nz * bulge;

          positions.push(px, y, pz);
          // Cliff faces darken toward their base; the horizon AO already knows
          // about the canyon, this adds the local contact gradient.
          aos.push(f.aoAt(x, z) * lerp(1.0, 0.42, kt * kt));
        }
      }

      for (let k = 0; k < VS; k++) {
        for (let s = 0; s < HS; s++) {
          const v00 = start + k * (HS + 1) + s;
          const v10 = v00 + 1;
          const v01 = v00 + (HS + 1);
          const v11 = v01 + 1;
          if (flip) {
            indices.push(v00, v10, v01, v10, v11, v01);
          } else {
            indices.push(v00, v01, v10, v10, v01, v11);
          }
        }
      }
    };

    for (let j = 0; j < CELLS; j++) {
      for (let i = 0; i < CELLS; i++) {
        const c = (j * CELLS + i) * 4;
        const x0 = -MAP_HALF + i * CELL;
        const z0 = -MAP_HALF + j * CELL;
        const x1 = x0 + CELL;
        const z1 = z0 + CELL;

        // +X neighbour: shared edge is x = x1, from z0 to z1.
        if (i < CELLS - 1) {
          const n = (j * CELLS + i + 1) * 4;
          const mineA = f.corners[c + 1];
          const mineB = f.corners[c + 2];
          const theirA = f.corners[n];
          const theirB = f.corners[n + 3];
          if (mineA - theirA > WALL_EPS || mineB - theirB > WALL_EPS) {
            emitWall(x1, z0, x1, z1, mineA, mineB, theirA, theirB, 1, 0, true);
          } else if (theirA - mineA > WALL_EPS || theirB - mineB > WALL_EPS) {
            emitWall(x1, z0, x1, z1, theirA, theirB, mineA, mineB, -1, 0, false);
          }
        }

        // +Z neighbour: shared edge is z = z1, from x0 to x1.
        if (j < CELLS - 1) {
          const n = ((j + 1) * CELLS + i) * 4;
          const mineA = f.corners[c + 3];
          const mineB = f.corners[c + 2];
          const theirA = f.corners[n];
          const theirB = f.corners[n + 1];
          if (mineA - theirA > WALL_EPS || mineB - theirB > WALL_EPS) {
            emitWall(x0, z1, x1, z1, mineA, mineB, theirA, theirB, 0, 1, false);
          } else if (theirA - mineA > WALL_EPS || theirB - mineB > WALL_EPS) {
            emitWall(x0, z1, x1, z1, theirA, theirB, mineA, mineB, 0, -1, true);
          }
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('aAo', new THREE.Float32BufferAttribute(aos, 1));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    geo.name = 'terrain.cliffs';
    return geo;
  }

  // ── Service ────────────────────────────────────────────────────────────────

  private normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const e = 1;
    const hL = this.field.heightAt(x - e, z);
    const hR = this.field.heightAt(x + e, z);
    const hD = this.field.heightAt(x, z - e);
    const hU = this.field.heightAt(x, z + e);
    return out.set(hL - hR, 2 * e, hD - hU).normalize();
  }

  dispose(): void {
    this.ground.geometry.dispose();
    this.cliffs.geometry.dispose();
    this.groundMat.dispose();
    this.cliffMat.dispose();
    this.ground.removeFromParent();
    this.cliffs.removeFromParent();
    activeField = null;
  }
}

export { MAP_SIZE, CELLS };
