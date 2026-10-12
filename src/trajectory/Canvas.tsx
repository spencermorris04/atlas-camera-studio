import {
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

const PATH_SAMPLES = 101;
const PATH_COLOR = "#347f78";
const PATH_ADDING_COLOR = "#70a99e";
const HANDLE_COLOR = "#70a99e";
const SELECTED_CAMERA_TEAL = "#286c66";
const SELECTED_CAMERA_DARK_TEAL = "#21423d";
const STUDIO_BACKGROUND = "#eeece5";
const PREVIEW_PROGRESS_REPORT_INTERVAL = 1 / 12;
const VIEWER_KEYS = new Set(["w", "a", "s", "d"]);

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
  const viewer = useRef<HTMLDivElement>(null);
  const navigationKeys = useRef(new Set<string>());
  const target = useMemo(
    () => cameraPathTarget(referenceView, pose.centroidWorld),
    [pose.centroidWorld, referenceView],
  );
  const [overviewHome, setOverviewHome] = useState(() => ({
    position: buildOverviewPosition(referenceView.position, target, segments),
  }));

  useEffect(() => {
    const clearKeys = () => navigationKeys.current.clear();
    window.addEventListener("blur", clearKeys);
    return () => window.removeEventListener("blur", clearKeys);
  }, []);

  useEffect(() => {
    if (!props.placingDirectionTarget) return;
    navigationKeys.current.clear();
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
    if (!VIEWER_KEYS.has(key)) return;
    event.preventDefault();
    if (pressed) navigationKeys.current.add(key);
    else navigationKeys.current.delete(key);
  }

  return (
    <div
      ref={viewer}
      role="application"
      tabIndex={0}
      aria-label="3D camera path viewer. Drag a camera to move it; drag empty space to rotate. Delete removes the selected camera. Use W A S D to move."
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
      className={`relative h-full w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#70a99e]/60 ${props.placingDirectionTarget ? "cursor-crosshair" : ""}`}
      onPointerDown={(event) =>
        event.currentTarget.focus({ preventScroll: true })
      }
      onKeyDown={(event) => updateNavigationKey(event, true)}
      onKeyUp={(event) => updateNavigationKey(event, false)}
      onBlur={() => navigationKeys.current.clear()}
    >
      {!inspecting && !props.placingDirectionTarget && (
        <button
          type="button"
          title="Reset 3D view"
          aria-label="Reset 3D view"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            navigationKeys.current.clear();
            setOverviewHome({
              position: buildOverviewPosition(
                referenceView.position,
                target,
                segments,
              ),
            });
          }}
          className="absolute left-1/2 top-3 z-30 flex h-9 -translate-x-1/2 items-center gap-1.5 rounded-md border border-[#263238]/15 bg-[#fffefa]/90 px-3 text-[11px] font-semibold tracking-[0.02em] text-[#263238]/65 shadow-lg backdrop-blur transition hover:border-[#263238]/30 hover:bg-[#fffefa] hover:text-[#263238] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#70a99e] active:translate-y-px"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset view
        </button>
      )}
      {props.placingDirectionTarget && (
        <div className="pointer-events-none absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-[#96713d]/40 bg-[#fffefa]/95 p-1.5 pl-3 text-xs font-semibold text-[#96713d] shadow-xl backdrop-blur">
          <span id="look-at-picker-instruction">
            {props.placingDirectionTargetMode === "look_away"
              ? "Click the point to look away from"
              : "Click the point to look at"}
          </span>
          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={props.onDirectionTargetCancel}
            className="pointer-events-auto h-7 rounded border border-[#263238]/15 px-2 text-[10px] text-[#263238]/65 transition hover:bg-[#263238]/[0.04] hover:text-[#263238] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#96713d]"
          >
            Cancel
          </button>
        </div>
      )}
      <Canvas
        className={`h-full w-full ${props.addingPivot || props.placingDirectionTarget ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}
        camera={{
          position: overviewHome.position,
          fov: 50,
          near: 0.01,
          far: 1000,
        }}
        dpr={[1, 1.5]}
        gl={{ antialias: false }}
        onCreated={({ gl }) => gl.setClearColor(STUDIO_BACKGROUND)}
      >
        <CameraTrajectoryScene
          {...props}
          target={target}
          overviewHome={overviewHome}
          navigationKeys={navigationKeys}
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
      onCreated={({ gl }) => gl.setClearColor("#eeece5")}
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
  navigationKeys,
}: CameraTrajectoryCanvasProps & {
  target: [number, number, number];
  overviewHome: { position: [number, number, number] };
  navigationKeys: RefObject<Set<string>>;
}) {
  const inspecting = previewing || previewProgress !== null;
  const overviewCamera = useThree((state) => state.camera);
  const controls = useRef<OrbitControlsImpl>(null);
  const [draggingHandle, setDraggingHandle] = useState(false);
  const lastReportedQuaternion = useRef<THREE.Quaternion | null>(null);
  const navigationForward = useRef(new THREE.Vector3()).current;
  const navigationRight = useRef(new THREE.Vector3()).current;
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

  useFrame((_, delta) => {
    const activeControls = controls.current;
    const keys = navigationKeys.current;
    if (
      !activeControls ||
      inspecting ||
      draggingHandle ||
      addingPivot ||
      placingDirectionTarget ||
      keys.size === 0
    ) {
      return;
    }

    navigationForward.set(0, 0, -1).applyQuaternion(overviewCamera.quaternion);
    navigationForward.y = 0;
    if (navigationForward.lengthSq() < 1e-8) {
      navigationForward.set(0, 1, 0).applyQuaternion(overviewCamera.quaternion);
      navigationForward.y = 0;
    }
    navigationRight.set(1, 0, 0).applyQuaternion(overviewCamera.quaternion);
    navigationRight.y = 0;
    if (
      navigationForward.lengthSq() < 1e-8 ||
      navigationRight.lengthSq() < 1e-8
    ) {
      return;
    }
    navigationForward.normalize();
    navigationRight.normalize();
    navigationMovement.set(0, 0, 0);
    if (keys.has("w")) navigationMovement.add(navigationForward);
    if (keys.has("s")) navigationMovement.sub(navigationForward);
    if (keys.has("d")) navigationMovement.add(navigationRight);
    if (keys.has("a")) navigationMovement.sub(navigationRight);
    if (navigationMovement.lengthSq() === 0) return;

    navigationMovement
      .normalize()
      .multiplyScalar(
        Math.max(activeControls.getDistance(), 1) * 0.8 * Math.min(delta, 0.1),
      );
    overviewCamera.position.add(navigationMovement);
    activeControls.target.add(navigationMovement);
    activeControls.update();
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
          cellSize={0.5}
          cellThickness={0.5}
          cellColor="#d9ddd7"
          sectionSize={2.5}
          sectionThickness={0.8}
          sectionColor="#c2c9c2"
          infiniteGrid
          fadeDistance={30}
          fadeStrength={1.5}
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
            color="#96713d"
            depth={markerDepth * 0.75}
            overlay
          />
          <Html
            position={referenceView.position}
            center
            zIndexRange={[20, 0]}
            className="pointer-events-none"
          >
            <div className="whitespace-nowrap rounded border border-[#96713d]/50 bg-[#fffefa]/90 px-2 py-1 text-[10px] font-semibold text-[#96713d] shadow-lg backdrop-blur">
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
        ref={controls}
        makeDefault
        enabled={
          !inspecting &&
          !draggingHandle &&
          !addingPivot &&
          !placingDirectionTarget
        }
        target={target}
        enablePan={false}
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
          color={SELECTED_CAMERA_TEAL}
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
          color={SELECTED_CAMERA_DARK_TEAL}
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
          color="#96713d"
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
        color="#96713d"
        lineWidth={4}
        depthTest={false}
        raycast={() => undefined}
      />
      <Line
        points={[
          [0, -0.62, 0],
          [0, 0.62, 0],
        ]}
        color="#96713d"
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
          className="whitespace-nowrap rounded border border-[#96713d]/50 bg-[#fffefa]/95 px-2 py-1 text-[9px] font-semibold tracking-[0.02em] text-[#96713d] shadow-lg backdrop-blur"
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
        color={SELECTED_CAMERA_TEAL}
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
        color={SELECTED_CAMERA_DARK_TEAL}
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
          color={selected ? SELECTED_CAMERA_TEAL : HANDLE_COLOR}
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
            color={dragging || hovered || selected ? "#f7f5ef" : HANDLE_COLOR}
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
            className={`grid h-5 w-5 place-items-center rounded-full border text-[10px] font-bold shadow-lg transition ${
              dragging || hovered
                ? "border-[#263238] bg-white text-[#263238]"
                : selected
                  ? "border-[#263238] bg-white text-[#263238]"
                  : "border-[#70a99e] bg-[#70a99e] text-[#21423d]"
            } ${hasCameraAngle ? "ring-2 ring-[#286c66]/70 ring-offset-1 ring-offset-[#eeece5]" : ""}`}
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
  radial.normalize();
  const side = new THREE.Vector3().crossVectors(
    radial,
    new THREE.Vector3(0, 1, 0),
  );
  if (side.lengthSq() < 1e-5) side.set(1, 0, 0);
  side.normalize();
  const direction = radial
    .multiplyScalar(1.05)
    .addScaledVector(side, 0.35)
    .addScaledVector(new THREE.Vector3(0, 1, 0), 0.25)
    .normalize();
  return target
    .addScaledVector(
      direction,
      Math.max(referenceDistance * 1.15, pathRadius * 2.5),
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
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.BufferAttribute(pose.points.positions, 3),
    );
    g.setAttribute("color", new THREE.BufferAttribute(pose.points.colors, 3));
    return g;
  }, [pose]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <group
      position={pose.camera.extrinsics.position}
      quaternion={pose.camera.extrinsics.quaternion}
    >
      <points geometry={geometry}>
        <pointsMaterial
          vertexColors
          size={pose.points.pointSize * scaleMultiplier}
          sizeAttenuation
          toneMapped={false}
        />
      </points>
    </group>
  );
}
