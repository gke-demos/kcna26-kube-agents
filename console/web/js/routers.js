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

// The atenet router on the island, in four looks: tower (the original),
// portal, lighthouse and core. Each is a group of meshes plus a little
// behavior: where wake arcs leave from, how they fly (a tube comet or a
// stream of particles), and what the router does when it wakes an agent.
// Pure three.js; the label comes from a factory the scene passes in (a
// CSS2DObject in the browser, a plain Object3D in tests).

import * as THREE from 'three';
import { routerPalette } from './themes.js';

export const ROUTERS = [
  { id: 'portal', name: 'Portal' },
  { id: 'lighthouse', name: 'Lighthouse' },
  { id: 'core', name: 'Core' },
  { id: 'tower', name: 'Tower' },
];

export const DEFAULT_ROUTER = 'portal';

/** The router id if known, else the default. */
export function routerId(id) {
  return ROUTERS.some((r) => r.id === id) ? id : DEFAULT_ROUTER;
}

const LABEL = 'atenet router';

const swirlVertex = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const swirlFragment = /* glsl */ `
uniform float uTime;
uniform float uPulse;
uniform float uAlpha;
uniform float uGain;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
varying vec2 vUv;
vec3 ramp(float t) {
  t = fract(t) * 4.0;
  if (t < 1.0) return mix(uC0, uC1, t);
  if (t < 2.0) return mix(uC1, uC2, t - 1.0);
  if (t < 3.0) return mix(uC2, uC3, t - 2.0);
  return mix(uC3, uC0, t - 3.0);
}
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float a = atan(p.y, p.x);
  float sw = a * 2.0 + r * 7.0 - uTime * 1.1;
  float bands = 0.5 + 0.5 * sin(sw);
  vec3 col = ramp(a / 6.2831 + r * 0.35 - uTime * 0.04);
  float core = exp(-r * r * 4.0);
  col = (col * (0.5 + 0.7 * bands) + vec3(1.0) * core * (0.15 + 0.6 * uPulse)) * uGain;
  float alpha = uAlpha * (0.35 + 0.65 * bands) * (1.0 - smoothstep(0.82, 1.0, r)) + core * 0.2 * uAlpha;
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}`;

const beamVertex = /* glsl */ `
varying vec2 vUv;
varying float vFacing;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 n = normalize(mat3(modelMatrix) * normal);
  vFacing = abs(dot(n, normalize(cameraPosition - wp.xyz)));
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const beamFragment = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
varying vec2 vUv;
varying float vFacing;
void main() {
  // Bright at the lamp, fading with distance; soft at the silhouette.
  float a = uAlpha * pow(vUv.y, 1.4) * pow(vFacing, 1.2);
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor, a);
}`;

/** Disposes every geometry, material and texture under obj and removes label elements. */
export function disposeTree(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose();
    for (const m of [o.material].flat()) {
      if (!m) continue;
      m.map?.dispose();
      m.dispose();
    }
    if (o.isCSS2DObject) o.element.remove();
  });
  obj.removeFromParent();
}

class Router {
  /**
   * @param {object} ctx {theme, blending, island, makeLabel, time}
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.theme = ctx.theme;
    this.light = !ctx.theme.glow.additive;
    this.group = new THREE.Group();
    this.origin = new THREE.Vector3();
    this.lastWake = -99;
    // Wake rate: wakes per minute, decaying.
    this.rate = 0;
    this.arcStyle = 'tube';
  }

  /** The back-left corner of the island, where most routers stand. */
  corner() {
    const isl = this.ctx.island;
    return { x: isl.cx - isl.width / 2 + 2.6, z: isl.cz - isl.depth / 2 + 2.6 };
  }

  label(y) {
    const l = this.ctx.makeLabel(LABEL);
    l.position.y = y;
    this.group.add(l);
    this.labelObj = l;
    return l;
  }

  std(color, extra = {}) {
    return new THREE.MeshStandardMaterial({ color, roughness: this.light ? 0.6 : 0.4, metalness: this.light ? 0.1 : 0.6, ...extra });
  }

  basic(color, extra = {}) {
    return new THREE.MeshBasicMaterial({ color, ...extra });
  }

