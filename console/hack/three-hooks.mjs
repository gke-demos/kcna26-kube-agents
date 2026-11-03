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

// Module hooks for node tests: resolve the bare 'three' imports the browser
// gets from index.html's import map to the vendored build.
//   import { register } from 'node:module';
//   register('../../hack/three-hooks.mjs', import.meta.url);

const root = new URL('../web/vendor/three/', import.meta.url);

export async function resolve(specifier, context, next) {
  if (specifier === 'three') return { url: new URL('three.module.js', root).href, shortCircuit: true };
  if (specifier.startsWith('three/addons/')) return { url: new URL(specifier.slice('three/'.length), root).href, shortCircuit: true };
  return next(specifier, context);
}
