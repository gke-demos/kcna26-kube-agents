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

// Agent shapes, agent layers and router looks build, and switching disposes
// everything the old one made (no leaked geometries, materials or meshes).

import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('../../hack/three-hooks.mjs', import.meta.url);
const THREE = await import('three');
const { SHAPES, DEFAULT_SHAPE, shapeById, FLOOR } = await import('./shapes.js');
const { AgentLayers } = await import('./agents.js');
const { ROUTERS, DEFAULT_ROUTER, buildRouter, routerId } = await import('./routers.js');
const { THEMES, AURORA, routerPalette } = await import('./themes.js');
const { CLASSES } = await import('./model.js');

/** Every geometry and material under obj, plus the meshes. */
function resources(obj) {
  const geos = new Set();
  const mats = new Set();
  const meshes = new Set();
  obj.traverse((o) => {
    if (o.geometry) geos.add(o.geometry);
    for (const m of [o.material].flat()) if (m) mats.add(m);
    if (o.isInstancedMesh) meshes.add(o);
  });
  return { geos, mats, meshes };
}

/** Counts 'dispose' events on each of the things. */
function watch(things) {
  const disposed = new Set();
  for (const t of things) t.addEventListener('dispose', () => disposed.add(t));
  return disposed;
}

function triangles(geo) {
  return (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
}

const look = () => ({
  uGlow: { value: 1 }, uAmb: { value: 0.1 }, uDiff: { value: 0.45 }, uHemi: { value: 0.22 }, uGloss: { value: 0 },
  uInk: { value: 0 }, uOcc: { value: 0 }, uAdditive: { value: 1 }, uDimColor: { value: new THREE.Color() },
});

test('every shape builds one low-poly geometry that fits its cell', () => {
  assert.deepEqual(SHAPES.map((s) => s.id).sort(), ['box', 'droid', 'meeple', 'orb', 'spark']);
  assert.equal(shapeById('nope').id, DEFAULT_SHAPE);
  for (const s of SHAPES) {
    const g = s.build();
    assert.ok(g.attributes.position && g.attributes.normal, `${s.id}: position and normal`);
    // 5,000 agents: keep each under a few hundred triangles.
    assert.ok(triangles(g) <= 400, `${s.id}: ${triangles(g)} triangles`);
    g.computeBoundingBox();
    const b = g.boundingBox;
    assert.ok(b.max.x - b.min.x < 1.4 && b.max.z - b.min.z < 1.4, `${s.id}: wider than a cell`);
    for (const cls of CLASSES) {
      const p = s.pose[cls];
      assert.ok(Number.isFinite(p.h) && Number.isFinite(p.tip), `${s.id}/${cls}: pose`);
      const m = new Float32Array(16);
      s.matrix(m, 0, 3, -2, p.h, p.tip);
      assert.ok(m.every(Number.isFinite), `${s.id}/${cls}: matrix`);
      assert.ok(Math.abs(m[12] - 3) < 0.6 && Math.abs(m[14] + 2) < 0.6, `${s.id}/${cls}: stays in its cell`);
      assert.ok(s.top(p.h, p.tip) > FLOOR, `${s.id}/${cls}: top above the floor`);
    }
    // Running stands taller than suspended: suspended agents recede.
    const run = s.pose.running;
    const sus = s.pose.suspended;
    assert.ok(s.top(run.h, run.tip) > s.top(sus.h, sus.tip), `${s.id}: running taller than suspended`);
    g.dispose();
  }
});

test('agent layers hold instances and dispose everything when the shape switches', () => {
  const parent = new THREE.Group();
  const time = { value: 0 };
  for (const s of SHAPES) {
    const agents = new AgentLayers(parent, s, time, look());
    agents.setTheme(THEMES[0]);
    // Grow past the first allocation so the reallocation path runs too.
    const run = agents.layers.running;
    const first = resources(parent);
    const firstDisposed = watch([...first.meshes]);
    for (let i = 0; i < 150; i++) run.add(`a${i}`);
    assert.ok(run.capacity >= 150);
    assert.equal(run.mesh.count, 150);
    for (const x of run.extras()) {
      assert.equal(x.mesh.count, 150, `${s.id}: extras follow the layer`);
      assert.equal(x.mesh.instanceMatrix, run.mesh.instanceMatrix, `${s.id}: extras share the instance buffer`);
    }
    // Old running meshes were replaced and disposed.
    const runOld = [...first.meshes].filter((m) => !parent.children.includes(m));
    assert.ok(runOld.length >= 1, `${s.id}: reallocation replaced meshes`);
    for (const m of runOld) assert.ok(firstDisposed.has(m), `${s.id}: replaced mesh disposed`);
    // Remove swaps the last slot in.
    assert.equal(run.remove(0), 'a149');
    assert.equal(run.keys[0], 'a149');
    assert.equal(agents.pickable().length, 1);

    const { geos, mats, meshes } = resources(parent);
    const disposed = watch([...geos, ...mats, ...meshes]);
    agents.dispose();
    assert.equal(parent.children.length, 0, `${s.id}: meshes left in the scene`);
    for (const g of geos) assert.ok(disposed.has(g), `${s.id}: geometry not disposed`);
    for (const m of mats) assert.ok(disposed.has(m), `${s.id}: material not disposed`);
    for (const m of meshes) assert.ok(disposed.has(m), `${s.id}: mesh not disposed`);
  }
});

test('extras can be turned off and follow the theme', () => {
  const parent = new THREE.Group();
  const agents = new AgentLayers(parent, shapeById('orb'), { value: 0 }, look());
  agents.setExtras(false);
  for (const l of Object.values(agents.layers)) for (const x of l.extras()) assert.equal(x.mesh.visible, false);
  agents.setExtras(true);
  const light = THEMES.find((t) => !t.glow.additive);
  agents.setTheme(light);
  // No light pool on light themes; a contact shadow under suspended orbs.
  assert.equal(agents.layers.running.decal.material.uniforms.uPool.value, 0);
  assert.ok(agents.layers.suspended.decal.material.uniforms.uShadow.value > 0);
  assert.equal(agents.layers.running.decal.material.blending, THREE.NormalBlending);
  agents.dispose();
});

const island = { cx: -1.2, cz: 2.6, width: 60, depth: 40 };
const ctx = (theme) => ({ theme, blending: THREE.AdditiveBlending, island, time: { value: 0 }, makeLabel: () => new THREE.Object3D() });

test('every router builds, animates, wakes and disposes cleanly', () => {
  assert.deepEqual(ROUTERS.map((r) => r.id), ['portal', 'lighthouse', 'core', 'tower']);
  assert.equal(routerId('nope'), DEFAULT_ROUTER);
  for (const theme of [THEMES[0], THEMES.find((t) => t.id === 'google-light')]) {
    for (const { id } of ROUTERS) {
      const parent = new THREE.Group();
      const r = buildRouter(id, ctx(theme));
      parent.add(r.group);
      assert.equal(r.id, id);
      assert.ok(r.labelObj, `${id}: has a label`);
      assert.ok(r.origin.y > 2, `${id}: arcs leave from up high`);
      for (let t = 0; t < 3; t += 0.1) r.update(t, 0.1);
      parent.updateMatrixWorld(true);
      const from = r.wake(new THREE.Vector3(10, 1, 10), 3);
      assert.ok(from.y > 2 && Number.isFinite(from.x), `${id}: wake origin`);
      for (let t = 3; t < 6; t += 0.1) r.update(t, 0.1);
      assert.ok(['tube', 'comet'].includes(r.arcStyle));

      const { geos, mats } = resources(r.group);
      const disposed = watch([...geos, ...mats]);
      r.dispose();
      assert.equal(parent.children.length, 0, `${id}: still in the scene`);
      for (const g of geos) assert.ok(disposed.has(g), `${id}: geometry not disposed`);
      for (const m of mats) assert.ok(disposed.has(m), `${id}: material not disposed`);
    }
  }
});

test('the core spins its rings faster as wakes come in', () => {
  const r = buildRouter('core', ctx(THEMES[0]));
  const spin = () => r.rings[0].spin.rotation.z;
  r.update(0, 1);
  const calm = spin();
  r.update(1, 1);
  const calmStep = spin() - calm;
  for (let i = 0; i < 10; i++) r.wake(new THREE.Vector3(), 1);
  const before = spin();
  r.update(2, 1);
  assert.ok(spin() - before > calmStep * 1.5);
  r.dispose();
});

test('the router palette is the Aurora on the Google themes', () => {
  for (const t of THEMES) {
    const p = routerPalette(t);
    assert.equal(p.length, 4);
    if (t.id.startsWith('google-')) assert.deepEqual(p, AURORA);
  }
});
