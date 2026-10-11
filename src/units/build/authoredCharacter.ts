/**
 * Authored characters. Owner: CHARACTERS.
 *
 * A character that arrives from an artist already has the three things this
 * project generates badly: a skeleton placed by hand, skin weights painted by
 * hand, and animation authored rather than derived. The sensible thing is to
 * use all three and contribute nothing.
 *
 * So this path does not touch `rig/rig.ts`, `anim/clips.ts` or the proximity
 * weighting. It loads the file, normalises it to the roster's height, and hands
 * the mesh and its own clips to `bakeImportedVat`, which produces exactly the
 * textures the instanced creep renderer already consumes. Everything downstream
 * is unchanged.
 *
 * ## What a file has to arrive as
 *
 * - **One GLB**, mesh and texture together.
 * - **Under 16,384 vertices**, and realistically far under: the vertex
 *   animation texture is one texel per vertex per frame, so a creature's whole
 *   animation set costs `vertices x frames x 16` bytes. Around 2,000 vertices
 *   is 6 MB, which is the same order as a procedural creep.
 * - **Clips named with our ids** (`idle`, `walk`, `run`, `attack`, `cast`,
 *   `hit`, `death`). A missing id falls back to `idle`.
 *
 * Downloads rarely arrive that way. `tools/` holds the conversion: merge the
 * submeshes, weld (a split FBX commonly carries six times the vertices it
 * needs), decimate carrying the skin attributes, trim each clip to the window
 * that actually holds motion, and write one GLB.
 *
 * Licences for everything under `public/models/` are recorded in
 * `public/models/LICENSES.md`. An asset without a recorded licence must not be
 * used -- see the asset policy in ARCHITECTURE.md.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CLIP_IDS, type ClipId } from '../anim/clips';
import type { ImportedSource } from '../anim/vatImported';

/**
 * A rigid object that rides on one of the character's bones.
 *
 * Bound to a single bone at full weight, which is the whole reason this works:
 * nothing is interpolated, so nothing deforms, and the piece follows every clip
 * for free because the clips move the bone. It is how the orc's axe behaves,
 * except the orc's came rigged inside its own pack and these are separate files
 * -- a hero generated from a portrait has to be generated with empty hands or
 * the auto-rigger reads the weapon as a limb.
 *
 * `scale`, `rot` and `pos` are in the BONE's own space, which is the
 * character's unscaled authoring space, not metres. See the note where they
 * are set in the manifest.
 */
export interface AuthoredAttachment {
  /** Path under `public/`, e.g. `/models/parts/bulwark-hammer.glb`. */
  url: string;
  /** Exact bone name to ride on, e.g. `CC_Base_R_Hand`. */
  bone: string;
  /** Uniform scale in the bone's space. */
  scale: number;
  /** XYZ Euler in radians. */
  rot?: [number, number, number];
  /** Offset in the bone's space, applied after the rotation. */
  pos?: [number, number, number];
}

export interface AuthoredEntry {
  url: string;
  /** Height in metres the character is scaled to, measured on its own box. */
  height: number;
  /** Yaw in radians for a character not authored facing +Z, the way the engine faces. */
  yawOffset?: number;
  /** Rigid pieces carried on named bones: weapons, shields, a halo. */
  attachments?: AuthoredAttachment[];
  /**
   * Closes the hands, because the motions do not.
   *
   * ActorCore's clips are body mocap and leave the fingers dead straight: the
   * middle finger measures a tip-to-knuckle ratio of 0.96 out of a possible
   * 1.0. A hand like that cannot hold anything -- a weapon placed perfectly
   * inside it still reads as resting against an open palm, which is what four
   * rounds of moving the weapon failed to fix because the weapon was never the
   * problem.
   *
   * `match` picks the finger bones, `angle` is radians per joint. The axis is
   * Z and its sign mirrors per side; both were found by sweeping every axis
   * and measuring which one shortened that ratio, not by assuming a
   * convention.
   */
  fists?: { match: string; angle: number };
  /**
   * Turns on a bone every frame, after the clip has written it.
   *
   * Not the same thing as `fists`, and the difference is why this exists. A
   * static pose set at load survives only where the clips do not animate that
   * bone -- fingers, once their tracks are stripped. An arm IS animated, and
   * stripping its tracks would throw the animation away, so the only place a
   * nudge can live is after the mixer has run.
   *
   * It is what "move the arm" means: the shield stays where it belongs on the
   * arm and the arm opens, instead of the shield being shoved off the body.
   */
  boneNudges?: { bone: string; axis: [number, number, number]; angle: number }[];
}

