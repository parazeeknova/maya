/// <reference lib="webworker" />

import * as ort from "onnxruntime-web";

interface EnrollmentIdentity {
  color: string;
  embedding: number[];
  id: string;
  name: string;
  role: string;
}

interface InitMessage {
  bundle: {
    identities: EnrollmentIdentity[];
    version: number;
  };
  config: {
    capture: {
      intervalMs: number;
      jpegQuality: number;
      maxWidth: number;
    };
    detector: {
      inputSize: number;
      maxFaces: number;
      modelUrl: string;
      nmsThreshold: number;
      scoreThreshold: number;
    };
    recognizer: {
      embeddingDimension: number;
      inputSize: number;
      marginThreshold: number;
      modelUrl: string;
      threshold: number;
      topK: number;
    };
  };
  type: "init";
}

interface FrameMessage {
  frame: ImageBitmap;
  frameId: number;
  sourceHeight: number;
  sourceWidth: number;
  type: "frame";
}

type WorkerMessage = FrameMessage | InitMessage;

interface DetectBox {
  height: number;
  width: number;
  x: number;
  y: number;
}

interface RecognizerState {
  bundleVersion: number;
  detectorInputSize: number;
  detectorMaxFaces: number;
  detectorNmsThreshold: number;
  detectorScoreThreshold: number;
  detectorSession: ort.InferenceSession;
  device: "wasm" | "webgpu";
  embeddings: Float32Array[];
  identities: EnrollmentIdentity[];
  inputSize: number;
  marginThreshold: number;
  recognizerSession: ort.InferenceSession;
  threshold: number;
  topK: number;
}

const ctx = self as DedicatedWorkerGlobalScope;
const detectorCanvas = new OffscreenCanvas(320, 320);
const detectorContext = detectorCanvas.getContext("2d", {
  willReadFrequently: true,
});
const recognizerCanvas = new OffscreenCanvas(112, 112);
const recognizerContext = recognizerCanvas.getContext("2d", {
  willReadFrequently: true,
});

if (detectorContext === null || recognizerContext === null) {
  throw new TypeError("Worker canvas contexts are unavailable.");
}

let recognizerState: RecognizerState | null = null;

const SCORE_OUTPUT_INDICES = [0, 1, 2] as const;
const BBOX_OUTPUT_INDICES = [3, 4, 5] as const;
const DETECTOR_STRIDES = [8, 16, 32] as const;
const DETECTOR_ANCHORS = 2;

const normalize = (vector: Float32Array) => {
  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }

  norm = Math.sqrt(norm);
  if (!norm) {
    return vector;
  }

  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index];
    if (value === undefined) {
      continue;
    }
    vector[index] = value / norm;
  }

  return vector;
};

const imageDataToTensor = (imageData: ImageData) => {
  const { data, height, width } = imageData;
  const input = new Float32Array(1 * 3 * height * width);
  const area = height * width;

  for (let index = 0; index < area; index += 1) {
    const offset = index * 4;
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    if (red === undefined || green === undefined || blue === undefined) {
      continue;
    }

    input[index] = (red - 127.5) / 128;
    input[index + area] = (green - 127.5) / 128;
    input[index + area * 2] = (blue - 127.5) / 128;
  }

  return new ort.Tensor("float32", input, [1, 3, height, width]);
};

const createSession = async (
  modelUrl: string
): Promise<{ device: "wasm" | "webgpu"; session: ort.InferenceSession }> => {
  ort.env.wasm.numThreads = Math.max(
    1,
    Math.min(4, navigator.hardwareConcurrency ?? 4)
  );
  ort.env.wasm.simd = true;

  const supportsWebGPU = "gpu" in navigator;
  const executionProviders: ort.InferenceSession.SessionOptions["executionProviders"] =
    supportsWebGPU ? ["webgpu", "wasm"] : ["wasm"];
  const response = await fetch(modelUrl);
  if (!response.ok) {
    throw new Error(`Failed to load model: ${modelUrl}`);
  }
  const modelBuffer = await response.arrayBuffer();
  const session = await ort.InferenceSession.create(modelBuffer, {
    executionProviders,
    graphOptimizationLevel: "all",
  });

  return {
    device: supportsWebGPU ? "webgpu" : "wasm",
    session,
  };
};

const generateAnchorCenters = (
  featureHeight: number,
  featureWidth: number,
  stride: number
) => {
  const centers = new Float32Array(
    featureHeight * featureWidth * DETECTOR_ANCHORS * 2
  );
  let offset = 0;
  for (let y = 0; y < featureHeight; y += 1) {
    for (let x = 0; x < featureWidth; x += 1) {
      for (let anchor = 0; anchor < DETECTOR_ANCHORS; anchor += 1) {
        centers[offset] = x * stride;
        centers[offset + 1] = y * stride;
        offset += 2;
      }
    }
  }
  return centers;
};

