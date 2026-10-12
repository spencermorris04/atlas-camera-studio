// Connect the sampled image grid without stretching it across depth edges.
// Missing samples are skipped. A cell with three valid corners keeps one
// triangle; otherwise use the shorter valid diagonal. Edge lengths are capped
// relative to their projected pixel spacing at the nearer depth. Positions may
// be in camera or world coordinates because rigid transforms preserve length.

export type DepthSurfaceGrid = {
  /** Number of sampled columns and rows in the source image grid. */
  cols: number;
  rows: number;
  /** Compact vertex index per grid cell, -1 where no sample was kept. */
  vertexAt: Int32Array;
  /** Camera-space depth per grid cell, NaN where no sample was kept. */
  depthAt: Float32Array;
  /** Interleaved xyz positions of the compact vertex order. */
  positions: Float32Array;
};

export type DepthSurfaceOptions = {
  /** Sampling stride in source pixels between adjacent grid cells. */
  stride: number;
  fx: number;
  fy: number;
  /** Edge length limit in pixel footprints at that depth. Default 7. */
  maxFootprintScale?: number;
  /** Maximum relative depth change across an edge. Default 0.12. */
  maxDepthJump?: number;
};

export function triangulateDepthSurface(
  grid: DepthSurfaceGrid,
  options: DepthSurfaceOptions,
): Uint32Array {
  const { cols, rows, vertexAt, depthAt, positions } = grid;
  const maxFootprintScale = options.maxFootprintScale ?? 7;
  const maxDepthJump = options.maxDepthJump ?? 0.12;
  const finitePositive = (depth: number) => Number.isFinite(depth) && depth > 0;

  // An edge may be a triangle side only when both endpoints exist with
  // usable depths and the samples are plausibly part of one surface.
  const edgeOk = (a: number, b: number) => {
    const va = vertexAt[a]!,
      vb = vertexAt[b]!;
    if (va < 0 || vb < 0) return false;
    const da = depthAt[a]!,
      db = depthAt[b]!;
    if (!finitePositive(da) || !finitePositive(db)) return false;
    const nearer = Math.min(da, db);
    if (Math.abs(da - db) > maxDepthJump * nearer) return false;
    const pixelX = (((a % cols) - (b % cols)) * options.stride) / options.fx;
    const pixelY =
      ((Math.floor(a / cols) - Math.floor(b / cols)) * options.stride) /
      options.fy;
    const limitSquared =
      (maxFootprintScale * nearer) ** 2 * (pixelX * pixelX + pixelY * pixelY);
    const i = va * 3,
      j = vb * 3;
    const dx = positions[j]! - positions[i]!,
      dy = positions[j + 1]! - positions[i + 1]!,
      dz = positions[j + 2]! - positions[i + 2]!;
    return dx * dx + dy * dy + dz * dz <= limitSquared;
  };

  const diagonalLengthSq = (a: number, b: number) => {
    const i = vertexAt[a]! * 3,
      j = vertexAt[b]! * 3;
    const dx = positions[j]! - positions[i]!,
      dy = positions[j + 1]! - positions[i + 1]!,
      dz = positions[j + 2]! - positions[i + 2]!;
    return dx * dx + dy * dy + dz * dz;
  };

  const out: number[] = [];
  for (let y = 0; y + 1 < rows; y += 1) {
    for (let x = 0; x + 1 < cols; x += 1) {
      const a = y * cols + x,
        b = a + 1,
        c = a + cols,
        d = c + 1;
      // Cell sides, shared with neighboring cells and recomputed per cell
      // to keep the helper stateless.
      const top = edgeOk(a, b),
        bottom = edgeOk(c, d),
        left = edgeOk(a, c),
        right = edgeOk(b, d);
      const diagAd = edgeOk(a, d),
        diagBc = edgeOk(b, c);
      // Prefer the shorter diagonal when both splits are viable.
      if (
        diagAd &&
        (!diagBc || diagonalLengthSq(a, d) <= diagonalLengthSq(b, c))
      ) {
        // Triangle (a, b, d) spans the top and right sides.
        if (top && right) out.push(vertexAt[a]!, vertexAt[b]!, vertexAt[d]!);
        // Triangle (a, d, c) spans the bottom and left sides.
        if (left && bottom) out.push(vertexAt[a]!, vertexAt[d]!, vertexAt[c]!);
      } else if (diagBc) {
        // Triangle (b, d, c) spans the right and bottom sides.
        if (right && bottom) out.push(vertexAt[b]!, vertexAt[d]!, vertexAt[c]!);
        // Triangle (b, c, a) spans the top and left sides.
        if (top && left) out.push(vertexAt[b]!, vertexAt[c]!, vertexAt[a]!);
      }
    }
  }
  return new Uint32Array(out);
}
