// Connect the sampled image grid without stretching it across depth edges.
// Missing samples are skipped. A cell with three valid corners keeps one
// triangle; otherwise use the shorter valid diagonal. Long edges require a
// consistent inverse-depth trend. Positions may
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
  /** Longer edges need a consistent neighboring depth trend. Default 7 footprints. */
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
    const lengthSquared = dx * dx + dy * dy + dz * dz;
    if (!Number.isFinite(lengthSquared)) return false;
    if (lengthSquared <= limitSquared) return true;

    // Inverse depth varies linearly across a plane in the source image.
    // A grazing floor has long 3D edges but the same trend on both sides;
    // an occlusion step has a different trend before and after the edge.
    const ax = a % cols,
      ay = Math.floor(a / cols);
    const bx = b % cols,
      by = Math.floor(b / cols);
    const stepX = bx - ax,
      stepY = by - ay;
    const px = ax - stepX,
      py = ay - stepY;
    const nx = bx + stepX,
      ny = by + stepY;
    if (
      px < 0 ||
      py < 0 ||
      nx < 0 ||
      ny < 0 ||
      px >= cols ||
      nx >= cols ||
      py >= rows ||
      ny >= rows
    )
      return false;
    const prev = py * cols + px,
      next = ny * cols + nx;
    if (
      vertexAt[prev] < 0 ||
      vertexAt[next] < 0 ||
      !finitePositive(depthAt[prev]) ||
      !finitePositive(depthAt[next])
    )
      return false;
    const slope = 1 / db - 1 / da;
    if (Math.abs(slope) < 1e-6) return false;
    const tolerance = Math.abs(slope) * 0.25 + 1e-6;
    return (
      Math.abs(1 / da - 1 / depthAt[prev] - slope) <= tolerance &&
      Math.abs(1 / depthAt[next] - 1 / db - slope) <= tolerance
    );
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
