// Flow-field pathfinding for masses converging on a siege objective. One BFS sweep
// from the goal produces a per-cell direction the whole army samples in O(1), so
// soldiers route around fort walls and funnel through the gate instead of piling on
// the masonry. Pure JS (no deps) so it runs in both the Bun server and the browser,
// like the rest of sim.js. Blocked cells are re-marked from standing bricks each
// recompute, so a wall breached by boulders opens a new path automatically.
export function createFlowField(W, D, cell = 2) {
  const cols = Math.ceil(W / cell), rows = Math.ceil(D / cell), N = cols * rows;
  const blocked = new Uint8Array(N);
  const dist = new Int32Array(N);
  const dirX = new Float32Array(N), dirZ = new Float32Array(N);
  const x0 = -W / 2, z0 = -D / 2;
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const idxOf = (x, z) => {
    let c = Math.floor((x - x0) / cell), r = Math.floor((z - z0) / cell);
    c = c < 0 ? 0 : c >= cols ? cols - 1 : c;
    r = r < 0 ? 0 : r >= rows ? rows - 1 : r;
    return r * cols + c;
  };

  return {
    clearBlocked() { blocked.fill(0); },
    blockWorld(x, z) { blocked[idxOf(x, z)] = 1; },
    // BFS the integration field out from the goal, then set each open cell's
    // direction toward its lowest-distance neighbour.
    compute(gx, gz) {
      dist.fill(-1);
      const start = idxOf(gx, gz);
      blocked[start] = 0;
      const q = [start]; dist[start] = 0;
      for (let head = 0; head < q.length; head++) {
        const cur = q[head], cr = (cur / cols) | 0, cc = cur % cols, cd = dist[cur];
        for (const [dc, dr] of NB) {
          const nc = cc + dc, nr = cr + dr;
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
          const ni = nr * cols + nc;
          if (dist[ni] !== -1 || blocked[ni]) continue;
          if (dc && dr && (blocked[cr * cols + nc] || blocked[nr * cols + cc])) continue; // no corner cutting
          dist[ni] = cd + 1; q.push(ni);
        }
      }
      for (let i = 0; i < N; i++) {
        dirX[i] = dirZ[i] = 0;
        if (dist[i] <= 0) continue;
        const cr = (i / cols) | 0, cc = i % cols;
        let best = dist[i], bc = 0, br = 0;
        for (const [dc, dr] of NB) {
          const nc = cc + dc, nr = cr + dr;
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
          const nd = dist[nr * cols + nc];
          if (nd !== -1 && nd < best) { best = nd; bc = dc; br = dr; }
        }
        if (bc || br) { const l = Math.hypot(bc, br); dirX[i] = bc / l; dirZ[i] = br / l; }
      }
    },
    // unit steering direction {x,z} at a world point, or null if at goal/unreachable
    sample(x, z) {
      const i = idxOf(x, z);
      if (dist[i] < 0 || (dirX[i] === 0 && dirZ[i] === 0)) return null;
      return { x: dirX[i], z: dirZ[i] };
    },
  };
}
