import test from "node:test";
import assert from "node:assert/strict";
import {
  triangulateDepthSurface,
  type DepthSurfaceGrid,
} from "../src/depth-surface";

// Build a grid the same way decodePointCloud does: regular lattice over the
// source image, camera-local positions from the pinhole projection, and a
// compact vertex order that skips invalid samples.
const FX = 1000;
const FY = 1000;
const STRIDE = 4;

type Sample = number | null; // null = missing/invalid depth

function buildGrid(
  cols: number,
  rows: number,
  depthAtSample: (col: number, row: number) => Sample,
): DepthSurfaceGrid {
  const cx = (cols * STRIDE) / 2,
    cy = (rows * STRIDE) / 2;
  const vertexAt = new Int32Array(cols * rows).fill(-1);
  const depthAt = new Float32Array(cols * rows).fill(NaN);
  const positions: number[] = [];
  for (let row = 0; row < rows; row += 1)
    for (let col = 0; col < cols; col += 1) {
      const d = depthAtSample(col, row);
      if (d === null || !Number.isFinite(d) || d <= 0) continue;
      const px = col * STRIDE + 0.5,
        py = row * STRIDE + 0.5;
      positions.push(((px - cx) / FX) * d, (-(py - cy) / FY) * d, -d);
      vertexAt[row * cols + col] = positions.length / 3 - 1;
      depthAt[row * cols + col] = d;
    }
  return {
    cols,
    rows,
    vertexAt,
    depthAt,
    positions: new Float32Array(positions),
  };
}

function triangulate(
  cols: number,
  rows: number,
  depthAtSample: (col: number, row: number) => Sample,
) {
  return triangulateDepthSurface(buildGrid(cols, rows, depthAtSample), {
    stride: STRIDE,
    fx: FX,
    fy: FY,
  });
}

/** Reverse of vertexAt: compact vertex index -> grid cell index. */
function cellOfVertex(grid: DepthSurfaceGrid): Map<number, number> {
  const cellOf = new Map<number, number>();
  for (let cell = 0; cell < grid.vertexAt.length; cell += 1) {
    const vertex = grid.vertexAt[cell]!;
    if (vertex >= 0) cellOf.set(vertex, cell);
  }
  return cellOf;
}

test("flat plane connects every grid cell with two triangles", () => {
  const cols = 8,
    rows = 6,
    depth = 5;
  const indices = triangulate(cols, rows, () => depth);
  // Every (cols-1)*(rows-1) cell yields both triangles.
  assert.equal(indices.length, (cols - 1) * (rows - 1) * 6);
  // Every sampled vertex participates in the surface.
  const used = new Set(indices);
  const vertexCount = cols * rows;
  assert.equal(used.size, vertexCount);
});

test("flat plane triangle corners all sit at the sampled depth", () => {
  const indices = triangulate(6, 5, () => 3);
  const grid = buildGrid(6, 5, () => 3);
  for (const index of indices) assert.equal(grid.positions[index * 3 + 2], -3);
});

test("sharp foreground/background step is not bridged", () => {
  const cols = 10,
    rows = 6,
    near = 2,
    far = 9;
  // A relative depth jump of 3.5 across the middle columns must produce
  // no triangle mixing the two surfaces.
  const depthAtSample = (col: number) => (col < 5 ? near : far);
  const indices = triangulate(cols, rows, depthAtSample);
  const cellOf = cellOfVertex(buildGrid(cols, rows, depthAtSample));
  for (let t = 0; t < indices.length; t += 3) {
    const triangleCols = [0, 1, 2].map(
      (k) => cellOf.get(indices[t + k]!)! % cols,
    );
    const nearSide = triangleCols[0]! < 5;
    for (const col of triangleCols)
      assert.equal(col < 5, nearSide, "triangle spans the step");
  }
});

test("sloped plane stays fully connected", () => {
  const cols = 8,
    rows = 6;
  // Depth grows linearly with x: about 0.03 world units per sample, a
  // roughly 60 degree slope from a camera at depth 4. Well inside both
  // the relative jump cutoff and the footprint length limit.
  const slope = (col: number) => 4 + 0.0075 * col * STRIDE;
  const indices = triangulate(cols, rows, (col) => slope(col));
  assert.equal(indices.length, (cols - 1) * (rows - 1) * 6);
});

test("missing depth cells are skipped and never indexed", () => {
  const cols = 7,
    rows = 7;
  const isMissing = (col: number, row: number) =>
    col === 3 || (col === 5 && row === 5);
  const depthAtSample = (col: number, row: number) =>
    isMissing(col, row) ? null : 4;
  const indices = triangulate(cols, rows, depthAtSample);
  const grid = buildGrid(cols, rows, depthAtSample);
  const cellOf = cellOfVertex(grid);
  for (const index of indices) {
    const cell = cellOf.get(index)!;
    const col = cell % cols,
      row = Math.floor(cell / cols);
    assert.ok(!isMissing(col, row), `index ${index} came from a missing cell`);
  }
  // The surface closes around the hole but never covers it.
  assert.ok(indices.length > 0);
  assert.ok(indices.length < (cols - 1) * (rows - 1) * 6);
});