const decodeDistanceBox = (
  centers: Float32Array,
  distances: Float32Array,
  index: number
): DetectBox => {
  const centerX = centers[index * 2] ?? 0;
  const centerY = centers[index * 2 + 1] ?? 0;
  const offset = index * 4;
  const x1 = centerX - (distances[offset] ?? 0);
  const y1 = centerY - (distances[offset + 1] ?? 0);
  const x2 = centerX + (distances[offset + 2] ?? 0);
  const y2 = centerY + (distances[offset + 3] ?? 0);

  return {
    height: y2 - y1,
    width: x2 - x1,
    x: x1,
    y: y1,
  };
};

const iou = (left: DetectBox, right: DetectBox) => {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);

  const interWidth = Math.max(0, x2 - x1);
  const interHeight = Math.max(0, y2 - y1);
  const intersection = interWidth * interHeight;
  if (intersection <= 0) {
    return 0;
  }

  const leftArea = left.width * left.height;
  const rightArea = right.width * right.height;
  const union = leftArea + rightArea - intersection;
  return union <= 0 ? 0 : intersection / union;
};

const buildDetectorTensor = (frame: ImageBitmap, inputSize: number) => {
  const imageRatio = frame.height / frame.width;
  let resizedHeight = inputSize;
  let resizedWidth = inputSize;

  if (imageRatio > 1) {
    resizedHeight = inputSize;
    resizedWidth = Math.round(resizedHeight / imageRatio);
  } else {
    resizedWidth = inputSize;
    resizedHeight = Math.round(resizedWidth * imageRatio);
  }

  detectorCanvas.height = inputSize;
  detectorCanvas.width = inputSize;
  detectorContext.fillStyle = "black";
  detectorContext.fillRect(0, 0, inputSize, inputSize);
  detectorContext.drawImage(frame, 0, 0, resizedWidth, resizedHeight);

  const imageData = detectorContext.getImageData(0, 0, inputSize, inputSize);
  const tensor = imageDataToTensor(imageData);
  const scale = resizedHeight / frame.height;

  return { scale, tensor };
};

const detectFaces = async (
  frame: ImageBitmap,
  state: RecognizerState
): Promise<DetectBox[]> => {
  const { scale, tensor } = buildDetectorTensor(frame, state.detectorInputSize);
  const [inputName] = state.detectorSession.inputNames;
  if (inputName === undefined) {
    throw new Error("Detector session metadata is incomplete.");
  }

  const outputs = await state.detectorSession.run({
    [inputName]: tensor,
  });

  const detections: {
    bbox: DetectBox;
    score: number;
  }[] = [];

  for (const [featureIndex, stride] of DETECTOR_STRIDES.entries()) {
    const scoreIndex = SCORE_OUTPUT_INDICES[featureIndex];
    const bboxIndex = BBOX_OUTPUT_INDICES[featureIndex];
    if (scoreIndex === undefined || bboxIndex === undefined) {
      continue;
    }

    const scoreName = state.detectorSession.outputNames[scoreIndex];
    const bboxName = state.detectorSession.outputNames[bboxIndex];
    if (scoreName === undefined || bboxName === undefined) {
      continue;
    }

    const scoreOutput = outputs[scoreName];
    const bboxOutput = outputs[bboxName];
    if (scoreOutput === undefined || bboxOutput === undefined) {
      continue;
    }

    const scores = scoreOutput.data as Float32Array;
    const boxes = bboxOutput.data as Float32Array;
    const featureSize = Math.sqrt(scores.length / DETECTOR_ANCHORS);
    const featureHeight = Math.max(1, Math.round(featureSize));
    const featureWidth = featureHeight;
    const centers = generateAnchorCenters(featureHeight, featureWidth, stride);

    for (let index = 0; index < scores.length; index += 1) {
      const score = scores[index] ?? 0;
      if (score < state.detectorScoreThreshold) {
        continue;
      }

      const decoded = decodeDistanceBox(centers, boxes, index);
      detections.push({
        bbox: {
          height: decoded.height / scale,
          width: decoded.width / scale,
          x: decoded.x / scale,
          y: decoded.y / scale,
        },
        score,
      });
    }
  }

  detections.sort((left, right) => right.score - left.score);
  const kept: DetectBox[] = [];
  for (const detection of detections) {
    const overlaps = kept.some(
      (existing) => iou(existing, detection.bbox) > state.detectorNmsThreshold
    );
    if (overlaps) {
      continue;
    }

    kept.push(detection.bbox);
    if (kept.length >= state.detectorMaxFaces) {
      break;
    }
  }

  return kept;
};

