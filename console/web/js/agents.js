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

// Agents on the GPU: one InstancedMesh per visual class, all sharing one
// shape's geometry (see shapes.js), drawn by one shader. Each layer can carry
// two extras that share its instance buffers, so they cost one draw call each
// and never get out of step with the agents:
//   - a floor decal: the idle ring that drains toward suspend, a soft light
//     pool under running agents (dark themes), a contact shadow under
//     suspended orbs;
//   - rising particles over agents that are serving a request.
// Every layer also draws a floor tile tinted by the agent's atespace, shown
// only in worker view (so "which team runs here" stays answerable there).
// Pure three.js (no DOM, no renderer), so node tests can build and dispose it.

import * as THREE from 'three';
import { CLASSES } from './model.js';
import { DirtyRanges, uploadRanges } from './dirty.js';

/** Look of each class in the agent shader. */
export const CLASS_LOOK = {
  running: { breath: 1, pulse: 0, outline: 0, emissive: 0.75, base: 1.0, speed: 1.4, rim: 0.9, desat: 0, flat: 0 },
  transition: { breath: 1, pulse: 0, outline: 0, emissive: 0.9, base: 1.0, speed: 6.0, rim: 0.7, desat: 0, flat: 0 },
  suspended: { breath: 0, pulse: 0, outline: 0, emissive: 0.1, base: 0.75, speed: 0, rim: 0.05, desat: 0.35, flat: 0.65 },
  crashed: { breath: 0, pulse: 1, outline: 0, emissive: 0.55, base: 1.0, speed: 5.0, rim: 0.5, desat: 0, flat: 0 },
  pending: { breath: 0.4, pulse: 0, outline: 1, emissive: 0.7, base: 1.0, speed: 1.0, rim: 0.6, desat: 0, flat: 0 },
};

/** Seconds of the fake idle timer in synthetic mode (one full drain). */
export const FAKE_IDLE_SECONDS = 45;

// Level of detail: a shape grows in near the camera (within uCloseFar,
// full size at uCloseNear, or everywhere when uAllShapes) and shrinks away
// where its district shows as an aggregate tile; the agent's point sprite
// fades the other way (points.js), so the two crossfade.
const lodChunk = /* glsl */ `
uniform float uScale;
uniform float uFarLo;
uniform float uFarHi;
uniform float uCloseNear;
uniform float uCloseFar;
uniform float uAllShapes;
float lodScale(vec3 c) {
  vec4 mv = viewMatrix * vec4(c, 1.0);
  float px = 1.5 * uScale / max(-mv.z, 0.01);
  float far = 1.0 - smoothstep(uFarLo, uFarHi, px);
  float close = uAllShapes > 0.5 ? 1.0 : smoothstep(uCloseFar, uCloseNear, distance(c, cameraPosition));
  return close * (1.0 - far);
}
`;

const agentVertex = /* glsl */ `
${lodChunk}
attribute float aSeed;
attribute float aDim;
attribute float aFlash;
attribute float aHi;
uniform float uTime;
uniform float uBob;
uniform float uSpin;
uniform float uWobble;
uniform float uY0;
uniform float uY1;
varying vec3 vNormal;
varying vec3 vColor;
varying vec3 vWorld;
varying vec3 vLocal;
varying vec2 vUv;
varying float vY;
varying float vDim;
varying float vFlash;
varying float vSeed;
varying float vHi;
void main() {
  vec3 c0 = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float lod = lodScale(c0);
  if (lod < 0.01) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec3 p = position * lod;
  vec3 nrm = normal;
  float ph = aSeed * 6.2831;
  if (uSpin != 0.0) {
    float a = uTime * uSpin + ph;
    float c = cos(a);
    float s = sin(a);
    p = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
    nrm = vec3(c * nrm.x + s * nrm.z, nrm.y, -s * nrm.x + c * nrm.z);
  }
  if (uWobble != 0.0) {
    float a = sin(uTime * 4.2 + ph) * 0.32 * uWobble;
    float c = cos(a);
    float s = sin(a);
    p = vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z);
    nrm = vec3(nrm.x, c * nrm.y - s * nrm.z, s * nrm.y + c * nrm.z);
  }
  mat4 m = modelMatrix * instanceMatrix;
  vec4 wp = m * vec4(p, 1.0);
  wp.y += uBob * (0.5 + 0.5 * sin(uTime * 1.7 + ph)) * 0.22 * lod;
  vNormal = normalize(mat3(m) * nrm);
  #ifdef USE_INSTANCING_COLOR
    vColor = instanceColor;
  #else
    vColor = vec3(1.0);
  #endif
  vUv = uv;
  vLocal = position;
  vY = (position.y - uY0) / (uY1 - uY0);
  vWorld = wp.xyz;
  vDim = aDim;
  float age = uTime - aFlash;
  vFlash = (aFlash > 0.0 && age >= 0.0) ? exp(-age * 1.6) : 0.0;
  vSeed = aSeed;
  vHi = aHi;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const agentFragment = /* glsl */ `
