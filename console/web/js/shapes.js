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

// Agent shapes: one low-poly geometry per shape (shared by every state's
// InstancedMesh), the pose of each visual class (where the agent stands, how
// it lies when suspended, how it tips over when crashed), and the motion the
// agent shader adds on top (bob, spin, wobble, visor). Pure three.js, no DOM,
// so node tests can build every shape.
//
// A pose is two numbers that the scene animates between classes:
//   h    lift: 1 is "up and running", 0 is "down" (box: the column height)
//   tip  0 standing, 1 tipped over (crashed)

import * as THREE from 'three';

/** Height of the agent's tile top: every shape stands on it. */
export const FLOOR = 0.12;

/** The old column heights per class (the box shape). */
const BOX_HEIGHT = { running: 1.9, transition: 1.0, suspended: 0.16, crashed: 1.1, pending: 0.7 };

/** Default pose per class for the shapes that lift and lie down. */
const LIFT_POSE = {
  running: { h: 1, tip: 0 },
  transition: { h: 0.55, tip: 0 },
  suspended: { h: 0, tip: 0 },
  crashed: { h: 0.15, tip: 1 },
  pending: { h: 0.45, tip: 0 },
};

/** Motion per class: bob (orb), spin (spark), wobble (meeple), visor (droid). */
const STILL = { bob: 0, spin: 0, wobble: 0, visor: 0, flicker: 0 };

function motion(over) {
  const out = {};
  for (const cls of ['running', 'transition', 'suspended', 'crashed', 'pending']) out[cls] = { ...STILL, ...(over[cls] || {}) };
  return out;
}

const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const e = new THREE.Euler(0, 0, 0, 'ZXY');
const v = new THREE.Vector3();
const s = new THREE.Vector3();

/** Writes translate(x,y,z) * rotZ(rz) * rotX(rx) * scale(sx,sy,sz) into arr at o. */
function compose(arr, o, x, y, z, rx, rz, sx, sy, sz) {
  e.set(rx, 0, rz);
  q.setFromEuler(e);
  m4.compose(v.set(x, y, z), q, s.set(sx, sy, sz));
  m4.toArray(arr, o);
}

/** Moves a geometry so it is centered on x/z and its lowest point is y=0. */
function standOnFloor(geo) {
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  geo.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
  return geo;
}

/** Centers a geometry on the origin. */
function centered(geo) {
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  geo.translate(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, -(b.min.z + b.max.z) / 2);
  return geo;
}