const cropFace = (frame: ImageBitmap, box: DetectBox, inputSize: number) => {
  const padding = 0.18;
  const size = Math.max(box.width, box.height);
  const cropSize = size * (1 + padding * 2);
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const sourceX = Math.max(0, centerX - cropSize / 2);
  const sourceY = Math.max(0, centerY - cropSize / 2);
  const sourceSize = Math.min(
    cropSize,
    frame.width - sourceX,
    frame.height - sourceY
  );

  recognizerCanvas.height = inputSize;
  recognizerCanvas.width = inputSize;
  recognizerContext.clearRect(0, 0, inputSize, inputSize);
  recognizerContext.drawImage(
    frame,
    sourceX,
    sourceY,
    sourceSize,
    sourceSize,
    0,
    0,
    inputSize,
    inputSize
  );
  return recognizerContext.getImageData(0, 0, inputSize, inputSize);
};

const matchIdentity = (embedding: Float32Array, state: RecognizerState) => {
  const scores = state.identities.map((identity, index) => {
    const candidate = state.embeddings[index];
    if (candidate === undefined) {
      return { identity, score: -1 };
    }

    let score = 0;
    for (let valueIndex = 0; valueIndex < embedding.length; valueIndex += 1) {
      const left = embedding[valueIndex];
      const right = candidate[valueIndex];
      if (left === undefined || right === undefined) {
        continue;
      }
      score += left * right;
    }

    return { identity, score };
  });

  const ranked = scores
    .toSorted((left, right) => right.score - left.score)
    .slice(0, state.topK);
  const [best, second] = ranked;
  if (
    best === undefined ||
    best.score < state.threshold ||
    (second !== undefined && best.score - second.score < state.marginThreshold)
  ) {
    return {
      confidence: best?.score ?? 0,
      identity: null,
    };
  }

  return {
    confidence: best.score,
    identity: best.identity,
  };
};

const processFrame = async (message: FrameMessage) => {
  const state = recognizerState;
  if (state === null) {
    throw new Error("Recognizer is not initialized.");
  }

  const startedAt = performance.now();
  const [inputName] = state.recognizerSession.inputNames;
  const [outputName] = state.recognizerSession.outputNames;
  if (inputName === undefined || outputName === undefined) {
    throw new Error("Recognizer session metadata is incomplete.");
  }

  const detections = await detectFaces(message.frame, state);
  const results: {
    bbox: DetectBox;
    confidence: number;
    identity: {
      color: string;
      id: string;
      name: string;
      role: string;
    } | null;
  }[] = [];

  for (const detection of detections) {
    const imageData = cropFace(message.frame, detection, state.inputSize);
    const tensor = imageDataToTensor(imageData);
    const output = await state.recognizerSession.run({
      [inputName]: tensor,
    });
    const firstOutput = output[outputName];
    if (firstOutput === undefined) {
      throw new Error("Recognizer session returned no output tensor.");
    }

    const embedding = normalize(
      Float32Array.from(firstOutput.data as Float32Array)
    );
    const match = matchIdentity(embedding, state);
    results.push({
      bbox: detection,
      confidence: match.confidence,
      identity: match.identity
        ? {
            color: match.identity.color,
            id: match.identity.id,
            name: match.identity.name,
            role: match.identity.role,
          }
        : null,
    });
  }

  message.frame.close();
  ctx.postMessage({
    faces: results,
    frameId: message.frameId,
    latencyMs: performance.now() - startedAt,
    status: "frame",
  });
};

ctx.addEventListener("message", async (event: MessageEvent<WorkerMessage>) => {
  try {
    if (event.data.type === "init") {
      const detector = await createSession(event.data.config.detector.modelUrl);
      const recognizer = await createSession(
        event.data.config.recognizer.modelUrl
      );

      recognizerState = {
        bundleVersion: event.data.bundle.version,
        detectorInputSize: event.data.config.detector.inputSize,
        detectorMaxFaces: event.data.config.detector.maxFaces,
        detectorNmsThreshold: event.data.config.detector.nmsThreshold,
        detectorScoreThreshold: event.data.config.detector.scoreThreshold,
        detectorSession: detector.session,
        device: detector.device,
        embeddings: event.data.bundle.identities.map((identity) =>
          normalize(Float32Array.from(identity.embedding))
        ),
        identities: event.data.bundle.identities,
        inputSize: event.data.config.recognizer.inputSize,
        marginThreshold: event.data.config.recognizer.marginThreshold,
        recognizerSession: recognizer.session,
        threshold: event.data.config.recognizer.threshold,
        topK: event.data.config.recognizer.topK,
      };

      ctx.postMessage({
        device: recognizerState.device,
        identities: recognizerState.identities.length,
        modelUrl: event.data.config.recognizer.modelUrl,
        status: "ready" as const,
        version: event.data.bundle.version,
      });
      return;
    }

    await processFrame(event.data);
  } catch (error) {
    ctx.postMessage({
      message: error instanceof Error ? error.message : String(error),
      status: "error",
    });
  }
});