uniform float uTime;
uniform float uBreath;
uniform float uPulse;
uniform float uOutline;
uniform float uEmissive;
uniform float uBase;
uniform float uSpeed;
uniform float uRim;
uniform float uDesat;
uniform float uFlat;
uniform float uCrack;
uniform float uVisor;
uniform float uFlicker;
uniform float uGlow;
uniform float uAmb;
uniform float uDiff;
uniform float uHemi;
uniform float uGloss;
uniform float uInk;
uniform float uOcc;
uniform float uAdditive;
uniform vec3 uDimColor;
uniform float uHiDim;
varying vec3 vNormal;
varying vec3 vColor;
varying vec3 vWorld;
varying vec3 vLocal;
varying vec2 vUv;
varying float vY;
varying float vDim;
varying float vFlash;
varying float vSeed;
varying float vHi;
void main() {
  vec3 n = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorld);
  float fr = pow(1.0 - clamp(abs(dot(n, V)), 0.0, 1.0), 2.2);
#ifdef BOX_EDGES
  float edge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
  if (uOutline > 0.5 && edge > 0.08) discard;
  float rim = smoothstep(0.07, 0.0, edge);
#else
  if (uOutline > 0.5 && fr < 0.3) discard;
  float rim = smoothstep(0.35, 0.85, fr);
#endif
  vec3 L = normalize(vec3(0.35, 1.0, 0.45));
  float diff = mix(max(dot(n, L), 0.0), 0.55, uFlat);
  float hemi = mix(0.5 + 0.5 * n.y, 0.75, uFlat);
  vec3 base = vColor * (uAmb + uDiff * diff + uHemi * hemi) * uBase;
  // Darker toward the foot: a cheap ambient-occlusion feel.
  base *= mix(1.0 - uOcc, 1.0, smoothstep(0.0, 0.7, vY));
  // Suspended agents recede: flatter and a little desaturated.
  base = mix(base, vec3(dot(base, vec3(0.299, 0.587, 0.114))), uDesat);
  float wave = 0.5 + 0.5 * sin(uTime * uSpeed + vSeed * 6.2831);
  float breath = mix(1.0, 0.55 + 0.45 * wave, uBreath);
  float pulse = uPulse * pow(wave, 4.0);
#ifdef BOX_EDGES
  float top = smoothstep(0.45, 1.0, vY) * step(0.5, 1.0 - abs(n.y - 1.0)) + 0.35 * smoothstep(0.2, 1.0, vY);
#else
  // A bright cap: the top of a running agent reads as a light source.
  float top = smoothstep(0.55, 1.0, vY) * smoothstep(0.1, 0.9, n.y) + 0.3 * smoothstep(0.2, 1.0, vY);
#endif
  vec3 glow = vColor * uEmissive * uGlow * (0.25 + 0.9 * top) * breath;
  glow += vColor * (pulse * 1.6 + vFlash * 1.6) * max(uGlow, 0.4);
#ifdef BOX_EDGES
  glow += vColor * rim * (0.12 + uEmissive * 0.8) * uGlow;
#else
  glow += vColor * fr * uRim * 1.1 * uGlow * breath;
#endif
  vec3 col = base + glow;
