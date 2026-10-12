import { Vector3, type Quaternion } from "three";

/** Held keys that move the view: WASD along horizontal camera-facing axes, Q/E along world Y. */
export const VIEWER_NAVIGATION_KEYS = new Set(["w", "a", "s", "d", "q", "e"]);
export const VIEWER_RESET_KEY = "r";
/** One axis-button step, as a fraction of the current view distance. */
export const VIEWER_AXIS_STEP = 0.1;
/** Held-key speed, in view distances per second. */
export const VIEWER_KEY_SPEED = 0.8;

const MIN_VIEW_DISTANCE = 1;
const KEY_DELTA_CAP = 0.1;
/** How quickly axis-button moves close in on their target, per second. */
const AXIS_DAMPING_RATE = 12;
/** Below this fraction of a step, the remaining axis move is applied in full. */
const AXIS_SNAP = 1e-3;

const TYPING_TAGS = new Set(["button", "input", "textarea", "select", "a"]);

const horizontalForward = new Vector3();
const horizontalRight = new Vector3();

/**
 * Movement direction for the currently held keys, in world space. Forward and
 * back, left and right follow the camera but stay horizontal; Q and E move
 * along world Y. Diagonals are normalized.
 */
export function viewerMovementFromKeys(
  keys: ReadonlySet<string>,
  quaternion: Quaternion,
  out: Vector3,
): Vector3 {
  out.set(0, 0, 0);
  if (keys.size === 0) return out;

  horizontalForward.set(0, 0, -1).applyQuaternion(quaternion);
  horizontalRight.set(1, 0, 0).applyQuaternion(quaternion);
  horizontalForward.y = 0;
  if (horizontalForward.lengthSq() < 1e-8) {
    horizontalForward.set(0, 1, 0).applyQuaternion(quaternion);
    horizontalForward.y = 0;
  }
  horizontalRight.y = 0;
  if (
    horizontalForward.lengthSq() > 1e-8 &&
    horizontalRight.lengthSq() > 1e-8
  ) {
    horizontalForward.normalize();
    horizontalRight.normalize();
    if (keys.has("w")) out.add(horizontalForward);
    if (keys.has("s")) out.sub(horizontalForward);
    if (keys.has("d")) out.add(horizontalRight);
    if (keys.has("a")) out.sub(horizontalRight);
  }
  if (keys.has("e")) out.y += 1;
  if (keys.has("q")) out.y -= 1;
  if (out.lengthSq() > 1) out.normalize();
  return out;
}

/** Frame step for held keys, scaled by the view distance. */
export function viewerKeyStep(distance: number, delta: number): number {
  return (
    Math.max(distance, MIN_VIEW_DISTANCE) *
    VIEWER_KEY_SPEED *
    Math.min(Math.max(delta, 0), KEY_DELTA_CAP)
  );
}

/** Unit direction of a world axis button: X, Y, or Z, positive or negative. */
export function worldAxisDirection(
  axis: "x" | "y" | "z",
  positive: boolean,
  out: Vector3,
): Vector3 {
  if (axis === "x") out.set(positive ? 1 : -1, 0, 0);
  else if (axis === "y") out.set(0, positive ? 1 : -1, 0);
  else out.set(0, 0, positive ? 1 : -1);
  return out;
}

/**
 * Advance a pending axis-button move by one damped frame. `remaining` holds
 * outstanding clicks in axis-step units; it is reduced by the applied step and
 * zeroed once the leftover is negligible. Returns this frame's world-space
 * step in `out`.
 */
export function consumePendingAxisMove(
  remaining: Vector3,
  distance: number,
  delta: number,
  out: Vector3,
): Vector3 {
  const worldScale = VIEWER_AXIS_STEP * Math.max(distance, MIN_VIEW_DISTANCE);
  out.copy(remaining).multiplyScalar(worldScale);
  if (out.lengthSq() <= (worldScale * AXIS_SNAP) ** 2) {
    remaining.set(0, 0, 0);
    return out;
  }
  const fraction = 1 - Math.exp(-Math.max(delta, 0) * AXIS_DAMPING_RATE);
  out.multiplyScalar(fraction);
  remaining.addScaledVector(out, -1 / worldScale);
  return out;
}

/** True when a keyboard event may drive the viewer instead of a child control. */
export function shouldHandleViewerKey(event: {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: { tagName?: string; isContentEditable?: boolean } | null;
}): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  const tagName = event.target?.tagName?.toLowerCase();
  if (tagName && TYPING_TAGS.has(tagName)) return false;
  return !event.target?.isContentEditable;
}