/** Normals and bounds for a finished geometry. */
function finish(geo) {
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

// ------------------------------------------------------------------ shapes

/** Board-game meeple: an extruded, bevelled person silhouette. */
function meepleGeometry() {
  const k = 0.88;
  const p = (x, y) => [x * k, y * k];
  const sh = new THREE.Shape();
  sh.moveTo(...p(0, 0.2));
  sh.lineTo(...p(0.1, 0));
  sh.lineTo(...p(0.44, 0));
  sh.quadraticCurveTo(...p(0.32, 0.25), ...p(0.25, 0.5));
  sh.quadraticCurveTo(...p(0.36, 0.52), ...p(0.5, 0.58));
  sh.quadraticCurveTo(...p(0.6, 0.72), ...p(0.44, 0.77));
  sh.quadraticCurveTo(...p(0.26, 0.8), ...p(0.14, 0.84));
  sh.absarc(0, 1.0 * k, 0.21 * k, -0.87, Math.PI + 0.87, false);
  sh.quadraticCurveTo(...p(-0.26, 0.8), ...p(-0.44, 0.77));
  sh.quadraticCurveTo(...p(-0.6, 0.72), ...p(-0.5, 0.58));
  sh.quadraticCurveTo(...p(-0.36, 0.52), ...p(-0.25, 0.5));
  sh.quadraticCurveTo(...p(-0.32, 0.25), ...p(-0.44, 0));
  sh.lineTo(...p(-0.1, 0));
  sh.lineTo(...p(0, 0.2));
  const geo = new THREE.ExtrudeGeometry(sh, { depth: 0.24, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.045, bevelSegments: 1, curveSegments: 3 });
  return finish(standOnFloor(geo));
}

/** Rounded capsule; the visor band is drawn by the shader (VISOR). */
function droidGeometry() {
  const geo = new THREE.CapsuleGeometry(0.33, 0.48, 3, 10);
  return finish(standOnFloor(geo));
}

/** A low-poly sphere. */
function orbGeometry() {
  return finish(centered(new THREE.IcosahedronGeometry(0.4, 2)));
}

/** Gemini-style four-point star with curved, concave sides. */
function sparkGeometry() {
  const R = 0.56;
  const W = 0.44;
  const c = 0.06;
  const sh = new THREE.Shape();
  sh.moveTo(0, R);
  sh.quadraticCurveTo(c, c, W, 0);
  sh.quadraticCurveTo(c, -c, 0, -R);
  sh.quadraticCurveTo(-c, -c, -W, 0);
  sh.quadraticCurveTo(-c, c, 0, R);
  const geo = new THREE.ExtrudeGeometry(sh, { depth: 0.1, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.025, bevelSegments: 2, curveSegments: 6 });
  return finish(centered(geo));
}

/** Spark: standing, it floats a little above the tile; down, it lies flat on it. */
function sparkPose(h, tip) {
  const sc = 0.82 + 0.18 * h;
  const yUp = FLOOR + 0.18 + 0.56 * sc;
  const yDown = FLOOR + 0.1 * sc;
  const lie = (1 - h) * (1 - tip);
  return { sc, y: yDown + (yUp - yDown) * h + tip * 0.12, rx: -(Math.PI / 2) * lie - tip * 1.0, rz: tip * 0.5 };
}

function boxGeometry() {
  const geo = new THREE.BoxGeometry(0.92, 1, 0.92);
  geo.translate(0, 0.5, 0);
  return finish(geo);
}

/**
 * Every shape. Fields:
 *   build()            a new geometry (each state's layer gets a clone)
 *   defines            shader defines (BOX_EDGES: uv-edge rim and outline; VISOR)
 *   pose[cls]          {h, tip} the class's resting pose
 *   motion[cls]        shader motion (bob, spin, wobble, visor, flicker)
 *   matrix(arr,o,x,z,h,tip)  writes an instance matrix
 *   top(h, tip)        world height of the agent's top (labels, arcs, marker)
 *   crown              top of the running agent above its instance origin, in
 *                      instance units (particles rise from there)
 *   pool               light pool under running agents on dark themes (0..1)
 *   contactShadow      draw a small shadow under suspended agents
 *   crack              crashed agents show glowing cracks
 */
export const SHAPES = [
  {
    id: 'orb',
    name: 'Orb',
    build: orbGeometry,
    defines: {},
    pose: LIFT_POSE,
    motion: motion({ running: { bob: 1 }, transition: { bob: 0.5 } }),
    matrix(arr, o, x, z, h, tip) {
      const r = 0.4;
      const sc = 0.9 + 0.1 * h;
      compose(arr, o, x, FLOOR + r * sc + h * 0.8 - tip * 0.04, z, 0, 0, sc, sc, sc);
    },
    top: (h) => FLOOR + 0.8 * (0.9 + 0.1 * h) + h * 0.8,
    crown: 0.4,
    pool: 1,
    contactShadow: true,
    crack: true,
  },
  {
    id: 'spark',
    name: 'Spark',
    build: sparkGeometry,
    defines: {},
    pose: LIFT_POSE,
    motion: motion({ running: { spin: 0.7 }, transition: { spin: 3.2 }, pending: { spin: 0.3 } }),
    matrix(arr, o, x, z, h, tip) {
      const p = sparkPose(h, tip);
      compose(arr, o, x, p.y, z, p.rx, p.rz, p.sc, p.sc, p.sc);
    },
    top(h, tip) {
      const p = sparkPose(h, tip);
      return p.y + p.sc * (0.56 * Math.max(h, 0.3 * tip) + 0.1 * (1 - h));
    },
    crown: 0.56,
    pool: 0.6,
    contactShadow: false,
    crack: true,
  },
  {
    id: 'meeple',
    name: 'Meeple',
    build: meepleGeometry,
    defines: {},
    pose: LIFT_POSE,
    motion: motion({ transition: { wobble: 1 } }),
    matrix(arr, o, x, z, h, tip) {
      // Suspended: on its back, head toward the back of the cell. Crashed:
      // tipped over on its side.
      const lie = (1 - h) * (1 - tip);
      const half = 0.18;
      const y = FLOOR + lie * half + tip * 0.16;
      compose(arr, o, x + tip * 0.48, y, z + lie * 0.5, -(Math.PI / 2) * lie, (Math.PI / 2) * 0.94 * tip, 1, 1, 1);
    },
    top: (h, tip) => FLOOR + (0.36 + (1.06 - 0.36) * h) * (1 - 0.6 * tip),
    crown: 1.06,
    pool: 0.6,
    contactShadow: false,
    crack: true,
  },
  {
    id: 'droid',
    name: 'Droid',
    build: droidGeometry,
    defines: { VISOR: '' },
    pose: LIFT_POSE,
    motion: motion({ running: { visor: 1 }, transition: { visor: 1, flicker: 1 }, crashed: { visor: 1 }, pending: { visor: 0.4 } }),
    matrix(arr, o, x, z, h, tip) {
      // Powered down: squat, head bowed. Crashed: leaning over.
      const sy = 0.72 + 0.28 * h;
      compose(arr, o, x, FLOOR - tip * 0.05, z, (1 - h) * (1 - tip) * 0.32, tip * 0.62, 1, sy, 1);
    },
    top: (h, tip) => FLOOR + 1.14 * (0.72 + 0.28 * h) * (1 - 0.2 * tip),
    crown: 1.14,
    pool: 0.6,
    contactShadow: false,
    crack: true,
  },
  {
    id: 'box',
    name: 'Box',
    build: boxGeometry,
    defines: { BOX_EDGES: '' },
    pose: Object.fromEntries(Object.entries(BOX_HEIGHT).map(([cls, h]) => [cls, { h, tip: 0 }])),
    motion: motion({}),
    matrix(arr, o, x, z, h) {
      const hh = Math.max(h, 0.02);
      compose(arr, o, x, FLOOR, z, 0, 0, 1, hh, 1);
    },
    top: (h) => FLOOR + Math.max(h, 0.02),
    crown: 1,
    pool: 0.35,
    contactShadow: false,
    crack: false,
  },
];

export const DEFAULT_SHAPE = 'orb';

/** The shape with this id, or the default one. */
export function shapeById(id) {
  return SHAPES.find((x) => x.id === id) || SHAPES.find((x) => x.id === DEFAULT_SHAPE);
}