#ifdef VISOR
  // A band around the front of the head: dark glass, lit while running.
  float band = 1.0 - smoothstep(0.0, 0.03, abs(vY - 0.7) - 0.08);
  band *= smoothstep(-0.14, 0.06, vLocal.z);
  float vis = uVisor;
  if (uFlicker > 0.0) vis *= 0.15 + 0.85 * step(0.45, fract(sin(floor(uTime * 11.0) + vSeed * 91.0) * 43758.5453));
  vec3 lit = mix(vColor, vec3(1.0), 0.5 * (1.0 - uCrack));
  col = mix(col, vColor * 0.12, band * 0.85);
  col += lit * band * vis * mix(0.95, 1.7, uAdditive) * breath;
#endif
  if (uCrack > 0.0) {
    float cr = abs(sin(vLocal.x * 21.0 + sin(vLocal.y * 15.0 + vSeed * 40.0) * 2.2 + vLocal.z * 9.0));
    float line = (1.0 - smoothstep(0.0, 0.1, cr)) * step(0.3, fract(vLocal.y * 2.7 + vSeed * 5.0));
    col = mix(mix(col, col * 0.25, line * uCrack), col + vColor * line * uCrack * 1.5, uAdditive);
  }
#ifdef BOX_EDGES
  // Light themes: a glossy highlight on the top face and inked edges.
  float topFace = step(0.9, n.y);
  col = mix(col, vec3(1.0), topFace * uGloss * smoothstep(0.75, 0.0, length(vUv - vec2(0.28, 0.72))));
#else
  col = mix(col, vec3(1.0), uGloss * (smoothstep(0.7, 1.0, n.y) * 0.8 + fr * uRim * 2.0));