  /** Called when the router wakes an agent at target (world). Returns where the arc starts. */
  wake(target, t) {
    this.lastWake = t;
    this.rate += 1;
    return this.origin.clone();
  }

  /** Per frame. */
  update(t, dt) {
    this.rate *= Math.exp(-dt / 30);
  }

  /** 1 right after a wake, decaying. */
  pulse(t) {
    return Math.exp(-(t - this.lastWake) * 2.5);
  }

  dispose() {
    disposeTree(this.group);
  }
}

/** The original: a hexagonal shaft with bands and a beacon on top. */
class Tower extends Router {
  build() {
    const th = this.theme.router;
    const { x, z } = this.corner();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.75, 7, 6), this.std(th.shaft, { emissive: th.emissive }));
    shaft.position.y = 3.5;
    shaft.castShadow = true;
    this.group.add(shaft);
    for (let i = 1; i <= 3; i++) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.75 - i * 0.12, 0.05, 6, 24), this.basic(th.band));
      band.rotation.x = Math.PI / 2;
      band.position.y = i * 1.8;
      this.group.add(band);
    }
    this.beacon = new THREE.Mesh(new THREE.SphereGeometry(0.38, 20, 14), this.basic(th.beacon));
    this.beacon.position.y = 7.4;
    this.group.add(this.beacon);
    this.beaconColor = new THREE.Color(th.beacon);
    this.label(8.4);
    this.group.position.set(x, 0, z);
    this.origin.set(x, 7.4, z);
  }

  update(t, dt) {
    super.update(t, dt);
    const k = 0.8 + 0.2 * Math.sin(t * 2) + 2.5 * this.pulse(t);
    this.beacon.scale.setScalar(0.8 + 0.25 * k);
    this.beacon.material.color.copy(this.beaconColor).multiplyScalar(this.light ? 0.7 + 0.3 * Math.min(k, 1.4) : k);
  }
}

/** A standing ring gateway with a slow swirl inside; wakes leave as comets. */
class Portal extends Router {
  build() {
    const th = this.theme.router;
    const { x, z } = this.corner();
    const pal = routerPalette(this.theme);
    const R = 2.4;
    const cy = R + 0.55;
    const gate = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(R, 0.24, 10, 48), this.std(th.shaft, { emissive: th.emissive }));
    ring.castShadow = true;
    gate.add(ring);
    // A thin glowing inner lip.
    const lip = new THREE.Mesh(new THREE.TorusGeometry(R - 0.22, 0.07, 6, 64), this.basic(th.band));
    gate.add(lip);
    this.swirl = new THREE.Mesh(
      new THREE.CircleGeometry(R - 0.18, 48),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: this.ctx.blending,
        uniforms: {
          uTime: this.ctx.time,
          uPulse: { value: 0 },
          uAlpha: { value: this.light ? 0.85 : 0.42 },
          uGain: { value: this.light ? 1 : 0.55 },
          uC0: { value: new THREE.Color(pal[0]) },
          uC1: { value: new THREE.Color(pal[1]) },
          uC2: { value: new THREE.Color(pal[2]) },
          uC3: { value: new THREE.Color(pal[3]) },
        },
        vertexShader: swirlVertex,
        fragmentShader: swirlFragment,
      }),
    );
    gate.add(this.swirl);
    gate.position.y = cy;
    this.group.add(gate);
    // Two feet so it stands on the island.
    for (const sx of [-1, 1]) {
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.9), this.std(th.shaft, { emissive: th.emissive }));
      foot.position.set(sx * 1.05, 0.25, 0);
      foot.castShadow = true;
      this.group.add(foot);
    }
    this.lip = lip;
    this.lipColor = new THREE.Color(th.band);
    this.label(cy + R + 0.9);
    this.group.position.set(x, 0, z);
    // Face the middle of the island.
    const isl = this.ctx.island;
    // Half way between facing the island's middle and facing the camera.
    this.group.rotation.y = Math.atan2(isl.cx - x, isl.cz - z) * 0.5;
    this.origin.set(x, cy, z);
    this.arcStyle = 'comet';
  }

  update(t, dt) {
    super.update(t, dt);
    const p = this.pulse(t);
    this.swirl.material.uniforms.uPulse.value = p;
    this.swirl.rotation.z = -t * 0.15;
    this.lip.material.color.copy(this.lipColor).multiplyScalar(this.light ? 1 : 1 + 1.5 * p);
  }
}

