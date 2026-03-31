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
  };
  type: "init";
}

interface FrameMessage {
  detections: {
    height: number;
    width: number;
    x: number;
    y: number;
  }[];
  frame: ImageBitmap;
  frameId: number;
  sourceHeight: number;
  sourceWidth: number;
  type: "frame";
}

type WorkerMessage = FrameMessage | InitMessage;

interface RecognizerState {
  bundleVersion: number;
  device: "wasm" | "webgpu";
  embeddings: Float32Array[];
  identities: EnrollmentIdentity[];
  inputSize: number;
  marginThreshold: number;
  session: ort.InferenceSession;
  threshold: number;
  topK: number;
}

const ctx = self as DedicatedWorkerGlobalScope;
const canvas = new OffscreenCanvas(112, 112);
const context = canvas.getContext("2d", { willReadFrequently: true });
if (context === null) {
  throw new TypeError("Offscreen canvas 2D context is unavailable.");
}

let recognizerState: RecognizerState | null = null;

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

const cropFace = (
  frame: ImageBitmap,
  box: FrameMessage["detections"][number],
  inputSize: number
) => {
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

  canvas.height = inputSize;
  canvas.width = inputSize;
  context.clearRect(0, 0, inputSize, inputSize);
  context.drawImage(
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
  return context.getImageData(0, 0, inputSize, inputSize);
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
    input[index] = (red - 127.5) / 127.5;
    input[index + area] = (green - 127.5) / 127.5;
    input[index + area * 2] = (blue - 127.5) / 127.5;
  }

  return new ort.Tensor("float32", input, [1, 3, height, width]);
};

const buildSession = async (
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
  const session = await ort.InferenceSession.create(modelUrl, {
    executionProviders,
    graphOptimizationLevel: "all",
  });

  return {
    device: supportsWebGPU ? "webgpu" : "wasm",
    session,
  };
};

const matchIdentity = (embedding: Float32Array, state: RecognizerState) => {
  const scores = state.identities.map((identity, index) => {
    const candidate = state.embeddings[index];
    if (candidate === undefined) {
      return {
        identity,
        score: -1,
      };
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

    return {
      identity,
      score,
    };
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
  const [inputName] = state.session.inputNames;
  const [outputName] = state.session.outputNames;
  if (inputName === undefined || outputName === undefined) {
    throw new Error("Recognizer session metadata is incomplete.");
  }

  const results: {
    bbox: FrameMessage["detections"][number];
    confidence: number;
    identity: {
      color: string;
      id: string;
      name: string;
      role: string;
    } | null;
  }[] = [];

  for (const detection of message.detections) {
    const imageData = cropFace(message.frame, detection, state.inputSize);
    const tensor = imageDataToTensor(imageData);
    const feeds = {
      [inputName]: tensor,
    };
    const output = await state.session.run(feeds);
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
      const { config } = event.data;
      const { device, session } = await buildSession(
        config.recognizer.modelUrl
      );
      recognizerState = {
        bundleVersion: event.data.bundle.version,
        device,
        embeddings: event.data.bundle.identities.map((identity) =>
          normalize(Float32Array.from(identity.embedding))
        ),
        identities: event.data.bundle.identities,
        inputSize: config.recognizer.inputSize,
        marginThreshold: config.recognizer.marginThreshold,
        session,
        threshold: config.recognizer.threshold,
        topK: config.recognizer.topK,
      };

      ctx.postMessage({
        device,
        identities: event.data.bundle.identities.length,
        modelUrl: config.recognizer.modelUrl,
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
