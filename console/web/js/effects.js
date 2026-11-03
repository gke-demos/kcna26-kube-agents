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

// Short-lived event animations: the wake arc from the router (a tube comet,
// or a stream of glowing particles for the portal), the suspend ripple, the
// crash shockwave and the new-task beam. Each is a small additive mesh that
// removes itself when done.

import * as THREE from 'three';

const ringGeo = new THREE.RingGeometry(0.62, 0.72, 64);
ringGeo.rotateX(-Math.PI / 2);
const beamGeo = new THREE.CylinderGeometry(0.3, 0.3, 1, 24, 1, true);
beamGeo.translate(0, 0.5, 0);

const arcVertex = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const arcFragment = `
uniform float uProg; uniform vec3 uColor; uniform float uFade;
varying vec2 vUv;
void main(){
  float u = vUv.x;
  float head = smoothstep(uProg - 0.35, uProg, u) * (1.0 - smoothstep(uProg, uProg + 0.015, u));
  float trail = step(u, uProg) * 0.3;
  float a = (head * 1.0 + trail) * uFade;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor * (0.5 + 1.6 * head), a);
}`;

const beamFragment = `
uniform vec3 uColor; uniform float uAlpha; varying vec2 vUv;
void main(){
  float a = uAlpha * pow(1.0 - vUv.y, 1.6);
  gl_FragColor = vec4(uColor * 1.1, a);
}`;

const cometVertex = `
attribute float aAlpha;
attribute float aSize;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * 1500.0 / -mv.z;
  vA = aAlpha;
  gl_Position = projectionMatrix * mv;
}`;
const cometFragment = `
uniform vec3 uColor;
uniform float uWhite;
uniform float uBright;
varying float vA;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0 || vA < 0.01) discard;
  float core = exp(-d * d * 6.0);
  gl_FragColor = vec4(mix(uColor, vec3(1.0), core * uWhite) * uBright, vA * (1.0 - d) * (0.5 + core));
}`;

export class Effects {
  constructor(parent, timeUniform) {
    this.parent = parent;
    this.time = timeUniform;
    this.items = [];
    // Additive on dark themes; normal blending on light ones (set by the scene).
    this.blending = THREE.AdditiveBlending;
  }

  add(obj, update) {
    this.parent.add(obj);
    this.items.push({ obj, update, t0: this.time.value });
  }

