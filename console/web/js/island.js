// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// The island's ground for a plan: the slab, its rim, the cluster's name and
// one tile per district (an atespace, or in worker view a worker platform
// and the parked area), with dots for the room left in each. Rebuilt when
// the plan, the theme or the grouping changes; clearGroup disposes the old
// one completely. Labels and text come from factories (CSS2D and canvas in
// the browser), so node tests can build ground without a DOM.

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { slotPosition, labelAnchor } from './layout.js';

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

export function roundedRect(w, d, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -d / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + d - r);
  s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  s.lineTo(x + r, y + d);
  s.quadraticCurveTo(x, y + d, x, y + d - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/**
 * A deck's rim: a closed outline of shape at height y, a constant RIM_PX
 * wide on screen. WebGL lines are always 1 px, so they read thick or faint
 * by angle and distance; Line2 draws screen-space quads instead.
 */
export const RIM_PX = 2;
export function rimLine(shape, segments, cx, y, cz, mat) {
  const pts = shape.getPoints(segments);
  pts.push(pts[0]);
  const geo = new LineGeometry().setPositions(pts.flatMap((p) => [p.x + cx, y, p.y + cz]));
  return new Line2(geo, mat);
}

// Glowing (additive) rims are dimmed to keep the bloom off the wider line
// near what it was on the 1 px one; full brightness, it beads where the
// unantialiased line steps from 2 to 3 px.
const RIM_GLOW = 0.6;
export function rimMaterial(color, opacity, blending) {
  const c = new THREE.Color(color);
  if (blending === THREE.AdditiveBlending) c.multiplyScalar(RIM_GLOW);
  return new LineMaterial({ color: c, linewidth: RIM_PX, transparent: opacity < 1, opacity, blending });
}

/** Removes and disposes everything under group (geometries, materials, textures, labels). */
export function clearGroup(group) {
  for (const child of [...group.children]) {
    group.remove(child);
    child.traverse?.((o) => {
      o.geometry?.dispose();
      for (const m of [o.material].flat()) {
        m?.map?.dispose();
        m?.dispose();
      }
      if (o.isCSS2DObject) o.element.remove();
    });
  }
}

/**
 * Room dots: world-sized points that fade out where agent cells get too
 * small on screen (the far tiles take over there), instead of turning
 * into moire. look: the scene's level-of-detail uniforms (uScale, uFarLo,
 * uFarHi); without them the dots always show.
 */
function dotMaterial(color, size, look = {}, fade = null) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uSize: { value: size },
      uScale: look.uScale || { value: 600 },
      uFarLo: look.uFarLo || { value: 0 },
      uFarHi: look.uFarHi || { value: 0.001 },
      uFade: fade || { value: 1 },
    },
    vertexShader: `uniform float uSize; uniform float uScale; uniform float uFarLo; uniform float uFarHi; varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float d = max(-mv.z, 0.01);
        float px = 1.5 * uScale / d;
        vA = smoothstep(uFarLo, uFarHi * 1.6, px) * 0.8;
        // uScale is pixels per unit at depth 1 for the vertical fov; three's
        // PointsMaterial (which these replace) used half the canvas height.
        gl_PointSize = max(uSize * uScale * 0.384 / d, 1.0);
        gl_Position = projectionMatrix * mv;
        if (vA < 0.01) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }`,
    fragmentShader: `uniform vec3 uColor; uniform float uFade; varying float vA;
      void main() {
        vec2 c = gl_PointCoord * 2.0 - 1.0;
        if (dot(c, c) > 1.0) discard;
        gl_FragColor = vec4(uColor, vA * uFade);
      }`,
  });
}

/** Above this many worker platforms, platforms get labels from the scene's pool instead of one each. */
export const MAX_PLATFORM_LABELS = 64;

/**
 * Builds the ground for a plan into group (cleared first). Every district
 * tile is one instance of a single InstancedMesh, every outline is in one
 * LineSegments and every room dot in one Points (two: worker platforms get
 * bigger dots), so the ground costs a handful of draw calls whether it has
 * 16 districts or 2,000 worker platforms. Pool and node frames (worker
 * view, and the pad area's pools in atespace view) are tiles too.
 * @param {THREE.Group} group
 * @param {{width: number, depth: number, districts: Map, frames?: object[], padFrames?: object[], padDepth?: number}} plan
 * @param {object} theme
 * @param {{cluster: string, blending: number, makeLabel: (cls: string) => THREE.Object3D, makeText: (text: string, opts: object) => THREE.Mesh, look?: object, glass?: boolean, noPadRow?: boolean, fade?: {value: number}}} opts
 *   glass: a see-through slab and tiles (the decks layout's agent deck); noPadRow: no room for worker pads at the front
 * @returns {{width: number, depth: number, cx: number, cz: number, rowZ: number, outline: THREE.Shape, glass: {mat: THREE.Material, opacity: number}[]}}
 *   the island (center and size), the z of the worker pad row (atespace view) and the glass materials
 */
