const requiredNode = (selector) => {
  const element = document.querySelector(selector);
  if (element === null) {
    throw new TypeError(`Missing required element: ${selector}`);
  }
  return element;
};

/** @type {HTMLVideoElement} */
const cameraFeed = requiredNode("#camera-feed");
/** @type {HTMLCanvasElement} */
const overlayCanvas = requiredNode("#overlay-canvas");
/** @type {HTMLCanvasElement} */
const captureCanvas = requiredNode("#capture-canvas");
/** @type {HTMLDetailsElement} */
const menuShell = requiredNode("#menu-shell");
/** @type {HTMLElement} */
const menuToggle = requiredNode("#menu-toggle");
const connectionValue = requiredNode("#connection-value");
const frameCounter = requiredNode("#frame-counter");
const latencyChip = requiredNode("#latency-chip");
const providersValue = requiredNode("#providers-value");
const trackingValue = requiredNode("#tracking-value");
const enrollmentValue = requiredNode("#enrollment-value");
const indexValue = requiredNode("#index-value");
/** @type {HTMLInputElement} */
const intervalInput = requiredNode("#interval-input");
const intervalValue = requiredNode("#interval-value");
/** @type {HTMLInputElement} */
const qualityInput = requiredNode("#quality-input");
const qualityValue = requiredNode("#quality-value");

const overlayContext = overlayCanvas.getContext("2d");
const captureContext = captureCanvas.getContext("2d");
if (overlayContext === null || captureContext === null) {
  throw new TypeError("Canvas 2D contexts are required.");
}

const state = {
  frameId: 0,
  framesProcessed: 0,
  lastResultFrameId: -1,
  latestFaces: [],
  sampleTimer: null,
  sampling: {
    intervalMs: Number(intervalInput.value),
    jpegQuality: Number(qualityInput.value) / 100,
    maxWidth: 640,
  },
  sessionId: crypto.randomUUID(),
  socket: null,
  sourceSize: {
    height: 0,
    width: 0,
  },
};

const setConnectionState = (mode) => {
  menuToggle.dataset.state = mode;
  switch (mode) {
    case "connected": {
      connectionValue.textContent = "bun online";
      break;
    }
    case "error": {
      connectionValue.textContent = "error";
      break;
    }
    case "python-ready": {
      connectionValue.textContent = "python ready";
      break;
    }
    case "python-wait": {
      connectionValue.textContent = "python wait";
      break;
    }
    default: {
      connectionValue.textContent = "offline";
      menuToggle.dataset.state = "offline";
    }
  }
};

const drawOverlay = () => {
  overlayContext.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  if (!state.sourceSize.height || !state.sourceSize.width) {
    return;
  }

  const scaleX = overlayCanvas.width / state.sourceSize.width;
  const scaleY = overlayCanvas.height / state.sourceSize.height;

  overlayContext.font = '14px "Cascadia Mono", monospace';
  overlayContext.lineWidth = 3;
  overlayContext.textBaseline = "top";

  for (const face of state.latestFaces) {
    const color = face.identity?.color ?? "#ffffff";
    const height = face.bbox.height * scaleY;
    const label = face.identity
      ? `${face.identity.name} · ${face.identity.role} · ${(face.confidence * 100).toFixed(0)}%`
      : `unknown · ${(face.confidence * 100).toFixed(0)}%`;
    const width = face.bbox.width * scaleX;
    const x = face.bbox.x * scaleX;
    const y = face.bbox.y * scaleY;

    overlayContext.shadowBlur = 18;
    overlayContext.shadowColor = `${color}66`;
    overlayContext.strokeStyle = color;
    overlayContext.strokeRect(x, y, width, height);

    const chipHeight = 28;
    const chipWidth = overlayContext.measureText(label).width + 20;
    const chipY = Math.max(8, y - chipHeight - 8);

    overlayContext.fillStyle = color;
    overlayContext.fillRect(x, chipY, chipWidth, chipHeight);
    overlayContext.fillStyle = "#000";
    overlayContext.fillText(label, x + 10, chipY + 6);
  }

  overlayContext.shadowBlur = 0;
};

const syncOverlaySize = () => {
  const rect = cameraFeed.getBoundingClientRect();
  overlayCanvas.height = rect.height;
  overlayCanvas.width = rect.width;
  drawOverlay();
};

