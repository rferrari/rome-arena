import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const loader = new GLTFLoader();
const cache = new Map();

/**
 * Loads (and caches) a mob GLB by manifest-relative path, e.g. "beasts/wolf.glb".
 * Returns a fresh clone of the scene each call so callers can place multiple
 * instances of the same mob.
 */
export async function loadMob(relativePath, basePath = '/assets/mobs/') {
  if (!cache.has(relativePath)) {
    const url = basePath + relativePath;
    const gltf = await loader.loadAsync(url);
    cache.set(relativePath, gltf);
  }
  const gltf = cache.get(relativePath);
  const clone = gltf.scene.clone(true);
  return { scene: clone, animations: gltf.animations };
}

export async function loadManifest(basePath = '/assets/mobs/') {
  const res = await fetch(basePath + 'manifest.json');
  return res.json();
}
