import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import {
  Grid,
  Html,
  Line,
  OrbitControls,
  PerspectiveCamera,
  useTexture,
} from "@react-three/drei";
import {
  Canvas,
  useFrame,
  useThree,
  type ThreeEvent,
} from "@react-three/fiber";
import { RotateCcw } from "lucide-react";
import { createIntrinsicsFromFov } from "./common";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { FrustumObject } from "./FrustumObject";
import type { PosedView } from "./pose";
import {
  cameraDrawingView,
  cameraPathProgressAtFrame,
  cameraPathTarget,
  sampleCameraPivot,
  sampleCameraPath,
  TRAJECTORY_FLOOR_Y,
  trajectoryPivotsFromSegments,
  type CameraDirectionMode,
  type CameraView,
  type SampledCameraView,
  type TrajectoryDrawingView,
  type TrajectoryPoint,
  type TrajectorySegment,
} from "./camera-trajectory";
import {
  consumePendingAxisMove,
  isometricViewDirection,
  shouldHandleViewerKey,
  viewerKeyStep,
  viewerMovementFromKeys,
  VIEWER_AXIS_STEP,
  VIEWER_NAVIGATION_KEYS,
  VIEWER_RESET_KEY,
  worldAxisDirection,
} from "./view-navigation";

const PATH_SAMPLES = 101;
const PATH_COLOR = "#334155";
const PATH_ADDING_COLOR = "#94a3b8";
const HANDLE_COLOR = "#94a3b8";
const SELECTED_CAMERA_COLOR = "#334155";
const SELECTED_CAMERA_OUTLINE = "#1e293b";
const STUDIO_BACKGROUND = "#ffffff";
const OVERVIEW_FOV = 35;
const PREVIEW_PROGRESS_REPORT_INTERVAL = 1 / 12;

type CameraTrajectoryCanvasProps = {
  pose: PosedView;
  referenceView: CameraView;
  views: readonly CameraView[];
  segments: readonly TrajectorySegment[];
  selectedPivot: {
    segmentId: string;
    pointIndex: number;
    pivotNumber: number;
  } | null;
  addingPivot: boolean;
  previewing: boolean;
  /** Null shows the editing overview; a number pins the preview camera to that path progress (0..1). */
  previewProgress: number | null;
  onPreviewProgress: (progress: number) => void;
  disabled: boolean;
  frameCount: number;
  previewSeconds: number;
  frameWidth: number;
  frameHeight: number;
  directionMode: CameraDirectionMode;
  directionTarget: TrajectoryPoint | null;
  directionTargetCandidates: readonly TrajectoryPoint[];
  placingDirectionTarget: boolean;
  placingDirectionTargetMode: "look_at" | "look_away";
  closedLoop: boolean;
  allowBelowFloor: boolean;
  onPreviewDone: () => void;
  onDrawingViewChange: (view: TrajectoryDrawingView) => void;
  onPointChange: (
    segmentId: string,
    pointIndex: number,
    position: TrajectoryPoint,
  ) => void;
  onPointSelect: (
    segmentId: string,
    pointIndex: number,
    pivotNumber: number,
  ) => void;
  onPivotAdd: (position: TrajectoryPoint, pathProgress: number) => void;
  onDirectionTargetChange: (position: TrajectoryPoint) => void;
  onDirectionTargetCancel: () => void;
  onDirectionTargetMiss: () => void;
};

