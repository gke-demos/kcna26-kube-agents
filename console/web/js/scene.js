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

// The 3D scene: the cluster island, districts (atespaces, or workers grouped
// by node pool and node in the "group by worker" view), agents, worker pads
// with flowing links to their agents, the router (in a switchable look), and
// the short animations that show events.
//
// Two layouts (decks.js): 'decks' (default) puts the agents on a glassy top
// deck and the workers on a deck of their own below, joined by beams (one
// per agent holding a worker) and, zoomed out, flow ribbons per atespace ->
// node pool (beams.js); 'combined' is the single island with the worker
// pads along its front edge and the "group by worker" view.
//
// Agents are drawn at three levels of detail (see lod.js): far, each
// district is one aggregate tile (tiles.js); mid, each agent is one point
// sprite (points.js); close, the agents nearest the camera, up to a budget,
// are full shapes (agents.js: one InstancedMesh per visual class), and the
// rest stay points. The levels crossfade per pixel in the shaders. Small
// clusters (no more agents than the budget) draw every agent as a shape,
// as before.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

import { CLASSES, stateClass } from './model.js';
import { AgentLayers } from './agents.js';
import { shapeById } from './shapes.js';
import { buildRouter, routerId } from './routers.js';
import { planIsland, slotPosition, slotAt, SlotTable, CELL, labelAnchor } from './layout.js';
import { esc, duration, since, workerLabel, compact } from './format.js';
import { Effects } from './effects.js';
import { themeById, classColor, hex } from './themes.js';
import { buildGround, buildWorkerDeck, clearGroup, hashString, roundedRect } from './island.js';
import { LinkSet } from './links.js';
import { WorkerPads, PAD_H } from './pads.js';
import { PARKED, WORKER_STRIP, PAD_SPACING, groupId, groupOf, groupCounts, planWorkerView, planPadArea, focusOf, levelOf, sameFocus, workerUsage, teamHues, teamCSS } from './workers.js';
import { PointLayer, CLASS_INDEX } from './points.js';
import { AggregateTiles } from './tiles.js';
import { Aggregates, RectIndex, selectNearest, pickRay, cellPixels, depthForPixels, farMix, lodLevel, FAR_LO, FAR_HI, SHAPE_PX, SHAPE_BUDGET } from './lod.js';
import { FrameStats } from './perf.js';
import { layoutId, deckViewId, deckAlphas, planWorkerDeck, FlowCounts, ribbonSize, ribbonLevel, litTiles, sameTile, beamSet, BEAM_BUDGET, BEAM_DROP } from './decks.js';
import { defaultOffsets, copyOffsets, moveDeck, clampOffsets, relOffset, easeOffsets, deckLimits, deckAt, rayAtY, unitsPerPixel } from './decks.js';
import { beamModeId, focusBeams, BEAM_RECENT, BEAM_RECENT_RATE, BUNDLE } from './decks.js';
import { BeamSet, RibbonSet } from './beams.js';
import { Gestures } from './gestures.js';

// The active theme (see themes.js). Every state shares its class color: the
// five class colors of a theme are validated as a set.
let theme = themeById();
export function stateColor(state) {
  return hex(cssColor(state));
}
export function cssColor(state) {
  return classColor(theme, stateClass(state));
}

const TONE_MAPPING = { none: THREE.NoToneMapping, neutral: THREE.NeutralToneMapping, aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping };

/** A vertical gradient for the scene background. */
function gradientTexture(top, bottom) {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, top);
  g.addColorStop(0.65, bottom);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A flat text plane drawn with a canvas texture (for the island's name). */
function textPlane(text, { size = 3, color = '#7f93bd', weight = 700, letterSpacing = 0.18 } = {}) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const px = 128;
  ctx.font = `${weight} ${px}px Inter, "Segoe UI", system-ui, sans-serif`;
  const spaced = text.toUpperCase().split('').join(String.fromCharCode(8202));
  const w = Math.ceil(ctx.measureText(spaced).width + px * letterSpacing * text.length) + 40;
  canvas.width = w;
  canvas.height = px * 1.4;
  ctx.font = `${weight} ${px}px Inter, "Segoe UI", system-ui, sans-serif`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  let x = 20;
  for (const ch of text.toUpperCase()) {
    ctx.fillText(ch, x, canvas.height / 2);
    x += ctx.measureText(ch).width + px * letterSpacing;
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const aspect = canvas.width / canvas.height;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.9 });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size * aspect, size), mat);
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

/** Sets a label's HTML when it changed (and forgets its size estimate). */
function setHTML(el, html) {
  if (el.innerHTML === html) return;
  el.innerHTML = html;
  el._est = null;
}

/**
 * A district label's size on screen, estimated from its text (no layout
 * reads, which force reflows): widths full, without chips (compact) and
 * name only (tiny), and heights.
 */
function labelSize(el) {
  if (el._est) return el._est;
  const name = el.querySelector('.name')?.textContent.length || 0;
  const meta = el.querySelector('.meta');
  let base = 0;
  let chips = 0;
  if (meta) {
    for (const n of meta.childNodes) {
      if (n.nodeType === 1 && n.classList.contains('chip')) chips += n.textContent.length * 5.8 + 25;
      else base += (n.textContent || '').length * 6.2;
    }
  }
  const nameW = name * 8 + 22;
  el._est = { full: Math.max(nameW, base + chips + 22), compact: Math.max(nameW, base + 22), tiny: nameW, h: meta ? 38 : 24, th: 24 };
  return el._est;
}

// Seconds a label stays up after its agent changes state (crashes: twice).
const CHANGE_LABEL_SECONDS = 6;
// Camera-to-target distance under which 'auto' labels every nearby agent.
const CLOSE_UP_DISTANCE = 20;
// Camera-to-pad distance under which worker pads show their labels.
const WORKER_LABEL_DISTANCE = 34;
// Seconds agents take to move between layouts when the grouping changes.
const MOVE_SECONDS = 0.8;
// Above this many agents, layout changes are instant (no tween).
const MOVE_MAX_AGENTS = 20000;
// Seconds between level-of-detail re-selections of the shapes near the camera.
const NEAR_EVERY = 0.2;
// Seconds between label passes (agent, district, pad labels) and aggregate updates.
const LABEL_EVERY = 0.25;
// Re-plans (a district overflowed, a new atespace or worker) wait at least this long after the last.
const REPLAN_EVERY = 1.0;
// Effects at scale: at most this many per second (burst: twice that), only in view.
const FX_RATE = 10;
// Point sprites' lift per class (matches points.js), for picking.
const POINT_TOP = { running: 1.0, transition: 0.8, suspended: 0.5, crashed: 0.6, pending: 0.7 };
// Most "just changed" agent labels at once in big clusters.
const MAX_PINNED = 10;
// Pooled labels for worker platforms in big worker views.
const PLATFORM_LABELS = 24;
// Focus beams: how visible the ribbons stay where beams would be (they carry the flow at rest).
const FOCUS_RIBBONS = 0.22;
// A deck's grab rim: this many pixels either side of its edge (at least the band's width).
const RIM_PX = 11;

