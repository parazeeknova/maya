import "./style.css";

interface EnrollmentIdentity {
  color: string;
  embedding: number[];
  id: string;
  name: string;
  role: string;
}

interface RuntimeConfig {
  capture: {
    intervalMs: number;
    jpegQuality: number;
    maxWidth: number;
  };
  detector: {
    kind: "shape-detection";
  };
  recognizer: {
    embeddingDimension: number;
    inputSize: number;
    marginThreshold: number;
    modelUrl: string;
    threshold: number;
    topK: number;
  };
}

interface WorkerInitResponse {
  device: "wasm" | "webgpu";
  identities: number;
  modelUrl: string;
  status: "ready";
  version: number;
}

interface WorkerErrorResponse {
  message: string;
  status: "error";
}

interface WorkerFrameResult {
  faces: {
    bbox: {
      height: number;
      width: number;
      x: number;
      y: number;
    };
    confidence: number;
    identity: {
      color: string;
      id: string;
      name: string;
      role: string;
    } | null;
  }[];
  frameId: number;
  latencyMs: number;
  status: "frame";
}

type WorkerResponse =
  | WorkerErrorResponse
  | WorkerFrameResult
  | WorkerInitResponse;

const root = document.querySelector<HTMLDivElement>("#app");
if (root === null) {
  throw new TypeError("Missing app root.");
}

root.innerHTML = `
  <main class="shell">
    <video class="video" id="camera" autoplay muted playsinline></video>
    <canvas class="overlay" id="overlay"></canvas>
    <div class="hud">
      <div class="pill"><span>Device</span><strong id="device-pill">booting</strong></div>
      <div class="pill"><span>Latency</span><strong id="latency-pill">0 ms</strong></div>
      <div class="pill"><span>Faces</span><strong id="faces-pill">0</strong></div>
    </div>
    <div class="status">
      <section class="status-card">
        <h1>Maya</h1>
        <p id="status-copy">Loading browser inference runtime…</p>
      </section>
    </div>
  </main>
`;

const camera = document.querySelector<HTMLVideoElement>("#camera");
const overlay = document.querySelector<HTMLCanvasElement>("#overlay");
const devicePill = document.querySelector<HTMLElement>("#device-pill");
const latencyPill = document.querySelector<HTMLElement>("#latency-pill");
const facesPill = document.querySelector<HTMLElement>("#faces-pill");
const statusCopy = document.querySelector<HTMLElement>("#status-copy");

if (
  camera === null ||
  overlay === null ||
  devicePill === null ||
  latencyPill === null ||
  facesPill === null ||
  statusCopy === null
) {
  throw new TypeError("Aegis UI failed to initialize.");
}

const context = overlay.getContext("2d");
if (context === null) {
  throw new TypeError("Overlay canvas context is unavailable.");
}

const worker = new Worker(new URL("inference/worker.ts", import.meta.url), {
  type: "module",
});

const state = {
  config: null as RuntimeConfig | null,
  frameId: 0,
  inFlight: false,
};

interface BrowserFaceDetector {
  detect(source: CanvasImageSource): Promise<
    {
      boundingBox: DOMRectReadOnly;
    }[]
  >;
}

type BrowserWindow = Window & {
  FaceDetector?: new (options?: {
    fastMode?: boolean;
    maxDetectedFaces?: number;
  }) => BrowserFaceDetector;
};

const resizeOverlay = () => {
  const rect = camera.getBoundingClientRect();
  overlay.height = rect.height;
  overlay.width = rect.width;
};