/** A squat lighthouse; its beam turns and snaps toward each agent it wakes. */
class Lighthouse extends Router {
  build() {
    const th = this.theme.router;
    const { x, z } = this.corner();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 1.05, 3.0, 12), this.std(th.shaft, { emissive: th.emissive }));
    // Squat, but tall enough to read next to a big district.
    body.position.y = 1.5;
    body.castShadow = true;
    this.group.add(body);
    for (const y of [0.9, 2.0]) {
      const r = 1.05 - (y / 3.0) * 0.33;
      const stripe = new THREE.Mesh(new THREE.CylinderGeometry(r - 0.02, r + 0.03, 0.32, 12, 1, true), this.basic(th.band));
      stripe.position.y = y;
      this.group.add(stripe);
    }
    const gallery = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 0.9, 0.16, 14), this.std(th.shaft, { emissive: th.emissive }));
    gallery.position.y = 3.08;
    this.group.add(gallery);
    this.lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.8, 10), this.basic(th.beacon));
    this.lamp.position.y = 3.56;
    this.group.add(this.lamp);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(0.72, 0.6, 12), this.std(th.shaft, { emissive: th.emissive }));
    roof.position.y = 4.26;
    roof.castShadow = true;
    this.group.add(roof);
    // The beam: an open cone from the lamp along +z.
    const L = 17;
    const geo = new THREE.ConeGeometry(2.0, L, 28, 1, true);
    geo.translate(0, -L / 2, 0);
    geo.rotateX(-Math.PI / 2);
    this.beam = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: this.ctx.blending,
        uniforms: { uColor: { value: new THREE.Color(this.light ? th.band : th.beacon) }, uAlpha: { value: 0.3 } },
        vertexShader: beamVertex,
        fragmentShader: beamFragment,
      }),
    );
    this.pivot = new THREE.Group();
    this.pivot.rotation.order = 'YXZ';
    this.pivot.position.y = 3.56;
    this.pivot.add(this.beam);
    this.group.add(this.pivot);
    this.lampColor = new THREE.Color(th.beacon);
    this.label(5.3);
    this.group.position.set(x, 0, z);
    this.origin.set(x, 3.56, z);
    this.yaw = 0.6;
    this.pitch = 0.16;
    this.aim = null;
  }

  wake(target, t) {
    const from = super.wake(target, t);
    const dx = target.x - this.origin.x;
    const dz = target.z - this.origin.z;
    const yaw = Math.atan2(dx, dz);
    const pitch = Math.atan2(this.origin.y - target.y, Math.hypot(dx, dz));
    // Turn the short way round.
    let d = yaw - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.aim = { t0: t, fromYaw: this.yaw, toYaw: this.yaw + d, fromPitch: this.pitch, toPitch: pitch };
    return from;
  }

  update(t, dt) {
    super.update(t, dt);
    const DEFAULT_PITCH = 0.16;
    if (this.aim) {
      const a = this.aim;
      const k = (t - a.t0) / 0.3;
      const ease = 1 - Math.pow(1 - Math.min(k, 1), 3);
      this.yaw = a.fromYaw + (a.toYaw - a.fromYaw) * ease;
      this.pitch = a.fromPitch + (a.toPitch - a.fromPitch) * ease;
      // Hold on the agent while the arc flies, then resume turning.
      if (t - a.t0 > 2.2) this.aim = null;
    } else {
      this.yaw += dt * 0.55;
      this.pitch += (DEFAULT_PITCH - this.pitch) * Math.min(1, dt * 2);
    }
    this.pivot.rotation.set(this.pitch, this.yaw, 0);
    const p = this.pulse(t);
    this.beam.material.uniforms.uAlpha.value = (this.light ? 0.22 : 0.4) + p * 0.4;
    this.lamp.material.color.copy(this.lampColor).multiplyScalar(this.light ? 1 : 1 + p * 1.5);
  }
}