/**
 * Character id -> file. A character absent from here uses the procedural
 * builder, which is what lets authored creatures arrive one at a time.
 */
export const AUTHORED_MANIFEST: Record<string, AuthoredEntry> = {
  'creep.cleaver': { url: '/models/orc.glb', height: 2.0 },
  'creep.duskrunner': { url: '/models/mutant.glb', height: 2.0 },
  'creep.spinebolt': { url: '/models/erika.glb', height: 1.75 },
  'creep.breaker': { url: '/models/crusader.glb', height: 1.95 },
  // The first hero with authored art. 2.62 is its own `proportions.height`, so
  // the authored Bulwark stands exactly where the procedural one stood and no
  // camera, health bar or selection ring has to be touched.
  // No yawOffset, and the reason is worth keeping: the left toe bone sits 15
  // units forward of its ankle in +Z, so the model faces +Z, and the comment
  // on `yawOffset` above says this manifest wants -Z. A half turn was added on
  // that reading and the owner reported Bulwark walking and swinging
  // backwards. No character had ever set the field, so the convention it
  // documents had never once been exercised. The engine's forward is +Z.
  'hero.bulwark': {
    url: '/models/bulwark.glb',
    height: 2.62,
    // Scale is in bone space, which is the file's own units: this character is
    // 168.7 units tall in the GLB and stands 2.62 m in the game, so one metre
    // is about 64 units. A 1.1 m maul from a 1.9-unit model is therefore
    // 1.1 x 64 / 1.9, near enough 37.
    //
    // The hammer's orientation is stated in the HAND's own space, not solved
    // against a pose, and that distinction is the whole of it. It was first
    // solved as "point down in the idle pose", which happened to leave the
    // haft lying along the forearm's own axis. At rest that reads fine; the
    // moment the arm swings, the weapon continues the line of the arm and the
    // whole limb becomes one pole -- "como si un palo saliese del hombro",
    // which is exactly what it looked like. A transform solved against one
    // pose means something different in every other pose.
    //
    // A fist does not hold a haft along the forearm, it holds it ACROSS the
    // palm -- but across the palm fails the other way round, sticking the haft
    // out horizontally while the arm hangs. Neither end of that range works,
    // and the reason is that these hands are not posed to grip: the clips are
    // body mocap with open, neutral hands, so there is no orientation that is
    // simultaneously right for a weapon at rest and a weapon mid-swing.
    //
    // And it hangs from the FIST, not from the bone. `CC_Base_R_Hand` is the
    // WRIST: measured on this character the closed fist sits 16.5 units beyond
    // it, which is a quarter of a metre at the scale he is drawn. Every
    // placement before this one pinned the haft a quarter of a metre behind
    // the hand, so it read as floating beside the arm whichever way it
    // pointed, and five rounds of changing the angle could never have fixed
    // it. The attach point is now the middle of the second knuckles, taken
    // from the bones after the fists are closed.
    //
    // The last half turn is about the haft's OWN axis. The head is not round:
    // its broad face was pointing forward where it should point back. That is
    // a different quantity from where the haft points, and confusing the two
    // is what made "the hammer is the wrong way round" get read, over and
    // over, as the direction of the shaft.
    //
    // And a hard limit, measured rather than argued: the wrist turns only 12
    // to 35 degrees between the idle and the attack. A weapon bolted to the
    // hand therefore holds very nearly the same angle to the forearm in both,
    // so "hangs along the arm at rest" and "swings clear of the arm" cannot
    // both be had from any fixed transform. The elbow is not the problem --
    // it bends from 115 to 162 degrees in the attack, which was checked
    // before anything was changed; it is the hammer continuing the line of
    // the forearm that makes the bend disappear.
    //
    // ALL SEVEN CLIPS NOW COME FROM ONE SWORD-AND-SHIELD SET, and that is what
    // finally fixed this. Before, the attack was an armed motion and the idle,
    // walk and run were not: one grip cannot serve a hand posed around a
    // weapon and three hands posed around nothing, and every hour spent on
    // the attachment was spent on a contradiction. The armed clips also close
    // the fingers themselves -- 0.776 against the 0.96 the unarmed ones left
    // -- so the synthetic fist is gone.
    //
    // The haft runs straight across the palm, on the hand's own -Z.
    //
    // That is the knuckle line with the finger direction taken out of it. The
    // four knuckles are staggered ALONG the hand as well as across it -- the
    // pinky root sits 6.5 units further out than the index -- so a raw fit
    // through them picks up that stagger and tilts the axis towards the
    // fingers, which is what put the hammer along the forearm. Removing it
    // leaves (0.03, 0, -1), where a handle actually lies in a fist.
    //
    // Aiming at a WORLD direction instead was tried and fails: a rigid
    // attachment follows the hand, and the hand turns a long way between
    // clips, so pointing the head up in the walk put it across his face in
    // the idle. No transform flatters all seven, and none needs to -- this
    // set was authored around a weapon in this grip, so each clip holds it
    // the way the animator posed it.
    //
    // The shield itself is NOT pushed anywhere. Earlier versions shoved it
    // off the body to clear his line of sight, which is not what a shield
    // does and not what was asked for; the ARM opens instead, through
    // `boneNudges` above, and the shield rides on it. Its own transform is
    // then refitted with the arm already open -- without that it turns with
    // the arm and ends up edge-on.
    //
    // A haft in a closed fist lies along the line of the knuckles, and that
    // line can be measured rather than argued about. Fitting it through the
    // four finger roots gives (0.025, 0.664, -0.747) in the hand's own space,
    // passing through (-1.75, 16.99, 1.84), with 1.77 units of scatter -- the
    // knuckles really are collinear. It is identical in all seven clips,
    // because the fingers are posed statically.
    //
    // That axis sits 42 degrees off the arm, which is most of the separation
    // the swing needed, and it was arrived at without anyone's taste. Which
    // end the head goes on, and how it is rolled, were then settled by
    // measuring instead of looking: head down and the striking face pointing
    // back (-0.85 in world Z) is sign +1 with a half turn.
    //
    // The rest pose comes from `public/portraits/Bulwark_fullbody.jpg`, which was
    // in the repository the whole time and which nobody opened until the
    // owner pointed at it. It settles every question that six rounds of
    // guessing could not: the weapon HANGS DOWN at the side, gripped near the
    // top of its haft, head at ankle height; the shield is large -- shoulder
    // to below the knee -- face forward, its inner edge against the body.
    //
    // Held BY THE GRIP: a named point on the prop is where the fist closes and
    // it goes at the hand bone, `position = -rotation * (grip * scale)`. That
    // is why the shield hangs off CC_Base_L_Hand and not the forearm.
    //
    // The shield is gripped at its centre and stood off FORWARD -- along the
    // way he faces -- rather than sideways. Sideways was a misreading of
    // "separarlo del cuerpo": it swung the plate out past his flank, which
    // moved the overlap rather than removing it. Sixteen units forward takes
    // the share of it inside the body to zero, from 7.6 at the same size with
    // no stand-off, and the hand still sits in the hollow behind the face.
    //
    // A limit no placement could fix, now fixed elsewhere: the hands were OPEN. The ActorCore
    // clips leave the fingers straight -- the middle finger measures a
    // tip-to-knuckle ratio of 0.96 -- so nothing closes around a haft. At the
    // game's camera distance a finger is a few pixels and the overlap reads as
    // holding; close up it does not, and it never will without a finger-curl
    // pass over the clips.
    // No `fists` here, deliberately. The armed motion set closes the hands
    // itself -- the middle finger measures 0.776 against the 0.96 the unarmed
    // clips left -- and a grip an animator posed around a weapon beats a
    // synthetic curl. The capability stays in the type for the next character
    // that turns up with open hands.
    // The left arm opens half a radian so the shield rides clear of his own
    // line of sight. Local X negative is the axis, measured: 0.4 radians
    // carries the hand 6.4 units to his left, and the five other directions
    // were tried and move it less or the wrong way.
    boneNudges: [{ bone: 'CC_Base_L_Upperarm', axis: [1, 0, 0], angle: -1.05 }],
    attachments: [
      {
        url: '/models/parts/bulwark-hammer.glb', bone: 'CC_Base_R_Hand',
        scale: 47.63, rot: [-1.603, -0.815, 3.098], pos: [-7.8, 22.3, -8.2],
      },
      {
        url: '/models/parts/bulwark-shield.glb', bone: 'CC_Base_L_Hand',
        scale: 61.95, rot: [-0.563, -0.175, 2.771], pos: [29.2, 85.7, -17],
      },
    ],
  },
};

