import test from "node:test";
import assert from "node:assert/strict";
import { Quaternion, Vector3 } from "three";
import {
  VIEWER_AXIS_STEP,
  consumePendingAxisMove,
  shouldHandleViewerKey,
  viewerKeyStep,
  viewerMovementFromKeys,
  worldAxisDirection,
} from "../src/trajectory/view-navigation";

function movement(keys: string[], quaternion = new Quaternion()): Vector3 {
  return viewerMovementFromKeys(new Set(keys), quaternion, new Vector3());
}

test("WASD moves along horizontal camera-facing axes", () => {
  assert.deepEqual(movement(["w"]).toArray(), [0, 0, -1]);
  assert.deepEqual(movement(["s"]).toArray(), [0, 0, 1]);
  assert.deepEqual(movement(["d"]).toArray(), [1, 0, 0]);
  assert.deepEqual(movement(["a"]).toArray(), [-1, 0, 0]);
});

test("movement stays horizontal when the camera pitches", () => {
  const pitched = new Quaternion().setFromAxisAngle(
    new Vector3(1, 0, 0),
    -Math.PI / 4,
  );
  const forward = movement(["w"], pitched);
  assert.ok(Math.abs(forward.y) < 1e-9, "forward must not drift vertically");
  assert.deepEqual(forward.toArray(), [0, 0, -1]);
});

test("yaw rotates the horizontal movement axes", () => {
  const yawed = new Quaternion().setFromAxisAngle(
    new Vector3(0, 1, 0),
    Math.PI / 2,
  );
  assert.ok(movement(["w"], yawed).distanceTo(new Vector3(-1, 0, 0)) < 1e-9);
  assert.ok(movement(["d"], yawed).distanceTo(new Vector3(0, 0, -1)) < 1e-9);
});

test("E and Q move along world Y regardless of camera orientation", () => {
  const upsideDown = new Quaternion().setFromAxisAngle(
    new Vector3(0, 0, 1),
    Math.PI,
  );
  assert.deepEqual(movement(["e"]).toArray(), [0, 1, 0]);
  assert.deepEqual(movement(["q"]).toArray(), [0, -1, 0]);
  assert.deepEqual(movement(["e"], upsideDown).toArray(), [0, 1, 0]);
  assert.deepEqual(movement(["q"], upsideDown).toArray(), [0, -1, 0]);
});

test("diagonal key combinations are normalized", () => {
  const length = movement(["w", "d"]).length();
  assert.ok(Math.abs(length - 1) < 1e-9, `got length ${length}`);
});

test("opposing keys cancel out", () => {
  assert.equal(movement(["w", "s"]).lengthSq(), 0);
  assert.equal(movement(["a", "d"]).lengthSq(), 0);
  assert.equal(movement(["q", "e"]).lengthSq(), 0);
});

test("vertical keys still work while looking straight down", () => {
  const straightDown = new Quaternion().setFromAxisAngle(
    new Vector3(1, 0, 0),
    -Math.PI / 2,
  );
  assert.deepEqual(movement(["w"], straightDown).toArray(), [0, 0, 0]);
  assert.deepEqual(movement(["e"], straightDown).toArray(), [0, 1, 0]);
});

test("key speed scales with view distance and caps the frame delta", () => {
  assert.ok(Math.abs(viewerKeyStep(10, 0.1) - 0.8) < 1e-9);
  assert.ok(Math.abs(viewerKeyStep(5, 0.016) - 5 * 0.8 * 0.016) < 1e-9);
  // Long frames must not let the camera jump.
  assert.equal(viewerKeyStep(10, 5), 0.8);
  // Very close zooms keep a usable minimum speed.
  assert.ok(Math.abs(viewerKeyStep(0.01, 0.1) - 0.08) < 1e-9);
});

test("world axis directions match their labels", () => {
  assert.deepEqual(
    worldAxisDirection("x", true, new Vector3()).toArray(),
    [1, 0, 0],
  );
  assert.deepEqual(
    worldAxisDirection("x", false, new Vector3()).toArray(),
    [-1, 0, 0],
  );
  assert.deepEqual(
    worldAxisDirection("y", true, new Vector3()).toArray(),
    [0, 1, 0],
  );
  assert.deepEqual(
    worldAxisDirection("y", false, new Vector3()).toArray(),
    [0, -1, 0],
  );
  assert.deepEqual(
    worldAxisDirection("z", true, new Vector3()).toArray(),
    [0, 0, 1],
  );
  assert.deepEqual(
    worldAxisDirection("z", false, new Vector3()).toArray(),
    [0, 0, -1],
  );
});

test("pending axis moves converge on the requested displacement", () => {
  const remaining = new Vector3(1, 0, 0);
  const step = new Vector3();
  const applied = new Vector3();
  const worldTarget = VIEWER_AXIS_STEP * 10;
  for (let frame = 0; frame < 200 && remaining.lengthSq() > 0; frame += 1) {
    applied.add(consumePendingAxisMove(remaining, 10, 1 / 60, step));
  }
  assert.equal(remaining.lengthSq(), 0);
  assert.ok(
    Math.abs(applied.x - worldTarget) < 1e-6,
    `applied ${applied.x}, wanted ${worldTarget}`,
  );
  assert.equal(applied.y, 0);
  assert.equal(applied.z, 0);
});

test("pending axis moves are damped, largest first", () => {
  const remaining = new Vector3(1, 0, 0);
  const step = consumePendingAxisMove(remaining, 10, 1 / 60, new Vector3());
  assert.ok(step.x > 0 && step.x < VIEWER_AXIS_STEP * 10);
  assert.ok(remaining.x > 0 && remaining.x < 1);
});

test("pending axis moves zero out on a zero request", () => {
  const remaining = new Vector3();
  const step = consumePendingAxisMove(remaining, 10, 1 / 60, new Vector3());
  assert.equal(step.lengthSq(), 0);
});

test("viewer keys are ignored while modifiers are held or typing", () => {
  const base = {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    target: { tagName: "DIV" },
  };
  assert.equal(shouldHandleViewerKey(base), true);
  assert.equal(shouldHandleViewerKey({ ...base, ctrlKey: true }), false);
  assert.equal(shouldHandleViewerKey({ ...base, metaKey: true }), false);
  assert.equal(shouldHandleViewerKey({ ...base, altKey: true }), false);
  assert.equal(
    shouldHandleViewerKey({ ...base, target: { tagName: "BUTTON" } }),
    false,
  );
  assert.equal(
    shouldHandleViewerKey({ ...base, target: { tagName: "INPUT" } }),
    false,
  );
  assert.equal(
    shouldHandleViewerKey({ ...base, target: { tagName: "TEXTAREA" } }),
    false,
  );
  assert.equal(
    shouldHandleViewerKey({
      ...base,
      target: { tagName: "DIV", isContentEditable: true },
    }),
    false,
  );
  assert.equal(
    shouldHandleViewerKey({ ...base, target: null }),
    true,
    "a null target is still the viewer",
  );
});
