# Atlas Camera Studio

[Try the hosted app](https://camera.wlt-ai.art) · [Explore an example — no signup](https://camera.wlt-ai.art/?example=igloo) · [Join the API beta waitlist](https://form.typeform.com/to/zHFR4r3A) · [API quickstart](https://atlas-beta.worldlabs.ai/docs/quickstart)

Turn a still image into a camera-controlled shot with the Marble 5 API. Upload a photo, reconstruct its depth, choose a camera path, and generate a four-second MP4.

Based on the original camera-trajectory editor created by [Gowthami Somepalli (@somepago)](https://github.com/somepago) at World Labs.

This repository contains the complete React editor, Express server, camera math, job runner, and optional hosted-demo billing. The local version uses your own API key. Hosted mode adds Clerk phone verification and one-time Stripe credit packs; there is no Metronome dependency.

![Draw and aim a camera path in the 3D editor](docs/editor-light.png)

## Example videos

Two camera-controlled videos shared by Jos. Click a preview to open the full MP4; the original files are included in [`examples/`](examples/).

### Original camera demo

[![Generated camera move around a group seated indoors](examples/original-camera-demo.gif)](examples/original-camera-demo.mp4)

The video from Jos's [“what did Ilya see?” post](https://x.com/JosvdWest/status/2094859846982275213). This earlier demo is supplied at 2560 × 1440, 30 FPS, four seconds. [Download MP4](https://github.com/worldlabsai/atlas-camera-studio/raw/refs/heads/main/examples/original-camera-demo.mp4).

### Holographic fish orbit

[![Camera orbit around holographic fish above a city](examples/holographic-fish-orbit.gif)](examples/holographic-fish-orbit.mp4)

Prompt: **“camera orbits around holographic fish”**. Generated with Camera Studio: 1280 × 720, 48 frames at 12 FPS, seed 42. [Download MP4](https://github.com/worldlabsai/atlas-camera-studio/raw/refs/heads/main/examples/holographic-fish-orbit.mp4).

The current app produces four-second videos at 12 FPS. These are output examples; the original source images and saved camera paths are not included.

## Explore without signing up

Choose **Explore an example** to open a prepared igloo scene with an editable camera path. Move or delete cameras, aim them, smooth the path, and preview the move without an account or API key. The public image, EXR depth, and camera metadata are bundled in [`public/example/`](public/example/); no API task runs while you explore.

On the hosted app, sign in and verify a phone number when you want to **Queue video** or prepare your own image. Your example edits stay in the tab through sign-in. Generating the example uses the same credits and limits as any other video. A local fork sends the bundled scene with your own API key; it does not depend on our private asset IDs.

## Run locally

You need Node.js 22.12+ (Node 24 recommended), FFmpeg on your PATH, and an API-enabled World Labs beta account.

1. Clone this repository and run `npm ci`.
2. Copy `.env.example` to `.env`.
3. Add your project API key as `WLT_API_KEY`.
4. Run `npm run build && npm start`.
5. Open [localhost:3030](http://localhost:3030), upload a JPG, PNG or WebP, to prepare its 3D scene.

The editor crops inputs to 16:9. Rotate the scene, draw a camera path on the map, adjust camera direction, and preview the move before choosing **Queue video**. Each video contains 48 frames at 12 FPS. MP4 encoding runs locally using FFmpeg.

Drag a camera or its numbered point in the 3D view to move it; drag empty space to rotate the scene. Use **Smooth path** to soften bends, and find **Look at point** below Yaw and Pitch. **Delete/Backspace** removes the selected camera. **Cmd/Ctrl-Z** undoes an edit; **Cmd/Ctrl-Shift-Z** redoes it. Each drag or drawn stroke is one undo step.

**Saved** contains drafts, generations, and favorites. Drafts are saved in this browser, separately for each signed-in account (up to 30 drafts), and need their source scene to remain available. Generated videos and scene data expire after seven days; download videos you want to keep.

For development, run `npm run dev` and `npx vite` in separate terminals. The Vite app proxies API requests to port 3030.

## Camera planning controls

The editor uses a compact white workspace with Path, Camera, and Video tabs in one collapsible sidebar. The 3D cloud and drawing map use colors sampled from the reference image, with sRGB colors converted to linear values for Three.js rendering.

Choose **Push in**, **Pull back**, **Truck right**, or **Orbit left** to replace the current path with five editable cameras. **Travel** controls the amount used by the next preset, relative to the subject distance. Presets start at the source camera; orbit cameras aim at the scene center. Undo restores your previous path.

Use the timeline to scrub, play, or pause. Playback appears in the bottom-right camera inset while the overview and editing controls remain usable. Click the inset to expand it; Escape restores its size. **Stop preview** returns the inset to the selected camera. Preview uses the same camera samples as generation and holds the final frame when playback finishes.

Select a camera to open its properties. Drag the X/Y/Z labels to scrub position values, hold Shift for finer movement, or type a value and press Enter. Y stays above the floor unless **Allow below floor** is enabled. Selection darkens the model without enlarging it. Camera models keep a stable screen size as you zoom, and nearby number labels are spaced apart. The reference camera has a dashed outline and a separate Source label.

The Video tab contains the FOV and prompt. Playback and generation controls share a compact bottom row, and the path map scales to the available height. [See the compact layout](docs/editor-scaled.png).

The editor opens at an isometric angle on a white grid, with finer 1-unit lines and stronger 5-unit lines. Navigate the scene with the vertical X/Y/Z toolbar on the right, WASD to move horizontally, and Q/E to move down/up. Drag to orbit; right-drag or Shift-drag to pan. Movement stops immediately on release. **Reset view** (or R while the viewer is focused) returns to the default view. These controls move the editor viewpoint, not the cameras in your shot.

The preview connects adjacent depth samples into textured surfaces to fill the gaps between points when viewing at an angle. It skips unsupported depth jumps and reconnects grazing surfaces when local inverse-depth samples establish a plane. Isolated missing samples can be repaired from measured planar neighbors; larger gaps remain open. Geometry hidden by the source image remains unobserved.

### Get an API key

Join the [World Labs beta waitlist](https://form.typeform.com/to/zHFR4r3A) if you don't already have access. Signing up requests access; it does not immediately issue a key.

After your account is enabled, open the [developer portal](https://atlas-beta.worldlabs.ai/developers), select a project, and create an API key with task creation, operation reading, and asset creation/reading permissions. Keep the key in the server's `.env`; never paste it into frontend source or commit it.

The API is currently served from `https://api.atlas-beta.worldlabs.ai/api/v2`. See the [API quickstart](https://atlas-beta.worldlabs.ai/docs/quickstart) for current access and setup details. API charges are billed to the project that owns your key.

## How it works

1. The browser resizes the image to 1280 × 720.
2. The server calls `tasks:images2PosedRGBD` and polls the returned operation.
3. The editor decodes the EXR depth map and reconstructs a colored point cloud.
4. The editor smooths the drawn path and interpolates camera positions and directions into 48 target cameras.
5. The server calls `tasks:atlasGenerate`, downloads the frames, and encodes an MP4.

The preview is a point cloud used to plan the camera. Generated views can reveal details that are absent from the original image.

## Host a demo

See [hosted setup](docs/hosting.md). Hosted mode requires verified phone ownership before preparing images or generating. Each phone can claim three free generations once, even across accounts. One-time credit packs offer 3 generations for $5, 12 for $20, or 60 for $100 through Stripe Checkout.

Credits are reserved before generation and returned on terminal failure. Duplicate webhooks and repeated job requests do not double-credit or double-charge. Interrupted workers resume stored operation IDs. Job inputs and videos are kept for seven days; download finished shots before they expire.

Local mode has no authentication or paywall and binds to loopback only. Use hosted mode for any shared deployment.

## Verify changes

```sh
npm run typecheck
npm test
npm run build
```

Tests exercise the original trajectory drawing and camera math, coordinate transforms, ledger concurrency, payment validation, refunds, and job recovery. They do not replace a real Stripe Checkout, SMS verification, and Marble API smoke test before deployment.

## License and credits

MIT. The editor, drawing controls, and trajectory math are adapted from the original camera-trajectory app created by [Gowthami Somepalli (@somepago)](https://github.com/somepago) at World Labs. Built with Three.js, React Three Fiber, Clerk, Stripe, and FFmpeg. World Labs API usage is subject to the service's own terms and charges.
