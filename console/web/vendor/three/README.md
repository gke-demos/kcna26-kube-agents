# Vendored three.js

three.js **r186 (npm `three@0.186.1`)**, MIT licensed (see `LICENSE`), copied
verbatim from the published npm package. Do not edit these files; re-copy them
from the package to upgrade.

| File | From the package |
|---|---|
| `three.module.js`, `three.core.js` | `build/` |
| `addons/controls/OrbitControls.js` | `examples/jsm/controls/` |
| `addons/postprocessing/*.js` | `examples/jsm/postprocessing/` |
| `addons/shaders/*.js` | `examples/jsm/shaders/` |
| `addons/renderers/CSS2DRenderer.js` | `examples/jsm/renderers/` |
| `addons/lines/{Line2,LineSegments2,LineGeometry,LineSegmentsGeometry,LineMaterial}.js` | `examples/jsm/lines/` |

`web/index.html` maps `three` and `three/addons/` to this directory with an
import map, so the front end needs no bundler.
