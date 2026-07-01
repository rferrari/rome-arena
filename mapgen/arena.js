import * as THREE from 'three';

// ponytail: deterministic PRNG, stdlib has no seedable random — mulberry32 is the
// standard 1-function solution, no need for a dependency.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SAND = 0xc2a878;
const STONE = 0x9a8f7c;
const STONE_DARK = 0x6f6558;
const WALL = 0x8a7f6e;

/**
 * Procedurally generates a Colosseum-style circular arena: sand floor,
 * perimeter wall with N gates, stepped stone seating tiers, scattered
 * obstacles, and gameplay spawn point metadata for a handoff agent to
 * wire up combat/pathing against.
 *
 * @param {object} opts
 * @param {number} [opts.seed=1] - RNG seed, same seed -> same arena.
 * @param {number} [opts.floorRadius=30] - sand floor radius (world units).
 * @param {number} [opts.gates=4] - number of perimeter gates (evenly spaced).
 * @param {number} [opts.seatTiers=5] - number of stepped seating rings.
 * @param {number} [opts.obstacleCount=10] - scattered pillars/rocks on the floor.
 * @returns {{ group: THREE.Group, spawnPoints: object, arenaRadius: number, obstacles: Array }}
 */
export function generateArena(opts = {}) {
  const {
    seed = 1,
    floorRadius = 30,
    gates = 4,
    seatTiers = 5,
    obstacleCount = 10,
  } = opts;

  const rng = mulberry32(seed);
  const group = new THREE.Group();
  group.name = 'arena';

  // --- sand floor ---
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(floorRadius, 64),
    new THREE.MeshStandardMaterial({ color: SAND, roughness: 1 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.name = 'floor';
  group.add(floor);

  // --- perimeter wall with gates ---
  const wallHeight = 3;
  const wallThickness = 1.5;
  const wallRadius = floorRadius + wallThickness / 2;
  const gateWidthRad = (Math.PI * 2) / gates / 3; // gate occupies 1/3 of its slice
  const wallSegments = 128;
  const wallShapePoints = [];
  for (let i = 0; i <= wallSegments; i++) {
    const a = (i / wallSegments) * Math.PI * 2;
    const nearestGate = Math.round(a / ((Math.PI * 2) / gates)) * ((Math.PI * 2) / gates);
    const angleFromGate = Math.abs(((a - nearestGate + Math.PI) % (Math.PI * 2)) - Math.PI);
    const isGateGap = angleFromGate < gateWidthRad / 2;
    if (!isGateGap) wallShapePoints.push(a);
  }
  const wallGeo = new THREE.CylinderGeometry(
    wallRadius, wallRadius, wallHeight, wallSegments, 1, true
  );
  const wallMat = new THREE.MeshStandardMaterial({ color: WALL, roughness: 0.9, side: THREE.DoubleSide });
  const wallMesh = new THREE.Mesh(wallGeo, wallMat);
  wallMesh.position.y = wallHeight / 2;
  wallMesh.name = 'perimeterWall';
  group.add(wallMesh);
  // gate openings are handled as metadata (spawnPoints.gates) rather than
  // literal wall gaps, so the handoff agent can swap in real gate meshes.

  // --- stepped stone seating tiers (bowl, viewed from inside) ---
  const seating = new THREE.Group();
  seating.name = 'seatingTiers';
  const tierHeight = 1.2;
  const tierDepth = 2.2;
  for (let i = 0; i < seatTiers; i++) {
    const innerR = wallRadius + i * tierDepth;
    const outerR = innerR + tierDepth;
    const y = wallHeight + i * tierHeight;
    const ringShape = new THREE.Shape();
    ringShape.absarc(0, 0, outerR, 0, Math.PI * 2, false);
    const hole = new THREE.Path();
    hole.absarc(0, 0, innerR, 0, Math.PI * 2, true);
    ringShape.holes.push(hole);
    const ringGeo = new THREE.ExtrudeGeometry(ringShape, { depth: tierHeight, bevelEnabled: false });
    const ringMesh = new THREE.Mesh(
      ringGeo,
      new THREE.MeshStandardMaterial({ color: i % 2 === 0 ? STONE : STONE_DARK, roughness: 1 })
    );
    ringMesh.rotation.x = Math.PI / 2;
    ringMesh.position.y = y;
    seating.add(ringMesh);
  }
  group.add(seating);

  // --- scattered obstacles (pillars) on the sand floor ---
  const obstacles = [];
  const clearRadius = floorRadius * 0.25; // keep center clear for combat
  const pillarGeo = new THREE.CylinderGeometry(0.6, 0.7, 3, 12);
  const pillarMat = new THREE.MeshStandardMaterial({ color: STONE, roughness: 0.8 });
  for (let i = 0; i < obstacleCount; i++) {
    const angle = rng() * Math.PI * 2;
    const dist = clearRadius + rng() * (floorRadius * 0.85 - clearRadius);
    const x = Math.cos(angle) * dist;
    const z = Math.sin(angle) * dist;
    const pillar = new THREE.Mesh(pillarGeo, pillarMat);
    pillar.position.set(x, 1.5, z);
    pillar.name = `obstacle_${i}`;
    group.add(pillar);
    obstacles.push({ type: 'pillar', position: { x, y: 0, z }, radius: 0.7 });
  }

  // --- gameplay spawn point metadata ---
  const gateSpawns = [];
  for (let i = 0; i < gates; i++) {
    const angle = (i / gates) * Math.PI * 2;
    const x = Math.cos(angle) * (floorRadius - 2);
    const z = Math.sin(angle) * (floorRadius - 2);
    gateSpawns.push({ id: `gate_${i}`, position: { x, y: 0, z }, facing: angle + Math.PI });
  }
  const beastRingSpawns = [];
  const beastCount = Math.max(gates, 6);
  for (let i = 0; i < beastCount; i++) {
    const angle = ((i + 0.5) / beastCount) * Math.PI * 2;
    const x = Math.cos(angle) * (floorRadius * 0.6);
    const z = Math.sin(angle) * (floorRadius * 0.6);
    beastRingSpawns.push({ id: `beast_${i}`, position: { x, y: 0, z } });
  }

  return {
    group,
    arenaRadius: floorRadius,
    spawnPoints: {
      gates: gateSpawns,
      beastRing: beastRingSpawns,
      center: { id: 'center', position: { x: 0, y: 0, z: 0 } },
    },
    obstacles,
  };
}