export interface AuthoredCharacter extends ImportedSource {
  materials: THREE.Material[];
  /** Carried through to the view, which applies them after each mixer tick. */
  boneNudges?: { bone: string; axis: [number, number, number]; angle: number }[];
}

/**
 * Collapses the empty wrapper chains a merged FBX leaves in front of every
 * bone.
 *
 * The conversion in tools/ merges one FBX per animation, and each merge left
 * an empty Object3D in front of every bone. They nest, so the real ork_Hips
 * sits at the end of a chain of forty ork_Hips_N wrappers, and the same holds
 * for all 136 bones: 5,684 nodes to express a skeleton of 136.
 *
 * That cost lands twice. Every clone of the character allocates and walks all
 * 5,684 nodes each frame, which is what made five orcs stutter. And three
 * binds animation tracks to nodes BY NAME, so the wrappers put eleven bone
 * names in play twice and a track could bind to a node that drives no
 * vertices, which is the likeliest reason a weapon stops following the hand.
 *
 * Splicing out every wrapper takes the orc to 371 nodes with no duplicated
 * bone name left, no animation track unresolved, and the walk stride
 * unchanged at 0.328 m. A node is only spliced when it is not a bone, not a
 * mesh, has exactly one child, and is named by no animation track, so this is
 * safe on a file that does not have the problem: nothing matches and nothing
 * moves.
 *
 * The asset should really be exported without them. This runs at load because
 * it is cheap, it is general, and it does not need the file rebuilt.
 */