const drawFaces = (
  faces: WorkerFrameResult["faces"],
  sourceWidth: number,
  sourceHeight: number
) => {
  context.clearRect(0, 0, overlay.width, overlay.height);
  if (!sourceWidth || !sourceHeight) {
    return;
  }

  const scaleX = overlay.width / sourceWidth;
  const scaleY = overlay.height / sourceHeight;
  context.font = '14px "Cascadia Mono", monospace';
  context.lineWidth = 3;
  context.textBaseline = "top";

  for (const face of faces) {
    const box = face.bbox;
    const color = face.identity?.color ?? "#ffffff";
    const label = face.identity
      ? `${face.identity.name} · ${(face.confidence * 100).toFixed(0)}%`
      : `unknown · ${(face.confidence * 100).toFixed(0)}%`;
    const height = box.height * scaleY;
    const width = box.width * scaleX;
    const x = box.x * scaleX;
    const y = box.y * scaleY;

    context.shadowBlur = 18;
    context.shadowColor = `${color}66`;
    context.strokeStyle = color;
    context.strokeRect(x, y, width, height);

    const chipHeight = 28;
    const chipWidth = context.measureText(label).width + 18;
    const chipY = Math.max(8, y - chipHeight - 8);

    context.fillStyle = color;
    context.fillRect(x, chipY, chipWidth, chipHeight);
    context.fillStyle = "#000";
    context.fillText(label, x + 9, chipY + 6);
  }

  context.shadowBlur = 0;
};

const startCamera = async () => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: "user",
      height: { ideal: 720 },
      width: { ideal: 1280 },
    },
  });
  camera.srcObject = stream;
  await camera.play();
  resizeOverlay();
};

const detectFaces = () => {
  const browserWindow = window as BrowserWindow;
  const FaceDetectorCtor = browserWindow.FaceDetector;
  if (FaceDetectorCtor === undefined) {
    throw new Error("FaceDetector API is not available in this browser.");
  }

  const detector = new FaceDetectorCtor({
    fastMode: true,
    maxDetectedFaces: 5,
  });

  const loop = async () => {
    if (
      state.config === null ||
      state.inFlight ||
      camera.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      window.setTimeout(loop, state.config?.capture.intervalMs ?? 120);
      return;
    }

    state.inFlight = true;
    try {
      const detections = await detector.detect(camera);
      const frame = await createImageBitmap(camera);
      state.frameId += 1;
      worker.postMessage(
        {
          detections: detections.map(
            (detection: { boundingBox: DOMRectReadOnly }) => ({
              height: detection.boundingBox.height,
              width: detection.boundingBox.width,
              x: detection.boundingBox.x,
              y: detection.boundingBox.y,
            })
          ),
          frame,
          frameId: state.frameId,
          sourceHeight: camera.videoHeight,
          sourceWidth: camera.videoWidth,
          type: "frame",
        },
        [frame]
      );
    } catch (error) {
      statusCopy.textContent =
        error instanceof Error ? error.message : String(error);
      state.inFlight = false;
    } finally {
      window.setTimeout(loop, state.config.capture.intervalMs);
    }
  };
  void loop();
};

const loadBundle = async () => {
  const [configResponse, enrollmentResponse] = await Promise.all([
    fetch("/bundle/config.json"),
    fetch("/bundle/enrollment.json"),
  ]);

  const config = (await configResponse.json()) as RuntimeConfig;
  const enrollment = (await enrollmentResponse.json()) as {
    identities: EnrollmentIdentity[];
    version: number;
  };

  state.config = config;
  worker.postMessage({
    bundle: enrollment,
    config,
    type: "init",
  });
};

worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
  if (event.data.status === "error") {
    statusCopy.textContent = event.data.message;
    state.inFlight = false;
    return;
  }

  if (event.data.status === "ready") {
    devicePill.textContent = event.data.device;
    statusCopy.innerHTML = `Running on <code>${event.data.device}</code> with ${event.data.identities} enrolled identities.`;
    try {
      detectFaces();
    } catch (error) {
      statusCopy.textContent =
        error instanceof Error ? error.message : String(error);
    }
    return;
  }

  state.inFlight = false;
  latencyPill.textContent = `${event.data.latencyMs.toFixed(1)} ms`;
  facesPill.textContent = String(event.data.faces.length);
  drawFaces(event.data.faces, camera.videoWidth, camera.videoHeight);
});

window.addEventListener("resize", resizeOverlay);

const bootstrap = async () => {
  await Promise.all([startCamera(), loadBundle()]);
};

const startApp = async () => {
  try {
    await bootstrap();
  } catch (error) {
    statusCopy.textContent =
      error instanceof Error ? error.message : String(error);
  }
};

void startApp();