export function CameraTrajectoryCanvas(props: CameraTrajectoryCanvasProps) {
  const { pose, referenceView, segments } = props;
  const inspecting = props.previewing || props.previewProgress !== null;
  const navigating =
    !inspecting && !props.placingDirectionTarget && !props.addingPivot;
  const viewer = useRef<HTMLDivElement>(null);
  const navigationKeys = useRef(new Set<string>());
  // Outstanding axis-button movement in step units; consumed by the scene's
  // frame loop with damping.
  const pendingAxisMove = useRef(new THREE.Vector3());
  const target = useMemo(
    () => cameraPathTarget(referenceView, pose.centroidWorld),
    [pose.centroidWorld, referenceView],
  );
  const [defaultHome] = useState(() => ({
    position: buildOverviewPosition(referenceView.position, target, segments),
  }));
  const [overviewHome, setOverviewHome] = useState(defaultHome);
  const [resetVersion, setResetVersion] = useState(0);
  const resetView = useCallback(() => {
    navigationKeys.current.clear();
    pendingAxisMove.current.set(0, 0, 0);
    setOverviewHome({ position: [...defaultHome.position] });
    setResetVersion((version) => version + 1);
  }, [defaultHome]);

  useEffect(() => {
    const clearInput = () => {
      navigationKeys.current.clear();
      pendingAxisMove.current.set(0, 0, 0);
    };
    window.addEventListener("blur", clearInput);
    return () => window.removeEventListener("blur", clearInput);
  }, []);

  useEffect(() => {
    if (!props.placingDirectionTarget) return;
    navigationKeys.current.clear();
    pendingAxisMove.current.set(0, 0, 0);
    viewer.current?.focus({ preventScroll: true });
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      props.onDirectionTargetCancel();
    };
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [props.onDirectionTargetCancel, props.placingDirectionTarget]);

  function updateNavigationKey(
    event: ReactKeyboardEvent<HTMLDivElement>,
    pressed: boolean,
  ) {
    const key = event.key.toLowerCase();
    if (!pressed) {
      navigationKeys.current.delete(key);
      return;
    }
    if (key === VIEWER_RESET_KEY) {
      if (
        pressed &&
        !event.repeat &&
        navigating &&
        shouldHandleViewerKey(event)
      ) {
        resetView();
      }
      return;
    }
    if (
      !navigating ||
      !VIEWER_NAVIGATION_KEYS.has(key) ||
      !shouldHandleViewerKey(event)
    ) {
      return;
    }
    event.preventDefault();
    if (pressed) navigationKeys.current.add(key);
    else navigationKeys.current.delete(key);
  }

  const nudgeView = useCallback((axis: "x" | "y" | "z", positive: boolean) => {
    pendingAxisMove.current.add(
      worldAxisDirection(axis, positive, new THREE.Vector3()),
    );
    viewer.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      ref={viewer}
      role="application"
      tabIndex={0}
      aria-label="3D camera path viewer. Drag a camera to move it; drag empty space to rotate. Delete removes the selected camera. Use W A S D to move, Q and E to move down and up, and R to reset the view."
      aria-describedby={
        props.placingDirectionTarget ? "look-at-picker-instruction" : undefined
      }
      data-look-at-picker={
        props.placingDirectionTarget
          ? "picking"
          : (props.directionMode === "look_at" ||
                props.directionMode === "look_away") &&
              props.directionTarget
            ? "set"
            : "idle"
      }
      className={`relative h-full w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#94a3b8]/60 ${props.placingDirectionTarget ? "cursor-crosshair" : ""}`}
      onPointerDown={(event) =>
        event.currentTarget.focus({ preventScroll: true })
      }
      onKeyDown={(event) => updateNavigationKey(event, true)}
      onKeyUp={(event) => updateNavigationKey(event, false)}
      onBlur={(event) => {
        navigationKeys.current.clear();
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          pendingAxisMove.current.set(0, 0, 0);
        }
      }}
    >
      {navigating && (
        <nav
          aria-label="Scene navigation"
          className="studio-view-controls absolute left-1/2 top-3 z-40 max-w-[calc(100%-1.5rem)] -translate-x-1/2 rounded-lg border border-[#202733]/15 bg-[#ffffff]/95 p-2 shadow-sm backdrop-blur"
        >
          <div className="flex items-center gap-2">
            <span className="hidden text-[10px] font-medium text-[#727b88] md:inline">
              View
            </span>
            {(["x", "y", "z"] as const).map((axis) => (
              <div key={axis} className="flex gap-0.5">
                {([false, true] as const).map((positive) => (
                  <button
                    key={positive ? "+" : "-"}
                    type="button"
                    aria-label={`Move view along world ${axis.toUpperCase()} ${positive ? "positive" : "negative"}`}
                    title={`Move view on ${axis.toUpperCase()}`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => nudgeView(axis, positive)}
                    className="h-8 w-8 rounded-md border border-[#202733]/10 bg-white text-[11px] font-medium text-[#202733] hover:border-[#334155]/50 hover:text-[#334155]"
                  >
                    {axis.toUpperCase()}
                    {positive ? "+" : "−"}
                  </button>
                ))}
              </div>
            ))}
            <button
              type="button"
              title="Reset view (R)"
              aria-label="Reset 3D view"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={resetView}
              className="flex h-8 items-center gap-1.5 rounded-md border border-[#202733]/10 px-2 text-[11px] font-medium text-[#202733] hover:text-[#334155]"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span className="hidden lg:inline">Reset view</span>
            </button>
          </div>
          <p className="mt-1.5 hidden whitespace-nowrap text-center text-[9px] text-[#727b88] md:block">
            Drag: orbit · Right-drag: pan · WASD: move · Q/E: down/up
          </p>
        </nav>
      )}
      {props.placingDirectionTarget && (
        <div className="pointer-events-none absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-[#64748b]/40 bg-[#ffffff]/95 p-1.5 pl-3 text-xs font-semibold text-[#64748b] shadow-sm backdrop-blur">
          <span id="look-at-picker-instruction">
            {props.placingDirectionTargetMode === "look_away"
              ? "Click the point to look away from"
              : "Click the point to look at"}
          </span>
          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={props.onDirectionTargetCancel}
            className="pointer-events-auto h-7 rounded border border-[#202733]/15 px-2 text-[10px] text-[#202733]/65 transition hover:bg-[#202733]/[0.04] hover:text-[#202733] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#64748b]"
          >
            Cancel
          </button>
        </div>
      )}
      <Canvas
        className={`h-full w-full ${props.addingPivot || props.placingDirectionTarget ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}
        camera={{
          position: overviewHome.position,
          fov: OVERVIEW_FOV,
          near: 0.01,
          far: 1000,
        }}
        dpr={[1, 1.5]}
        gl={{ antialias: true }}
        onCreated={({ gl }) => gl.setClearColor(STUDIO_BACKGROUND)}
      >
        <CameraTrajectoryScene
          {...props}
          target={target}
          overviewHome={overviewHome}
          resetVersion={resetVersion}
          navigationKeys={navigationKeys}
          pendingAxisMove={pendingAxisMove}
        />
      </Canvas>
    </div>
  );
}

export function CameraPointCloudView({
  pose,
  view,
}: {
  pose: PosedView;
  view: CameraView;
}) {
  return (
    <Canvas
      className="pointer-events-none h-full w-full"
      camera={{
        position: view.position,
        fov: THREE.MathUtils.radToDeg(view.fovRadians),
        near: 0.01,
        far: 1000,
      }}
      dpr={[1, 1.5]}
      frameloop="demand"
      gl={{ antialias: false }}
      onCreated={({ gl }) => gl.setClearColor("#ffffff")}
    >
      <PosedPointCloud pose={pose} scaleMultiplier={0.7} />
      <CameraPointCloudViewCamera view={view} />
    </Canvas>
  );
}

function CameraPointCloudViewCamera({ view }: { view: CameraView }) {
  const camera = useThree((state) => state.camera);
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    if (!(camera instanceof THREE.PerspectiveCamera)) return;
    camera.position.set(...view.position);
    camera.quaternion.set(...view.quaternion);
    camera.fov = THREE.MathUtils.radToDeg(view.fovRadians);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    invalidate();
  }, [camera, invalidate, view]);

  return null;
}

function CameraTrajectoryScene({
  pose,
  referenceView,
  views,
  segments,
  selectedPivot,
  addingPivot,
  previewing,
  previewProgress,
  onPreviewProgress,
  disabled,
  frameCount,
  previewSeconds,
  frameWidth,
  frameHeight,
  directionMode,
  directionTarget,
  directionTargetCandidates,
  placingDirectionTarget,
  closedLoop,
  allowBelowFloor,
  onPreviewDone,
  onDrawingViewChange,
  onPointChange,
  onPointSelect,
  onPivotAdd,
  onDirectionTargetChange,
  onDirectionTargetMiss,
  target,
  overviewHome,
  resetVersion,
  navigationKeys,
  pendingAxisMove,
}: CameraTrajectoryCanvasProps & {
  target: [number, number, number];
  overviewHome: { position: [number, number, number] };
  resetVersion: number;
  navigationKeys: RefObject<Set<string>>;
  pendingAxisMove: RefObject<THREE.Vector3>;
}) {
  const inspecting = previewing || previewProgress !== null;
  const overviewCamera = useThree((state) => state.camera);
  const controls = useRef<OrbitControlsImpl>(null);
  const [draggingHandle, setDraggingHandle] = useState(false);
  const lastReportedQuaternion = useRef<THREE.Quaternion | null>(null);
  const navigationMovement = useRef(new THREE.Vector3()).current;
  const linePoints = useMemo(
    () =>
      sampleCameraPath(views, PATH_SAMPLES, {
        directionMode,
        directionTarget: directionTarget ?? pose.centroidWorld,
        closedLoop,
        allowBelowFloor,
      }).map((view) => view.position),
    [
      allowBelowFloor,
      closedLoop,
      directionMode,
      directionTarget,
      pose.centroidWorld,
      views,
    ],
  );
  const pivotViews = useMemo(
    () =>
      views.map((view, index) => ({
        ...view,
        ...sampleCameraPivot(views, index, {
          directionMode,
          directionTarget: directionTarget ?? pose.centroidWorld,
          closedLoop,
          allowBelowFloor,
        }),
      })),
    [
      views,
      directionMode,
      directionTarget,
      pose.centroidWorld,
      closedLoop,
      allowBelowFloor,
    ],
  );
  const partDirectionTargets = useMemo(
    () =>
      segments.flatMap((segment, index) =>
        segment.look_at_target
          ? [
              {
                key: `${segment.id}:${segment.look_at_target.join(":")}`,
                position: segment.look_at_target,
                label: `Part ${index + 1} target`,
              },
            ]
          : [],
      ),
    [segments],
  );
  const markerDepth = Math.max(
    0.12,
    new THREE.Vector3(...referenceView.position).distanceTo(
      new THREE.Vector3(...target),
    ) * 0.12,
  );

  // Switching to preview or picking must not leave held keys queued.
  useEffect(() => {
    if (
      !inspecting &&
      !addingPivot &&
      !placingDirectionTarget &&
      !draggingHandle
    )
      return;
    navigationKeys.current.clear();
    pendingAxisMove.current.set(0, 0, 0);
  }, [
    inspecting,
    addingPivot,
    placingDirectionTarget,
    draggingHandle,
    navigationKeys,
    pendingAxisMove,
  ]);

  useFrame((_, delta) => {
    const activeControls = controls.current;
    if (
      !activeControls ||
      inspecting ||
      draggingHandle ||
      addingPivot ||
      placingDirectionTarget
    ) {
      return;
    }

    const distance = activeControls.getDistance();
    let moved = false;
    const keys = navigationKeys.current;
    if (keys.size > 0) {
      const movement = viewerMovementFromKeys(
        keys,
        overviewCamera.quaternion,
        navigationMovement,
      );
      if (movement.lengthSq() > 0) {
        movement.multiplyScalar(viewerKeyStep(distance, delta));
        overviewCamera.position.add(movement);
        activeControls.target.add(movement);
        moved = true;
      }
    }
    if (pendingAxisMove.current.lengthSq() > 0) {
      const axisMove = consumePendingAxisMove(
        pendingAxisMove.current,
        distance,
        delta,
        navigationMovement,
      );
      overviewCamera.position.add(axisMove);
      activeControls.target.add(axisMove);
      moved = true;
    }
    if (moved) activeControls.update();
  });

  return (
    <>
      <OverviewCamera
        home={overviewHome}
        target={target}
        controls={controls}
        onDrawingViewChange={onDrawingViewChange}
      />

      {!inspecting && (
        <Grid
          args={[100, 100]}
          position={[0, -0.002, 0]}
          cellSize={1}
          cellThickness={0.65}
          cellColor="#dfe5ee"
          sectionSize={5}
          sectionThickness={1}
          sectionColor="#c3cedd"
          infiniteGrid
          fadeDistance={40}
          fadeStrength={2}
        />
      )}

      <PosedPointCloud pose={pose} scaleMultiplier={1} />

      {(directionMode === "look_at" || directionMode === "look_away") &&
        directionTarget &&
        !inspecting && (
          <DirectionTargetMarker
            position={directionTarget}
            label={directionMode === "look_at" ? "Look target" : "Away target"}
          />
        )}

      {!inspecting &&
        partDirectionTargets.map((partTarget) => (
          <DirectionTargetMarker
            key={partTarget.key}
            position={partTarget.position}
            label={partTarget.label}
          />
        ))}

      {placingDirectionTarget && (
        <DirectionTargetPicker
          candidates={directionTargetCandidates}
          onChange={onDirectionTargetChange}
          onMiss={onDirectionTargetMiss}
        />
      )}

      {!inspecting && linePoints.length >= 2 && (
        <>
          <Line
            points={linePoints}
            color={addingPivot ? PATH_ADDING_COLOR : PATH_COLOR}
            lineWidth={addingPivot ? 4 : 2.5}
            transparent
            opacity={addingPivot ? 1 : 0.9}
          />
          {addingPivot && (
            <Line
              points={linePoints}
              color="#ffffff"
              lineWidth={18}
              transparent
              opacity={0.001}
              onClick={(event) => {
                event.stopPropagation();
                const point = event.pointOnLine ?? event.point;
                const lineIndex = THREE.MathUtils.clamp(
                  event.faceIndex ?? 0,
                  0,
                  linePoints.length - 2,
                );
                const startProgress = cameraPathProgressAtFrame(
                  lineIndex,
                  PATH_SAMPLES,
                  views.length,
                  closedLoop,
                );
                const endProgress = cameraPathProgressAtFrame(
                  lineIndex + 1,
                  PATH_SAMPLES,
                  views.length,
                  closedLoop,
                );
                onPivotAdd(point.toArray(), (startProgress + endProgress) / 2);
              }}
            />
          )}
        </>
      )}

      {!inspecting && !placingDirectionTarget && (
        <TrajectoryHandles
          segments={segments}
          views={pivotViews}
          markerDepth={markerDepth}
          frameWidth={frameWidth}
          frameHeight={frameHeight}
          selectedPivot={selectedPivot}
          disabled={disabled || addingPivot}
          allowBelowFloor={allowBelowFloor}
          onChange={onPointChange}
          onSelect={onPointSelect}
          onDraggingChange={setDraggingHandle}
        />
      )}

      {!inspecting && (
        <>
          <FrustumObject
            camera={{
              intrinsics: frameIntrinsics(
                referenceView.fovRadians,
                frameWidth,
                frameHeight,
              ),
              extrinsics: {
                position: referenceView.position,
                quaternion: referenceView.quaternion,
              },
            }}
            color="#64748b"
            depth={markerDepth * 0.75}
            overlay
          />
          <Html
            position={referenceView.position}
            center
            zIndexRange={[20, 0]}
            className="pointer-events-none"
          >
            <div className="whitespace-nowrap rounded border border-[#64748b]/50 bg-[#ffffff]/90 px-2 py-1 text-[10px] font-semibold text-[#64748b] shadow-sm backdrop-blur">
              Source camera
            </div>
          </Html>
        </>
      )}

      {views.length >= 2 && (
        <PreviewCamera
          views={views}
          previewing={previewing}
          previewProgress={previewProgress}
          onPreviewProgress={onPreviewProgress}
          frameCount={frameCount}
          previewSeconds={previewSeconds}
          aspectRatio={frameWidth / frameHeight}
          directionMode={directionMode}
          directionTarget={directionTarget ?? pose.centroidWorld}
          closedLoop={closedLoop}
          allowBelowFloor={allowBelowFloor}
          onDone={onPreviewDone}
        />
      )}

      <OrbitControls
        key={resetVersion}
        ref={controls}
        makeDefault
        enabled={
          !inspecting &&
          !draggingHandle &&
          !addingPivot &&
          !placingDirectionTarget
        }
        target={target}
        enablePan
        screenSpacePanning
        enableDamping
        dampingFactor={0.08}
        maxPolarAngle={Math.PI - 0.01}
        onChange={() => {
          const previous = lastReportedQuaternion.current;
          if (
            previous &&
            1 - Math.abs(previous.dot(overviewCamera.quaternion)) < 1e-6
          ) {
            return;
          }
          lastReportedQuaternion.current = overviewCamera.quaternion.clone();
          onDrawingViewChange(
            cameraDrawingView(overviewCamera.quaternion.toArray()),
          );
        }}
      />
    </>
  );
}

function SelectedCameraDirection({
  view,
  depth,
  aspectRatio,
}: {
  view: CameraView;
  depth: number;
  aspectRatio: number;
}) {
  const outlineSegments = useMemo(() => {
    const halfHeight = Math.tan(view.fovRadians / 2) * depth;
    const halfWidth = halfHeight * aspectRatio;
    const apex: TrajectoryPoint = [0, 0, 0];
    const corners: TrajectoryPoint[] = [
      [-halfWidth, halfHeight, -depth],
      [halfWidth, halfHeight, -depth],
      [halfWidth, -halfHeight, -depth],
      [-halfWidth, -halfHeight, -depth],
    ];
    return [
      ...corners.map((corner) => [apex, corner] as const),
      [...corners, corners[0]!] as TrajectoryPoint[],
    ];
  }, [aspectRatio, depth, view.fovRadians]);

  return (
    <group
      name="selected-camera-direction"
      position={view.position}
      quaternion={view.quaternion}
    >
      {outlineSegments.map((points, index) => (
        <CameraDirectionStroke key={index} points={points} lineWidth={7} />
      ))}
      <CameraDirectionStroke
        points={[
          [0, 0, 0],
          [0, 0, -depth * 1.55],
        ]}
        lineWidth={10}
      />
      <mesh
        position={[0, 0, -depth * 1.58]}
        rotation={[-Math.PI / 2, 0, 0]}
        renderOrder={88}
        raycast={() => undefined}
      >
        <coneGeometry args={[depth * 0.18, depth * 0.38, 16]} />
        <meshBasicMaterial
          color={SELECTED_CAMERA_COLOR}
          transparent
          opacity={0.7}
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <mesh
        position={[0, 0, -depth * 1.58]}
        rotation={[-Math.PI / 2, 0, 0]}
        renderOrder={89}
        raycast={() => undefined}
      >
        <coneGeometry args={[depth * 0.115, depth * 0.3, 16]} />
        <meshBasicMaterial
          color={SELECTED_CAMERA_OUTLINE}
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

function DirectionTargetPicker({
  candidates,
  onChange,
  onMiss,
}: {
  candidates: readonly TrajectoryPoint[];
  onChange: (position: TrajectoryPoint) => void;
  onMiss: () => void;
}) {
  const plane = useRef<THREE.Mesh>(null);
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const forward = useRef(new THREE.Vector3()).current;

  useEffect(() => {
    const chooseCenterTarget = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (
        !(event.target instanceof HTMLElement) ||
        event.target.dataset.lookAtPicker !== "picking"
      ) {
        return;
      }
      event.preventDefault();
      camera.getWorldDirection(forward);
      const closest = closestDirectionTarget(
        candidates,
        new THREE.Ray(camera.position.clone(), forward.clone()),
      );
      if (closest) onChange(closest);
      else onMiss();
    };
    window.addEventListener("keydown", chooseCenterTarget);
    return () => window.removeEventListener("keydown", chooseCenterTarget);
  }, [camera, candidates, forward, onChange, onMiss]);

  useFrame(() => {
    if (!plane.current || !(camera instanceof THREE.PerspectiveCamera)) return;
    const distance = Math.max(camera.near * 4, 0.1);
    camera.getWorldDirection(forward);
    plane.current.position
      .copy(camera.position)
      .addScaledVector(forward, distance);
    plane.current.quaternion.copy(camera.quaternion);
    const height =
      2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    plane.current.scale.set(
      height * (size.width / size.height) * 1.1,
      height * 1.1,
      1,
    );
  });

  function chooseTarget(event: ThreeEvent<PointerEvent>) {
    if (event.button !== 0) return;
    event.stopPropagation();
    const closest = closestDirectionTarget(candidates, event.ray);
    if (!closest) {
      onMiss();
      return;
    }
    onChange(closest);
  }

  return (
    <mesh ref={plane} renderOrder={1000} onPointerDown={chooseTarget}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial
        transparent
        opacity={0}
        depthTest={false}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}

function closestDirectionTarget(
  candidates: readonly TrajectoryPoint[],
  ray: THREE.Ray,
): TrajectoryPoint | null {
  let closest: TrajectoryPoint | null = null;
  let closestAngle = Infinity;
  let closestDepth = Infinity;
  const candidateVector = new THREE.Vector3();
  const offset = new THREE.Vector3();
  for (const candidate of candidates) {
    candidateVector.set(...candidate);
    const depth = offset
      .copy(candidateVector)
      .sub(ray.origin)
      .dot(ray.direction);
    if (depth <= 0) continue;
    const angle = Math.sqrt(ray.distanceSqToPoint(candidateVector)) / depth;
    if (
      angle < closestAngle - 0.002 ||
      (Math.abs(angle - closestAngle) <= 0.002 && depth < closestDepth)
    ) {
      closest = candidate;
      closestAngle = angle;
      closestDepth = depth;
    }
  }
  return closest && closestAngle <= 0.075
    ? ([...closest] as TrajectoryPoint)
    : null;
}

function DirectionTargetMarker({
  position,
  label,
}: {
  position: TrajectoryPoint;
  label: string;
}) {
  const group = useRef<THREE.Group>(null);
  const camera = useThree((state) => state.camera);
  const viewportHeight = useThree((state) => state.size.height);

  useFrame(() => {
    if (!group.current || !(camera instanceof THREE.PerspectiveCamera)) return;
    const distance = camera.position.distanceTo(group.current.position);
    const worldHeight =
      2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    group.current.scale.setScalar((worldHeight * 15) / viewportHeight);
    group.current.quaternion.copy(camera.quaternion);
  });

  return (
    <group
      ref={group}
      position={position}
      renderOrder={95}
      userData={{ cameraLookTarget: true }}
    >
      <mesh raycast={() => undefined}>
        <ringGeometry args={[0.3, 0.45, 32]} />
        <meshBasicMaterial
          color="#64748b"
          transparent
          opacity={0.95}
          side={THREE.DoubleSide}
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <Line
        points={[
          [-0.62, 0, 0],
          [0.62, 0, 0],
        ]}
        color="#64748b"
        lineWidth={4}
        depthTest={false}
        raycast={() => undefined}
      />
      <Line
        points={[
          [0, -0.62, 0],
          [0, 0.62, 0],
        ]}
        color="#64748b"
        lineWidth={4}
        depthTest={false}
        raycast={() => undefined}
      />
      <Html
        position={[0, 0.9, 0]}
        center
        zIndexRange={[30, 0]}
        className="pointer-events-none"
      >
        <div
          data-camera-look-target="set"
          className="whitespace-nowrap rounded border border-[#64748b]/50 bg-[#ffffff]/95 px-2 py-1 text-[9px] font-semibold tracking-[0.02em] text-[#64748b] shadow-sm backdrop-blur"
        >
          {label}
        </div>
      </Html>
    </group>
  );
}

function CameraDirectionStroke({
  points,
  lineWidth,
}: {
  points: readonly TrajectoryPoint[];
  lineWidth: number;
}) {
  return (
    <>
      <Line
        points={[...points]}
        color={SELECTED_CAMERA_COLOR}
        lineWidth={lineWidth + 5}
        transparent
        opacity={0.7}
        depthTest={false}
        depthWrite={false}
        toneMapped={false}
        renderOrder={88}
        raycast={() => undefined}
      />
      <Line
        points={[...points]}
        color={SELECTED_CAMERA_OUTLINE}
        lineWidth={lineWidth}
        depthTest={false}
        depthWrite={false}
        toneMapped={false}
        renderOrder={89}
        raycast={() => undefined}
      />
    </>
  );
}

function TrajectoryHandles({
  segments,
  views,
  markerDepth,
  frameWidth,
  frameHeight,
  selectedPivot,
  disabled,
  allowBelowFloor,
  onChange,
  onSelect,
  onDraggingChange,
}: {
  segments: readonly TrajectorySegment[];
  views: readonly CameraView[];
  markerDepth: number;
  frameWidth: number;
  frameHeight: number;
  selectedPivot: { segmentId: string; pointIndex: number } | null;
  disabled: boolean;
  allowBelowFloor: boolean;
  onChange: (
    segmentId: string,
    pointIndex: number,
    position: TrajectoryPoint,
  ) => void;
  onSelect: (
    segmentId: string,
    pointIndex: number,
    pivotNumber: number,
  ) => void;
  onDraggingChange: (dragging: boolean) => void;
}) {
  const handles = trajectoryPivotsFromSegments(segments);

  return handles.map((handle) => (
    <TrajectoryHandle
      key={`${handle.segmentId}:${handle.pointIndex}`}
      position={handle.position}
      view={views[handle.pivotNumber - 1]!}
      markerDepth={markerDepth}
      frameWidth={frameWidth}
      frameHeight={frameHeight}
      pivotNumber={handle.pivotNumber}
      selected={
        handle.segmentId === selectedPivot?.segmentId &&
        handle.pointIndex === selectedPivot.pointIndex
      }
      hasCameraAngle={handle.hasCameraAngle}
      disabled={disabled}
      allowBelowFloor={allowBelowFloor}
      onChange={(nextPosition) =>
        onChange(handle.segmentId, handle.pointIndex, nextPosition)
      }
      onSelect={() =>
        onSelect(handle.segmentId, handle.pointIndex, handle.pivotNumber)
      }
      onDraggingChange={onDraggingChange}
    />
  ));
}

function TrajectoryHandle({
  position,
  view,
  markerDepth,
  frameWidth,
  frameHeight,
  pivotNumber,
  selected,
  hasCameraAngle,
  disabled,
  allowBelowFloor,
  onChange,
  onSelect,
  onDraggingChange,
}: {
  position: TrajectoryPoint;
  view: CameraView;
  markerDepth: number;
  frameWidth: number;
  frameHeight: number;
  pivotNumber: number;
  selected: boolean;
  hasCameraAngle: boolean;
  disabled: boolean;
  allowBelowFloor: boolean;
  onChange: (position: TrajectoryPoint) => void;
  onSelect: () => void;
  onDraggingChange: (dragging: boolean) => void;
}) {
  const group = useRef<THREE.Group>(null);
  const orbitControls = useThree(
    (state) => state.controls,
  ) as OrbitControlsImpl | null;
  const canvas = useThree((state) => state.gl.domElement);
  const camera = useThree((state) => state.camera);
  const viewportHeight = useThree((state) => state.size.height);
  const hitDepth = markerDepth * (selected ? 2.65 : 1);
  const hitHeight =
    2 * Math.tan(view.fovRadians / 2) * markerDepth * (selected ? 1.65 : 1);

  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    pointerId: number;
    plane: THREE.Plane;
    grabOffset: THREE.Vector3;
    startPosition: TrajectoryPoint;
  } | null>(null);

  useFrame(() => {
    if (!group.current || !(camera instanceof THREE.PerspectiveCamera)) return;
    const distance = camera.position.distanceTo(new THREE.Vector3(...position));
    const worldHeight =
      2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    group.current.scale.setScalar((worldHeight * 10) / viewportHeight);
  });

  useEffect(
    () => () => {
      if (drag.current) onDraggingChange(false);
      canvas.style.cursor = "";
    },
    [canvas, onDraggingChange],
  );

  function startDrag(event: ThreeEvent<PointerEvent>) {
    if (disabled || event.button !== 0 || drag.current) return;
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();
    if (orbitControls) orbitControls.enabled = false;
    onSelect();

    const worldPosition = new THREE.Vector3(...position);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      event.camera.getWorldDirection(new THREE.Vector3()),
      worldPosition,
    );
    const intersection = event.ray.intersectPlane(plane, new THREE.Vector3());
    if (!intersection) {
      if (orbitControls) orbitControls.enabled = true;
      return;
    }

    (event.target as Element).setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      plane,
      grabOffset: intersection.sub(worldPosition),
      startPosition: [...position],
    };
    canvas.style.cursor = "grabbing";
    setDragging(true);
    onDraggingChange(true);
  }

  function continueDrag(event: ThreeEvent<PointerEvent>) {
    const activeDrag = drag.current;
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const intersection = event.ray.intersectPlane(
      activeDrag.plane,
      new THREE.Vector3(),
    );
    if (!intersection) return;
    intersection.sub(activeDrag.grabOffset);
    if (!allowBelowFloor) {
      intersection.y = Math.max(TRAJECTORY_FLOOR_Y, intersection.y);
    }
    onChange(intersection.toArray());
  }

  function finishDrag(event: ThreeEvent<PointerEvent>) {
    const activeDrag = drag.current;
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    drag.current = null;
    setDragging(false);
    onDraggingChange(false);
    if (orbitControls) orbitControls.enabled = true;
    canvas.style.cursor = hovered ? "grab" : "";
    const target = event.target as Element;
    if (target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }
  }

  function cancelDrag(event: ThreeEvent<PointerEvent>) {
    const activeDrag = drag.current;
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
    onChange(activeDrag.startPosition);
    finishDrag(event);
  }

  return (
    <group
      position={position}
      renderOrder={100}
      onPointerDown={startDrag}
      onPointerMove={continueDrag}
      onPointerUp={finishDrag}
      onPointerCancel={cancelDrag}
      onLostPointerCapture={cancelDrag}
      onPointerOver={(event) => {
        event.stopPropagation();
        setHovered(true);
        if (!drag.current) canvas.style.cursor = "grab";
      }}
      onPointerOut={() => {
        setHovered(false);
        if (!drag.current) canvas.style.cursor = "";
      }}
    >
      <group quaternion={view.quaternion}>
        <FrustumObject
          camera={{
            intrinsics: frameIntrinsics(
              view.fovRadians,
              frameWidth,
              frameHeight,
            ),
            extrinsics: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
          }}
          color={selected ? SELECTED_CAMERA_COLOR : HANDLE_COLOR}
          depth={markerDepth}
          overlay
          markers={false}
        />
        <mesh position={[0, 0, -hitDepth / 2]}>
          <boxGeometry
            args={[(hitHeight * frameWidth) / frameHeight, hitHeight, hitDepth]}
          />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      </group>
      {selected && (
        <SelectedCameraDirection
          view={{ ...view, position: [0, 0, 0] }}
          depth={markerDepth * 1.65}
          aspectRatio={frameWidth / frameHeight}
        />
      )}
      <group ref={group}>
        <mesh>
          <sphereGeometry args={[1, 24, 16]} />
          <meshBasicMaterial
            color={dragging || hovered || selected ? "#ffffff" : HANDLE_COLOR}
            depthTest={false}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
        <mesh>
          <sphereGeometry args={[2.5, 16, 12]} />
          <meshBasicMaterial
            transparent
            opacity={0}
            depthTest={false}
            depthWrite={false}
          />
        </mesh>
        <Html center zIndexRange={[30, 0]} className="pointer-events-none">
          <span
            data-camera-handle={pivotNumber}
            data-camera-selected={selected}
            data-camera-position={position.join(",")}
            data-camera-angle={hasCameraAngle ? "set" : "unset"}
            className={`grid h-5 w-5 place-items-center rounded-full border text-[10px] font-bold shadow-sm transition ${
              dragging || hovered
                ? "border-[#202733] bg-white text-[#202733]"
                : selected
                  ? "border-[#202733] bg-white text-[#202733]"
                  : "border-[#94a3b8] bg-[#94a3b8] text-[#1e293b]"
            } ${hasCameraAngle ? "ring-2 ring-[#1e293b]/70 ring-offset-1 ring-offset-[#ffffff]" : ""}`}
          >
            {pivotNumber}
          </span>
        </Html>
      </group>
    </group>
  );
}

function OverviewCamera({
  home,
  target,
  controls,
  onDrawingViewChange,
}: {
  home: { position: [number, number, number] };
  target: [number, number, number];
  controls: RefObject<OrbitControlsImpl | null>;
  onDrawingViewChange: (view: TrajectoryDrawingView) => void;
}) {
  const camera = useRef(useThree((state) => state.camera)).current;

  useEffect(() => {
    camera.position.set(...home.position);
    camera.lookAt(...target);
    if (controls.current) {
      controls.current.target.set(...target);
      controls.current.update();
    }
    camera.updateMatrixWorld();
    onDrawingViewChange(cameraDrawingView(camera.quaternion.toArray()));
  }, [camera, controls, home, onDrawingViewChange, target]);

  return null;
}

function applySampleToCamera(
  camera: THREE.PerspectiveCamera,
  samples: readonly SampledCameraView[],
  progress: number,
) {
  const index = THREE.MathUtils.clamp(
    Math.floor(THREE.MathUtils.clamp(progress, 0, 1) * samples.length),
    0,
    samples.length - 1,
  );
  const sample = samples[index]!;
  camera.position.set(...sample.position);
  camera.quaternion.set(...sample.quaternion);
  camera.fov = THREE.MathUtils.radToDeg(sample.fovRadians);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

function PreviewCamera({
  views,
  previewing,
  previewProgress,
  onPreviewProgress,
  frameCount,
  previewSeconds,
  aspectRatio,
  directionMode,
  directionTarget,
  closedLoop,
  allowBelowFloor,
  onDone,
}: {
  views: readonly CameraView[];
  previewing: boolean;
  previewProgress: number | null;
  onPreviewProgress: (progress: number) => void;
  frameCount: number;
  previewSeconds: number;
  aspectRatio: number;
  directionMode: CameraDirectionMode;
  directionTarget: TrajectoryPoint;
  closedLoop: boolean;
  allowBelowFloor: boolean;
  onDone: () => void;
}) {
  const previewCamera = useRef<THREE.PerspectiveCamera>(null);
  const samples = useMemo(
    () =>
      sampleCameraPath(views, frameCount, {
        directionMode,
        directionTarget,
        closedLoop,
        allowBelowFloor,
      }),
    [
      allowBelowFloor,
      closedLoop,
      directionMode,
      directionTarget,
      frameCount,
      views,
    ],
  );
  const startedAt = useRef<number | null>(null);
  const finished = useRef(false);
  const lastReportedAt = useRef(-Infinity);

  useEffect(() => {
    startedAt.current = null;
    finished.current = false;
    lastReportedAt.current = -Infinity;
  }, [previewing]);

  // While paused on a scrub position, keep the camera pinned to that sample.
  useEffect(() => {
    if (previewing || previewProgress === null || !previewCamera.current)
      return;
    applySampleToCamera(previewCamera.current, samples, previewProgress);
  }, [previewProgress, previewing, samples]);

  useFrame(({ clock }) => {
    if (!previewing || samples.length === 0 || !previewCamera.current) return;
    // Playback finished: hold the final frame until inspection is exited.
    if (finished.current) return;
    startedAt.current ??=
      clock.elapsedTime - (previewProgress ?? 0) * previewSeconds;
    const progress = Math.min(
      (clock.elapsedTime - startedAt.current) / previewSeconds,
      1,
    );
    applySampleToCamera(previewCamera.current, samples, progress);
    if (
      progress === 1 ||
      clock.elapsedTime - lastReportedAt.current >=
        PREVIEW_PROGRESS_REPORT_INTERVAL
    ) {
      lastReportedAt.current = clock.elapsedTime;
      onPreviewProgress(progress);
    }
    if (progress === 1) {
      finished.current = true;
      onDone();
    }
  });

  return (
    <PerspectiveCamera
      ref={previewCamera}
      makeDefault={previewing || previewProgress !== null}
      fov={THREE.MathUtils.radToDeg(views[0]!.fovRadians)}
      aspect={aspectRatio}
      near={0.01}
      far={1000}
    />
  );
}

function frameIntrinsics(
  fovRadians: number,
  frameWidth: number,
  frameHeight: number,
) {
  return createIntrinsicsFromFov(
    THREE.MathUtils.radToDeg(fovRadians),
    frameWidth,
    frameHeight,
  );
}

function buildOverviewPosition(
  referencePosition: [number, number, number],
  targetPosition: [number, number, number],
  segments: readonly TrajectorySegment[],
): [number, number, number] {
  const target = new THREE.Vector3(...targetPosition);
  const radial = new THREE.Vector3(...referencePosition).sub(target);
  const referenceDistance = Math.max(radial.length(), 1);
  const pathRadius = Math.max(
    0,
    ...segments.flatMap((segment) =>
      segment.points.map((point) =>
        new THREE.Vector3(...point).distanceTo(target),
      ),
    ),
  );
  const direction = isometricViewDirection(
    referencePosition,
    targetPosition,
    new THREE.Vector3(),
  );
  // Preserve the overview framing with a narrower lens for flatter depth.
  const lensScale =
    Math.tan(THREE.MathUtils.degToRad(25)) /
    Math.tan(THREE.MathUtils.degToRad(OVERVIEW_FOV / 2));
  return target
    .addScaledVector(
      direction,
      Math.max(referenceDistance * 1.15, pathRadius * 2.5) * lensScale,
    )
    .toArray();
}

function PosedPointCloud({
  pose,
  scaleMultiplier,
}: {
  pose: PosedView;
  scaleMultiplier: number;
}) {
  const { pointGeometry, surfaceGeometry } = useMemo(() => {
    // Both geometries reference the same position/color buffers; nothing
    // large is copied.
    const position = new THREE.BufferAttribute(pose.points.positions, 3);
    const color = new THREE.BufferAttribute(pose.points.colors, 3);
    const pointGeometry = new THREE.BufferGeometry();
    pointGeometry.setAttribute("position", position);
    pointGeometry.setAttribute("color", color);

    const surface = pose.points;
    let surfaceGeometry: THREE.BufferGeometry | null = null;
    if (surface.indices.length) {
      surfaceGeometry = new THREE.BufferGeometry();
      surfaceGeometry.setAttribute("position", position);
      surfaceGeometry.setAttribute(
        "uv",
        new THREE.BufferAttribute(surface.uvs, 2),
      );
      surfaceGeometry.setIndex(new THREE.BufferAttribute(surface.indices, 1));
    }
    return { pointGeometry, surfaceGeometry };
  }, [pose]);

  useEffect(
    () => () => {
      pointGeometry.dispose();
      surfaceGeometry?.dispose();
    },
    [pointGeometry, surfaceGeometry],
  );

  return (
    <group
      position={pose.camera.extrinsics.position}
      quaternion={pose.camera.extrinsics.quaternion}
    >
      {/* Colored points stay visible for mesh edges and unmeshed areas; the
          surface is biased back so coincident points win the depth test. */}
      <points geometry={pointGeometry}>
        <pointsMaterial
          vertexColors
          size={pose.points.pointSize * scaleMultiplier}
          sizeAttenuation
          toneMapped={false}
        />
      </points>
      {surfaceGeometry && (
        <Suspense fallback={null}>
          <PosedSurface geometry={surfaceGeometry} imageUrl={pose.imageUrl} />
        </Suspense>
      )}
    </group>
  );
}

function PosedSurface({
  geometry,
  imageUrl,
}: {
  geometry: THREE.BufferGeometry;
  imageUrl: string;
}) {
  const texture = useTexture(imageUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  return (
    <mesh geometry={geometry} raycast={() => null}>
      <meshBasicMaterial
        map={texture}
        side={THREE.DoubleSide}
        toneMapped={false}
        polygonOffset
        polygonOffsetFactor={1}
        polygonOffsetUnits={1}
      />
    </mesh>
  );
}