function pruneToSkeleton(
  root: THREE.Object3D,
  mesh: THREE.SkinnedMesh,
  clips: readonly THREE.AnimationClip[],
): number {
  const bones = new Set<THREE.Object3D>(mesh.skeleton.bones);
  // A node an animation track names has to survive, whatever else it looks
  // like, or the track silently stops driving anything.
  const animated = new Set<string>();
  for (const clip of clips) {
    for (const track of clip.tracks) animated.add(track.name.split('.')[0]!);
  }

  const splice = (node: THREE.Object3D): boolean => {
    const parent = node.parent;
    if (!parent || node === root) return false;
    if (bones.has(node) || (node as THREE.Mesh).isMesh) return false;
    if (node.children.length !== 1) return false;
    if (animated.has(node.name)) return false;
    const child = node.children[0]!;

    // Only an identity wrapper may go, and that restriction is not caution, it
    // is correctness. Folding a wrapper's transform into its child lasts
    // exactly until an animation track writes that child's position and
    // quaternion, which it does every frame, throwing the folded-in value away.
    // The body survived it because these wrappers are identity; anything that
    // was not would have been silently dropped, which is how the props ended up
    // detached from the orc.
    node.updateMatrix();
    const e = node.matrix.elements;
    const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (let i = 0; i < 16; i++) if (Math.abs(e[i]! - IDENTITY[i]!) > 1e-6) return false;

    parent.add(child);
    node.removeFromParent();
    return true;
  };

  let removed = 0;
  // Repeat until the tree stops shrinking: the chains are nested, so collapsing
  // one link exposes the next.
  for (;;) {
    const candidates: THREE.Object3D[] = [];
    root.traverse((o) => candidates.push(o));
    let cut = 0;
    for (const node of candidates) if (splice(node)) cut++;
    removed += cut;
    if (cut === 0) break;
  }
  return removed;
}

const loader = new GLTFLoader();
const loaded = new Map<string, AuthoredCharacter>();
const warned = new Set<string>();

export function hasAuthored(id: string): boolean {
  return loaded.has(id);
}

export function getAuthored(id: string): AuthoredCharacter | null {
  return loaded.get(id) ?? null;
}

/**
 * Loads every manifested character.
 *
 * Runs at boot, before anything can spawn, because the bake is synchronous and
 * a character that arrives late would simply be absent from a batch already
 * built. Never rejects: a file that fails to load leaves its creature on the
 * procedural builder.
 */