  /** Expanding ring on the ground at (x, z). */
  ripple(x, z, color, scale = 1, delay = 0) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: this.blending, depthWrite: false });
    const m = new THREE.Mesh(ringGeo, mat);
    m.position.set(x, 0.2, z);
    const dur = 1.6 * scale;
    this.add(m, (age) => {
      const k = (age - delay) / dur;
      if (k < 0) return true;
      if (k >= 1) return false;
      const s = 1 + k * 3.2 * scale;
      m.scale.set(s, 1, s);
      mat.opacity = (1 - k) * (1 - k) * 0.9;
      return true;
    });
  }

  /** Crash: three fast red rings and a short flash column. */
  shock(x, z, color) {
    for (let i = 0; i < 3; i++) this.ripple(x, z, color, 1.1, i * 0.28);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: this.blending,
      uniforms: { uColor: { value: new THREE.Color(color) }, uAlpha: { value: 0 } },
      vertexShader: arcVertex,
      fragmentShader: beamFragment,
      side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(beamGeo, mat);
    m.position.set(x, 0.1, z);
    m.scale.set(0.9, 7, 0.9);
    this.add(m, (age) => {
      const k = age / 1.2;
      if (k >= 1) return false;
      mat.uniforms.uAlpha.value = Math.sin(Math.PI * Math.min(k * 2, 1)) * (1 - k);
      return true;
    });
  }

  /** New task: a beam of light coming down onto the agent. */
  beam(x, z, color) {
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: this.blending,
      uniforms: { uColor: { value: new THREE.Color(color) }, uAlpha: { value: 0 } },
      vertexShader: arcVertex,
      fragmentShader: beamFragment,
      side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(beamGeo, mat);
    m.position.set(x, 0.1, z);
    m.scale.set(0.8, 26, 0.8);
    this.add(m, (age) => {
      const k = age / 3.5;
      if (k >= 1) return false;
      // Up fast, hold, fade.
      mat.uniforms.uAlpha.value = (k < 0.08 ? k / 0.08 : k < 0.4 ? 1 : 1 - (k - 0.4) / 0.6) * 0.5;
      return true;
    });
    this.ripple(x, z, color, 1.2, 0.2);
  }

  /** Wake: a comet along an arc from the router tower to the agent. */
  arc(from, to, color, onArrive) {
    const mid = from.clone().lerp(to, 0.5);
    mid.y += 2.5 + from.distanceTo(to) * 0.2;
    const curve = new THREE.QuadraticBezierCurve3(from.clone(), mid, to.clone());
    const geo = new THREE.TubeGeometry(curve, 128, 0.13, 8, false);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: this.blending,
      uniforms: { uProg: { value: 0 }, uColor: { value: new THREE.Color(color) }, uFade: { value: 1 } },
      vertexShader: arcVertex,
      fragmentShader: arcFragment,
    });
    const m = new THREE.Mesh(geo, mat);
    let arrived = false;
    const travel = 1.8;
    this.add(m, (age) => {
      const k = age / travel;
      mat.uniforms.uProg.value = Math.min(k, 1.0) * 1.02;
      if (k >= 1 && !arrived) {
        arrived = true;
        onArrive?.();
      }
      if (k > 1) mat.uniforms.uFade.value = Math.max(0, 1 - (k - 1) * 1.2);
      if (k > 1.9) {
        geo.dispose();
        return false;
      }
      return true;
    });
  }

  /** Wake, portal style: a glowing head and a trail of sparks along an arc. */
  comet(from, to, color, onArrive) {
    const mid = from.clone().lerp(to, 0.5);
    mid.y += 2.0 + from.distanceTo(to) * 0.18;
    const curve = new THREE.QuadraticBezierCurve3(from.clone(), mid, to.clone());
    const N = 40;
    const pos = new Float32Array(N * 3);
    const alpha = new Float32Array(N);
    const size = new Float32Array(N);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: this.blending,
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        // Light themes: the wake color itself, not a near-white glow.
        uWhite: { value: this.blending === THREE.AdditiveBlending ? 0.6 : 0 },
        uBright: { value: this.blending === THREE.AdditiveBlending ? 1.4 : 0.9 },
      },
      vertexShader: cometVertex,
      fragmentShader: cometFragment,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    const p = new THREE.Vector3();
    // Each spark's jitter off the curve, fixed per comet.
    const jitter = Array.from({ length: N }, () => new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.35));
    let arrived = false;
    const travel = 1.6;
    this.add(pts, (age) => {
      const k = age / travel;
      if (k >= 1 && !arrived) {
        arrived = true;
        onArrive?.();
      }
      const fade = k > 1 ? Math.max(0, 1 - (k - 1) * 2.5) : 1;
      for (let i = 0; i < N; i++) {
        const lag = i / N;
        const u = Math.min(Math.max(k - lag * 0.45, 0), 1);
        curve.getPoint(u, p);
        const spread = lag * (1 - u * 0.5);
        p.addScaledVector(jitter[i], spread);
        p.toArray(pos, i * 3);
        alpha[i] = (k - lag * 0.45 > 0 ? 1 : 0) * (1 - lag * 0.8) * fade;
        size[i] = i === 0 ? 1.1 : 0.55 * (1 - lag) + 0.12;
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aAlpha.needsUpdate = true;
      geo.attributes.aSize.needsUpdate = true;
      if (k > 1.5) {
        geo.dispose();
        return false;
      }
      return true;
    });
  }

  /**
   * Builds one of every effect so a renderer.compile() can compile their
   * shaders up front, and keeps their materials: three.js releases a shader
   * program when the last material using it is disposed, so without a
   * keeper every effect kind would recompile whenever none of it is
   * playing (a long frame in the middle of a session, not only on first
   * use). Returns the cleanup that takes the meshes away again.
   */
  warmup() {
    const n = this.items.length;
    const a = new THREE.Vector3(0, -50, 0);
    const b = new THREE.Vector3(1, -50, 1);
    this.ripple(0, 0, 0xffffff);
    this.shock(0, 0, 0xffffff);
    this.beam(0, 0, 0xffffff);
    this.arc(a, b, 0xffffff);
    this.comet(a, b, 0xffffff);
    const added = this.items.splice(n);
    // A comet draws nothing until its first update.
    for (const it of added) it.update(0.2);
    return () => {
      const before = this.keepers || [];
      this.keepers = added.map((it) => it.obj.material);
      for (const it of added) {
        this.parent.remove(it.obj);
        if (it.obj.geometry !== ringGeo && it.obj.geometry !== beamGeo) it.obj.geometry?.dispose();
      }
      // The previous keepers go only now that the new ones hold the programs.
      for (const m of before) m.dispose();
    };
  }

  update(t) {
    this.items = this.items.filter((it) => {
      if (it.update(t - it.t0)) return true;
      this.parent.remove(it.obj);
      it.obj.material?.dispose();
      return false;
    });
  }
}