/** A floating crystal over the island with orbiting rings that speed up with the wake rate. */
class Core extends Router {
  build() {
    const th = this.theme.router;
    const pal = routerPalette(this.theme);
    const isl = this.ctx.island;
    const x = isl.cx - isl.width * 0.18;
    const z = isl.cz - isl.depth / 2 + 1.0;
    const cy = 8.2;
    const gemGeo = new THREE.OctahedronGeometry(1.0, 0);
    gemGeo.scale(1, 1.45, 1);
    this.gem = new THREE.Mesh(
      gemGeo,
      new THREE.MeshStandardMaterial({ color: th.band, emissive: th.beacon, emissiveIntensity: this.light ? 0.15 : 0.55, roughness: 0.25, metalness: 0.3, flatShading: true }),
    );
    this.gem.castShadow = true;
    this.facets = new THREE.LineSegments(
      new THREE.EdgesGeometry(gemGeo),
      new THREE.LineBasicMaterial({ color: this.light ? th.band : th.beacon, transparent: true, opacity: 0.9, blending: this.ctx.blending }),
    );
    this.gem.add(this.facets);
    const holder = new THREE.Group();
    holder.position.y = cy;
    holder.add(this.gem);
    this.rings = [];
    const tilts = [
      [1.25, 0.2],
      [0.5, -0.9],
      [-0.35, 0.7],
    ];
    tilts.forEach(([rx, rz], i) => {
      const r = 1.9 + i * 0.42;
      const plane = new THREE.Group();
      plane.rotation.set(rx, 0, rz);
      const spin = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.06, 6, 72), this.basic(pal[i], { transparent: true, opacity: 0.85 }));
      spin.add(ring);
      const bead = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), this.basic(pal[i]));
      bead.position.x = r;
      spin.add(bead);
      plane.add(spin);
      holder.add(plane);
      this.rings.push({ spin, speed: 0.35 + i * 0.12, dir: i % 2 ? -1 : 1 });
    });
    // A faint tether down to the island so it reads as anchored there.
    const tether = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, cy - 1.6, 6, 1, true),
      this.basic(th.band, { transparent: true, opacity: this.light ? 0.35 : 0.25, depthWrite: false, blending: this.ctx.blending }),
    );
    tether.position.y = (cy - 1.6) / 2;
    this.group.add(tether);
    this.group.add(holder);
    this.holder = holder;
    this.label(cy + 2.6);
    this.group.position.set(x, 0, z);
    this.origin.set(x, cy, z);
    this.cy = cy;
  }

  update(t, dt) {
    super.update(t, dt);
    const boost = 1 + Math.min(this.rate, 20) * 0.35;
    for (const r of this.rings) r.spin.rotation.z += dt * r.speed * r.dir * boost;
    this.gem.rotation.y += dt * (0.3 + 0.1 * boost);
    const p = this.pulse(t);
    this.holder.position.y = this.cy + Math.sin(t * 0.9) * 0.18;
    this.gem.scale.setScalar(1 + 0.12 * p);
    this.gem.material.emissiveIntensity = (this.light ? 0.15 : 0.55) + p * 0.8;
  }

  wake(target, t) {
    super.wake(target, t);
    return this.holder.getWorldPosition(new THREE.Vector3());
  }
}

/** Size factor for an island: 1 on a small cluster, up to 2 on a big one. */
export function routerScale(island) {
  return Math.min(2, Math.max(1, island.width / 40));
}

const KINDS = { tower: Tower, portal: Portal, lighthouse: Lighthouse, core: Core };

/**
 * Builds a router.
 * @param {string} id one of ROUTERS
 * @param {{theme: object, blending: number, island: {cx, cz, width, depth}, makeLabel: (text: string) => THREE.Object3D, time: {value: number}}} ctx
 */
export function buildRouter(id, ctx) {
  const K = KINDS[routerId(id)];
  const r = new K(ctx);
  r.id = routerId(id);
  r.build();
  // Grow with the island so the router still reads on a big cluster (the
  // tower keeps its original size).
  if (r.id !== 'tower') {
    const k = routerScale(ctx.island);
    r.group.scale.setScalar(k);
    r.origin.y *= k;
    r.scale = k;
  }
  return r;
}