#endif
  col = mix(col, col * 0.42, rim * uInk);
  // Worker focus: lit agents (2) glow, siblings (1) a little, others (-1) recede.
  float hi = vHi > 1.5 ? 1.0 : (vHi > 0.5 ? 0.4 : 0.0);
  float shimmer = 0.75 + 0.25 * sin(uTime * 3.0 + vSeed * 6.2831);
  // Dark themes: lit agents glow brighter. Light themes: they deepen to
  // their full state color (brightening would wash out on a pale ground).
  vec3 glowUp = col + (vColor * 0.7 + 0.1) * hi * shimmer;
  vec3 deepen = mix(col, vColor * 0.92, 0.65 * hi);
  col = mix(deepen, glowUp, uAdditive);
  float dim = max(vDim * 0.9, vHi < -0.5 ? uHiDim : 0.0);
  col = mix(col, uDimColor, dim);
  gl_FragColor = vec4(col, 1.0);
}`;

// Floor decal: drawn at the agent's tile, whatever the agent's own pose.
const decalVertex = /* glsl */ `
${lodChunk}
attribute float aSeed;
attribute float aDim;
attribute float aIdle;
attribute float aServe;
attribute float aHi;
uniform float uTime;
uniform float uIdleFake;
varying vec2 vUv;
varying vec3 vColor;
varying float vIdle;
varying float vDim;
void main() {
  vec4 c = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float lod = lodScale(c.xyz);
  if (lod < 0.01) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec3 wp = vec3(c.x + position.x * lod, 0.135, c.z + position.z * lod);
  vUv = uv;
  #ifdef USE_INSTANCING_COLOR
    vColor = instanceColor;
  #else
    vColor = vec3(1.0);
  #endif
  float idle = aIdle;
  if (uIdleFake > 0.5) idle = aServe > 0.5 ? 1.0 : 1.0 - fract(aIdle + uTime / ${FAKE_IDLE_SECONDS.toFixed(1)});
  vIdle = idle;
  vDim = max(aDim, aHi < -0.5 ? 0.8 : 0.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const decalFragment = /* glsl */ `
uniform float uPool;
uniform float uRing;
uniform float uShadow;
uniform vec3 uShadowColor;
varying vec2 vUv;
varying vec3 vColor;
varying float vIdle;
varying float vDim;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p) * 1.1;
  vec3 col = vec3(0.0);
  float a = 0.0;
  if (uShadow > 0.0) {
    a = uShadow * (1.0 - smoothstep(0.05, 0.5, r));
    col = uShadowColor;
  } else {
    float pool = uPool * exp(-r * r * 3.5) * 0.55;
    col += vColor * pool;
    a += pool;
    if (uRing > 0.0 && vIdle >= 0.0) {
      // The idle ring: full when the agent just served a request, draining
      // clockwise from the front as the idle timer approaches suspend.
      float band = 1.0 - smoothstep(0.0, 0.03, abs(r - 0.68) - 0.035);
      float ang = fract(atan(p.x, p.y) / 6.2831 + 0.5);
      float on = step(ang, vIdle);
      col += vColor * band * (0.25 + 1.1 * on) * uRing;
      a += band * (0.15 + 0.8 * on) * uRing;
    }
  }
  a *= 1.0 - vDim * 0.85;
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
}`;

// Rising particles over an agent serving a request: four billboards each.
const PARTICLES = 4;
const sparkVertex = /* glsl */ `
${lodChunk}
attribute float aSeed;
attribute float aDim;
attribute float aServe;
attribute float aHi;
uniform float uTime;
uniform float uCrown;
uniform float uBob;
varying vec2 vC;
varying float vA;
varying vec3 vColor;
void main() {
  if (aServe < 0.5 || aDim > 0.5 || aHi < -0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  mat4 m = modelMatrix * instanceMatrix;
  vec3 c = (m * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  if (lodScale(c) < 0.6) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float ph = aSeed * 6.2831;
  float top = c.y + uCrown * length(m[1].xyz) + uBob * (0.5 + 0.5 * sin(uTime * 1.7 + ph)) * 0.22;
  float i = position.z;
  float life = fract(uTime * 0.45 + i / ${PARTICLES.toFixed(1)} + aSeed * 7.3);
  float spread = 0.22 * (0.4 + life);
  vec3 wp = vec3(c.x + sin(ph + i * 2.1) * spread, top + 0.08 + life * 1.4, c.z + cos(ph + i * 2.1) * spread);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  mv.xy += position.xy * 0.075 * (1.25 - life);
  gl_Position = projectionMatrix * mv;
  vC = position.xy;
  vA = (1.0 - life) * smoothstep(0.0, 0.12, life);
  #ifdef USE_INSTANCING_COLOR
    vColor = instanceColor;
  #else
    vColor = vec3(1.0);
  #endif
}`;

const sparkFragment = /* glsl */ `
uniform float uBright;
uniform float uWhite;
varying vec2 vC;
varying float vA;
varying vec3 vColor;
void main() {
  float d = length(vC);
  if (d > 1.0) discard;
  gl_FragColor = vec4(mix(vColor, vec3(1.0), uWhite) * uBright, vA * (1.0 - d * d));
}`;

// Atespace tile: a rounded square under the agent, tinted by its atespace's
// hue (aTeam: the hue, plus 2 when parked; -1 for none), faded in with uTeam
// in worker view.
const tileVertex = /* glsl */ `
${lodChunk}
attribute float aTeam;
attribute float aDim;
attribute float aHi;
uniform float uTeam;
uniform float uTeamSat;
uniform float uTeamLight;
varying vec2 vUv;
varying vec3 vTint;
varying float vA;
vec3 hsl2rgb(float h, float s, float l) {
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return l + s * (k - 0.5) * (1.0 - abs(2.0 * l - 1.0));
}
void main() {
  if (uTeam < 0.005 || aTeam < 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec4 c = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float lod = lodScale(c.xyz);
  if (lod < 0.01) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec3 wp = vec3(c.x + position.x * lod, 0.128, c.z + position.z * lod);
  vUv = uv;
  // aTeam >= 2: parked (no worker), drawn fainter so platforms lead.
  float parked = step(2.0, aTeam);
  vTint = hsl2rgb(fract(aTeam), uTeamSat, uTeamLight);
  vA = uTeam * (1.0 - aDim * 0.8) * (aHi < -0.5 ? 0.35 : 1.0) * (1.0 - 0.55 * parked);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const tileFragment = /* glsl */ `
varying vec2 vUv;
varying vec3 vTint;
varying float vA;
void main() {
  vec2 q = abs(vUv * 2.0 - 1.0) - 0.62;
  float d = length(max(q, 0.0)) - 0.3;
  float a = vA * (1.0 - smoothstep(-0.04, 0.03, d));
  if (a < 0.004) discard;
  gl_FragColor = vec4(vTint, a);
}`;

function tileGeometry() {
  const g = new THREE.PlaneGeometry(1.32, 1.32);
  g.rotateX(-Math.PI / 2);
  return g;
}

function decalGeometry() {
  const g = new THREE.PlaneGeometry(2.2, 2.2);
  g.rotateX(-Math.PI / 2);
  return g;
}

function particleGeometry() {
  const pos = [];
  const idx = [];
  for (let i = 0; i < PARTICLES; i++) {
    pos.push(-1, -1, i, 1, -1, i, 1, 1, i, -1, 1, i);
    const b = i * 4;
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

/** The level-of-detail uniforms (shared with the scene's look, or defaults that draw every shape). */
function lodUniforms(look) {
  return {
    uScale: look.uScale || { value: 600 },
    uFarLo: look.uFarLo || { value: 0 },
    uFarHi: look.uFarHi || { value: 0.001 },
    uCloseNear: look.uCloseNear || { value: 1e6 },
    uCloseFar: look.uCloseFar || { value: 2e6 },
    uAllShapes: look.uAllShapes || { value: 1 },
  };
}

/** Per-instance float attributes every layer keeps (and its extras share). */
const ATTRS = ['aSeed', 'aDim', 'aFlash', 'aIdle', 'aServe', 'aHi', 'aTeam'];

/** One InstancedMesh per visual class, with slots that can be added and removed. */
export class Layer {
  /**
   * @param {string} cls visual class
   * @param {THREE.Object3D} parent
   * @param {object} shape from shapes.js
   * @param {THREE.BufferGeometry} geometry this layer's own copy of the shape
   * @param {{value: number}} timeUniform
   * @param {object} look shared uniforms the theme sets
   * @param {{decal?: object, particles?: boolean}} extras
   */
  constructor(cls, parent, shape, geometry, timeUniform, look, extras = {}) {
    this.cls = cls;
    this.parent = parent;
    this.geometry = geometry;
    const lk = CLASS_LOOK[cls];
    const mo = shape.motion[cls];
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    this.material = new THREE.ShaderMaterial({
      vertexShader: agentVertex,
      fragmentShader: agentFragment,
      defines: { ...shape.defines },
      side: lk.outline ? THREE.DoubleSide : THREE.FrontSide,
      uniforms: {
        uTime: timeUniform,
        uBreath: { value: lk.breath },
        uPulse: { value: lk.pulse },
        uOutline: { value: lk.outline },
        uEmissive: { value: lk.emissive },
        uBase: { value: lk.base },
        uSpeed: { value: lk.speed },
        uRim: { value: lk.rim },
        uDesat: { value: lk.desat },
        uFlat: { value: lk.flat },
        uCrack: { value: cls === 'crashed' && shape.crack ? 1 : 0 },
        uVisor: { value: mo.visor },
        uFlicker: { value: mo.flicker },
        uBob: { value: mo.bob },
        uSpin: { value: mo.spin },
        uWobble: { value: mo.wobble },
        uY0: { value: bb.min.y },
        uY1: { value: bb.max.y },
        ...lodUniforms(look),
        ...look,
      },
    });
    // Extras share this layer's instance buffers.
    this.decal = null;
    if (extras.decal) {
      const d = extras.decal;
      this.decal = {
        geometry: decalGeometry(),
        material: new THREE.ShaderMaterial({
          vertexShader: decalVertex,
          fragmentShader: decalFragment,
          transparent: true,
          depthWrite: false,
          uniforms: {
            uTime: timeUniform,
            uIdleFake: extras.fake,
            uPool: { value: d.pool || 0 },
            uRing: { value: d.ring || 0 },
            uShadow: { value: d.shadow || 0 },
            uShadowColor: { value: new THREE.Color(0x000000) },
            ...lodUniforms(look),
          },
        }),
        mesh: null,
      };
    }
    this.particles = null;
    if (extras.particles) {
      this.particles = {
        geometry: particleGeometry(),
        material: new THREE.ShaderMaterial({
          vertexShader: sparkVertex,
          fragmentShader: sparkFragment,
          transparent: true,
          depthWrite: false,
          uniforms: { uTime: timeUniform, uCrown: { value: shape.crown }, uBob: { value: mo.bob }, uBright: { value: 1.2 }, uWhite: { value: 0.45 }, ...lodUniforms(look) },
        }),
        mesh: null,
      };
    }
    // The atespace tile: always built, not an extra (x doesn't hide it).
    this.tile = {
      geometry: tileGeometry(),
      material: new THREE.ShaderMaterial({
        vertexShader: tileVertex,
        fragmentShader: tileFragment,
        transparent: true,
        depthWrite: false,
        uniforms: { uTeam: look.uTeam || { value: 0 }, uTeamSat: look.uTeamSat || { value: 0.5 }, uTeamLight: look.uTeamLight || { value: 0.5 }, ...lodUniforms(look) },
      }),
      mesh: null,
    };
    this.keys = [];
    this.capacity = 0;
    this.mesh = null;
    this.ranges = new DirtyRanges();
    this.attrs = {};
    this.allocate(64);
  }

  /** The decal and particle parts that exist (the ones x toggles). */
  extras() {
    return [this.decal, this.particles].filter(Boolean);
  }

  /** Every part that shares this layer's instance buffers. */
  parts() {
    return [...this.extras(), this.tile];
  }

  allocate(cap) {
    const old = this.mesh;
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    const attrs = {};
    for (const name of ATTRS) {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
      a.setUsage(THREE.DynamicDrawUsage);
      attrs[name] = a;
      // Each class has its own geometry clone so the per-instance
      // attributes don't collide between layers.
      this.geometry.setAttribute(name, a);
    }
    if (old) {
      mesh.instanceMatrix.array.set(old.instanceMatrix.array.subarray(0, this.capacity * 16));
      mesh.instanceColor.array.set(old.instanceColor.array.subarray(0, this.capacity * 3));
      for (const name of ATTRS) attrs[name].array.set(this.attrs[name].array.subarray(0, this.capacity));
      this.parent.remove(old);
      old.dispose();
    }
    this.attrs = attrs;
    mesh.count = this.keys.length;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.userData.layer = this;
    this.mesh = mesh;
    this.capacity = cap;
    this.parent.add(mesh);
    for (const x of this.parts()) {
      if (x.mesh) {
        this.parent.remove(x.mesh);
        x.mesh.dispose();
      }
      const em = new THREE.InstancedMesh(x.geometry, x.material, cap);
      // Share the agents' buffers: same slots, same colors.
      em.instanceMatrix = mesh.instanceMatrix;
      em.instanceColor = mesh.instanceColor;
      for (const name of ATTRS) x.geometry.setAttribute(name, attrs[name]);
      em.count = mesh.count;
      em.frustumCulled = false;
      em.renderOrder = x === this.tile ? 1 : 2;
      em.visible = x.visible !== false;
      x.mesh = em;
      this.parent.add(em);
    }
    this.markDirty();
  }

  get seed() {
    return this.attrs.aSeed;
  }
  get dim() {
    return this.attrs.aDim;
  }
  get flash() {
    return this.attrs.aFlash;
  }
  get hi() {
    return this.attrs.aHi;
  }
  get team() {
    return this.attrs.aTeam;
  }

  /** Grows the buffers to hold n shapes now, so they don't grow (several reallocations in one frame) when the camera first comes close. */
  reserve(n) {
    if (n <= this.capacity) return;
    let cap = this.capacity;
    while (cap < n) cap *= 2;
    this.allocate(cap);
  }

  add(key) {
    if (this.keys.length >= this.capacity) this.allocate(this.capacity * 2);
    const slot = this.keys.length;
    this.keys.push(key);
    this.setCount();
    this.markSlot(slot);
    return slot;
  }

  /** Removes a slot by moving the last one into it. Returns the moved key. */
  remove(slot) {
    const last = this.keys.length - 1;
    let moved = null;
    if (slot !== last) {
      moved = this.keys[last];
      this.keys[slot] = moved;
      this.mesh.instanceMatrix.array.copyWithin(slot * 16, last * 16, last * 16 + 16);
      this.mesh.instanceColor.array.copyWithin(slot * 3, last * 3, last * 3 + 3);
      for (const name of ATTRS) this.attrs[name].array[slot] = this.attrs[name].array[last];
    }
    this.keys.pop();
    this.setCount();
    this.markSlot(slot);
    return moved;
  }

  clear() {
    this.keys.length = 0;
    this.setCount();
    this.markDirty();
  }

  setCount() {
    this.mesh.count = this.keys.length;
    for (const x of this.parts()) x.mesh.count = this.keys.length;
  }

  /** Everything needs uploading (a resize, a clear). */
  markDirty() {
    this.ranges.markAll();
  }

  /** One slot was written: only its range uploads. */
  markSlot(slot) {
    this.ranges.mark(slot);
  }

  get dirty() {
    return this.ranges.dirty;
  }

  /** Uploads the slots written since the last flush (ranges, or everything when cheaper). */
  flush() {
    if (!this.ranges.dirty) return;
    const r = this.ranges.take(this.keys.length);
    uploadRanges([this.mesh.instanceMatrix, this.mesh.instanceColor, ...ATTRS.map((n) => this.attrs[n])], r);
  }

  dispose() {
    for (const m of [this.mesh, ...this.parts().map((x) => x.mesh)]) {
      if (!m) continue;
      this.parent.remove(m);
      m.dispose();
    }
    this.geometry.dispose();
    this.material.dispose();
    for (const x of this.parts()) {
      x.geometry.dispose();
      x.material.dispose();
    }
  }
}

/**
 * Every class's layer for one shape. Switching shapes means disposing this
 * and building a new one: geometries, materials and meshes all go.
 */
export class AgentLayers {
  /**
   * @param {THREE.Object3D} parent
   * @param {object} shape from shapes.js
   * @param {{value: number}} timeUniform
   * @param {object} look shared uniforms the theme sets
   * @param {{fake: {value: number}}} opts fake: 1 in synthetic mode (fake idle timers)
   */
  constructor(parent, shape, timeUniform, look, opts = {}) {
    this.shape = shape;
    this.parent = parent;
    this.fake = opts.fake || { value: 0 };
    const geo = shape.build();
    this.layers = {};
    for (const cls of CLASSES) {
      const extras = { fake: this.fake };
      if (cls === 'running') {
        extras.decal = { pool: shape.pool, ring: 1 };
        extras.particles = true;
      } else if (cls === 'suspended' && shape.contactShadow) {
        extras.decal = { shadow: 0.4 };
      }
      this.layers[cls] = new Layer(cls, parent, shape, geo.clone(), timeUniform, look, extras);
    }
    geo.dispose();
    this.extrasOn = true;
  }

  /** Adapts the extras to a theme: additive glow on dark themes, normal on light. */
  setTheme(theme) {
    const additive = !!theme.glow.additive;
    const blend = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    const run = this.layers.running;
    if (run.decal) {
      run.decal.material.blending = blend;
      // The light pool only reads on dark themes.
      run.decal.material.uniforms.uPool.value = additive ? this.shape.pool : 0;
      run.decal.material.needsUpdate = true;
    }
    if (run.particles) {
      run.particles.material.blending = blend;
      run.particles.material.uniforms.uBright.value = additive ? 1.3 : 0.9;
      run.particles.material.uniforms.uWhite.value = additive ? 0.45 : 0;
      run.particles.material.needsUpdate = true;
    }
    const sus = this.layers.suspended;
    if (sus.decal) {
      sus.decal.material.uniforms.uShadow.value = additive ? 0.5 : 0.22;
      sus.decal.material.uniforms.uShadowColor.value.set(additive ? 0x000000 : 0x3c4043);
    }
    for (const cls of CLASSES) {
      this.layers[cls].material.uniforms.uBase.value = additive ? CLASS_LOOK[cls].base : 1;
    }
  }

  /** Turns the decals and particles on or off. */
  setExtras(on) {
    this.extrasOn = on;
    for (const l of Object.values(this.layers)) {
      for (const x of l.extras()) {
        x.visible = on;
        if (x.mesh) x.mesh.visible = on;
      }
    }
  }

  /** Reserves room per class ({class: shapes}), see Layer.reserve. */
  reserve(counts) {
    for (const [cls, n] of Object.entries(counts)) this.layers[cls]?.reserve(n);
  }

  /** The meshes picking should test (the agents, not their extras). */
  pickable() {
    return CLASSES.map((c) => this.layers[c].mesh).filter((m) => m.count > 0);
  }

  flush() {
    for (const l of Object.values(this.layers)) l.flush();
  }

  dispose() {
    for (const l of Object.values(this.layers)) l.dispose();
    this.layers = {};
  }
}