const handleServerMessage = (message) => {
  switch (message.type) {
    case "error": {
      connectionValue.textContent = message.message;
      break;
    }
    case "frame.result": {
      if (message.frameId >= state.lastResultFrameId) {
        state.framesProcessed += 1;
        state.lastResultFrameId = message.frameId;
        state.latestFaces = message.faces;
        state.sourceSize = message.sourceSize;
        frameCounter.textContent = `${state.framesProcessed} frames`;
        indexValue.textContent = String(message.indexVersion);
        latencyChip.textContent = `${message.latencyMs.toFixed(1)} ms`;
        drawOverlay();
      }
      break;
    }
    case "python.status": {
      setConnectionState(message.connected ? "python-ready" : "python-wait");
      enrollmentValue.textContent = message.ready
        ? `${message.ready.enrollment.identities} identities`
        : "pending";
      indexValue.textContent = message.ready
        ? String(message.ready.enrollment.version)
        : "pending";
      providersValue.textContent = message.ready
        ? message.ready.providers.join(", ")
        : "pending";
      trackingValue.textContent = message.ready?.trackingEnabled
        ? "ByteTrack"
        : "off";
      break;
    }
    case "session.ready": {
      state.sampling = {
        ...state.sampling,
        intervalMs: message.sampling.intervalMs,
        jpegQuality: message.sampling.jpegQuality,
        maxWidth: message.sampling.maxWidth,
      };
      state.sessionId = message.sessionId;
      intervalInput.value = String(message.sampling.intervalMs);
      intervalValue.textContent = `${message.sampling.intervalMs} ms`;
      qualityInput.value = String(
        Math.round(message.sampling.jpegQuality * 100)
      );
      qualityValue.textContent = message.sampling.jpegQuality.toFixed(2);
      restartSampler();
      break;
    }
    case "signal.ack": {
      break;
    }
    default: {
      break;
    }
  }
};

const sampleAndSendFrame = () => {
  const sourceHeight = cameraFeed.videoHeight;
  const sourceWidth = cameraFeed.videoWidth;
  if (!sourceHeight || !sourceWidth) {
    return;
  }

  const scale = Math.min(1, state.sampling.maxWidth / sourceWidth);
  const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
  const targetWidth = Math.max(1, Math.round(sourceWidth * scale));

  captureCanvas.height = targetHeight;
  captureCanvas.width = targetWidth;
  captureContext.drawImage(cameraFeed, 0, 0, targetWidth, targetHeight);

  const dataUrl = captureCanvas.toDataURL(
    "image/jpeg",
    state.sampling.jpegQuality
  );
  const [, base64] = dataUrl.split(",", 2);
  if (base64 === undefined || !(state.socket instanceof WebSocket)) {
    return;
  }

  state.frameId += 1;
  state.socket.send(
    JSON.stringify({
      capturedAt: Date.now(),
      frameId: state.frameId,
      image: {
        data: base64,
        height: targetHeight,
        mimeType: "image/jpeg",
        width: targetWidth,
      },
      sampleIntervalMs: state.sampling.intervalMs,
      sessionId: state.sessionId,
      type: "frame.submit",
    })
  );
};

const restartSampler = () => {
  if (state.sampleTimer !== null) {
    window.clearInterval(state.sampleTimer);
  }

  state.sampleTimer = window.setInterval(() => {
    if (
      !(state.socket instanceof WebSocket) ||
      state.socket.readyState !== WebSocket.OPEN ||
      cameraFeed.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      return;
    }

    sampleAndSendFrame();
  }, state.sampling.intervalMs);
};

const connectSocket = () => {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(
    `${protocol}://${window.location.host}/ws/client`
  );
  state.socket = socket;

  socket.addEventListener("close", () => {
    setConnectionState("offline");
    window.setTimeout(connectSocket, 1000);
  });

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      return;
    }
    handleServerMessage(JSON.parse(event.data));
  });

  socket.addEventListener("open", () => {
    socket.send(
      JSON.stringify({
        sessionId: state.sessionId,
        type: "client.hello",
      })
    );
    setConnectionState("connected");
  });
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

  cameraFeed.addEventListener(
    "loadedmetadata",
    () => {
      syncOverlaySize();
    },
    { once: true }
  );

  cameraFeed.srcObject = stream;
  await cameraFeed.play();
  restartSampler();
};

const bootstrap = async () => {
  await startCamera();
  connectSocket();
};

menuToggle.addEventListener("click", () => {
  menuToggle.setAttribute("aria-expanded", String(!menuShell.open));
});

menuShell.addEventListener("toggle", () => {
  menuToggle.setAttribute("aria-expanded", String(menuShell.open));
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menuShell.open) {
    menuShell.open = false;
  }
});

intervalInput.addEventListener("input", () => {
  state.sampling.intervalMs = Number(intervalInput.value);
  intervalValue.textContent = `${state.sampling.intervalMs} ms`;
  restartSampler();
});

qualityInput.addEventListener("input", () => {
  state.sampling.jpegQuality = Number(qualityInput.value) / 100;
  qualityValue.textContent = state.sampling.jpegQuality.toFixed(2);
});

intervalValue.textContent = `${state.sampling.intervalMs} ms`;
qualityValue.textContent = state.sampling.jpegQuality.toFixed(2);

window.addEventListener("resize", syncOverlaySize);

void bootstrap();