test("indices always reference valid compact vertices in groups of three", () => {
  const cols = 9,
    rows = 8;
  const indices = triangulate(cols, rows, (col, row) =>
    (col * 7 + row * 5) % 11 === 0 ? null : 2.5 + 0.01 * col,
  );
  const vertexCount =
    buildGrid(cols, rows, (col, row) =>
      (col * 7 + row * 5) % 11 === 0 ? null : 2.5 + 0.01 * col,
    ).positions.length / 3;
  assert.equal(indices.length % 3, 0);
  for (const index of indices)
    assert.ok(
      Number.isInteger(index) && index >= 0 && index < vertexCount,
      `index ${index} outside [0, ${vertexCount})`,
    );
});

test("a cell with three valid corners emits exactly one triangle", () => {
  // 2x2 grid, the far corner (col 1, row 1) has no depth.
  const grid = buildGrid(2, 2, (col, row) =>
    col === 1 && row === 1 ? null : 3,
  );
  const indices = triangulateDepthSurface(grid, {
    stride: STRIDE,
    fx: FX,
    fy: FY,
  });
  assert.equal(indices.length, 3);
  const used = new Set(indices);
  assert.equal(used.size, 3);
  const valid = [...grid.vertexAt].filter((v) => v >= 0);
  for (const v of valid) assert.ok(used.has(v));
});

test("nonfinite and nonpositive depths never produce indices", () => {
  const grid = buildGrid(3, 3, () => 4);
  // Corrupt depths while keeping the vertex indices: these cells must be
  // treated as missing, so no triangle may reference them.
  grid.depthAt[4] = NaN;
  grid.depthAt[0] = 0;
  grid.depthAt[8] = -2;
  const indices = triangulateDepthSurface(grid, {
    stride: STRIDE,
    fx: FX,
    fy: FY,
  });
  const corrupted = new Set([0, 4, 8].map((cell) => grid.vertexAt[cell]));
  // The two cells diagonal to the corrupted corners keep three valid
  // corners each and emit one triangle apiece; the other two cells lose
  // two corners and emit none.
  assert.equal(indices.length, 6);
  for (const index of indices) assert.ok(!corrupted.has(index));
});

test("custom depth thresholds tighten or loosen acceptance", () => {
  // A smooth slope passes the normal guards but a stricter depth-jump
  // threshold rejects it.
  const cols = 6,
    rows = 5;
  const slope = (col: number) => 4 + 0.0075 * col * STRIDE;
  const grid = buildGrid(cols, rows, (col) => slope(col));
  const relaxed = triangulateDepthSurface(grid, {
    stride: STRIDE,
    fx: FX,
    fy: FY,
  });
  const tight = triangulateDepthSurface(grid, {
    stride: STRIDE,
    fx: FX,
    fy: FY,
    maxFootprintScale: 1,
    maxDepthJump: 0.001,
  });
  assert.ok(relaxed.length > 0);
  assert.equal(tight.length, 0);
});

test("empty and single-cell grids produce no indices", () => {
  for (const [cols, rows] of [
    [1, 1],
    [2, 1],
    [1, 2],
  ] as const) {
    const indices = triangulate(cols, rows, () => 3);
    assert.equal(indices.length, 0);
  }
});

test("pixel footprint respects both focal lengths and diagonal spacing", () => {
  const grid = buildGrid(4, 4, () => 5);
  // Make the horizontal spacing twice as wide as vertical spacing.
  for (let i = 0; i < grid.positions.length; i += 3) grid.positions[i] *= 2;
  const indices = triangulateDepthSurface(grid, {
    stride: STRIDE,
    fx: FX / 2,
    fy: FY,
    maxFootprintScale: 1.01,
  });
  assert.equal(indices.length, 3 * 3 * 6);
});

test("grazing floor keeps interior cells connected", () => {
  const cols = 7,
    rows = 7;
  const positions: number[] = [],
    depths: number[] = [];
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const depth = FX / (60 + y * STRIDE);
      depths.push(depth);
      positions.push(((x * STRIDE) / FX) * depth, -1, -depth);
    }
  const grid = {
    cols,
    rows,
    vertexAt: Int32Array.from(depths, (_, i) => i),
    depthAt: Float32Array.from(depths),
    positions: Float32Array.from(positions),
  };
  const indices = triangulateDepthSurface(grid, {
    stride: STRIDE,
    fx: FX,
    fy: FY,
  });
  assert.ok(
    indices.length > 0,
    "a smooth floor at a shallow angle must not disappear",
  );
  const cells = new Set(indices);
  assert.ok(cells.has(3 * cols + 3), "the middle of the floor remains covered");
});