export class Scene {
  /**
   * @param {HTMLElement} container
   * @param {{onPick?: Function, onHover?: Function, onHoverWorker?: Function, onFocus?: Function}} handlers
   * @param {{shape?: string, router?: string, extras?: boolean, group?: string, layout?: string, budget?: number, quality?: string}} opts
   */
  constructor(container, handlers = {}, opts = {}) {
    this.container = container;
    this.handlers = handlers;
    this.time = { value: 0 };
    this.timer = new THREE.Timer();
    this.recs = new Map();
    /** point index -> agent key */
    this.keyOfIdx = [];
    this.filter = () => true;
    this.selected = null;
    this.anims = new Map();
    this.labelPinned = new Map(); // key -> until (seconds)
    // Agent labels: 'auto' (selected, recent changes, close-ups), 'all', 'off'.
    this.labelMode = 'auto';
    this.plan = null;
    this.model = null;
    // 'decks' or 'combined' (see decks.js). Decks always group by atespace
    // (the workers have a deck of their own); the grouping the user picked
    // is kept for 'combined'.
    this.layout = layoutId(opts.layout);
    this.groupPref = groupId(opts.group);
    // 'atespace' or 'worker': what the districts are (see workers.js).
    this.group = this.layout === 'decks' ? 'atespace' : this.groupPref;
    // Decks: the worker deck's plan, which decks show, their fades (eased),
    // agents per atespace -> pool pair (the ribbons), agents holding a
    // worker (the beams), and the tile under the pointer when far.
    this.deck = null;
    this.deckView = 'both';
    this.deckA = { agents: 1, workers: 1 };
    this.fade = { agents: { value: 1 }, workers: { value: 1 }, beams: { value: 1 } };
    this.flows = new FlowCounts();
    this.holders = new Set();
    this.hoverTile = null;
    this.beamsTrimmed = false;
    this.beams = null;
    this.ribbons = null;
    this.workerTiles = null;
    // Beams: 'focus' (only the agent, worker or recent changes in focus;
    // ribbons carry the rest) or 'all' (up to BEAM_BUDGET). Recent changes:
    // key -> time its beam stops showing; started at most BEAM_RECENT_RATE a second.
    this.beamMode = beamModeId(opts.beams);
    this.recentBeams = new Map();
    this.beamTokens = BEAM_RECENT_RATE * 2;
    // Movable decks (decks.js): where the user put them (offsets) and what
    // is drawn (shown, easing to offsets on a reset). The scene's frame is
    // the agent deck's: moving the agent deck moves the camera, the sea and
    // the stars the other way instead (so picking, labels and the level of
    // detail never need its offset); the worker deck sits at its offset
    // relative to the agent deck.
    this.offsets = defaultOffsets();
    this.shown = defaultOffsets();
    this.frameShift = { x: 0, y: 0, z: 0 };
    this.deckLim = null;
    this.decksEasing = false;
    // The deck rim (or, with Option/Alt, deck) under the pointer, and a drag in progress.
    this.handle = null;
    this.deckDrag = null;
    this.dragging = null;
    this.altDown = false;
    // What the user points at; focusOf() turns it into the worker in focus.
    this.hl = { hoverWorker: null, pinnedWorker: null, hoverAgent: null, selectedAgent: null };
    this.focus = { worker: null, strong: false };
    // Agents moving between layouts: key -> {fx, fz, tx, tz, t0, dur}.
    this.moves = new Map();
    this.teams = new Map();
    // Level of detail: the agents drawn as shapes, and how many may be.
    this.near = new Set();
    this.budget = Math.max(100, Math.floor(opts.budget || SHAPE_BUDGET));
    this.baseBudget = this.budget;
    this.allShapes = true;
    this.closeR = { target: 1e6, value: 1e6 };
    this.lastNear = { t: -1, x: NaN, y: NaN, z: NaN, tx: NaN, tz: NaN };
    this.lod = 'close';
    // Incremental bookkeeping: per-district counts, agents per worker.
    this.agg = new Aggregates();
    this.hosted = new Map();
    this.byWorker = new Map();
    this.workerIx = new Map();
    this.dirtyGroups = new Set();
    this.dirtyPads = new Set();
    this.labelsDirty = true;
    this.replanAt = -1;
    this.lastReplan = -Infinity;
    this.fxTokens = FX_RATE * 2;
    this.frameStats = new FrameStats();
    this.cameraDriver = null;
    this.lastInfo = { calls: 0, triangles: 0, points: 0, lines: 0 };
    this.lastCpu = 0;
    const rm = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    this.reducedMotion = !!rm?.matches;
    rm?.addEventListener?.('change', (e) => {
      this.reducedMotion = e.matches;
      this.applyFlow();
    });
    // ?slowmo=N plays animations N times slower (for recording demos and
    // for screenshots with a software renderer).
    const params = new URLSearchParams(window.location.search);
    this.slowmo = Math.max(1, Number(params.get('slowmo')) || 1);
    // The agents' shape and the router's look (see shapes.js, routers.js);
    // main.js sets the remembered choice before the first snapshot.
    this.shape = shapeById(opts.shape);
    this.routerKind = routerId(opts.router);
    this.router = null;
    this.extras = opts.extras !== false;
    // 1 in synthetic mode: idle rings run on fake timers and a random
    // subset of running agents "serves requests".
    this.fake = { value: 0 };

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    // Quality: 'auto' lowers the pixel ratio (then bloom) while frames are
    // slow and raises it back when there is headroom; 'high' never lowers;
    // 'low' starts at pixel ratio 1 without bloom.
    const mode = ['auto', 'high', 'low'].includes(opts.quality) ? opts.quality : 'auto';
    const maxDpr = Math.min(window.devicePixelRatio || 1, 2);
    this.quality = { mode, maxDpr, dpr: mode === 'low' ? 1 : maxDpr, bloom: mode !== 'low', slow: 0, fast: 0, lastCheck: 0 };
    renderer.setPixelRatio(this.quality.dpr);
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.info.autoReset = false;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const labels = new CSS2DRenderer();
    labels.domElement.className = 'label-layer';
    container.appendChild(labels.domElement);
    this.labelRenderer = labels;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x000000, 0.006);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 2000);
    camera.position.set(0, 40, 55);
    this.camera = camera;

    const controls = new OrbitControls(camera, labels.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.47;
    controls.minDistance = 6;
    controls.maxDistance = 600;
    // Panning is in the screen plane (up, down, left, right); right-drag,
    // Shift+drag and trackpad scrolls are handled by gestures.js so the
    // point under the cursor stays there. The wheel zooms toward the cursor.
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;
    this.controls = controls;

    this.ambient = new THREE.AmbientLight(0xffffff, 0);
    scene.add(this.ambient);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1);
    scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1);
    sun.position.set(30, 60, 25);
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.radius = 6;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);
    scene.add(sun.target);
    this.sun = sun;

    // Shared agent-shader uniforms the theme and the level of detail set.
    this.look = {
      uGlow: { value: 1 },
      uAmb: { value: 0.1 },
      uDiff: { value: 0.45 },
      uHemi: { value: 0.22 },
      uGloss: { value: 0 },
      uInk: { value: 0 },
      uOcc: { value: 0 },
      uAdditive: { value: 1 },
      uDimColor: { value: new THREE.Color() },
      // How far agents outside a focused worker recede.
      uHiDim: { value: 0.7 },
      // Atespace tiles (worker view): strength, and the tints' saturation and lightness.
      uTeam: { value: 0 },
      uTeamSat: { value: 0.5 },
      uTeamLight: { value: 0.6 },
      // Level of detail (device pixels per world unit at depth 1, and the
      // cell sizes in device pixels where tiles give way to agents).
      uScale: { value: 600 },
      uFarLo: { value: FAR_LO },
      uFarHi: { value: FAR_HI },
      uCloseNear: { value: 1e6 },
      uCloseFar: { value: 2e6 },
      uAllShapes: { value: 1 },
    };

    this.world = new THREE.Group();
    scene.add(this.world);
    // The agent deck (the whole island in 'combined'): ground and router,
    // agents (points, and shapes in their own group), far tiles.
    this.agentDeck = new THREE.Group();
    this.world.add(this.agentDeck);
    this.islandGroup = new THREE.Group();
    this.agentDeck.add(this.islandGroup);
    this.agentGroup = new THREE.Group();
    this.agentDeck.add(this.agentGroup);
    this.shapeGroup = new THREE.Group();
    this.agentGroup.add(this.shapeGroup);
    // The worker deck (decks layout: its height is the deck's; 'combined':
    // 0, and only the pads are in it).
    this.workerDeck = new THREE.Group();
    this.world.add(this.workerDeck);
    this.workerGround = new THREE.Group();
    this.workerDeck.add(this.workerGround);

    this.points = new PointLayer(this.agentGroup, this.time, this.look, { fade: this.fade.agents });
    this.tiles = new AggregateTiles(this.agentDeck, this.time, this.look, { fade: this.fade.agents });
    this.buildAgents();

    this.effects = new Effects(this.world, this.time);
    this.addBackdrop();
    this.addSelectionMarker();

    // Agent-to-worker links (arcs with flowing dots) and the worker pads.
    this.links = new LinkSet(this.world, this.time);
    this.applyFlow();
    const makeLabel = (cls) => {
      const div = document.createElement('div');
      div.className = cls;
      return new CSS2DObject(div);
    };
    this.pads = new WorkerPads(this.workerDeck, makeLabel);
    // Deck names beside each deck (decks layout).
    this.deckLabels = {};
    for (const k of ['agents', 'workers']) {
      const l = makeLabel('deck-label');
      l.element.classList.add(k);
      l.center.set(1, 0.5);
      l.visible = false;
      this.world.add(l);
      this.deckLabels[k] = l;
    }
    // Labels lent to the worker platforms in view (big worker views).
    this.platformLabels = [];
    for (let i = 0; i < PLATFORM_LABELS; i++) {
      const l = makeLabel('district-label');
      l.element.classList.add('worker');
      l.center.set(0, 1);
      l.visible = false;
      this.world.add(l);
      this.platformLabels.push(l);
    }

    // Post-processing: bloom on the emissive parts.
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.45, 0.8);
    composer.addPass(this.bloom);
    composer.addPass(new OutputPass());
    this.composer = composer;
    this.setTheme(theme);

    // Agent label pool.
    this.agentLabels = [];
    for (let i = 0; i < 48; i++) {
      const div = document.createElement('div');
      div.className = 'agent-label';
      const obj = new CSS2DObject(div);
      obj.center.set(0.1, 1);
      obj.visible = false;
      this.world.add(obj);
      this.agentLabels.push(obj);
    }
    this.lastLabelUpdate = 0;
    this.lastHoverPick = 0;

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.bindPointer(labels.domElement);
    this.gestures = new Gestures(container, this, { onDrag: (kind) => this.handlers.onDrag?.(kind) });

    this.resize = this.resize.bind(this);
    window.addEventListener('resize', this.resize);
    this.resize();
    this.flyAnim = null;
    renderer.setAnimationLoop(() => this.frame());
  }

  addBackdrop() {
    // A faint grid "sea" that fades out with distance.
    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(1600, 1600),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: {
          uGrid: { value: new THREE.Color() },
          uGridA: { value: 0.2 },
          uSea: { value: new THREE.Color() },
          uSeaA: { value: 0.9 },
          uFade: { value: 0.018 },
          // The grid moves with the sea (the agent deck's moves shift it);
          // it fades out around the decks.
          uOrigin: { value: new THREE.Vector2() },
          uCenter: { value: new THREE.Vector2() },
        },
        vertexShader: `varying vec3 vP; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vP = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
        fragmentShader: `varying vec3 vP; uniform vec3 uGrid; uniform float uGridA; uniform vec3 uSea; uniform float uSeaA; uniform float uFade; uniform vec2 uOrigin; uniform vec2 uCenter;
          void main(){
            vec2 q = (vP.xz - uOrigin) / 4.0;
            vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
            float line = 1.0 - min(min(g.x, g.y), 1.0);
            float d = length(vP.xz - uCenter);
            float fade = exp(-d * uFade);
            vec3 c = mix(uSea, uGrid, line * uGridA);
            gl_FragColor = vec4(c, fade * uSeaA);
          }`,
      }),
    );
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = -1.6;
    // Drawn first: the glass deck (decks layout) must blend over it.
    sea.renderOrder = -2;
    this.scene.add(sea);
    this.sea = sea;

    // Stars.
    const n = 1400;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1;
      const t = Math.random() * Math.PI * 2;
      const r = 700 + Math.random() * 300;
      const s = Math.sqrt(1 - u * u);
      pos[i * 3] = r * s * Math.cos(t);
      pos[i * 3 + 1] = Math.abs(r * u) * 0.8 + 40;
      pos[i * 3 + 2] = r * s * Math.sin(t);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.55, fog: false }));
    this.scene.add(stars);
    this.stars = stars;
  }

  addSelectionMarker() {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1.0, 48),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 1, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    const marker = new THREE.Group();
    marker.add(ring);
    marker.add(beam);
    marker.visible = false;
    this.world.add(marker);
    this.marker = { group: marker, ring, beam };

    const hover = new THREE.Mesh(
      new THREE.RingGeometry(0.75, 0.85, 40),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide }),
    );
    hover.rotation.x = -Math.PI / 2;
    hover.visible = false;
    this.world.add(hover);
    this.hoverRing = hover;
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.links.setScale(h / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))));
    this.updateLodUniforms();
    this.sizeBeams();
  }

  /** Beams are a few device pixels wide whatever the canvas size. */
  sizeBeams() {
    if (!this.beams) return;
    const v = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.beams.setViewport(v.x, v.y, 1.9 * this.renderer.getPixelRatio());
  }

  /** Pixel-dependent level-of-detail uniforms (device pixels: gl_PointSize is in them). */
  updateLodUniforms() {
    const h = this.container.clientHeight || window.innerHeight;
    const dpr = this.renderer.getPixelRatio();
    this.look.uScale.value = (h * dpr) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    this.look.uFarLo.value = FAR_LO * dpr;
    this.look.uFarHi.value = FAR_HI * dpr;
  }

  // ---------------------------------------------------------------- theme

  /** The blending for glowing lines and effects: additive only on dark themes. */
  get blending() {
    return theme.glow.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
  }

  /** Applies a theme (see themes.js) without rebuilding the page. */
  setTheme(t) {
    theme = t;
    const sc = t.scene;
    this.scene.background?.dispose?.();
    this.scene.background = gradientTexture(sc.backgroundTop, sc.background);
    this.scene.fog.color.set(sc.fog);
    this.scene.fog.density = sc.fogDensity * this.fogScale();
    const su = this.sea.material.uniforms;
    su.uGrid.value.set(sc.grid);
    su.uGridA.value = sc.gridAlpha;
    su.uSea.value.set(sc.sea);
    su.uSeaA.value = sc.seaAlpha;
    this.stars.visible = !!sc.stars;
    if (sc.stars) {
      this.stars.material.color.set(sc.stars);
      this.stars.material.opacity = sc.starAlpha;
    }

    const L = t.light;
    this.renderer.toneMapping = TONE_MAPPING[L.toneMapping] ?? THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = L.exposure;
    this.ambient.color.set(L.ambient);
    this.ambient.intensity = L.ambientIntensity;
    this.hemi.color.set(L.hemiSky);
    this.hemi.groundColor.set(L.hemiGround);
    this.hemi.intensity = L.hemiIntensity;
    this.sun.color.set(L.sun);
    this.sun.intensity = L.sunIntensity;
    this.sun.castShadow = L.shadow;
    this.sun.shadow.intensity = L.shadowAlpha;
    this.renderer.shadowMap.enabled = L.shadow;

    const g = t.glow;
    this.look.uGlow.value = g.emissive;
    this.look.uAmb.value = g.ambient;
    this.look.uDiff.value = g.diffuse;
    this.look.uHemi.value = g.hemi;
    this.look.uGloss.value = g.gloss;
    this.look.uInk.value = g.ink;
    this.look.uOcc.value = g.occlusion;
    this.look.uAdditive.value = g.additive ? 1 : 0;
    this.look.uDimColor.value.set(sc.background);
    this.look.uHiDim.value = g.additive ? 0.72 : 0.78;
    this.look.uTeamSat.value = t.team.saturation;
    this.look.uTeamLight.value = t.team.lightness;
    // Light themes draw every class at full strength (their suspended color
    // is already pale) and blend the extras normally.
    this.agents.setTheme(t);
    this.applyClassColors();

    this.applyBloom();

    const blend = this.blending;
    this.styleLinks();
    this.styleDecks();
    this.marker.ring.material.color.set(t.marker.select);
    this.marker.beam.material.color.set(t.marker.select);
    this.hoverRing.material.color.set(t.marker.hover);
    for (const m of [this.marker.ring.material, this.marker.beam.material, this.hoverRing.material]) m.blending = blend;
    this.effects.blending = blend;

    // Shadows and blending changes need recompiled materials.
    this.scene.traverse((o) => {
      for (const m of [o.material].flat()) if (m) m.needsUpdate = true;
    });
    // Rebuild the ground and pads, recolor the agents drawn as shapes.
    if (this.model && this.plan) {
      this.buildIsland(this.model.cluster);
      for (const key of this.near) this.writeColor(this.recs.get(key));
      this.rebuildWorkers();
      this.syncTiles();
      this.labelsDirty = true;
    }
  }

  /** State colors for the point sprites and the far tiles. */
  applyClassColors() {
    const colors = Object.fromEntries(CLASSES.map((c) => [c, classColor(theme, c)]));
    this.points.setLook(colors, this.shape.id, theme.glow.additive ? THREE.AdditiveBlending : THREE.NormalBlending);
    this.tiles.setColors(colors, THREE.NormalBlending);
  }

  applyBloom() {
    this.bloom.enabled = theme.bloom.strength > 0 && this.quality.bloom;
    this.bloom.strength = theme.bloom.strength;
    this.bloom.radius = theme.bloom.radius;
    this.bloom.threshold = theme.bloom.threshold;
  }

  /** Fog thins out on big islands, so the far side doesn't vanish. */
  fogScale() {
    const span = this.island ? Math.max(this.island.width, this.island.depth * 1.5) : 0;
    return Math.min(1, 170 / Math.max(span, 1));
  }

  // --------------------------------------------------------------- shapes

  /** Builds the agent layers for the current shape. */
  buildAgents() {
    this.agents = new AgentLayers(this.shapeGroup, this.shape, this.time, this.look, { fake: this.fake });
    this.layers = this.agents.layers;
    this.agents.setExtras(this.extras);
  }

  /** Switches the agents' shape live: the old layers are disposed. */
  setAgentShape(id) {
    const shape = shapeById(id);
    if (shape === this.shape) return;
    this.shape = shape;
    this.agents.dispose();
    this.buildAgents();
    this.agents.setTheme(theme);
    this.applyClassColors();
    this.anims.clear();
    const near = [...this.near];
    this.near.clear();
    for (const key of near) {
      const rec = this.recs.get(key);
      rec.slot = -1;
      const pose = shape.pose[rec.cls];
      rec.h = pose.h;
      rec.tip = pose.tip;
      this.attach(rec);
    }
    for (const rec of this.recs.values()) {
      if (rec.slot >= 0) continue;
      const pose = shape.pose[rec.cls];
      rec.h = pose.h;
      rec.tip = pose.tip;
    }
    this.relinkAll();
    this.updateMarker();
  }

  /** Switches the router's look live. */
  setRouter(id) {
    const kind = routerId(id);
    if (kind === this.routerKind && this.router) return;
    this.routerKind = kind;
    if (this.island) this.buildRouter();
  }

  /** Turns the agents' extras (idle rings, light pools, particles) on or off. */
  setExtras(on) {
    this.extras = on;
    this.agents.setExtras(on);
    this.applyFlow();
  }

  /** Flowing dots on links, pulses on beams and ribbons: on with extras, off with reduced motion. */
  applyFlow() {
    const on = this.extras && !this.reducedMotion;
    this.links?.setFlow(on);
    this.beams?.setFlow(on);
    this.ribbons?.setFlow(on);
  }

  /** Synthetic mode: fake idle timers and request serving. */
  setFakeActivity(on) {
    this.fake.value = on ? 1 : 0;
  }

  buildRouter() {
    this.router?.dispose();
    this.router = buildRouter(this.routerKind, {
      theme,
      blending: this.blending,
      island: this.island,
      time: this.time,
      makeLabel: (text) => {
        const div = document.createElement('div');
        div.className = 'tower-label';
        div.textContent = text;
        return new CSS2DObject(div);
      },
    });
    this.islandGroup.add(this.router.group);
  }

  /** World height of an agent's top (labels, arcs, the marker). */
  topOf(rec) {
    return rec.slot >= 0 || this.allShapes ? this.shape.top(rec.h, rec.tip) : POINT_TOP[rec.cls];
  }

  // ---------------------------------------------------------------- data

  /** Rebuilds everything from the model (after a snapshot or a re-plan). */
  setModel(model) {
    this.model = model;
    for (const cls of CLASSES) this.layers[cls].clear();
    this.near.clear();
    for (const rec of this.recs.values()) this.points.free(rec.idx);
    this.points.clear();
    this.keyOfIdx = [];
    this.recs.clear();
    this.anims.clear();
    this.moves.clear();
    this.links.clear();
    this.replan(true);
  }

  /** The district plan for the current grouping, with its far tiles and (atespace view) pad area. */
  makePlan() {
    const model = this.model;
    const counts = groupCounts(model, this.group);
    if (this.group === 'worker') {
      const workers = [...counts.entries()]
        .filter(([name]) => name !== PARKED)
        .map(([name, count]) => {
          const w = model.workers.get(name);
          return { name, count, capacity: w?.capacityActors || 0, pool: w?.pool, node: w?.node };
        });
      const plan = planWorkerView(workers, counts.get(PARKED) || 0);
      plan.padArea = null;
      return plan;
    }
    const atespaces = [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => (a.name < b.name ? -1 : 1));
    const plan = planIsland(atespaces.length ? atespaces : [{ name: '(none)', count: 0 }]);
    plan.tiles = [...plan.districts.values()].map((d) => ({ name: d.name, kind: 'atespace', x: d.x, z: d.z, w: d.w, d: d.d, groups: [d.name] }));
    plan.frames = [];
    if (this.layout === 'decks') {
      // The workers get a deck of their own (planned with the island, see buildIsland).
      plan.padArea = null;
      plan.padFrames = [];
      return plan;
    }
    // The worker pads along the front edge, grouped by node pool.
    const area = planPadArea([...model.workers.values()], plan.width);
    const ox = -1.2;
    const oz = plan.depth / 2 + 3.2;
    plan.padArea = { items: area.items.map((it) => ({ ...it, x: it.x + ox, z: it.z + oz })) };
    plan.padFrames = area.frames.map((f) => ({ ...f, x: f.x + ox, z: f.z + oz }));
    plan.padDepth = area.depth;
    return plan;
  }

  /** Asks for a re-plan soon (coalesced: at most one per REPLAN_EVERY). */
  replanSoon() {
    if (this.replanAt < 0) this.replanAt = Math.max(this.time.value, this.lastReplan + REPLAN_EVERY);
  }

  /**
   * Lays out the island again and places every agent. With tween, agents
   * glide from where they were to their new cells (a grouping change).
   */
  replan(fit = false, tween = false) {
    const model = this.model;
    const firstPlan = !this.plan;
    this.replanAt = -1;
    this.lastReplan = this.time.value;
    this.plan = this.makePlan();
    this.slots = new Map();
    for (const d of this.plan.districts.values()) this.slots.set(d.name, new SlotTable(d.capacity));
    this.distIndex = new RectIndex([...this.plan.districts.values()]);
    this.teams = teamHues(model.atespaces.size ? model.atespaces.keys() : new Set([...model.agents.values()].map((a) => a.atespace)));
    this.buildIsland(model.cluster);

    const keys = [...model.agents.keys()].sort();
    const existing = this.recs;
    for (const cls of CLASSES) this.layers[cls].clear();
    this.near.clear();
    this.recs = new Map();
    this.agg.clear();
    this.hosted.clear();
    this.byWorker.clear();
    this.flows.clear();
    this.holders.clear();
    this.beams?.clear();
    this.ribbons?.clear();
    this.allShapes = keys.length <= this.baseBudget;
    this.look.uAllShapes.value = this.allShapes ? 1 : 0;
    this.points.points.visible = !this.allShapes;
    const animate = tween && !this.reducedMotion && keys.length <= MOVE_MAX_AGENTS;
    const t0 = this.time.value;
    this.moves.clear();
    for (const key of keys) {
      const a = model.agents.get(key);
      const old = existing.get(key);
      if (old) old.slot = -1;
      if (!this.place(key, a, old)) continue;
      if (animate && old) {
        const rec = this.recs.get(key);
        this.moves.set(key, { fx: old.x, fz: old.z, tx: rec.x, tz: rec.z, t0: t0 + rec.seed * 0.15, dur: MOVE_SECONDS });
        rec.x = old.x;
        rec.z = old.z;
        this.writePos(rec);
      }
    }
    // Agents that are gone (or found no room) free their points.
    for (const [key, old] of existing) {
      if (this.recs.has(key)) continue;
      this.points.free(old.idx);
      this.keyOfIdx[old.idx] = undefined;
      this.links.remove(key);
    }
    this.links.clear();
    // Big clusters: room for the close-up shapes up front, so their buffers
    // don't grow (and upload) mid-flight the first time the camera comes close.
    if (!this.allShapes) {
      const per = Object.fromEntries(CLASSES.map((c) => [c, 0]));
      for (const rec of this.recs.values()) per[rec.cls]++;
      for (const c of CLASSES) per[c] = Math.min(per[c], this.baseBudget);
      this.agents.reserve(per);
    }
    this.rebuildWorkers();
    this.syncTiles();
    this.labelsDirty = true;
    this.lastNear.t = -1;
    this.refreshNear(true);
    this.relinkAll();
    this.flushRibbons(true);
    this.updateMarker();
    if (fit || firstPlan) this.fitCamera();
    if (firstPlan || this.needCompile) this.precompile();
    // Frames while the plan was built say nothing about the scene's speed.
    this.frameStats.count = 0;
    this.quality.slow = this.quality.fast = 0;
  }

  /**
   * Compiles every material up front, including the far tiles and points
   * that are hidden until the camera pulls back and the effects that are
   * built on demand, so neither the first zoom nor the first wake in view
   * stalls on shader compiles.
   */
  precompile() {
    this.needCompile = false;
    // Everything hidden for now (far tiles, points, extras, flowing dots,
    // the deck layers) and one of each effect, which are otherwise built
    // on first use: the first wake or crash in view would compile its
    // shader mid-frame.
    const warm = this.effects.warmup();
    const hidden = [];
    this.scene.traverse((o) => {
      if (!o.visible && !o.isCSS2DObject) hidden.push(o);
    });
    for (const o of hidden) o.visible = true;
    // Then draw everything once, off screen: compiling builds the programs,
    // but buffers upload, vertex layouts bind and drivers (ANGLE on Metal,
    // SwiftShader) build their pipelines on an object's first draw, which
    // otherwise lands mid-flight (the beams first draw when the camera
    // comes in to mid range, effects when the first one plays in view).
    // Layers with no instances yet draw one, objects out of view too.
    const restore = [];
    this.scene.traverse((o) => {
      if (o.isCSS2DObject) return;
      const g = o.geometry;
      if (o.frustumCulled) {
        o.frustumCulled = false;
        restore.push(() => (o.frustumCulled = true));
      }
      if (o.isInstancedMesh && o.count === 0) {
        o.count = 1;
        restore.push(() => (o.count = 0));
      } else if (g?.isInstancedBufferGeometry && g.instanceCount === 0) {
        g.instanceCount = 1;
        restore.push(() => (g.instanceCount = 0));
      }
    });
    // Compile the variants the frame uses: the render pass draws into the
    // composer's buffer (no tone mapping, linear output), and three.js keys
    // programs by that, so compiling for the screen would warm the wrong ones.
    const target = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.composer.readBuffer);
    try {
      this.renderer.compile(this.scene, this.camera);
      this.renderer.render(this.scene, this.camera);
    } finally {
      this.renderer.setRenderTarget(target);
      for (const f of restore) f();
      for (const o of hidden) o.visible = false;
      warm();
    }
  }

  /** Places an agent; from: its earlier record (keeps its point and pose). */
  place(key, a, from) {
    const group = groupOf(a, this.group);
    const table = this.slots.get(group);
    if (!table) return false;
    const cell = table.assign(key);
    if (cell < 0) return false;
    const district = this.plan.districts.get(group);
    const p = slotPosition(district, cell);
    const cls = stateClass(a.state);
    const pose = this.shape.pose[cls];
    const idx = from && from.idx >= 0 ? from.idx : this.points.alloc();
    const rec = { key, agent: a, cls, group, cell, x: p.x, z: p.z, h: from?.h ?? pose.h, tip: from?.tip ?? pose.tip, seed: from?.seed ?? hashString(key), idx, slot: -1, match: this.filter(a) };
    this.keyOfIdx[idx] = key;
    this.recs.set(key, rec);
    this.writePoint(rec);
    this.account(rec, 1);
    if (this.allShapes) this.attach(rec);
    return true;
  }

  /** Adds (sign 1) or removes (-1) an agent from the per-district, per-worker and per-flow counts. */
  account(rec, sign) {
    const a = rec.agent;
    if (sign > 0) this.agg.add(rec.group, rec.cls, rec.match, a.atespace);
    else this.agg.remove(rec.group, rec.cls, rec.match, a.atespace);
    this.dirtyGroups.add(rec.group);
    this.labelsDirty = true;
    const w = a.worker;
    if (!w) return;
    this.hosted.set(w, (this.hosted.get(w) || 0) + sign);
    let set = this.byWorker.get(w);
    if (sign > 0) {
      if (!set) this.byWorker.set(w, (set = new Set()));
      set.add(rec.key);
    } else set?.delete(rec.key);
    if (sign > 0) this.holders.add(rec.key);
    else this.holders.delete(rec.key);
    if (this.deck) this.flows.add(a.atespace, this.deck.poolOf.get(w), sign);
    this.dirtyPads.add(w);
    if (this.group === 'worker') this.dirtyGroups.add(w);
  }

  /** A stable small number per worker (for the point shader's focus test). */
  workerIndex(name) {
    if (!name) return -1;
    let i = this.workerIx.get(name);
    if (i === undefined) this.workerIx.set(name, (i = this.workerIx.size));
    return i;
  }

  /** Writes everything about an agent's point. */
  writePoint(rec) {
    const pts = this.points;
    pts.setPos(rec.idx, rec.x, 0, rec.z);
    pts.setA(rec.idx, CLASS_INDEX[rec.cls], rec.seed, rec.match ? 0 : 1, this.workerIndex(rec.agent.worker));
    pts.setTeam(rec.idx, this.teamOf(rec));
    pts.setNear(rec.idx, rec.slot >= 0);
  }

  /**
   * Moves an agent whose district changed (worker view: it got or lost a
   * worker) to a cell in its new district, gliding there. False when the
   * new district is full or missing (the island must be re-planned).
   */
  regroup(rec) {
    const group = groupOf(rec.agent, this.group);
    if (group === rec.group) return true;
    const table = this.slots.get(group);
    if (!table) return false;
    const cell = table.assign(rec.key);
    if (cell < 0) return false;
    this.slots.get(rec.group)?.release(rec.key);
    rec.group = group;
    rec.cell = cell;
    const team = this.teamOf(rec);
    this.points.setTeam(rec.idx, team);
    if (rec.slot >= 0) {
      const layer = this.layers[rec.cls];
      layer.team.array[rec.slot] = team;
      layer.markSlot(rec.slot);
    }
    const p = slotPosition(this.plan.districts.get(group), cell);
    if (this.reducedMotion || (rec.slot < 0 && !this.allShapes)) {
      rec.x = p.x;
      rec.z = p.z;
      this.moves.delete(rec.key);
      this.writePos(rec);
    } else {
      this.moves.set(rec.key, { fx: rec.x, fz: rec.z, tx: p.x, tz: p.z, t0: this.time.value, dur: MOVE_SECONDS * 1.2 });
    }
    return true;
  }

  /** Draws an agent as a full shape (it joins the near set). */
  attach(rec) {
    const layer = this.layers[rec.cls];
    rec.slot = layer.add(rec.key);
    layer.seed.array[rec.slot] = rec.seed;
    layer.dim.array[rec.slot] = rec.match ? 0 : 1;
    layer.flash.array[rec.slot] = 0;
    layer.hi.array[rec.slot] = levelOf(this.focus, rec.agent.worker);
    layer.team.array[rec.slot] = this.teamOf(rec);
    this.writeActivity(rec);
    this.writeColor(rec);
    this.writeMatrix(rec);
    this.near.add(rec.key);
    this.points.setNear(rec.idx, true);
  }

  writeColor(rec) {
    if (!rec || rec.slot < 0) return;
    const c = new THREE.Color(stateColor(rec.agent.state));
    const layer = this.layers[rec.cls];
    layer.mesh.instanceColor.setXYZ(rec.slot, c.r, c.g, c.b);
    layer.markSlot(rec.slot);
  }

  /** The atespace tint of an agent's tile: its hue, plus 2 when parked (drawn fainter); -1 for none. */
  teamOf(rec) {
    const hue = this.teams.get(rec.agent.atespace);
    if (hue === undefined) return -1;
    return rec.group === PARKED ? hue + 2 : hue;
  }

  /** Stops drawing an agent as a shape (it leaves the near set; its point stays). */
  detach(rec) {
    if (rec.slot < 0) return;
    const layer = this.layers[rec.cls];
    const moved = layer.remove(rec.slot);
    if (moved) this.recs.get(moved).slot = rec.slot;
    rec.slot = -1;
    this.near.delete(rec.key);
    this.points.setNear(rec.idx, false);
  }

  /** Writes a shape's matrix (pose and position). */
  writeMatrix(rec) {
    if (rec.slot < 0) return;
    const layer = this.layers[rec.cls];
    this.shape.matrix(layer.mesh.instanceMatrix.array, rec.slot * 16, rec.x, rec.z, rec.h, rec.tip);
    layer.markSlot(rec.slot);
  }

  /** Writes an agent's position (point and shape). */
  writePos(rec) {
    this.points.setPos(rec.idx, rec.x, 0, rec.z);
    this.writeMatrix(rec);
  }

  /**
   * Idle progress (1 = just served, 0 = about to suspend; -1 = unknown) and
   * whether the agent is serving a request. The collector doesn't stream
   * either yet, so real agents show neither; synthetic mode fakes both (the
   * shader runs the fake idle timer from aIdle as a phase).
   */
  writeActivity(rec) {
    if (rec.slot < 0) return;
    const layer = this.layers[rec.cls];
    const fake = this.fake.value > 0;
    const a = rec.agent;
    let idle = -1;
    if (fake) idle = (rec.seed * 7.31) % 1;
    else if (typeof a.idleProgress === 'number') idle = a.idleProgress;
    layer.attrs.aIdle.array[rec.slot] = idle;
    layer.attrs.aServe.array[rec.slot] = this.serving(rec) ? 1 : 0;
    layer.markSlot(rec.slot);
  }

  /** Whether an agent is serving a request (synthetic mode: a fixed random subset). */
  serving(rec) {
    if (this.fake.value > 0) return (rec.seed * 13.7) % 1 < 0.22;
    return (rec.agent.inFlight || 0) > 0;
  }

  /** Big scenes play effects only where they can be seen, and only so many per second. */
  fxAllowed(x, z) {
    if (this.allShapes) return true;
    if (this.fxTokens < 1) return false;
    const p = new THREE.Vector3(x, 0.5, z);
    if (!this.frustum().containsPoint(p)) return false;
    const depth = p.applyMatrix4(this.camera.matrixWorldInverse).z * -1;
    if (cellPixels(depth, this.viewH(), this.camera.fov) < FAR_HI) return false;
    this.fxTokens -= 1;
    return true;
  }

  /** Whether a state-change label is worth pinning (in view, not a far tile). */
  labelAllowed(rec) {
    if (this.allShapes) return true;
    const p = new THREE.Vector3(rec.x, 0.5, rec.z);
    if (!this.frustum().containsPoint(p)) return false;
    const depth = p.applyMatrix4(this.camera.matrixWorldInverse).z * -1;
    return cellPixels(depth, this.viewH(), this.camera.fov) >= SHAPE_PX;
  }

  frustum() {
    if (this._frustumAt !== this.time.value) {
      this._frustumAt = this.time.value;
      this.camera.updateMatrixWorld();
      this._frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    }
    return this._frustum;
  }

  viewH() {
    return this.renderer.domElement.clientHeight || window.innerHeight;
  }

  /** Applies a batch of events that the model has already absorbed. */
  applyEvents(events) {
    let replan = false;
    let workersChanged = false;
    const now = this.time.value;
    for (const ev of events) {
      switch (ev.type) {
        case 'atespace_added':
        case 'atespace_removed':
          replan = true;
          break;
        case 'worker_added':
        case 'worker_removed':
          // Platforms (worker view) and the pad area come and go.
          replan = true;
          workersChanged = true;
          break;
        case 'worker_updated':
          this.dirtyPads.add(ev.key);
          break;
        default:
          break;
      }
      if (!ev.type.startsWith('agent_') && ev.type !== 'task_updated' && ev.type !== 'worker_assignment') continue;
      const key = ev.key;
      if (ev.type === 'agent_removed') {
        const rec = this.recs.get(key);
        if (rec) {
          if (this.fxAllowed(rec.x, rec.z)) this.effects.ripple(rec.x, rec.z, theme.effects.removed, 1.2);
          this.account(rec, -1);
          this.detach(rec);
          this.points.free(rec.idx);
          this.keyOfIdx[rec.idx] = undefined;
          this.recs.delete(key);
          this.moves.delete(key);
          this.anims.delete(key);
          this.links.remove(key);
          this.beams?.remove(key);
          this.slots.get(rec.group)?.release(key);
        }
        continue;
      }
      let rec = this.recs.get(key);
      if (!rec) {
        if (!this.place(key, ev.agent)) {
          replan = true;
          continue;
        }
        rec = this.recs.get(key);
        rec.h = 0;
        rec.tip = 0;
        this.writeMatrix(rec);
        this.animatePose(rec, 1.2);
        if (ev.agent.task && this.fxAllowed(rec.x, rec.z)) this.effects.beam(rec.x, rec.z, theme.effects.beam);
        if (this.labelAllowed(rec)) this.pinLabel(key, CHANGE_LABEL_SECONDS);
        this.lastNear.t = -1;
        this.syncLink(rec);
        if (rec.agent.worker) this.noteRecent(rec);
        this.syncBeam(rec, true);
        continue;
      }
      const prevState = rec.agent.state;
      const prevWorker = rec.agent.worker;
      this.account(rec, -1);
      rec.agent = ev.agent;
      rec.match = this.filter(ev.agent);
      if (prevState !== ev.agent.state) this.restyle(rec);
      let moved = true;
      if (prevWorker !== ev.agent.worker) {
        moved = this.regroup(rec);
        this.points.setWorker(rec.idx, this.workerIndex(ev.agent.worker));
        this.writeHi(rec);
      }
      this.account(rec, 1);
      this.points.setDim(rec.idx, rec.match ? 0 : 1);
      if (!moved) replan = true;
      if (prevWorker !== ev.agent.worker || prevState !== ev.agent.state) this.syncLink(rec);
      // Decks: a beam drops when the agent gets a worker (wake), retracts
      // when it loses it (suspend), and takes the state's color.
      // Focus mode: only a few recent changes in view get a beam (they fade after a few seconds).
      if (this.beams) {
        if (prevWorker !== ev.agent.worker) {
          if (ev.agent.worker) {
            this.noteRecent(rec);
            this.syncBeam(rec, true);
          } else {
            if (!this.beams.has(key) && prevWorker && this.noteRecent(rec)) this.beamTo(rec, prevWorker);
            this.beams.retract(key, now, BEAM_DROP);
          }
        } else if (prevState !== ev.agent.state) this.beams.setClass(key, CLASS_INDEX[rec.cls]);
      }
      switch (ev.type) {
        case 'agent_woke': {
          if (!this.fxAllowed(rec.x, rec.z)) break;
          // Aim at the agent's running pose (and, in worker view, its new
          // cell on the worker): it lifts while the arc flies.
          const pose = this.shape.pose.running;
          const dest = this.moves.get(key);
          const x = dest ? dest.tx : rec.x;
          const z = dest ? dest.tz : rec.z;
          const top = new THREE.Vector3(x, this.shape.top(pose.h, pose.tip) + 0.2, z);
          const from = this.router.wake(top, now);
          const arrive = () => {
            this.flash(rec.key);
            if (this.allShapes) this.effects.ripple(x, z, theme.states.running, 1.4);
          };
          if (this.router.arcStyle === 'comet') this.effects.comet(from, top, theme.effects.wake, arrive);
          else this.effects.arc(from, top, theme.effects.wake, arrive);
          this.pinLabel(key, CHANGE_LABEL_SECONDS);
          break;
        }
        case 'agent_suspended':
          if (!this.fxAllowed(rec.x, rec.z)) break;
          this.effects.ripple(rec.x, rec.z, theme.effects.suspend, 1.6);
          this.effects.ripple(rec.x, rec.z, theme.effects.suspend, 1.6, 0.35);
          this.pinLabel(key, CHANGE_LABEL_SECONDS);
          break;
        case 'agent_crashed':
          if (this.labelAllowed(rec)) this.pinLabel(key, CHANGE_LABEL_SECONDS * 2);
          if (this.fxAllowed(rec.x, rec.z)) this.effects.shock(rec.x, rec.z, theme.effects.crash);
          break;
        case 'task_updated':
          if (ev.new && this.fxAllowed(rec.x, rec.z)) this.effects.beam(rec.x, rec.z, theme.effects.beam);
          break;
        default:
          break;
      }
      // Every change flashes the agent (cheap: a float on its point).
      this.flash(key);
    }
    if (replan) this.replanSoon();
    if (workersChanged && !replan) this.rebuildWorkers();
    this.updateMarker();
  }

  /** Moves an agent to its new class and animates its pose. */
  restyle(rec) {
    const cls = stateClass(rec.agent.state);
    if (cls !== rec.cls) {
      this.points.setClass(rec.idx, CLASS_INDEX[cls]);
      if (rec.slot >= 0) {
        this.detach(rec);
        rec.cls = cls;
        this.attach(rec);
      } else rec.cls = cls;
    } else {
      this.writeColor(rec);
    }
    if (rec.slot >= 0) this.animatePose(rec, cls === 'suspended' ? 1.6 : 1.0);
    else {
      const pose = this.shape.pose[cls];
      rec.h = pose.h;
      rec.tip = pose.tip;
    }
  }

  /** Animates an agent from its current pose to its class's pose. */
  animatePose(rec, dur) {
    const to = this.shape.pose[rec.cls];
    this.anims.set(rec.key, { fromH: rec.h, fromTip: rec.tip, toH: to.h, toTip: to.tip, t0: this.time.value, dur });
  }

  flash(key) {
    const rec = this.recs.get(key);
    if (!rec) return;
    this.points.setFlash(rec.idx, this.time.value);
    if (rec.slot < 0) return;
    const layer = this.layers[rec.cls];
    layer.flash.array[rec.slot] = this.time.value;
    layer.markSlot(rec.slot);
  }

  /** Shows an agent's label for a while (it just changed state). */
  pinLabel(key, seconds) {
    this.labelPinned.set(key, this.time.value + seconds);
  }

  /** 'auto', 'all' or 'off'. */
  setLabelMode(mode) {
    this.labelMode = mode;
    this.lastLabelUpdate = -1;
  }

  /** Sets the filter predicate and dims everything that doesn't match. */
  setFilter(fn) {
    this.filter = fn;
    this.applyFilter();
  }

  applyFilter() {
    for (const rec of this.recs.values()) {
      const m = this.filter(rec.agent);
      if (m !== rec.match) {
        this.account(rec, -1);
        rec.match = m;
        this.account(rec, 1);
      }
      this.points.setDim(rec.idx, m ? 0 : 1);
      if (rec.slot >= 0) {
        const layer = this.layers[rec.cls];
        layer.dim.array[rec.slot] = m ? 0 : 1;
        layer.markSlot(rec.slot);
      }
    }
    this.labelsDirty = true;
  }

  // --------------------------------------------------------------- island

  buildIsland(clusterName) {
    const decks = this.layout === 'decks';
    const makeLabel = (cls) => {
      const div = document.createElement('div');
      div.className = cls;
      return new CSS2DObject(div);
    };
    this.island = buildGround(this.islandGroup, this.plan, theme, {
      cluster: clusterName,
      blending: this.blending,
      makeLabel,
      makeText: textPlane,
      look: this.look,
      glass: decks,
      noPadRow: decks,
      fade: this.fade.agents,
    });
    this.workerRowZ = this.island.rowZ;
    // Decks: the worker deck under the agent deck, and its layers.
    if (decks) {
      this.deck = planWorkerDeck([...this.model.workers.values()], this.island);
      this.deckGround = buildWorkerDeck(this.workerGround, this.deck, theme, { blending: this.blending, makeLabel, makeText: textPlane });
      this.workerDeck.position.y = this.deck.y;
      this.poolTile = new Map(this.deck.tiles.map((t) => [t.name, t]));
      this.ribbonW = Math.max(1.2, Math.sqrt(this.island.width * this.island.depth) * 0.014);
      this.ensureDeckLayers();
      // Grab rims, and the limits a move stays within for this plan.
      this.handles = {
        agents: this.buildHandle(this.islandGroup, this.island),
        workers: this.buildHandle(this.workerGround, this.deck),
      };
      this.deckLim = deckLimits(this.deck.gap, Math.max(this.island.width, this.island.depth, this.deck.width, this.deck.depth));
      this.offsets = clampOffsets(this.offsets, this.deckLim);
      if (!this.decksEasing) this.shown = copyOffsets(this.offsets);
    } else {
      this.deck = null;
      this.deckGround = null;
      this.poolTile = new Map();
      clearGroup(this.workerGround);
      this.handles = null;
      this.deckLim = null;
      this.disposeDeckLayers();
    }
    // A fresh plan is framed fresh: the deck offsets apply without moving the camera.
    this.applyDeckOffsets(false);
    this.handle = null;
    this.deckFadeAt = null;
    const { width: islandW, depth: islandD } = this.island;
    const span = Math.max(islandW, islandD * 1.5, decks ? this.deck.gap * 2.2 : 0);

    // Shadows cover the island (big islands: the part around the camera's
    // target, see frame()).
    this.setShadowSpan(Math.max(islandW, islandD) * 0.75 + 6, this.island.cx, this.island.cz);
    // From the front left, so shadows fall to the right where the camera sees them.
    this.sun.position.set(this.island.cx - 70, 80, this.island.cz + 35);

    // The backdrop, fog and camera range grow with the island.
    const k = Math.max(1, span / 500);
    this.sea.scale.set(k, k, 1);
    this.sea.material.uniforms.uFade.value = 0.018 / k;
    this.stars.scale.setScalar(Math.max(1, span / 400));
    this.scene.fog.density = theme.scene.fogDensity * this.fogScale();
    this.camera.far = Math.max(2000, span * 5);
    this.camera.updateProjectionMatrix();
    this.controls.maxDistance = Math.max(600, span * 2.2);

    this.buildRouter();
  }

  /**
   * A deck's grab rim: a flat band around its slab, shown (faintly) when
   * the pointer is on the rim or Option/Alt is held over the deck, and
   * brighter while it is dragged.
   */
  buildHandle(group, rect) {
    const b = Math.min(6, Math.max(1.2, Math.max(rect.width, rect.depth) * 0.018));
    const r = Math.min(3 + Math.max(rect.width, rect.depth) * 0.004, 7);
    const outer = roundedRect(rect.width + 2 * b, rect.depth + 2 * b, r + b);
    outer.holes.push(roundedRect(rect.width, rect.depth, r));
    const geo = new THREE.ShapeGeometry(outer, 12);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: theme.marker.hover, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, blending: this.blending });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(rect.cx, 0.06, rect.cz);
    mesh.renderOrder = 6;
    mesh.visible = false;
    group.add(mesh);
    return mesh;
  }

  /** The worker deck's origin in the scene (its plan's height plus its offset from the agent deck); target: where it is going, not where it is drawn. */
  workerOrigin(target = false) {
    if (!this.deck) return new THREE.Vector3(0, 0, 0);
    const r = relOffset(target ? this.offsets : this.shown);
    return new THREE.Vector3(r.x, this.deck.y + r.y, r.z);
  }

  /**
   * Places the decks for the shown offsets: the worker deck relative to
   * the agent deck, and (the scene's frame being the agent deck's) the
   * camera, sea and stars shifted against the agent deck's offset. With
   * moveCamera false the camera stays (a new plan or a reset frames it).
   */
  applyDeckOffsets(moveCamera = true) {
    const decks = this.layout === 'decks' && !!this.deck;
    const A = decks ? this.shown.agents : { x: 0, y: 0, z: 0 };
    const f = this.frameShift;
    const dx = A.x - f.x;
    const dy = A.y - f.y;
    const dz = A.z - f.z;
    if (moveCamera && (dx || dy || dz)) {
      this.camera.position.x -= dx;
      this.camera.position.y -= dy;
      this.camera.position.z -= dz;
      this.controls.target.x -= dx;
      this.controls.target.y -= dy;
      this.controls.target.z -= dz;
      this.camera.updateMatrixWorld();
    }
    this.frameShift = { x: A.x, y: A.y, z: A.z };
    const o = this.workerOrigin();
    this.workerDeck.position.copy(o);
    this.beams?.setWorkerOffset(o.x, o.y, o.z);
    this.ribbons?.setWorkerOffset(o.x, o.y, o.z);
    this.sea.position.set(-A.x, decks ? Math.min(0, o.y) - 2.5 : -1.6, -A.z);
    this.stars.position.set(-A.x, -A.y, -A.z);
    const su = this.sea.material.uniforms;
    su.uOrigin.value.set(-A.x, -A.z);
    if (decks) su.uCenter.value.set((this.island.cx + this.deck.cx + o.x) / 2, (this.island.cz + this.deck.cz + o.z) / 2);
    else su.uCenter.value.set(0, 0);
    // Labels follow on the next pass.
    this.lastLabelUpdate = -1;
  }

  /** Sets the decks' offsets (from storage, or a test) and draws them; linked stays as given. */
  setDeckOffsets(o) {
    this.offsets = this.deckLim ? clampOffsets(o, this.deckLim) : copyOffsets(o);
    this.shown = copyOffsets(this.offsets);
    this.decksEasing = false;
    this.applyDeckOffsets(false);
  }

  /** A copy of the decks' offsets (where the user put them). */
  copyDeckOffsets() {
    return copyOffsets(this.offsets);
  }

  /** Whether dragging a deck moves both (linked) or just that one. */
  setDecksLinked(on) {
    this.offsets.linked = this.shown.linked = !!on;
    this.handlers.onDecksChanged?.(this.offsets);
  }

  get decksLinked() {
    return this.offsets.linked;
  }

  /** Puts the decks back where the plan puts them (animated unless instant or reduced motion) and frames the camera. */
  resetDecks(instant = false) {
    const linked = this.offsets.linked;
    this.offsets = { ...defaultOffsets(), linked };
    if (instant || this.reducedMotion || this.layout !== 'decks') {
      this.shown = copyOffsets(this.offsets);
      this.decksEasing = false;
      this.applyDeckOffsets(false);
    } else this.decksEasing = true;
    if (this.island) this.fitCamera(!instant);
    this.handlers.onDecksChanged?.(this.offsets);
  }

  /**
   * The deck under a client position: its rim, or (any) anywhere on it
   * ({id, zone, x, z, y, t}: x, z in the deck's coordinates), or null.
   * Faded-out decks can't be grabbed.
   */
  deckHandleAt(clientX, clientY, any = false) {
    if (this.layout !== 'decks' || !this.deck || !this.island || this.cameraDriver) return null;
    const ray = this.rayAt(clientX, clientY);
    const o = this.workerOrigin();
    const I = this.island;
    const D = this.deck;
    const decks = [];
    if (this.deckA.agents > 0.5) decks.push({ id: 'agents', rect: I, y: 0, off: { x: 0, z: 0 } });
    if (this.deckA.workers > 0.5) decks.push({ id: 'workers', rect: D, y: o.y, off: { x: o.x, z: o.z } });
    const vh = this.viewH();
    const fov = this.camera.fov;
    const hit = deckAt(ray.origin, ray.direction, decks, (t) => Math.max(0.6, unitsPerPixel(t, fov, vh) * RIM_PX));
    if (!hit) return null;
    if (hit.zone !== 'rim' && !any) return null;
    return hit;
  }

  /** Shows the grab rim of the deck under the pointer (null: none). */
  setHandle(h) {
    const changed = (h?.id || null) !== (this.handle?.id || null) || (h?.zone || null) !== (this.handle?.zone || null);
    this.handle = h;
    if (!changed) return;
    this.styleHandles();
    this.handlers.onDeckHandle?.(h);
  }

  /** Grab rims: faint on hover, brighter while dragging (both decks when linked). */
  styleHandles() {
    if (!this.handles) return;
    const drag = this.deckDrag;
    for (const [k, m] of Object.entries(this.handles)) {
      const on = drag ? k === drag.id || drag.linked : this.handle?.id === k;
      m.visible = on;
      m.material.color.set(theme.marker.hover);
      if (m.material.blending !== this.blending) {
        m.material.blending = this.blending;
        m.material.needsUpdate = true;
      }
      m.material.opacity = drag ? (k === drag.id ? 0.7 : 0.4) : 0.5;
    }
  }

  /**
   * Starts (or, hit null, re-anchors) dragging a deck at a client position:
   * vertical changes its height (the gap), else it slides in its plane with
   * the point grabbed staying under the pointer. Positions are kept in
   * absolute terms (the scene's frame plus the agent deck's offset), which
   * don't change as the frame shifts during the drag.
   */
  startDeckDrag(hit, clientX, clientY, vertical = false) {
    if (!this.deck) return;
    const id = hit ? hit.id : this.deckDrag?.id;
    if (!id) return;
    const A = this.shown.agents;
    const o = this.workerOrigin();
    const planeY = id === 'agents' ? 0 : o.y;
    const ray = this.rayAt(clientX, clientY);
    const p = rayAtY(ray.origin, ray.direction, planeY) || { x: ray.origin.x, z: ray.origin.z, t: this.camera.position.distanceTo(this.controls.target) };
    this.decksEasing = false;
    this.shown = copyOffsets(this.offsets);
    this.deckDrag = {
      id,
      vertical,
      linked: this.offsets.linked,
      start: copyOffsets(this.offsets),
      planeAbs: planeY + A.y,
      anchor: { x: p.x + A.x, z: p.z + A.z },
      y0: clientY,
      upp: unitsPerPixel(Math.max(1, p.t), this.camera.fov, this.viewH()),
    };
    this.flyAnim = null;
    this.styleHandles();
  }

  /** Moves the dragged deck to follow the pointer. */
  dragDeck(clientX, clientY) {
    const g = this.deckDrag;
    if (!g || !this.deckLim) return;
    let next;
    if (g.vertical) {
      next = moveDeck(g.start, g.id, { y: -(clientY - g.y0) * g.upp }, this.deckLim);
    } else {
      const A = this.shown.agents;
      const ray = this.rayAt(clientX, clientY);
      const origin = { x: ray.origin.x + A.x, y: ray.origin.y + A.y, z: ray.origin.z + A.z };
      const p = rayAtY(origin, ray.direction, g.planeAbs);
      if (!p) return;
      next = moveDeck(g.start, g.id, { x: p.x - g.anchor.x, z: p.z - g.anchor.z }, this.deckLim);
    }
    this.offsets = next;
    this.shown = copyOffsets(next);
    this.applyDeckOffsets(true);
  }

  /** Ends a deck drag; the new arrangement is remembered. */
  endDeckDrag() {
    if (!this.deckDrag) return;
    this.deckDrag = null;
    this.styleHandles();
    this.setHandle(null);
    this.handlers.onDecksChanged?.(this.offsets);
  }

  /** Eases the drawn offsets toward the target (after a reset). */
  updateDeckEase(dt) {
    if (!this.decksEasing) return;
    const k = 1 - Math.exp(-dt * 7);
    const { offsets, moving } = easeOffsets(this.shown, this.offsets, k);
    this.shown = offsets;
    this.decksEasing = moving;
    this.applyDeckOffsets(false);
  }

  /**
   * Depth (camera space) of what is under a client position: a deck's
   * plane where the pointer is over one, else the orbit target's height,
   * else the target's distance. Pans move the scene by screen pixels at
   * that depth, so the point grabbed stays under the pointer.
   */
  grabDepth(clientX, clientY) {
    const ray = this.rayAt(clientX, clientY);
    const fwd = this.camera.getWorldDirection(new THREE.Vector3());
    const cos = Math.max(0.05, fwd.dot(ray.direction));
    const hit = this.deckHandleAt(clientX, clientY, true);
    let t = hit ? hit.t : null;
    if (t === null) t = rayAtY(ray.origin, ray.direction, this.controls.target.y)?.t ?? null;
    const maxT = this.camera.far * 0.5;
    if (t === null || t > maxT) return this.camera.position.distanceTo(this.controls.target);
    return t * cos;
  }

  /** Zooms by factor (<1 in, >1 out) along the view toward the orbit target, within the controls' distance limits. */
  zoomBy(factor) {
    if (this.cameraDriver) return;
    const c = this.controls;
    const off = this.camera.position.clone().sub(c.target);
    const d = Math.min(c.maxDistance, Math.max(c.minDistance, off.length() * factor));
    this.camera.position.copy(c.target).add(off.setLength(d));
    this.camera.updateMatrixWorld();
    this.flyAnim = null;
  }

  /** Pans the camera in the screen plane by pixels (right and down positive), at depth (the point there tracks the pointer). */
  panScreen(dxPx, dyPx, depth) {
    if (this.cameraDriver) return;
    const upp = unitsPerPixel(Math.max(0.5, depth), this.camera.fov, this.viewH());
    this.camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const move = right.multiplyScalar(-dxPx * upp).add(up.multiplyScalar(dyPx * upp));
    this.camera.position.add(move);
    this.controls.target.add(move);
    this.camera.updateMatrixWorld();
    this.flyAnim = null;
  }

  /** A click (no drag) at a client position: selects the agent or worker there, or clears. */
  clickAt(clientX, clientY) {
    const key = this.pick(clientX, clientY);
    const worker = key ? null : this.pickWorker(clientX, clientY);
    this.handlers.onPick?.(key, worker);
  }

  setShadowSpan(span, x, z) {
    const cam = this.sun.shadow.camera;
    cam.left = -span;
    cam.right = span;
    cam.top = span;
    cam.bottom = -span;
    cam.near = 1;
    cam.far = 400 + span;
    cam.updateProjectionMatrix();
    this.sun.target.position.set(x, 0, z);
    this.shadowSpan = span;
  }

  /** Every element with a district-style label: districts, pool frames, platform labels in use. */
  districtLabelEls() {
    const out = [];
    if (!this.plan) return out;
    for (const d of this.plan.districts.values()) if (d.label) out.push({ el: d.label, x0: d.x, x1: d.x + d.w, z: d.z + d.d / 2, ax: labelAnchor(d).x, az: labelAnchor(d).z, bottom: true, area: d.w * d.d });
    for (const f of [...(this.plan.frames || []), ...(this.plan.padFrames || [])]) if (f.label) out.push({ el: f.label, x0: f.x, x1: f.x + f.w, z: f.z + f.d / 2, ax: f.x + 0.5, az: f.z + (f.strip ?? 2) / 2, area: f.w * f.d * 4 });
    for (const l of this.platformLabels) {
      const d = l.visible && l.userData.d;
      if (d) out.push({ el: l.element, x0: d.x, x1: d.x + d.w, z: d.z, ax: labelAnchor(d).x, az: labelAnchor(d).z, bottom: true, area: 1 });
    }
    return out;
  }

  /**
   * Keeps district labels readable: a label wider than its district on
   * screen drops its state chips (and, when tiny, its count), and a label
   * that would overlap a bigger district's label is hidden.
   */
  layoutDistrictLabels() {
    if (!this.plan) return;
    // The selected agent's label wins over district labels.
    const placed = [];
    const sel = this.agentBoxes?.find((q) => q.selected);
    if (sel) placed.push(sel);
    this.districtBoxes = this.placeLabels(this.districtLabelEls(), placed);
    // Decks: the worker deck's labels have a budget of their own (they
    // never compete with the agent deck's), so both decks stay labeled.
    this.deckBoxes = [];
    if (this.deck && this.deckA.workers > 0.5) {
      const o = this.workerOrigin();
      const y = o.y;
      const ds = this.deck.frames
        .filter((f) => f.label)
        .map((f) => ({ el: f.label, x0: f.x + o.x, x1: f.x + f.w + o.x, z: f.z + f.d / 2 + o.z, ax: f.x + 0.5 + o.x, az: f.z + (f.strip ?? 2) / 2 + o.z, area: f.w * f.d, y }));
      // A worker's card (hovered or pinned) wins over the pool labels around it.
      const obstacles = [...(this.deckTitleBoxes || [])];
      const pad = this.focus.strong && this.pads.get(this.focus.worker);
      if (pad) {
        const q = new THREE.Vector3(pad.x + o.x, y + 0.2, pad.z + 1.15 + o.z).project(this.camera);
        const sx = (q.x * 0.5 + 0.5) * this.renderer.domElement.clientWidth;
        const sy = (-q.y * 0.5 + 0.5) * this.renderer.domElement.clientHeight;
        obstacles.push({ x0: sx - 130, x1: sx + 130, y0: sy - 6, y1: sy + 135 });
      }
      this.deckBoxes = this.placeLabels(ds, obstacles);
    }
  }

  /**
   * Places district-style labels greedily, biggest area first, around
   * obstacles (placed, which grows): each fits its district's width (full,
   * compact, tiny) or is hidden ("crowded") when it would overlap. Returns
   * the boxes placed.
   */
  placeLabels(list, placed) {
    const W = this.renderer.domElement.clientWidth;
    const H = this.renderer.domElement.clientHeight;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const ds = list.sort((x, y) => y.area - x.area);
    const boxes = [];
    // Sizes are estimated from the text and positions projected from the
    // anchors, so the pass never reads layout (no forced reflows).
    for (const d of ds) {
      const y = d.y || 0;
      a.set(d.x0, y, d.z).project(this.camera);
      b.set(d.x1, y, d.z).project(this.camera);
      const px = (Math.abs(b.x - a.x) / 2) * W;
      // Fit the label inside its district's width: full, then without
      // chips, then name only.
      const est = labelSize(d.el);
      const mode = est.full <= px ? '' : est.compact <= px ? 'compact' : 'tiny';
      const cl = d.el.classList;
      cl.toggle('compact', mode !== '');
      cl.toggle('tiny', mode === 'tiny');
      const w = mode === '' ? est.full : mode === 'compact' ? est.compact : est.tiny;
      const h = mode === 'tiny' ? est.th : est.h;
      a.set(d.ax, y + 0.2, d.az).project(this.camera);
      const sx = (a.x * 0.5 + 0.5) * W;
      const sy = (-a.y * 0.5 + 0.5) * H;
      // District labels hang above their anchor (bottom: true); the rest center on it.
      const cy = d.bottom ? 1 : 0.5;
      const box = { x0: sx - 4, x1: sx + w + 4, y0: sy - h * cy - 2, y1: sy + h * (1 - cy) + 2 };
      const off = a.z > 1 || box.x1 < 0 || box.x0 > W || box.y1 < 0 || box.y0 > H;
      const hit = placed.some((q) => box.x0 < q.x1 && box.x1 > q.x0 && box.y0 < q.y1 && box.y1 > q.y0);
      cl.toggle('crowded', hit);
      if (!hit && !off) {
        placed.push(box);
        boxes.push(box);
      }
    }
    return boxes;
  }

  /**
   * Decks: the deck names ("Agents", "Workers") with their counts, to the
   * right of each deck; their boxes start the worker deck's label pass.
   */
  layoutDeckLabels() {
    const L = this.deckLabels;
    if (this.layout !== 'decks' || !this.deck || !this.model) {
      L.agents.visible = L.workers.visible = false;
      this.deckTitleBoxes = [];
      return;
    }
    const I = this.island;
    const D = this.deck;
    L.agents.position.set(I.cx + I.width / 2 + 1.5, 0, I.cz);
    const o = this.workerOrigin();
    L.workers.position.set(D.cx + D.width / 2 + 1.5 + o.x, o.y, D.cz + o.z);
    L.agents.center.set(0, 0.5);
    L.workers.center.set(0, 0.5);
    L.agents.visible = this.deckA.agents > 0.5;
    L.workers.visible = this.deckA.workers > 0.5;
    const pools = this.deck.tiles.length;
    setHTML(L.agents.element, `<div class="name">Agents</div><div class="meta">${compact(this.model.agents.size)} · ${this.plan.districts.size} atespace${this.plan.districts.size === 1 ? '' : 's'}</div>`);
    setHTML(L.workers.element, `<div class="name">Workers</div><div class="meta">${compact(this.model.workers.size)} · ${pools} pool${pools === 1 ? '' : 's'} · ${compact(this.holders.size)} agents on them</div>`);
    const W = this.renderer.domElement.clientWidth;
    const H = this.renderer.domElement.clientHeight;
    const p = L.workers.position.clone().project(this.camera);
    const x = (p.x * 0.5 + 0.5) * W;
    const y = (-p.y * 0.5 + 0.5) * H;
    this.deckTitleBoxes = [{ x0: x - 4, x1: x + 190, y0: y - 22, y1: y + 22 }];
  }

  /** A worker platform's label HTML: name, node, fill, and the atespaces it runs. */
  platformHTML(d) {
    const c = this.agg.get(d.name);
    const wk = this.model.workers.get(d.name);
    const cap = wk?.capacityActors;
    const agents = `${c.total} agent${c.total === 1 ? '' : 's'}`;
    const teams = [...c.teams.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3);
    const chips = teams.map(([name, n]) => `<span class="chip team" style="--c:${teamCSS(this.teams.get(name) ?? 0, theme)}">${esc(name)} ${n}</span>`);
    const state = wk?.state && wk.state !== 'ACTIVE' ? `<span class="badge">${esc(wk.state.toLowerCase())}</span>` : '';
    return `<div class="name">${esc(wk ? workerLabel(wk) : d.name)}${state}</div><div class="meta">${wk?.node ? `<span class="node">${esc(wk.node)}</span> · ` : ''}${cap ? `${c.total}/${cap} agents` : agents} ${chips.join('')}</div>`;
  }

  updateDistrictLabels() {
    if (!this.plan || !this.model) return;
    this.labelsDirty = false;
    const chip = (cls, n, text) => (n ? `<span class="chip ${cls}">${n} ${text}</span>` : '');
    for (const d of this.plan.districts.values()) {
      if (!d.label) continue;
      const c = this.agg.get(d.name);
      const agents = `${c.total} agent${c.total === 1 ? '' : 's'}`;
      let html;
      if (d.kind === 'worker') html = this.platformHTML(d);
      else if (d.kind === 'parked') {
        html = `<div class="name">Not on a worker</div><div class="meta">${agents} ${chip('suspended', c.suspended, 'suspended')}${chip('pending', c.pending, 'pending')}${chip('crashed', c.crashed, 'crashed')}${chip('transition', c.transition, 'changing')}</div>`;
      } else {
        html = `<div class="name">${esc(d.name)}</div><div class="meta">${agents} ${chip('running', c.running, 'running')}${chip('transition', c.transition, 'changing')}${chip('crashed', c.crashed, 'crashed')}</div>`;
      }
      setHTML(d.label, html);
      d.label.classList.toggle('dim', c.match === 0 && c.total > 0);
      d.label.classList.toggle('focused', d.kind === 'worker' && this.focus.worker === d.name);
    }
    // Node pools: name, workers, agents and what they run.
    for (const f of this.deck?.frames || []) {
      if (!f.label) continue;
      let hosted = 0;
      for (const w of f.workers) hosted += this.hosted.get(w) || 0;
      setHTML(f.label, `<div class="name">${esc(f.name || 'pool')}</div><div class="meta">${f.workers.length} workers · ${compact(hosted)} agents</div>`);
    }
    for (const f of [...(this.plan.frames || []), ...(this.plan.padFrames || [])]) {
      if (!f.label) continue;
      const c = this.agg.sum(f.workers);
      const pads = this.group !== 'worker';
      const html = `<div class="name">${esc(f.name || 'pool')}</div><div class="meta">${f.workers.length} workers${pads ? '' : ` · ${c.total} agents ${chip('running', c.running, 'running')}${chip('crashed', c.crashed, 'crashed')}`}</div>`;
      setHTML(f.label, html);
    }
    for (const l of this.platformLabels) if (l.visible && l.userData.d) this.fillPlatformLabel(l, l.userData.d);
  }

  fillPlatformLabel(l, d) {
    setHTML(l.element, this.platformHTML(d));
    l.element.classList.toggle('focused', this.focus.worker === d.name);
  }

  /** Big worker views: lends the pooled labels to the platforms nearest the camera that are in view and readable. */
  layoutPlatformLabels() {
    const big = this.group === 'worker' && this.plan && [...this.plan.districts.values()].some((d) => d.kind === 'worker' && !d.label);
    if (!big) {
      for (const l of this.platformLabels) l.visible = false;
      return;
    }
    const cam = this.camera.position;
    const fr = this.frustum();
    const p = new THREE.Vector3();
    const cand = [];
    const maxD = depthForPixels(FAR_HI * 2.5, this.viewH(), this.camera.fov);
    for (const d of this.plan.districts.values()) {
      if (d.kind !== 'worker') continue;
      p.set(d.x + d.w / 2, 0, d.z + d.d / 2);
      const dist = cam.distanceTo(p);
      if (dist > maxD || !fr.containsPoint(p)) continue;
      cand.push({ d, dist });
    }
    cand.sort((a, b) => a.dist - b.dist);
    this.platformLabels.forEach((l, i) => {
      const c = cand[i];
      if (!c) {
        l.visible = false;
        l.userData.d = null;
        return;
      }
      l.visible = true;
      l.userData.d = c.d;
      const at = labelAnchor(c.d);
      l.position.set(at.x, 0.2, at.z);
      this.fillPlatformLabel(l, c.d);
    });
  }

  // ------------------------------------------------------------ far tiles

  /** Lays out the far tiles for the plan and writes their counts. */
  syncTiles() {
    this.tiles.sync(this.plan.tiles || [], (t) => (t.groups.length === 1 ? this.agg.get(t.groups[0]) : this.agg.sum(t.groups)));
    this.dirtyGroups.clear();
    if (this.litSet) this.relightTiles();
  }

  /** Rewrites the tiles whose districts changed. */
  flushTiles() {
    if (!this.dirtyGroups.size) return;
    const done = new Set();
    for (const g of this.dirtyGroups) {
      const i = this.tiles.tileOf(g);
      if (i === undefined || done.has(i)) continue;
      done.add(i);
      const t = this.tiles.tiles[i];
      this.tiles.write(i, t.groups.length === 1 ? this.agg.get(t.groups[0]) : this.agg.sum(t.groups), t.kind === 'atespace' ? this.tileLit('atespace', t.name) : 0);
    }
    this.dirtyGroups.clear();
  }

  // -------------------------------------------------------------- workers

  /** Places and styles every worker pad, then rebuilds the links. */
  rebuildWorkers() {
    if (!this.model || !this.plan) return;
    const items = [];
    if (this.group === 'worker') {
      // Each pad sits in its platform's label strip, at the right.
      for (const wk of this.model.workers.values()) {
        const d = this.plan.districts.get(wk.name);
        if (!d) continue;
        items.push({ worker: wk, x: d.x + d.w - 3.2 / 2 - 0.45, z: d.z + WORKER_STRIP / 2, usage: workerUsage(wk, this.hosted.get(wk.name) || 0) });
      }
    } else {
      // The pad area along the island's front edge (planned with the
      // island), or the worker deck (decks layout).
      for (const it of (this.deck ? this.deck.items : this.plan.padArea?.items) || []) {
        const wk = this.model.workers.get(it.name);
        if (wk) items.push({ worker: wk, x: it.x, z: it.z, usage: workerUsage(wk, this.hosted.get(wk.name) || 0) });
      }
    }
    this.pads.sync(items, theme, this.blending, { cardAbove: this.group === 'worker' });
    this.pads.setFocus(this.focus);
    this.dirtyPads.clear();
    this.relinkAll();
    if (this.beams) {
      // Pads moved: every beam's lower end with them.
      this.beams.clear();
      this.rebeamAll();
      this.syncWorkerTiles();
    }
  }

  /** Rewrites the pads whose worker or hosted count changed (and, decks, their pools' far tiles). */
  flushPads() {
    if (!this.dirtyPads.size || !this.model) return;
    const pools = new Set();
    for (const name of this.dirtyPads) {
      const wk = this.model.workers.get(name);
      if (wk) this.pads.update(name, wk, workerUsage(wk, this.hosted.get(name) || 0));
      if (this.deck) pools.add(this.deck.poolOf.get(name));
    }
    this.dirtyPads.clear();
    if (this.workerTiles) {
      for (const pool of pools) {
        const i = this.workerTiles.tileOf(pool);
        if (i !== undefined) this.workerTiles.write(i, this.poolCounts(this.workerTiles.tiles[i]), this.tileLit('pool', pool));
      }
    }
  }

  // ---------------------------------------------------------------- decks

  /** Creates the decks layout's layers: beams, ribbons and the node pools' far tiles. */
  ensureDeckLayers() {
    if (this.beams) return;
    this.beams = new BeamSet(this.world, this.time, this.look, this.fade.beams);
    this.beams.uniforms.uDrop.value = BEAM_DROP;
    this.beams.setBundle(this.beamMode === 'focus' ? BUNDLE : 0);
    // 'all' fills up to the budget: room up front, so the buffers don't grow mid-flight.
    if (this.beamMode === 'all') this.beams.reserve(BEAM_BUDGET);
    this.ribbons = new RibbonSet(this.world, this.time, this.look, this.fade.beams);
    this.ribbons.setMin(this.beamMode === 'focus' ? FOCUS_RIBBONS : 0);
    this.workerTiles = new AggregateTiles(this.workerDeck, this.time, this.look, { y: PAD_H + 0.12, cell: PAD_SPACING, fade: this.fade.workers });
    this.beamKeys = new Set();
    this.applyFlow();
    this.styleDecks();
    this.sizeBeams?.();
    this.needCompile = true;
  }

  /** Disposes the decks layout's layers (switching to 'combined'). */
  disposeDeckLayers() {
    if (!this.beams) return;
    this.beams.dispose();
    this.ribbons.dispose();
    this.workerTiles.dispose();
    this.beams = this.ribbons = this.workerTiles = null;
    this.beamKeys = new Set();
    this.beamsTrimmed = false;
    this.hoverTile = null;
    this.litSet = null;
  }

  /** Beam, ribbon and pool tile colors from the theme; the beams' rest alpha thins out as their number grows. */
  styleDecks() {
    if (!this.beams) return;
    const colors = Object.fromEntries(CLASSES.map((c) => [c, classColor(theme, c)]));
    const additive = theme.glow.additive;
    const n = Math.max(this.beams.count, 1);
    const a = additive ? 0.55 : 0.7;
    this.beams.setLook(colors, theme.links.highlight, this.blending, Math.min(a, Math.max(additive ? 0.05 : 0.08, a * Math.sqrt(60 / n))), 0.95);
    // Many ribbons add up (additive on dark themes): fainter as they grow in number.
    const nr = Math.max(1, this.flows.pairs.size);
    this.ribbons.setLook(colors.running, theme.worker.active, theme.links.highlight, this.blending, (additive ? 0.5 : 0.7) * Math.min(1, Math.max(additive ? 0.14 : 0.24, Math.sqrt(60 / nr))));
    const w = theme.worker;
    this.workerTiles.setColors({ running: w.fill, transition: w.full, suspended: w.idle, crashed: w.draining, pending: w.idle }, THREE.NormalBlending);
    this.beamCountStyled = n;
  }

  /**
   * A node pool's far tile counts, in AggregateTiles' terms: busy workers
   * (hosting agents) as "running", full ones (90%+ of their slots) as
   * "changing", draining ones as "crashed" (they pulse), idle ones as the
   * rest.
   */
  poolCounts(tile) {
    const c = { total: tile.groups.length, running: 0, transition: 0, suspended: 0, crashed: 0, pending: 0, match: tile.groups.length };
    for (const name of tile.groups) {
      const wk = this.model.workers.get(name);
      const n = this.hosted.get(name) || 0;
      if (wk?.state === 'DRAINING') c.crashed++;
      else if (!n) c.suspended++;
      else if (wk?.capacityActors && n / wk.capacityActors >= 0.9) c.transition++;
      else c.running++;
    }
    return c;
  }

  /** Lays out the node pools' far tiles and writes their counts. */
  syncWorkerTiles() {
    if (!this.workerTiles || !this.deck) return;
    this.workerTiles.sync(this.deck.tiles, (t) => this.poolCounts(t));
    this.relightTiles();
  }

  /** 1 when a far tile is lit by the hovered tile (it or the other end of its ribbons), else 0. */
  tileLit(kind, name) {
    const s = this.litSet;
    if (!s) return 0;
    return (kind === 'pool' ? s.pools : s.atespaces).has(name) ? 1 : 0;
  }

  /** Rewrites every far tile's lit flag (the hovered tile changed). */
  relightTiles() {
    if (this.group !== 'atespace') return;
    this.tiles.tiles.forEach((t, i) => this.tiles.write(i, this.agg.get(t.groups[0]), this.tileLit('atespace', t.name)));
    this.workerTiles?.tiles.forEach((t, i) => this.workerTiles.write(i, this.poolCounts(t), this.tileLit('pool', t.name)));
  }

  /**
   * Whether an agent gets a beam: it holds a worker with a pad, and (focus
   * mode) it must show or just changed, or ('all') it fits the budget or
   * must show.
   */
  beamAllowed(rec) {
    const w = rec.agent.worker;
    if (!this.beams || !w || !this.pads.get(w)) return false;
    if (this.beamMode === 'focus') return this.beamMust(rec) || (this.recentBeams.get(rec.key) || 0) > this.time.value;
    if (!this.beamsTrimmed) return true;
    return this.beamKeys.has(rec.key) || this.beamMust(rec);
  }

  /** Whether beams are picked per agent (focus mode, or 'all' over the budget), so focus changes add and drop them. */
  get beamsSelective() {
    return this.beamMode === 'focus' || this.beamsTrimmed;
  }

  /** 'focus' or 'all' (see decks.js BEAM_MODES); re-picks the beams. */
  setBeamMode(mode) {
    const m = beamModeId(mode);
    if (m === this.beamMode) return;
    this.beamMode = m;
    this.recentBeams.clear();
    if (!this.beams) return;
    this.beams.setBundle(m === 'focus' ? BUNDLE : 0);
    if (m === 'all') this.beams.reserve(BEAM_BUDGET);
    this.beams.clear();
    this.rebeamAll();
    this.relevelRibbons();
  }

  /** Adds, moves or drops an agent's beam; drop: animate it falling to the pad (a wake). */
  syncBeam(rec, drop = false) {
    if (!rec || !this.beams) return;
    if (!this.beamAllowed(rec)) {
      if (!this.beams.retracting.has(rec.key)) this.beams.remove(rec.key);
      return;
    }
    this.beamTo(rec, rec.agent.worker, drop);
    // Focus mode: a recent change's beam fades out when its time is up (unless it must show).
    if (this.beamMode === 'focus' && !this.beamMust(rec)) {
      const until = this.recentBeams.get(rec.key);
      if (until) this.beams.fadeOut(rec.key, until);
    }
  }

  /** Writes an agent's beam to a worker's pad (the pad end in the worker deck's coordinates), bundled with its atespace -> pool pair. */
  beamTo(rec, worker, drop = false) {
    const pad = this.pads.get(worker);
    if (!pad) return false;
    const d = this.plan.districts.get(rec.group);
    const t = this.poolTile.get(this.deck.poolOf.get(worker));
    const bundle = d && t ? { dx: d.x + d.w / 2, dz: d.z + d.d / 2, qx: t.x + t.w / 2, qz: t.z + t.d / 2 } : undefined;
    this.beams.set(rec.key, { x: rec.x, y: 0.1, z: rec.z }, pad.pos, CLASS_INDEX[rec.cls], this.workerIndex(worker), rec.seed, rec.idx, drop ? this.time.value : undefined, bundle);
    return true;
  }

  /** Whether an agent's beam must show: it is selected or hovered, or its worker is in focus. */
  beamMust(rec) {
    return rec.key === this.selected || rec.key === this.hovered || (!!rec.agent.worker && rec.agent.worker === this.focus.worker);
  }

  /**
   * Focus mode: whether a wake or suspend gets a beam for a few seconds
   * (in view, and at most BEAM_RECENT_RATE a second); records it.
   */
  noteRecent(rec) {
    if (this.beamMode !== 'focus' || this.beamTokens < 1) return false;
    if (!this.allShapes) {
      const p = new THREE.Vector3(rec.x, 0.5, rec.z);
      if (!this.frustum().containsPoint(p)) return false;
    }
    this.beamTokens -= 1;
    this.recentBeams.set(rec.key, this.time.value + BEAM_RECENT);
    return true;
  }

  /**
   * Picks the agents with beams (all holders while they fit BEAM_BUDGET,
   * else the nearest in view plus the focus) and syncs the beams to it.
   * Trimmed beams leave the ribbons visible as a floor, so the rest of the
   * flow still reads.
   */
  rebeamAll() {
    if (!this.beams) return;
    const must = [this.selected, this.hovered, ...(this.byWorker.get(this.focus.worker) || [])].filter(Boolean);
    let keys;
    if (this.beamMode === 'focus') {
      keys = focusBeams(this.holders, must, this.recentBeams, this.time.value);
      this.beamsTrimmed = false;
    } else {
      const sel = beamSet(this.holders, BEAM_BUDGET, () => this.nearestHolders(), must);
      this.beamsTrimmed = sel.trimmed;
      keys = sel.keys;
    }
    this.beamKeys = keys;
    for (const k of [...this.beams.keys]) if (!keys.has(k) && !this.beams.leaving(k)) this.beams.remove(k);
    for (const k of keys) if (!this.beams.has(k) || this.beams.fading.has(k)) this.syncBeam(this.recs.get(k));
    this.ribbons.setMin(this.beamMode === 'focus' ? FOCUS_RIBBONS : this.beamsTrimmed ? 0.12 : 0);
    this.styleDecks();
    this.applyBeamFocus();
  }

  /** The agents holding a worker nearest the camera, in view (at most the beam budget). */
  nearestHolders() {
    const sub = new Int32Array(this.holders.size);
    let k = 0;
    for (const key of this.holders) {
      const r = this.recs.get(key);
      if (r) sub[k++] = r.idx;
    }
    const planes = this.frustum().planes.map((p) => ({ x: p.normal.x, y: p.normal.y, z: p.normal.z, c: p.constant }));
    const pts = this.points;
    const { idx } = selectNearest(pts.attrs.position.array, pts.live, pts.hwm, this.camera.position, BEAM_BUDGET, 1e9, planes, 8, sub.subarray(0, k));
    return Array.from(idx, (i) => this.keyOfIdx[i]).filter(Boolean);
  }

  /** The beams' focus uniforms: the worker in focus, and the selected and hovered agents. */
  applyBeamFocus() {
    if (!this.beams) return;
    const f = this.focus;
    const idx = (key) => this.recs.get(key)?.idx ?? -10;
    this.beams.setFocus(f.worker ? this.workerIndex(f.worker) : -1, f.strong, this.selected ? idx(this.selected) : -10, this.hovered ? idx(this.hovered) : -10);
  }

  /**
   * Writes the ribbons whose pair changed (all: every pair). Widths are
   * relative to the biggest pair, so when that moves by more than 5% every
   * ribbon is rewritten.
   */
  flushRibbons(all = false) {
    if (!this.ribbons || !this.deck || !this.plan) return;
    let keys = this.flows.take();
    const max = this.flows.max();
    if (all || !this.ribbonMax || Math.abs(max - this.ribbonMax) > this.ribbonMax * 0.05) {
      this.ribbonMax = max;
      keys = [...this.flows.pairs.keys()];
    }
    if (!keys.length) return;
    const f = this.focus;
    const focusPool = f.worker ? this.deck.poolOf.get(f.worker) : null;
    for (const key of keys) {
      const p = this.flows.pairs.get(key);
      const d = p && this.plan.districts.get(p.atespace);
      const t = p && this.poolTile.get(p.pool);
      if (!d || !t) {
        this.ribbons.remove(key);
        continue;
      }
      const { width, strength } = ribbonSize(p.count, this.ribbonMax, this.ribbonW);
      this.ribbons.set(
        key,
        { x: d.x + d.w / 2, y: -2, z: d.z + d.d / 2 },
        { x: t.x + t.w / 2, y: PAD_H + 0.2, z: t.z + t.d / 2 },
        width,
        strength,
        ribbonLevel(p, this.hoverTile, focusPool, f.strong, this.beamMode === 'focus'),
        hashString(key),
      );
    }
  }

  /** Re-levels every ribbon (the hovered tile or the worker in focus changed). */
  relevelRibbons() {
    if (!this.ribbons || !this.deck) return;
    const f = this.focus;
    const focusPool = f.worker ? this.deck.poolOf.get(f.worker) : null;
    for (const key of this.ribbons.keys) {
      const p = this.flows.pairs.get(key);
      if (p) this.ribbons.setLevel(key, ribbonLevel(p, this.hoverTile, focusPool, f.strong, this.beamMode === 'focus'));
    }
  }

  /** The far tile under the pointer (decks): an atespace on the agent deck, or a node pool below. */
  setHoverTile(tile) {
    if (sameTile(tile, this.hoverTile)) return;
    this.hoverTile = tile;
    this.litSet = tile ? litTiles(this.flows, tile) : null;
    this.relevelRibbons();
    this.relightTiles();
    this.handlers.onHoverTile?.(tile, tile ? this.tileInfo(tile) : null);
  }

  /** What a far tile carries: running agents and the tiles at the other end. */
  tileInfo(tile) {
    let agents = 0;
    let ends = 0;
    for (const p of this.flows.pairs.values()) {
      if (p.count <= 0) continue;
      if ((tile.kind === 'atespace' && p.atespace === tile.name) || (tile.kind === 'pool' && p.pool === tile.name)) {
        agents += p.count;
        ends++;
      }
    }
    const workers = tile.kind === 'pool' ? this.poolTile.get(tile.name)?.groups.length || 0 : 0;
    return { ...tile, agents, ends, workers, total: tile.kind === 'atespace' ? this.agg.get(tile.name).total : 0 };
  }

  /** Whether the ground at (x, y, z) is drawn far (cells of size cell under the far threshold). */
  farAt(x, y, z, cell) {
    const p = new THREE.Vector3(x, y, z).applyMatrix4(this.camera.matrixWorldInverse);
    return farMix(cellPixels(-p.z, this.viewH(), this.camera.fov, cell)) > 0.5;
  }

  /** The far tile under a client position (decks), or null. */
  pickTile(clientX, clientY) {
    if (!this.deck) return null;
    const ray = this.rayAt(clientX, clientY);
    if (ray.direction.y > -1e-4) return null;
    const at = (y) => {
      const t = (y - ray.origin.y) / ray.direction.y;
      return t > 0 ? { x: ray.origin.x + ray.direction.x * t, z: ray.origin.z + ray.direction.z * t } : null;
    };
    if (this.deckA.agents > 0.5) {
      const p = at(0.15);
      const d = p && this.distIndex.at(p.x, p.z);
      if (d && this.farAt(p.x, 0, p.z, CELL)) return { kind: 'atespace', name: d.name };
    }
    if (this.deckA.workers > 0.5) {
      const o = this.workerOrigin();
      const y = o.y + PAD_H;
      const p = at(y);
      const lx = p ? p.x - o.x : 0;
      const lz = p ? p.z - o.z : 0;
      const t = p && this.deck.tiles.find((q) => lx >= q.x && lx <= q.x + q.w && lz >= q.z && lz <= q.z + q.d);
      if (t && this.farAt(p.x, y, p.z, PAD_SPACING)) return { kind: 'pool', name: t.name };
    }
    return null;
  }

  /** Switches between the two decks and the single island; resources of the other layout are disposed. */
  setLayout(id) {
    id = layoutId(id);
    if (id === this.layout) return;
    this.layout = id;
    this.group = id === 'decks' ? 'atespace' : this.groupPref;
    this.deckView = 'both';
    this.deckA = { agents: 1, workers: 1 };
    this.applyDeckFade(true);
    this.setHoverTile(null);
    if (!this.model) return;
    this.replan(true);
  }

  /** Decks: 'both', or one deck with the other faded out; the camera frames what shows. */
  setDeckView(view, fly = true) {
    if (this.layout !== 'decks') return;
    this.deckView = deckViewId(view);
    if (fly && this.island) this.fitCamera(true);
  }

  /** Eases the decks' fades toward the view's targets (decks layout). */
  updateDeckFade(dt) {
    if (this.layout !== 'decks') return;
    const tgt = deckAlphas(this.deckView);
    const k = this.reducedMotion ? 1 : 1 - Math.exp(-dt * 7);
    let moved = false;
    for (const d of ['agents', 'workers']) {
      let v = this.deckA[d] + (tgt[d] - this.deckA[d]) * k;
      if (Math.abs(tgt[d] - v) < 0.004) v = tgt[d];
      if (v !== this.deckA[d]) moved = true;
      this.deckA[d] = v;
    }
    if (moved || this.deckFadeAt === null) this.applyDeckFade();
  }

  /** Applies the decks' fades: uniforms, glass and deck materials, and what hides when faded out. */
  applyDeckFade(reset = false) {
    const a = reset ? 1 : this.deckA.agents;
    const b = reset ? 1 : this.deckA.workers;
    this.deckFadeAt = this.time.value;
    this.fade.agents.value = a;
    this.fade.workers.value = b;
    this.fade.beams.value = Math.min(a, b);
    for (const g of this.island?.glass || []) g.mat.opacity = g.opacity * a;
    for (const g of this.deckGround?.mats || []) {
      g.mat.opacity = g.opacity * b;
      // Opaque (sorted with the solid scene) unless fading or see-through by design.
      const see = g.opacity * b < 0.999;
      if (g.mat.transparent !== see) {
        g.mat.transparent = see;
        g.mat.needsUpdate = true;
      }
    }
    this.agentDeck.visible = a > 0.01;
    this.shapeGroup.visible = a > 0.5;
    this.workerDeck.visible = b > 0.01;
    for (const m of Object.values(this.pads.mesh)) m.visible = b > 0.5;
    if (this.router?.group) this.router.group.visible = a > 0.5;
    this.marker.group.visible = !!(this.selected && this.recs.get(this.selected)) && a > 0.5;
    if (a <= 0.5 && this.hoverRing) this.hoverRing.visible = false;
  }

  /** How busy an agent's link looks: 0 idle to 1 serving (more, faster dots). */
  linkRate(rec) {
    if (rec.cls !== 'running') return 0;
    if (this.serving(rec)) return 1;
    return this.fake.value > 0 ? ((rec.seed * 5.31) % 1) * 0.45 : 0.15;
  }

  /**
   * Whether an agent's link to its worker is drawn: for agents drawn as
   * shapes (the close-up budget), every agent of the worker in focus, and
   * the selected or hovered agent. 100,000 arcs would be noise.
   */
  wantsLink(rec) {
    // Decks: beams instead.
    if (this.layout === 'decks') return false;
    const w = rec.agent.worker;
    if (!w || !this.pads.get(w)) return false;
    return rec.slot >= 0 || w === this.focus.worker || rec.key === this.selected || rec.key === this.hovered;
  }

  /** Adds, moves or drops an agent's link to its worker's pad. */
  syncLink(rec) {
    if (!rec) return;
    if (!this.wantsLink(rec)) {
      this.links.remove(rec.key);
      return;
    }
    const pad = this.pads.get(rec.agent.worker);
    const level = levelOf(this.focus, rec.agent.worker);
    this.links.set(rec.key, { x: rec.x, y: this.topOf(rec), z: rec.z }, pad.pos, level, this.linkRate(rec), (rec.seed * 3.7) % 1);
  }

  relinkAll() {
    this.links.clear();
    const keys = new Set(this.near);
    for (const k of this.byWorker.get(this.focus.worker) || []) keys.add(k);
    if (this.selected) keys.add(this.selected);
    if (this.hovered) keys.add(this.hovered);
    for (const k of keys) this.syncLink(this.recs.get(k));
    this.styleLinks();
  }

  /** Link colors and alpha: many arcs add up, so the bundle gets fainter as it grows. */
  styleLinks() {
    const n = Math.max(this.links.count, 1);
    const a = theme.links.alpha;
    this.links.setLook({
      color: theme.links.color,
      highlight: theme.links.highlight,
      flow: theme.links.flow,
      restAlpha: Math.min(a, Math.max(a * 0.35, a * Math.sqrt(30 / n))),
      focusAlpha: theme.links.focusAlpha,
      dotAlpha: Math.min(0.85, Math.max(0.35, Math.sqrt(60 / n))) * (theme.glow.additive ? 1 : 0.85),
      blending: this.blending,
    });
  }

  // ------------------------------------------------------- level of detail

  /**
   * Re-selects the agents drawn as full shapes: the nearest within the
   * budget and the shape distance, in the frustum. Runs a few times a
   * second while the camera moves; the diff attaches and detaches only the
   * agents that changed.
   */
  refreshNear(force = false) {
    if (this.allShapes || !this.plan) {
      this.closeR.target = 1e6;
      return;
    }
    const cam = this.camera.position;
    const tgt = this.controls.target;
    const L = this.lastNear;
    const t = this.time.value;
    const movedBy = Math.hypot(cam.x - L.x, cam.y - L.y, cam.z - L.z) + Math.hypot(tgt.x - L.tx, tgt.z - L.tz);
    if (!force && L.t >= 0 && (t - L.t < NEAR_EVERY || movedBy < 0.02 * Math.max(5, cam.distanceTo(tgt)))) return;
    L.t = t;
    L.x = cam.x;
    L.y = cam.y;
    L.z = cam.z;
    L.tx = tgt.x;
    L.tz = tgt.z;
    const maxR = depthForPixels(SHAPE_PX, this.viewH(), this.camera.fov);
    const fr = this.frustum();
    const planes = fr.planes.map((p) => ({ x: p.normal.x, y: p.normal.y, z: p.normal.z, c: p.constant }));
    const pts = this.points;
    // Only the districts the shape radius reaches (on the ground) can hold
    // candidates; when that is a small part of the cluster, test just them.
    const reach2 = maxR * maxR - cam.y * cam.y;
    let subset = null;
    if (reach2 > 0) {
      const reach = Math.sqrt(reach2) + 2;
      const near = [];
      let total = 0;
      for (const d of this.plan.districts.values()) {
        const dx = Math.max(d.x - cam.x, 0, cam.x - (d.x + d.w));
        const dz = Math.max(d.z - cam.z, 0, cam.z - (d.z + d.d));
        if (dx * dx + dz * dz <= reach * reach) {
          near.push(d.name);
          total += this.slots.get(d.name)?.size || 0;
        }
      }
      if (total < this.recs.size * 0.6) {
        subset = new Int32Array(total);
        let k = 0;
        for (const name of near) {
          for (const key of this.slots.get(name).byKey.keys()) {
            const rec = this.recs.get(key);
            if (rec && k < total) subset[k++] = rec.idx;
          }
        }
        subset = subset.subarray(0, k);
      }
    } else {
      this.closeR.target = 0;
      for (const k of [...this.near]) {
        const rec = this.recs.get(k);
        if (rec) {
          this.detach(rec);
          this.syncLink(rec);
        }
      }
      return;
    }
    const { idx, radius } = selectNearest(pts.attrs.position.array, pts.live, pts.hwm, cam, this.budget, maxR, planes, 3, subset);
    const want = new Set();
    for (const i of idx) {
      const k = this.keyOfIdx[i];
      if (k) want.add(k);
    }
    // Keep the selected and hovered agents as shapes when they are close.
    for (const k of [this.selected, this.hovered]) if (k && this.near.has(k) && want.size < this.budget + 2) want.add(k);
    const changed = [];
    for (const k of [...this.near]) {
      if (want.has(k)) continue;
      const rec = this.recs.get(k);
      if (rec) {
        this.detach(rec);
        changed.push(rec);
      }
    }
    for (const k of want) {
      if (this.near.has(k)) continue;
      const rec = this.recs.get(k);
      if (!rec) continue;
      const pose = this.shape.pose[rec.cls];
      if (!this.anims.has(k)) {
        rec.h = pose.h;
        rec.tip = pose.tip;
      }
      this.attach(rec);
      changed.push(rec);
    }
    this.closeR.target = idx.length ? radius : 0;
    for (const rec of changed) this.syncLink(rec);
    if (changed.length) this.styleLinks();
  }

  /** Per-frame level-of-detail uniforms (the close-up radius eases to its target). */
  updateLod(dt) {
    const r = this.closeR;
    if (this.allShapes) r.value = r.target = 1e6;
    else if (r.value > 1e5) r.value = r.target;
    else r.value += (r.target - r.value) * (1 - Math.exp(-dt * 6));
    this.look.uCloseFar.value = r.value;
    this.look.uCloseNear.value = r.value * 0.85;
    // What the overlay reports: the level under the view's center.
    const d = this.camera.position.distanceTo(this.controls.target);
    this.lod = lodLevel(cellPixels(d, this.viewH(), this.camera.fov), this.allShapes ? 1 : this.near.size && r.value > 1 ? this.near.size : 0);
    // Tiles only draw when some district can be far.
    if (this.island) {
      const far = d + Math.max(this.island.width, this.island.depth);
      this.tiles.mesh.visible = farMix(cellPixels(far, this.viewH(), this.camera.fov)) > 0;
    }
    // Beams draw only where some agent cell is big enough for them (or one
    // is lit); ribbons only where some district is far (or beams are trimmed).
    if (this.beams && this.island) {
      const I = this.island;
      const cam = this.camera.position;
      const vh = this.viewH();
      const fov = this.camera.fov;
      const dx = Math.max(I.cx - I.width / 2 - cam.x, 0, cam.x - (I.cx + I.width / 2));
      const dz = Math.max(I.cz - I.depth / 2 - cam.z, 0, cam.z - (I.cz + I.depth / 2));
      const nearest = Math.hypot(dx, cam.y, dz);
      const farthest = d + Math.max(I.width, I.depth);
      const lit = !!(this.focus.worker || this.selected || this.hovered);
      const shown = this.fade.beams.value > 0.004;
      this.beams.lines.visible = shown && (lit || farMix(cellPixels(nearest, vh, fov) * 1.5) < 1);
      this.ribbons.mesh.visible = shown && (this.beamMode === 'focus' || this.beamsTrimmed || !!this.hoverTile || farMix(cellPixels(farthest, vh, fov)) > 0);
    }
    if (this.workerTiles && this.deck) {
      const D = this.deck;
      const o = this.workerOrigin();
      const far = this.camera.position.distanceTo(new THREE.Vector3(D.cx + o.x, o.y, D.cz + o.z)) + Math.max(D.width, D.depth);
      this.workerTiles.mesh.visible = farMix(cellPixels(far, this.viewH(), this.camera.fov, PAD_SPACING)) > 0;
    }
  }

  // ------------------------------------------------------------ highlight

  /** Writes an agent's shape highlight level (its worker may have changed). */
  writeHi(rec) {
    if (rec.slot < 0) return;
    const layer = this.layers[rec.cls];
    layer.hi.array[rec.slot] = levelOf(this.focus, rec.agent.worker);
    layer.markSlot(rec.slot);
  }

  /** Recomputes the worker in focus; repaints agents, links and pads when it changed. */
  refreshFocus() {
    const f = focusOf(this.hl, (key) => this.recs.get(key)?.agent.worker);
    if (sameFocus(f, this.focus)) return;
    const before = this.focus.worker;
    this.focus = f;
    // Points test the focus in the shader; shapes carry a level each.
    this.points.setFocus(f.worker ? this.workerIndex(f.worker) : -1, f.strong);
    for (const key of this.near) this.writeHi(this.recs.get(key));
    // Links: the old and new focused workers' agents come and go; every
    // drawn link takes its new level.
    for (const w of new Set([before, f.worker])) for (const k of this.byWorker.get(w) || []) this.syncLink(this.recs.get(k));
    for (const k of this.links.keys) this.links.setLevel(k, levelOf(f, this.recs.get(k)?.agent.worker));
    this.styleLinks();
    this.pads.setFocus(f);
    // Beams: the focused worker's agents must have one (budget or not).
    if (this.beams) {
      if (this.beamsSelective) for (const w of new Set([before, f.worker])) for (const k of this.byWorker.get(w) || []) this.syncBeam(this.recs.get(k));
      this.applyBeamFocus();
      this.relevelRibbons();
    }
    this.labelsDirty = true;
    this.lastLabelUpdate = -1;
    this.handlers.onFocus?.(f);
  }

  /** Pins a worker (clicked pad, or "show worker"); null unpins. */
  pinWorker(name) {
    this.hl.pinnedWorker = name || null;
    this.refreshFocus();
  }

  get pinnedWorker() {
    return this.hl.pinnedWorker;
  }

  /** Smoothly moves the camera to look at a worker's pad (or platform). */
  flyToWorker(name) {
    const pad = this.pads.get(name);
    if (!pad) return;
    const d = this.group === 'worker' && this.plan.districts.get(name);
    const target = d ? new THREE.Vector3(d.x + d.w / 2, 0.5, d.z + d.d / 2) : pad.pos.clone().add(this.workerOrigin(true));
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const dist = Math.max(Math.min(this.camera.position.distanceTo(this.controls.target), 60), 40);
    this.flyAnim = { t0: this.time.value, dur: 0.9, fromT: this.controls.target.clone(), toT: target, fromC: this.camera.position.clone(), toC: target.clone().add(dir.multiplyScalar(dist)) };
  }

  // -------------------------------------------------------------- grouping

  /** Switches between atespace and worker districts; agents glide to their new cells. */
  setGroup(mode) {
    mode = groupId(mode);
    this.groupPref = mode;
    // Decks group by atespace; the choice waits for 'combined'.
    if (this.layout === 'decks' || mode === this.group) return;
    this.group = mode;
    if (!this.model) return;
    this.replan(false, true);
    if (this.selected && this.recs.has(this.selected)) this.flyTo(this.selected);
    else this.fitCamera(true);
  }

  // --------------------------------------------------------------- camera

  /** Pixels on the left covered by the events panel (the fit keeps clear of them). */
  setLeftInset(px) {
    this.leftInset = px;
  }

  /** Frames the whole island; smooth: fly there instead of jumping. */
  fitCamera(smooth = false) {
    // Frame the island in the part of the view the events panel leaves
    // free: pull back to fit the narrower width and shift the target left
    // so the island (and the router tower on its left edge) clears the panel.
    const W = this.renderer.domElement.clientWidth || window.innerWidth;
    const inset = Math.min(this.leftInset || 0, W * 0.4);
    if (this.layout === 'decks' && this.deck) {
      this.fitDecks(smooth, W, inset);
      return;
    }
    const span = Math.max(this.island.width, this.island.depth * 1.5);
    const dist = Math.max(26, span * 0.95) * (W / (W - inset));
    const viewW = 2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect;
    const cx = this.island.cx - (inset / 2 / W) * viewW;
    // Aim a little toward the front edge when pulled back, so the island
    // uses the empty sky above it.
    const cz = this.island.cz + 0.5 + (inset ? this.island.depth * 0.05 : 0);
    const toT = new THREE.Vector3(cx, 0, cz);
    const toC = new THREE.Vector3(cx + dist * 0.1, dist * 0.56, cz + dist * 0.84);
    if (smooth) {
      this.flyAnim = { t0: this.time.value, dur: 0.9, fromT: this.controls.target.clone(), toT, fromC: this.camera.position.clone(), toC };
      return;
    }
    this.flyAnim = null;
    this.controls.target.copy(toT);
    this.camera.position.copy(toC);
    this.controls.update();
  }

  /**
   * Decks: frames what the deck view shows. Both decks: from a lower angle
   * (about 25 degrees), aimed between them, far enough back for the stack;
   * one deck: like the single island, at that deck's height.
   */
  fitDecks(smooth, W, inset) {
    const I = this.island;
    // The worker deck where it is going (a reset frames the arrangement it eases to).
    const o = this.workerOrigin(true);
    const D = { cx: this.deck.cx + o.x, cz: this.deck.cz + o.z, width: this.deck.width, depth: this.deck.depth, y: o.y };
    const view = this.deckView;
    let toT;
    let toC;
    if (view === 'both') {
      // The box around both decks (they may have been pulled apart).
      const x0 = Math.min(I.cx - I.width / 2, D.cx - D.width / 2);
      const x1 = Math.max(I.cx + I.width / 2, D.cx + D.width / 2);
      const z0 = Math.min(I.cz - I.depth / 2, D.cz - D.depth / 2);
      const z1 = Math.max(I.cz + I.depth / 2, D.cz + D.depth / 2);
      const span = Math.max(x1 - x0, I.width, D.width, (z1 - z0) * 1.2, I.depth * 1.5, D.depth * 1.5);
      const height = Math.abs(D.y);
      const dist = Math.max(34, span * 1.12, height * 2.9) * (W / (W - inset));
      const viewW = 2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect;
      const cx = (x0 + x1) / 2 - (inset / 2 / W) * viewW;
      const cz = (z0 + z1) / 2 + (z1 - z0) * 0.08;
      toT = new THREE.Vector3(cx, D.y * 0.42, cz);
      toC = new THREE.Vector3(cx + dist * 0.12, D.y * 0.42 + dist * 0.43, cz + dist * 0.9);
    } else {
      const b = view === 'agents' ? { cx: I.cx, cz: I.cz, w: I.width, d: I.depth, y: 0 } : { cx: D.cx, cz: D.cz, w: D.width, d: D.depth, y: D.y };
      const span = Math.max(b.w, b.d * 1.5);
      const dist = Math.max(26, span * 0.95) * (W / (W - inset));
      const viewW = 2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect;
      const cx = b.cx - (inset / 2 / W) * viewW;
      const cz = b.cz + 0.5;
      toT = new THREE.Vector3(cx, b.y, cz);
      toC = new THREE.Vector3(cx + dist * 0.1, b.y + dist * 0.56, cz + dist * 0.84);
    }
    if (smooth) {
      this.flyAnim = { t0: this.time.value, dur: 0.9, fromT: this.controls.target.clone(), toT, fromC: this.camera.position.clone(), toC };
      return;
    }
    this.flyAnim = null;
    this.controls.target.copy(toT);
    this.camera.position.copy(toC);
    this.controls.update();
  }

  /** Smoothly moves the camera to look at an agent. */
  flyTo(key) {
    const rec = this.recs.get(key);
    if (!rec) return;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const dist = Math.max(Math.min(this.camera.position.distanceTo(this.controls.target), 34), 24);
    // With the side panel open, aim right of the agent so it sits left of
    // center, clear of the panel.
    const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize().multiplyScalar(-dist * 0.18);
    // Where the agent is going, if it is moving between layouts.
    const mv = this.moves.get(key);
    const target = new THREE.Vector3(mv ? mv.tx : rec.x, 0.8, mv ? mv.tz : rec.z).add(right);
    const camTo = target.clone().add(dir.multiplyScalar(dist));
    this.flyAnim = { t0: this.time.value, dur: 0.9, fromT: this.controls.target.clone(), toT: target, fromC: this.camera.position.clone(), toC: camTo };
  }

  select(key) {
    const before = this.selected;
    this.selected = key;
    this.hl.selectedAgent = key;
    this.lastLabelUpdate = -1;
    for (const k of [before, key]) if (k) this.syncLink(this.recs.get(k));
    for (const k of [before, key]) if (k) this.syncBeam(this.recs.get(k));
    this.updateMarker();
    this.refreshFocus();
    this.applyBeamFocus();
  }

  updateMarker() {
    const rec = this.selected && this.recs.get(this.selected);
    if (!rec) {
      this.marker.group.visible = false;
      return;
    }
    this.marker.group.visible = this.layout !== 'decks' || this.deckA.agents > 0.5;
    this.marker.group.position.set(rec.x, 0.14, rec.z);
    const top = this.topOf(rec);
    this.marker.beam.scale.y = 3;
    this.marker.beam.position.y = top + 1.5;
  }

  /** Lets a benchmark drive the camera (fn(frame) each frame), or gives it back (null). */
  setCameraDriver(fn) {
    this.cameraDriver = fn;
    this.flyAnim = null;
    this.controls.enabled = !fn;
    if (!fn) this.controls.update();
  }

  // -------------------------------------------------------------- picking

  bindPointer(el) {
    let down = null;
    el.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      // A long press that picked up a deck (touch) isn't a click.
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      if (moved > 5) return;
      this.clickAt(e.clientX, e.clientY);
    });
    el.addEventListener('pointermove', (e) => {
      if (this.altDown !== e.altKey) {
        this.altDown = e.altKey;
        this.lastHoverPick = -1;
      }
      if (down) return;
      this.hoverAt = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointerleave', () => {
      this.hoverAt = null;
      this.setHover(null);
      this.setHoverWorker(null);
      if (!this.dragging) this.setHandle(null);
    });
  }

  /** The ray under a client position. */
  rayAt(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.ray;
  }

  /** The agent under a client position: the ray walks the agent grid (lod.js pickRay), no per-instance raycasting. */
  pick(clientX, clientY) {
    if (!this.plan || (this.layout === 'decks' && this.deckA.agents < 0.5)) return null;
    const ray = this.rayAt(clientX, clientY);
    const key = pickRay(ray.origin, ray.direction, {
      lookup: (x, z) => {
        const d = this.distIndex.at(x, z);
        if (!d) return null;
        const s = slotAt(d, x, z);
        return s < 0 ? null : this.slots.get(d.name)?.keyAt(s) || null;
      },
      body: (key) => {
        const rec = this.recs.get(key);
        if (!rec) return null;
        return { x: rec.x, z: rec.z, y0: 0.1, y1: Math.max(0.5, this.topOf(rec)), r: 0.62 };
      },
    });
    // Decks: where a district is drawn as its far tile, its agents aren't
    // on screen; the pointer is over the tile (see pickTile), not an agent.
    if (key && this.deck) {
      const rec = this.recs.get(key);
      if (rec && this.farAt(rec.x, 0, rec.z, CELL)) return null;
    }
    return key;
  }

  /** The worker pad under the pointer, by worker name. */
  pickWorker(clientX, clientY) {
    if (this.layout === 'decks' && this.deckA.workers < 0.5) return null;
    const ray = this.rayAt(clientX, clientY);
    if (ray.direction.y > -1e-4) return null;
    const o = this.workerOrigin();
    const t = (PAD_H + o.y - ray.origin.y) / ray.direction.y;
    if (t <= 0) return null;
    return this.pads.at(ray.origin.x + ray.direction.x * t - o.x, ray.origin.z + ray.direction.z * t - o.z);
  }

  setHover(key, x, y) {
    if (key !== this.hovered) {
      const before = this.hovered;
      this.hovered = key;
      const rec = key && this.recs.get(key);
      this.hoverRing.visible = !!rec;
      if (rec) this.hoverRing.position.set(rec.x, 0.15, rec.z);
      this.hl.hoverAgent = key || null;
      for (const k of [before, key]) if (k) this.syncLink(this.recs.get(k));
      if (this.beamsSelective) for (const k of [before, key]) if (k) this.syncBeam(this.recs.get(k));
      this.refreshFocus();
      this.applyBeamFocus();
    }
    this.handlers.onHover?.(key, x, y);
  }

  setHoverWorker(name) {
    if (name === this.hl.hoverWorker) return;
    this.hl.hoverWorker = name || null;
    this.refreshFocus();
    this.handlers.onHoverWorker?.(name);
  }

  // ---------------------------------------------------------------- frame

  /**
   * Adapts to the frame rate in 'auto' quality: while frames are slow
   * (over 26 ms), lower the pixel ratio to 1, then turn bloom off, then
   * halve the shape budget (to 1,200); with headroom (under 12 ms for five
   * seconds), step back up in reverse.
   */
  adaptQuality(t) {
    const q = this.quality;
    if (q.mode !== 'auto' || q.held || t - q.lastCheck < 1) return;
    q.lastCheck = t;
    const f = this.frameStats.summary();
    if (this.frameStats.count < 30) return;
    if (f.avgMs > 26) {
      q.fast = 0;
      if (++q.slow < 2) return;
      q.slow = 0;
      if (q.dpr > 1) q.dpr = Math.max(1, q.dpr - 0.25);
      else if (q.bloom) q.bloom = false;
      else if (!this.allShapes && this.budget > 1200) this.budget = Math.max(1200, Math.floor(this.budget / 2));
      else return;
    } else if (f.avgMs < 12) {
      q.slow = 0;
      if (++q.fast < 5) return;
      q.fast = 0;
      if (this.budget < this.baseBudget) this.budget = Math.min(this.baseBudget, this.budget * 2);
      else if (!q.bloom) q.bloom = true;
      else if (q.dpr < q.maxDpr) q.dpr = Math.min(q.maxDpr, q.dpr + 0.25);
      else return;
    } else {
      q.slow = q.fast = 0;
      return;
    }
    this.renderer.setPixelRatio(q.dpr);
    this.resize();
    this.applyBloom();
    this.refreshNear(true);
    this.frameStats.count = 0;
  }

  frame() {
    const start = performance.now();
    this.renderer.info.reset();
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 1.0) / this.slowmo;
    this.time.value += dt;
    const t = this.time.value;
    this.fxTokens = Math.min(FX_RATE * 2, this.fxTokens + dt * FX_RATE);
    this.beamTokens = Math.min(BEAM_RECENT_RATE * 2, this.beamTokens + dt * BEAM_RECENT_RATE);
    this.updateDeckEase(dt);

    if (this.replanAt >= 0 && t >= this.replanAt && this.model) this.replan(false, this.group === 'worker');

    // Layout moves (a grouping change, or an agent changing worker).
    for (const [key, mv] of this.moves) {
      const rec = this.recs.get(key);
      if (!rec) {
        this.moves.delete(key);
        continue;
      }
      const k = Math.min(Math.max((t - mv.t0) / mv.dur, 0), 1);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      rec.x = mv.fx + (mv.tx - mv.fx) * e;
      rec.z = mv.fz + (mv.tz - mv.fz) * e;
      this.points.setPos(rec.idx, rec.x, 0, rec.z);
      if (!this.anims.has(key)) this.writeMatrix(rec);
      if (rec.agent.worker) this.links.setFrom(key, rec.x, this.topOf(rec), rec.z);
      if (key === this.selected) this.updateMarker();
      if (key === this.hovered) this.hoverRing.position.set(rec.x, 0.15, rec.z);
      if (k >= 1) this.moves.delete(key);
    }

    // Pose animations (shapes only).
    for (const [key, an] of this.anims) {
      const rec = this.recs.get(key);
      if (!rec) {
        this.anims.delete(key);
        continue;
      }
      const k = Math.min((t - an.t0) / an.dur, 1);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      rec.h = an.fromH + (an.toH - an.fromH) * e;
      rec.tip = an.fromTip + (an.toTip - an.fromTip) * e;
      this.writeMatrix(rec);
      if (rec.agent.worker && rec.slot >= 0) this.links.setFrom(key, rec.x, this.topOf(rec), rec.z);
      if (key === this.selected) this.updateMarker();
      if (k >= 1) this.anims.delete(key);
    }

    // Atespace tiles fade in with the worker view; links fade with a focus.
    const ease = 1 - Math.exp(-dt * 8);
    const team = this.group === 'worker' ? theme.team.alpha : 0;
    this.look.uTeam.value += (team - this.look.uTeam.value) * ease;
    if (Math.abs(team - this.look.uTeam.value) < 0.002) this.look.uTeam.value = team;
    const fu = this.links.uniforms.uFocus;
    fu.value += ((this.focus.worker ? 1 : 0) - fu.value) * ease;

    // Camera: the benchmark's path, a fly-to, or the user.
    if (this.cameraDriver) {
      this.cameraDriver({ cpu: this.lastCpu, calls: this.lastInfo.calls, tris: this.lastInfo.triangles });
    } else {
      if (this.flyAnim) {
        const f = this.flyAnim;
        const k = Math.min((t - f.t0) / f.dur, 1);
        const e = 1 - Math.pow(1 - k, 3);
        this.controls.target.lerpVectors(f.fromT, f.toT, e);
        this.camera.position.lerpVectors(f.fromC, f.toC, e);
        if (k >= 1) this.flyAnim = null;
      }
      this.controls.update();
    }
    this.camera.updateMatrixWorld();

    // Level of detail: which agents are shapes, and the crossfade radius;
    // trimmed beams follow the camera at the same pace.
    const nearAt = this.lastNear.t;
    this.refreshNear();
    if (this.beamsTrimmed && this.lastNear.t !== nearAt) this.rebeamAll();
    this.updateLod(dt);
    this.updateDeckFade(dt);
    // Big islands: shadows cover the part around the camera's target.
    if (this.island && Math.max(this.island.width, this.island.depth) > 200) {
      const d = this.camera.position.distanceTo(this.controls.target);
      const span = Math.min(Math.max(this.island.width, this.island.depth) * 0.75 + 6, Math.max(30, d * 0.9));
      const tg = this.controls.target;
      if (Math.abs(span - this.shadowSpan) > span * 0.1 || this.sun.target.position.distanceTo(tg) > span * 0.2) {
        this.setShadowSpan(span, tg.x, tg.z);
        this.sun.position.set(tg.x - 70, 80, tg.z + 35);
      }
    }

    this.agents.flush();
    this.points.flush();
    this.links.flush();
    if (this.beams) {
      if (this.beams.expire(t)) for (const [k, until] of this.recentBeams) if (until + 2 < t) this.recentBeams.delete(k);
      this.beams.flush();
      this.ribbons.flush();
    }

    // Selection marker pulse, router beacon.
    if (this.marker.group.visible) {
      const s = 1 + 0.12 * Math.sin(t * 3);
      this.marker.ring.scale.set(s, s, s);
    }
    this.router?.update(t, dt);

    this.effects.update(t);

    if (this.hoverAt && !this.dragging && (t - this.lastHoverPick > 0.05 || this.lastHoverPick < 0)) {
      this.lastHoverPick = t;
      const { x, y } = this.hoverAt;
      // Option/Alt over a deck grabs the deck, not what is on it.
      const grab = this.altDown ? this.deckHandleAt(x, y, true) : null;
      const key = grab ? null : this.pick(x, y);
      this.setHover(key, x, y);
      const worker = key || grab ? null : this.pickWorker(x, y);
      this.setHoverWorker(worker);
      const handle = grab || (key || worker ? null : this.deckHandleAt(x, y, false));
      this.setHandle(handle);
      if (this.deck) this.setHoverTile(key || worker || handle ? null : this.pickTile(x, y));
    }

    if (t - this.lastLabelUpdate > LABEL_EVERY || this.lastLabelUpdate < 0) {
      this.lastLabelUpdate = t;
      this.flushTiles();
      this.flushPads();
      if (this.beams) {
        this.flushRibbons();
        // Crossing the beam budget either way re-picks the beams ('all' mode).
        if (this.beamMode === 'all' && this.beamsTrimmed !== this.holders.size > BEAM_BUDGET) this.rebeamAll();
        else if (Math.abs(this.beams.count - this.beamCountStyled) > this.beamCountStyled * 0.1) this.styleDecks();
      }
      if (this.labelsDirty) this.updateDistrictLabels();
      this.updateAgentLabels();
      this.layoutPlatformLabels();
      this.layoutDeckLabels();
      this.layoutDistrictLabels();
      this.layoutWorkerLabels();
      this.keepRouterLabelClear();
    }
    this.tiles.flush();
    this.workerTiles?.flush();
    this.pads.flush();

    this.composer.render();
    this.labelRenderer.render(this.scene, this.camera);
    const info = this.renderer.info.render;
    this.lastInfo = { calls: info.calls, triangles: info.triangles, points: info.points, lines: info.lines };
    this.lastCpu = performance.now() - start;
    this.frameStats.push(start, this.lastCpu);
    this.adaptQuality(t);
  }

  /** Renderer and layer numbers for the perf overlay. */
  stats() {
    const mem = this.renderer.info.memory;
    const layers = { points: this.allShapes ? 0 : this.points.count, shapes: 0 };
    for (const cls of CLASSES) {
      const n = this.layers[cls].keys.length;
      layers.shapes += n;
      if (n) layers[`  ${cls}`] = n;
    }
    layers.tiles = this.tiles.mesh.visible ? this.tiles.count : 0;
    layers.links = this.links.count;
    if (this.beams) {
      layers.beams = this.beams.count;
      layers.ribbons = this.ribbons.visibleCount;
      layers['pool tiles'] = this.workerTiles.mesh.visible ? this.workerTiles.count : 0;
    }
    Object.assign(layers, this.pads.stats());
    layers.effects = this.effects.items.length;
    layers.labels = this.agentLabels.filter((l) => l.visible).length + this.platformLabels.filter((l) => l.visible).length;
    const q = this.quality;
    return {
      ...this.lastInfo,
      geometries: mem.geometries,
      textures: mem.textures,
      heapMB: performance.memory ? performance.memory.usedJSHeapSize / 2 ** 20 : 0,
      lod: `${this.lod}${this.allShapes ? ' (all shapes)' : ` (budget ${this.budget}, r ${Math.min(this.closeR.value, 9999).toFixed(0)})`}`,
      quality: `${q.mode} · dpr ${q.dpr.toFixed(2)}${this.bloom.enabled ? '' : ' · no bloom'}${q.held ? ' · held' : ''}`,
      layout: this.layout === 'decks' ? `decks (${this.deckView}${this.beamsTrimmed ? `, beams trimmed to ${BEAM_BUDGET}` : ''})` : 'combined',
      layers,
    };
  }

  /**
   * Worker pad labels are quiet like agent labels: shown for the worker in
   * focus (a card when it is hovered or pinned), pads that aren't plainly
   * active (for example draining), and every pad when the camera is close to
   * it or labels are 'all'. In worker view the platforms carry the names, so
   * only the focused pad's card shows. They are placed greedily in screen
   * space after the district and agent labels and never overlap them or
   * each other (a card always shows). Labels come from the pads' pool.
   */
  layoutWorkerLabels() {
    if (!this.pads.count) return;
    const W = this.renderer.domElement.clientWidth;
    const H = this.renderer.domElement.clientHeight;
    const cam = this.camera.position;
    const mode = this.labelMode;
    const byWorker = this.group === 'worker';
    // Obstacles: the agent and district labels just placed (their boxes,
    // not layout reads). Decks: the worker deck has its own label budget,
    // so only its own labels are obstacles.
    const placed = this.deck ? [...(this.deckBoxes || []), ...(this.deckTitleBoxes || [])] : [...(this.agentBoxes || []), ...(this.districtBoxes || [])];
    const items = [];
    const wp = new THREE.Vector3();
    const fr = this.frustum();
    const o = this.workerOrigin();
    for (const [name, p] of this.pads.pads) {
      wp.set(p.x + o.x, o.y + 0.2, p.z + 2.6 + o.z);
      const focused = name === this.focus.worker;
      const card = focused && this.focus.strong;
      const notable = !!p.worker.state && p.worker.state !== 'ACTIVE';
      const prio = card ? 0 : focused ? 1 : notable ? 2 : 3;
      const d = cam.distanceTo(wp);
      const near = d < WORKER_LABEL_DISTANCE;
      const want = card || (!byWorker && mode !== 'off' && (prio < 3 || near || mode === 'all'));
      if (want && (card || fr.containsPoint(wp))) items.push({ p, prio, d, at: wp.clone() });
    }
    items.sort((a, b) => a.prio - b.prio || a.d - b.d);
    const show = [];
    for (const { p, prio, at } of items) {
      if (show.length >= this.pads.labelPool.length) break;
      at.project(this.camera);
      if (at.z > 1) continue;
      if (prio === 0) {
        show.push({ name: p.name, card: true });
        continue;
      }
      const x = (at.x * 0.5 + 0.5) * W;
      const y = (-at.y * 0.5 + 0.5) * H;
      // Estimated from the text: the element isn't laid out while hidden.
      const chars = Math.max(10, (p.worker.pod || p.worker.name).length + 2);
      const half = chars * 3.2 + 6;
      const box = { x0: x - half, x1: x + half, y0: y - 15, y1: y + 15 };
      if (placed.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) continue;
      placed.push(box);
      show.push({ name: p.name, card: false });
    }
    this.pads.showLabels(show);
  }

  /**
   * Places the router's label after the district labels: centered on its
   * anchor if that is clear, else above, right, left or below it, whichever
   * first clears the district and agent labels and the events panel; hidden
   * when none does (zoomed out, the router sits by the biggest districts'
   * labels, and those matter more). Sizes are estimated from the text.
   */
  keepRouterLabelClear() {
    const l = this.router?.labelObj;
    if (!l) return;
    const W = this.renderer.domElement.clientWidth;
    const H = this.renderer.domElement.clientHeight;
    const p = l.getWorldPosition(new THREE.Vector3()).project(this.camera);
    const x = (p.x * 0.5 + 0.5) * W;
    const y = (-p.y * 0.5 + 0.5) * H;
    const w = (l.element.textContent || '').length * 6.4 + 18;
    const h = 18;
    const obstacles = [...(this.districtBoxes || []), ...(this.agentBoxes || [])];
    const inset = this.leftInset || 0;
    const options = [
      [0.5, 0.5],
      [0.5, 1],
      [0, 0.5],
      [1, 0.5],
      [0.5, 0],
    ];
    for (const [cx, cy] of options) {
      const box = { x0: x - w * cx - 3, x1: x + w * (1 - cx) + 3, y0: y - h * cy - 3, y1: y + h * (1 - cy) + 3 };
      if (box.x0 < inset) continue;
      if (obstacles.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) continue;
      l.center.set(cx, cy);
      l.visible = true;
      return;
    }
    l.visible = false;
  }

  /**
   * Picks which agents get a label. In 'auto' mode: the selected agent,
   * agents that just changed state (for a few seconds), and the agents near
   * the camera only when it is close in on a district. 'all' labels every
   * agent near the camera; 'off' none. Hovering shows a tooltip instead.
   * Only agents drawn as shapes (plus pinned and selected ones) are
   * candidates, so the pass costs the close-up budget, not the cluster.
   * Far away (districts as tiles) only the selected agent keeps its label.
   */
  updateAgentLabels() {
    const cam = this.camera.position;
    const t = this.time.value;
    const mode = this.labelMode;
    const frustum = this.frustum();
    const near = [];
    const p = new THREE.Vector3();
    const closeUp = cam.distanceTo(this.controls.target) < CLOSE_UP_DISTANCE;
    const maxDist = mode === 'all' ? 60 : closeUp ? 34 : 0;
    const farView = this.lod === 'far';
    const cands = new Set();
    const deckHidden = this.layout === 'decks' && this.deckA.agents < 0.5;
    if (this.selected && !deckHidden) cands.add(this.selected);
    if (mode !== 'off' && !farView && !deckHidden) {
      for (const k of this.labelPinned.keys()) cands.add(k);
      if (maxDist > 0) for (const k of this.allShapes ? this.recs.keys() : this.near) cands.add(k);
    }
    for (const key of cands) {
      const rec = this.recs.get(key);
      if (!rec) continue;
      p.set(rec.x, this.topOf(rec), rec.z);
      const selected = rec.key === this.selected;
      const until = this.labelPinned.get(rec.key) || 0;
      const pinned = until > t;
      const d = cam.distanceTo(p);
      let prio;
      if (selected) prio = -1e9;
      else if (mode === 'off') continue;
      else if (pinned && rec.match) prio = -until; // newest change first
      else if (d <= maxDist && rec.match) prio = d;
      else continue;
      if (!frustum.containsPoint(p)) continue;
      near.push({ rec, d: prio, pinned: pinned && !selected && prio < 0, fade: pinned && !selected && until - t < 1.5 });
    }
    near.sort((a, b) => a.d - b.d);
    // Big clusters change hundreds of agents a second: show only the
    // newest few changes, so labels don't flicker everywhere.
    let pinnedShown = 0;
    const shown = this.allShapes ? near : near.filter((x) => !x.pinned || ++pinnedShown <= MAX_PINNED);
    // Greedy screen-space placement: skip a label that would overlap one
    // already placed, so a dense district doesn't turn into a smear.
    const W = this.renderer.domElement.clientWidth;
    const H = this.renderer.domElement.clientHeight;
    // District labels are obstacles: a passing agent label never covers one.
    const placed = [...(this.districtBoxes || [])];
    const agentBoxes = [];
    const chosen = [];
    for (const item of shown) {
      if (chosen.length >= this.agentLabels.length) break;
      const { rec } = item;
      p.set(rec.x, this.topOf(rec) + 0.13, rec.z).project(this.camera);
      const x = (p.x * 0.5 + 0.5) * W;
      const y = (-p.y * 0.5 + 0.5) * H;
      const w = 40 + rec.agent.name.length * 7 + (rec.agent.state.length + 8) * 5.6;
      const box = { x0: x - w * 0.1, x1: x + w * 0.9, y0: y - 22, y1: y };
      const hit = placed.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0);
      if (hit && item.d > -1e9) continue;
      placed.push(box);
      agentBoxes.push({ ...box, selected: item.d <= -1e9 });
      chosen.push(item);
    }
    this.agentBoxes = agentBoxes;
    const now = Date.now();
    for (let i = 0; i < this.agentLabels.length; i++) {
      const obj = this.agentLabels[i];
      const item = chosen[i];
      if (!item) {
        obj.visible = false;
        continue;
      }
      const { rec } = item;
      obj.visible = true;
      obj.position.set(rec.x, this.topOf(rec) + 0.13, rec.z);
      const a = rec.agent;
      const age = duration(since(a.stateSince, now));
      const html = `<span class="dot" style="background:${cssColor(a.state)}"></span>${esc(a.name)}<span class="sub">${esc(a.state.toLowerCase())} ${age}</span>`;
      if (obj.element.innerHTML !== html) obj.element.innerHTML = html;
      obj.element.classList.toggle('selected', rec.key === this.selected);
      obj.element.classList.toggle('fading', !!item.fade);
    }
    for (const [k, until] of this.labelPinned) if (until < t) this.labelPinned.delete(k);
  }
}