export function buildGround(group, plan, theme, opts) {
  clearGroup(group);
  const { width, depth, districts } = plan;
  // Room at the front for the worker pad area and the cluster's name; in
  // worker view the pads sit on their platforms, so only the name needs it.
  const ds = [...districts.values()];
  const padRow = !ds.some((d) => d.kind === 'worker') && !opts.noPadRow;
  const padDepth = plan.padDepth ?? 3;
  const extra = padRow ? 8 + padDepth : 6.5;
  const islandW = width + 9;
  const islandD = depth + extra;
  const island = { width: islandW, depth: islandD, cx: -1.2, cz: padRow ? (extra - 5.8) / 2 : 0.35, rowZ: depth / 2 + 3.2 };

  // The slab.
  const shape = roundedRect(islandW, islandD, Math.min(3.5 + Math.max(islandW, islandD) * 0.004, 8));
  island.outline = shape;
  const slabGeo = new THREE.ExtrudeGeometry(shape, { depth: 1.4, bevelEnabled: true, bevelThickness: 0.35, bevelSize: 0.35, bevelSegments: 3, curveSegments: 12 });
  slabGeo.rotateX(Math.PI / 2);
  const light = !theme.glow.additive;
  const blend = opts.blending;
  // Glass (the decks layout's agent deck): see-through, so the worker deck
  // below shows; island.glass lists the materials and their opacity for
  // the deck fade.
  const glass = !!opts.glass;
  island.glass = [];
  // The glass is tinted toward the rim color so it reads as a pane, not a
  // hole (dark themes' island and sea colors are close).
  const glassy = (mat, opacity) => {
    if (!glass) return mat;
    mat.transparent = true;
    mat.depthWrite = false;
    mat.opacity = opacity;
    if (mat.color && mat.emissive) {
      mat.color.lerp(new THREE.Color(theme.island.edge), light ? 0.06 : 0.16);
      mat.emissive.set(theme.island.edge).multiplyScalar(light ? 0 : 0.035);
    }
    island.glass.push({ mat, opacity });
    return mat;
  };
  const slab = new THREE.Mesh(slabGeo, [
    glassy(new THREE.MeshStandardMaterial({ color: theme.island.fill, roughness: light ? 0.9 : 0.8, metalness: light ? 0 : 0.2 }), light ? 0.55 : 0.5),
    glassy(new THREE.MeshStandardMaterial({ color: theme.island.side, roughness: light ? 0.9 : 0.8, metalness: light ? 0 : 0.2 }), light ? 0.4 : 0.35),
  ]);
  if (glass) slab.renderOrder = -1;
  slab.position.set(island.cx, -0.4, island.cz);
  slab.receiveShadow = true;
  group.add(slab);

  // Glowing rim around the top edge.
  const rimMat = rimMaterial(theme.island.edge, theme.island.edgeAlpha, blend);
  rimMat.transparent = true;
  group.add(rimLine(shape, 96, island.cx, 0.0, island.cz, rimMat));
  if (glass) island.glass.push({ mat: rimMat, opacity: rimMat.opacity });

  // Cluster name along the front edge, larger on big islands.
  const nameSize = Math.min(1.5 * Math.max(1, islandW / 160), 8);
  const name = opts.makeText(opts.cluster || 'cluster', { size: nameSize, color: theme.island.label });
  name.material.opacity = 0.75;
  if (glass) island.glass.push({ mat: name.material, opacity: 0.75 });
  const nameW = name.geometry.parameters?.width ?? 0;
  name.position.set(island.cx - islandW / 2 + 2.4 + nameW / 2, 0.03, island.cz + islandD / 2 - 1.3 - (nameSize - 1.5) / 2);
  group.add(name);

  // Frames first (under the platforms), then districts.
  const frames = [...(plan.frames || []), ...(plan.padFrames || [])];
  const tiles = [];
  for (const f of frames) {
    const pool = f.kind === 'pool';
    tiles.push({ x: f.x, z: f.z, w: f.w, d: f.d, y: pool ? 0.02 : 0.04, h: pool ? 0.04 : 0.04, color: new THREE.Color(theme.district.fill).offsetHSL(0, 0, pool ? -0.02 : 0.015), edge: theme.district.edge, edgeA: theme.district.edgeAlpha * (pool ? 0.7 : 0.4) });
  }
  for (const d of ds) {
    // A small per-district hue shift so neighbours read apart; the parked
    // area is plainer, a holding yard rather than a place.
    const parked = d.kind === 'parked';
    const jitter = parked ? 0 : (hashString(d.name) - 0.5) * theme.district.fillJitter;
    const color = new THREE.Color(parked ? theme.worker.parked : theme.district.fill).offsetHSL(jitter, 0, 0);
    const edgeColor = new THREE.Color(d.kind === 'worker' ? theme.worker.padEdge : theme.district.edge).offsetHSL(jitter, 0, 0);
    tiles.push({ x: d.x, z: d.z, w: d.w, d: d.d, y: 0.06, h: 0.12, color, edge: edgeColor, edgeA: theme.district.edgeAlpha * (parked ? 0.5 : 1) });
  }
  const tileMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    glassy(new THREE.MeshStandardMaterial({ roughness: light ? 0.9 : 0.7, metalness: light ? 0 : 0.2 }), light ? 0.7 : 0.68),
    Math.max(1, tiles.length),
  );
  tileMesh.count = tiles.length;
  tileMesh.receiveShadow = true;
  tileMesh.frustumCulled = false;
  const m4 = new THREE.Matrix4();
  // Outlines: the top rectangle of every tile, one vertex color (with alpha) each.
  const lp = new Float32Array(tiles.length * 8 * 3);
  const lc = new Float32Array(tiles.length * 8 * 4);
  const ec = new THREE.Color();
  tiles.forEach((t, i) => {
    m4.makeScale(t.w, t.h, t.d).setPosition(t.x + t.w / 2, t.y, t.z + t.d / 2);
    tileMesh.setMatrixAt(i, m4);
    tileMesh.setColorAt(i, t.color);
    const y = t.y + t.h / 2 + 0.01;
    const x0 = t.x - 0.02;
    const x1 = t.x + t.w + 0.02;
    const z0 = t.z - 0.02;
    const z1 = t.z + t.d + 0.02;
    const segs = [x0, z0, x1, z0, x1, z0, x1, z1, x1, z1, x0, z1, x0, z1, x0, z0];
    ec.set(t.edge);
    for (let k = 0; k < 8; k++) {
      lp.set([segs[k * 2], y, segs[k * 2 + 1]], (i * 8 + k) * 3);
      lc.set([ec.r, ec.g, ec.b, t.edgeA], (i * 8 + k) * 4);
    }
  });
  group.add(tileMesh);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(lp, 3));
  lineGeo.setAttribute('color', new THREE.BufferAttribute(lc, 4));
  const lineMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: blend });
  if (glass) island.glass.push({ mat: lineMat, opacity: 1 });
  const lines = new THREE.LineSegments(lineGeo, lineMat);
  lines.frustumCulled = false;
  group.add(lines);

  // Cell dots so empty capacity reads as "room" (on a worker platform:
  // its slots). One Points for districts, one for worker platforms.
  for (const workerDots of [false, true]) {
    const set = ds.filter((d) => (d.kind === 'worker') === workerDots);
    const n = set.reduce((a, d) => a + (d.shown ?? d.capacity), 0);
    if (!n) continue;
    const dots = new Float32Array(n * 3);
    let o = 0;
    for (const d of set) {
      const k = d.shown ?? d.capacity;
      for (let s = 0; s < k; s++) {
        const p = slotPosition(d, s);
        dots[o++] = p.x;
        dots[o++] = 0.125;
        dots[o++] = p.z;
      }
    }
    const dotGeo = new THREE.BufferGeometry();
    dotGeo.setAttribute('position', new THREE.BufferAttribute(dots, 3));
    const pts = new THREE.Points(dotGeo, dotMaterial(theme.district.dots, workerDots ? 0.16 : 0.12, opts.look, opts.fade));
    pts.frustumCulled = false;
    group.add(pts);
  }

  // Labels: one per atespace district and the parked area; one per worker
  // platform while there are few (the scene lends pooled labels to the
  // platforms in view beyond that); one per pool frame.
  const platforms = ds.filter((d) => d.kind === 'worker').length;
  for (const d of ds) {
    d.label = null;
    if (d.kind === 'worker' && platforms > MAX_PLATFORM_LABELS) continue;
    const label = opts.makeLabel('district-label');
    label.element.classList?.add(d.kind);
    const at = labelAnchor(d);
    label.position.set(at.x, 0.2, at.z);
    label.center?.set(0, 1);
    group.add(label);
    d.label = label.element;
  }
  for (const f of frames) {
    f.label = null;
    if (f.kind !== 'pool') continue;
    const label = opts.makeLabel('district-label');
    label.element.classList?.add('pool');
    label.position.set(f.x + 0.5, 0.2, f.z + (f.strip ?? 2) / 2);
    label.center?.set(0, 0.5);
    group.add(label);
    f.label = label.element;
  }
  return island;
}

