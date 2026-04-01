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
const enrollmentForm = requiredNode("#enrollment-form");
const enrollmentStatus = requiredNode("#enrollment-status");
const enrollmentList = requiredNode("#enrollment-list");
const identityNameInput = requiredNode("#identity-name-input");
const identityRoleInput = requiredNode("#identity-role-input");
const identityColorInput = requiredNode("#identity-color-input");
const identityFilesInput = requiredNode("#identity-files-input");
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
  enrollmentIdentities: [],
  frameId: 0,
  framesProcessed: 0,
  lastCompletedFrameId: 0,
  lastResultFrameId: -1,
  renderTracks: new Map(),
  sampleTimer: null,
  sampling: {
    intervalMs: Number(intervalInput.value),
    jpegQuality: Number(qualityInput.value) / 100,
    maxWidth: 320,
  },
  sessionId: crypto.randomUUID(),
  socket: null,
  sourceSize: {
    height: 0,
    width: 0,
  },
};

const renderEnrollmentList = () => {
  enrollmentList.replaceChildren();

  for (const identity of state.enrollmentIdentities) {
    const row = document.createElement("div");
    row.className = "identity-row";
    row.innerHTML = `
      <div>
        <strong>${identity.metadata.name}</strong>
        <span>${identity.id} · ${identity.metadata.role} · ${identity.files.length} file(s)</span>
      </div>
      <button class="identity-delete" data-id="${identity.id}" type="button">Delete</button>
    `;
    enrollmentList.append(row);
  }

  if (state.enrollmentIdentities.length === 0) {
    const empty = document.createElement("span");
    empty.className = "option-note";
    empty.textContent = "no identities";
    enrollmentList.append(empty);
  }
};

const loadEnrollmentList = async () => {
  const response = await fetch("/api/enrollment");
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? "Failed to load enrollment list.");
  }

  state.enrollmentIdentities = payload.identities;
  enrollmentValue.textContent = `${payload.identities.length} identities`;
  renderEnrollmentList();
};

const cloneBox = (bbox) => ({
  height: bbox.height,
  width: bbox.width,
  x: bbox.x,
  y: bbox.y,
});

const makeTrackKey = (face, index) =>
  face.trackId === null ? `ephemeral-${index}` : `track-${face.trackId}`;

const mixBox = (fromBox, toBox, progress) => ({
  height: fromBox.height + (toBox.height - fromBox.height) * progress,
  width: fromBox.width + (toBox.width - fromBox.width) * progress,
  x: fromBox.x + (toBox.x - fromBox.x) * progress,
  y: fromBox.y + (toBox.y - fromBox.y) * progress,
});

const scaleBox = (box, factor) => ({
  height: box.height * factor,
  width: box.width * factor,
  x: box.x * factor,
  y: box.y * factor,
});

const subtractBox = (nextBox, previousBox) => ({
  height: nextBox.height - previousBox.height,
  width: nextBox.width - previousBox.width,
  x: nextBox.x - previousBox.x,
  y: nextBox.y - previousBox.y,
});

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

const getTrackBox = (track, now) => {
  const duration = Math.max(track.transitionDuration, 1);
  const progress = Math.min(1, (now - track.transitionStart) / duration);
  const interpolated = mixBox(track.fromBox, track.toBox, progress);

  if (progress < 1) {
    return interpolated;
  }

  const predictiveElapsed = Math.min(
    now - (track.transitionStart + duration),
    track.maxPredictionMs
  );
  if (predictiveElapsed <= 0) {
    return interpolated;
  }

  return mixBox(
    interpolated,
    {
      height: interpolated.height + track.velocity.height,
      width: interpolated.width + track.velocity.width,
      x: interpolated.x + track.velocity.x,
      y: interpolated.y + track.velocity.y,
    },
    predictiveElapsed / track.maxPredictionMs
  );
};

const updateRenderTracks = (message) => {
  const activeKeys = new Set();
  const now = performance.now();
  const fadeDuration = Math.max(220, message.sampleIntervalMs * 1.35);

  for (const [index, face] of message.faces.entries()) {
    const key = makeTrackKey(face, index);
    const existing = state.renderTracks.get(key);
    const fromBox = existing ? getTrackBox(existing, now) : cloneBox(face.bbox);
    const { identity } = face;
    const transitionDuration = Math.max(48, message.sampleIntervalMs * 0.9);
    const velocity =
      existing === undefined
        ? scaleBox(cloneBox(face.bbox), 0)
        : scaleBox(
            subtractBox(face.bbox, existing.toBox),
            1 / Math.max(now - existing.transitionStart, 16)
          );

    activeKeys.add(key);
    state.renderTracks.set(key, {
      color: identity?.color ?? "#ffffff",
      fadeDuration,
      fromBox,
      label: identity
        ? `${identity.name} · ${identity.role} · ${(face.confidence * 100).toFixed(0)}%`
        : `unknown · ${(face.confidence * 100).toFixed(0)}%`,
      maxPredictionMs: Math.max(90, message.sampleIntervalMs * 1.2),
      removeAfter: null,
      sourceSize: message.sourceSize,
      toBox: cloneBox(face.bbox),
      trackId: face.trackId,
      transitionDuration,
      transitionStart: now,
      velocity,
    });
  }

  for (const [key, track] of state.renderTracks.entries()) {
    if (activeKeys.has(key)) {
      continue;
    }

    if (track.trackId === null) {
      state.renderTracks.delete(key);
      continue;
    }

    if (track.removeAfter === null) {
      const frozenBox = getTrackBox(track, now);
      state.renderTracks.set(key, {
        ...track,
        fromBox: frozenBox,
        removeAfter: now + fadeDuration,
        toBox: frozenBox,
        transitionStart: now,
      });
    }
  }
};