export async function preloadAuthored(): Promise<void> {
  await Promise.all(
    Object.entries(AUTHORED_MANIFEST).map(async ([id, entry]) => {
      try {
        const gltf = await loader.loadAsync(entry.url);
        const root = gltf.scene;
        let mesh: THREE.SkinnedMesh | null = null;
        root.traverse((o) => {
          if (!mesh && (o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh;
        });
        if (!mesh) throw new Error('no skinned mesh in the file');
        const skinned: THREE.SkinnedMesh = mesh;

        pruneToSkeleton(root, skinned, gltf.animations);

        // Attachments go on AFTER the prune, which walks the tree removing
        // anything the skeleton does not need and would take a hammer with it,
        // and BEFORE the measurement below, which must see the character alone:
        // a maul held overhead would otherwise count towards his height and
        // shrink him to compensate.
        root.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(root);
        const size = box.getSize(new THREE.Vector3());
        root.scale.setScalar(entry.height / Math.max(size.y, 1e-6));
        // Same once-only pattern the loader already uses below, so a bad
        // attachment names itself once instead of every frame.
        const say = (key: string, line: string) => {
          if (warned.has(key)) return;
          warned.add(key);
          console.warn(line);
        };
        for (const att of entry.attachments ?? []) {
          let bone: THREE.Bone | null = null;
          root.traverse((o) => {
            if (!bone && (o as THREE.Bone).isBone && o.name === att.bone) bone = o as THREE.Bone;
          });
          if (!bone) {
            say(`${id}:${att.bone}`, `[authored] ${id}: no bone named ${att.bone}`);
            continue;
          }
          try {
            const part = await loader.loadAsync(att.url);
            const holder = new THREE.Group();
            holder.name = `attach:${att.bone}`;
            holder.scale.setScalar(att.scale);
            if (att.rot) holder.rotation.set(att.rot[0], att.rot[1], att.rot[2]);
            if (att.pos) holder.position.set(att.pos[0], att.pos[1], att.pos[2]);
            part.scene.traverse((o) => {
              const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
              if (m && m.map) m.map.colorSpace = THREE.SRGBColorSpace;
            });
            holder.add(part.scene);
            (bone as THREE.Bone).add(holder);
          } catch (err) {
            say(`${id}:${att.url}`, `[authored] ${id}: ${att.url} failed: ${String(err)}`);
          }
        }
        if (entry.yawOffset) root.rotation.y += entry.yawOffset;
        root.updateMatrixWorld(true);

        if (entry.fists) {
          const rx = new RegExp(entry.fists.match, 'i');
          const axis = new THREE.Vector3(0, 0, 1);
          let closed = 0;
          root.traverse((o) => {
            if (!(o as THREE.Bone).isBone || !rx.test(o.name)) return;
            const sign = o.name.includes('_R_') ? 1 : -1;
            o.quaternion.multiply(
              new THREE.Quaternion().setFromAxisAngle(axis, sign * entry.fists!.angle),
            );
            closed++;
          });
          // And the clips lose their finger tracks. Without this the pose above
          // survives exactly one frame: every clip carries rotation tracks for
          // all thirty finger joints and would straighten them again the moment
          // the mixer ran.
          for (const clip of gltf.animations) {
            clip.tracks = clip.tracks.filter((track) => !rx.test(track.name.split('.')[0]));
          }
          if (closed === 0 && !warned.has(`${id}:fists`)) {
            warned.add(`${id}:fists`);
            console.warn(`[authored] ${id}: fists.match matched no bones`);
          }
          root.updateMatrixWorld(true);
        }

        const clips = new Map<ClipId, THREE.AnimationClip>();
        const byName = new Map(gltf.animations.map((c) => [c.name, c]));
        for (const cid of CLIP_IDS) {
          const clip = byName.get(cid);
          if (clip) clips.set(cid, clip);
        }
        if (clips.size === 0 && gltf.animations.length > 0) {
          clips.set('idle', gltf.animations[0]!);
        }
        if (clips.size === 0) throw new Error('no clips in the file');

        // A character can carry more than one material: this orc has one for
        // the body and one for its axes, each with its own texture, drawn as
        // two groups of the same mesh. Keeping only the first would leave the
        // second group's triangles pointing at a material that is not there.
        const materials = (
          Array.isArray(skinned.material) ? skinned.material : [skinned.material]
        ) as THREE.MeshStandardMaterial[];
        // Tone mapping happens in the composer, so an imported colour map has
        // to be flagged sRGB or the character renders washed out.
        for (const material of materials) {
          if (material.map) material.map.colorSpace = THREE.SRGBColorSpace;
        }

        loaded.set(id, { root, mesh: skinned, clips, materials, boneNudges: entry.boneNudges });
      } catch (err) {
        if (!warned.has(id)) {
          warned.add(id);
          console.warn(
            `[authored] ${id}: could not load ${entry.url}, using the procedural builder`,
            err,
          );
        }
      }
    }),
  );
}