/**
 * Builds the decks layout's worker deck into group (cleared first; the
 * scene sets the group's height): an opaque slab under the pads, its rim,
 * the deck's name along the front edge, and one framed tile per node pool
 * (when there are several) with a label. The pads themselves are the
 * scene's WorkerPads. Every material is listed in deck.mats with its
 * opacity, for the deck fade.
 * @param {THREE.Group} group
 * @param {{width: number, depth: number, cx: number, cz: number, frames: object[]}} deck from decks.js planWorkerDeck
 * @param {object} theme
 * @param {{blending: number, makeLabel: (cls: string) => THREE.Object3D, makeText: (text: string, opts: object) => THREE.Mesh}} opts
 * @returns {{width: number, depth: number, cx: number, cz: number, mats: {mat: THREE.Material, opacity: number}[]}}
 */
export function buildWorkerDeck(group, deck, theme, opts) {
  clearGroup(group);
  const light = !theme.glow.additive;
  const out = { width: deck.width, depth: deck.depth, cx: deck.cx, cz: deck.cz, mats: [] };
  const fading = (mat, opacity = 1) => {
    mat.transparent = opacity < 1;
    mat.opacity = opacity;
    out.mats.push({ mat, opacity });
    return mat;
  };
  const shape = roundedRect(deck.width, deck.depth, Math.min(3 + Math.max(deck.width, deck.depth) * 0.004, 7));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 1.0, bevelEnabled: true, bevelThickness: 0.3, bevelSize: 0.3, bevelSegments: 2, curveSegments: 10 });
  geo.rotateX(Math.PI / 2);
  const fill = new THREE.Color(theme.island.fill).offsetHSL(0, 0, light ? -0.03 : 0.025);
  // The opaque surfaces under the deck's outlines are pushed back in depth
  // (polygon offset): zoomed out, the depth buffer can't tell a line a few
  // hundredths above a face from the face, and the outline breaks into dashes.
  const under = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
  const slab = new THREE.Mesh(geo, [
    fading(new THREE.MeshStandardMaterial({ color: fill, roughness: light ? 0.9 : 0.75, metalness: light ? 0 : 0.25, ...under })),
    fading(new THREE.MeshStandardMaterial({ color: theme.island.side, roughness: light ? 0.9 : 0.75, metalness: light ? 0 : 0.25, ...under })),
  ]);
  slab.position.set(deck.cx, -0.3, deck.cz);
  slab.receiveShadow = true;
  group.add(slab);
  // The slab's top is at y = 0; the rim floats just above it, like the agent deck's.
  group.add(rimLine(shape, 64, deck.cx, 0.05, deck.cz, fading(rimMaterial(theme.worker.padEdge, 1, opts.blending), theme.island.edgeAlpha)));
  // The deck's name along its front edge.
  const nameSize = Math.min(1.3 * Math.max(1, deck.width / 120), 6);
  const name = opts.makeText('workers', { size: nameSize, color: theme.island.label });
  fading(name.material, 0.6);
  const nameW = name.geometry.parameters?.width ?? 0;
  name.position.set(deck.cx - deck.width / 2 + 2 + nameW / 2, 0.03, deck.cz + deck.depth / 2 - 1.1 - (nameSize - 1.3) / 2);
  group.add(name);
  // Pool frames: flat tiles with outlines, one instanced mesh.
  const frames = deck.frames || [];
  if (frames.length) {
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), fading(new THREE.MeshStandardMaterial({ roughness: light ? 0.9 : 0.7, metalness: light ? 0 : 0.2, ...under })), frames.length);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color(theme.district.fill).offsetHSL(0, 0, light ? -0.02 : 0.01);
    const lp = new Float32Array(frames.length * 8 * 3);
    frames.forEach((f, i) => {
      m4.makeScale(f.w, 0.06, f.d).setPosition(f.x + f.w / 2, 0.03, f.z + f.d / 2);
      mesh.setMatrixAt(i, m4);
      mesh.setColorAt(i, col);
      const y = 0.07;
      const segs = [f.x, f.z, f.x + f.w, f.z, f.x + f.w, f.z, f.x + f.w, f.z + f.d, f.x + f.w, f.z + f.d, f.x, f.z + f.d, f.x, f.z + f.d, f.x, f.z];
      for (let k = 0; k < 8; k++) lp.set([segs[k * 2], y, segs[k * 2 + 1]], (i * 8 + k) * 3);
    });
    group.add(mesh);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(lp, 3));
    const lines = new THREE.LineSegments(lg, fading(new THREE.LineBasicMaterial({ color: theme.district.edge, blending: opts.blending }), theme.district.edgeAlpha * 0.8));
    lines.frustumCulled = false;
    group.add(lines);
  }
  for (const f of frames) {
    f.label = null;
    const label = opts.makeLabel('district-label');
    label.element.classList?.add('pool', 'lower');
    label.position.set(f.x + 0.5, 0.2, f.z + (f.strip ?? 2) / 2);
    label.center?.set(0, 0.5);
    group.add(label);
    f.label = label.element;
  }
  return out;
}