const drawOverlay = () => {
  overlayContext.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  if (!state.sourceSize.height || !state.sourceSize.width) {
    return;
  }

  const now = performance.now();

  overlayContext.font = '14px "Cascadia Mono", monospace';
  overlayContext.lineWidth = 3;
  overlayContext.textBaseline = "top";

  for (const [key, track] of state.renderTracks.entries()) {
    const scaleX = overlayCanvas.width / track.sourceSize.width;
    const scaleY = overlayCanvas.height / track.sourceSize.height;
    const box = getTrackBox(track, now);
    const { color } = track;
    const width = box.width * scaleX;
    const height = box.height * scaleY;
    const x = box.x * scaleX;
    const y = box.y * scaleY;
    let alpha = 1;

    if (track.removeAfter !== null) {
      alpha = Math.max(
        0,
        (track.removeAfter - now) / Math.max(track.fadeDuration, 1)
      );
      if (alpha <= 0) {
        state.renderTracks.delete(key);
        continue;
      }
    }

    overlayContext.shadowBlur = 18;
    overlayContext.shadowColor = `${color}${Math.round(alpha * 102)
      .toString(16)
      .padStart(2, "0")}`;
    overlayContext.strokeStyle = color;
    overlayContext.globalAlpha = alpha;
    overlayContext.strokeRect(x, y, width, height);

    const chipHeight = 28;
    const chipWidth = overlayContext.measureText(track.label).width + 20;
    const chipY = Math.max(8, y - chipHeight - 8);

    overlayContext.fillStyle = color;
    overlayContext.fillRect(x, chipY, chipWidth, chipHeight);
    overlayContext.fillStyle = "#000";
    overlayContext.fillText(track.label, x + 10, chipY + 6);
  }

  overlayContext.globalAlpha = 1;
  overlayContext.shadowBlur = 0;
};

const renderLoop = () => {
  drawOverlay();
  window.requestAnimationFrame(renderLoop);
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
        state.lastCompletedFrameId = Math.max(
          state.lastCompletedFrameId,
          message.frameId
        );
        state.framesProcessed += 1;
        state.lastResultFrameId = message.frameId;
        state.sourceSize = message.sourceSize;
        frameCounter.textContent = `${state.framesProcessed} frames`;
        indexValue.textContent = String(message.indexVersion);
        latencyChip.textContent = `${message.latencyMs.toFixed(1)} ms`;
        if (message.latencyMs > 300) {
          state.sampling.jpegQuality = 0.42;
          state.sampling.maxWidth = 224;
        } else if (message.latencyMs > 160) {
          state.sampling.jpegQuality = 0.46;
          state.sampling.maxWidth = 256;
        } else if (message.latencyMs < 80) {
          state.sampling.jpegQuality = 0.5;
          state.sampling.maxWidth = 320;
        }
        updateRenderTracks(message);
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
  if (document.hidden) {
    return;
  }
  if (
    state.frameId - state.lastCompletedFrameId > 0 ||
    !(state.socket instanceof WebSocket) ||
    state.socket.bufferedAmount > 128_000
  ) {
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
  if (base64 === undefined) {
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
  window.requestAnimationFrame(renderLoop);
};

const bootstrap = async () => {
  await Promise.all([startCamera(), loadEnrollmentList()]);
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

enrollmentForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (
    !(identityNameInput instanceof HTMLInputElement) ||
    !(identityRoleInput instanceof HTMLInputElement) ||
    !(identityColorInput instanceof HTMLInputElement) ||
    !(identityFilesInput instanceof HTMLInputElement)
  ) {
    return;
  }

  const { files } = identityFilesInput;
  if (files === null || files.length === 0) {
    enrollmentStatus.textContent = "select at least one file";
    return;
  }

  const form = new FormData();
  form.set("name", identityNameInput.value.trim());
  form.set("role", identityRoleInput.value.trim());
  form.set("color", identityColorInput.value.trim());
  for (const file of files) {
    form.append("files", file);
  }

  enrollmentStatus.textContent = "uploading…";
  const response = await fetch("/api/enrollment", {
    body: form,
    method: "POST",
  });
  const payload = await response.json();
  if (!response.ok) {
    enrollmentStatus.textContent = payload.error ?? "upload failed";
    return;
  }

  state.enrollmentIdentities = payload.identities;
  enrollmentValue.textContent = `${payload.identities.length} identities`;
  renderEnrollmentList();
  enrollmentStatus.textContent = "uploaded";
  enrollmentForm.reset();
  identityColorInput.value = "#4ee3ff";
});

enrollmentList.addEventListener("click", async (event) => {
  if (!(event.target instanceof HTMLButtonElement)) {
    return;
  }

  const identityId = event.target.dataset.id;
  if (identityId === undefined) {
    return;
  }

  enrollmentStatus.textContent = "deleting…";
  const response = await fetch(`/api/enrollment/${identityId}`, {
    method: "DELETE",
  });
  const payload = await response.json();
  if (!response.ok) {
    enrollmentStatus.textContent = payload.error ?? "delete failed";
    return;
  }

  state.enrollmentIdentities = payload.identities;
  enrollmentValue.textContent = `${payload.identities.length} identities`;
  renderEnrollmentList();
  enrollmentStatus.textContent = "deleted";
});

window.addEventListener("resize", syncOverlaySize);

void bootstrap();
