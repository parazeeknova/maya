### Maya

Maya is a fully local, closed-set face recognition system built for controlled environments where every identity is explicitly enrolled in advance. The product is designed around deterministic matching over a private identity set rather than open-world recognition, cloud APIs, or scraped public data. The output is a live operator view that overlays names, roles, colors, and confidence on top of a local camera feed while keeping transport, inference, and enrollment boundaries explicit.

### Architecture

The Turborepo is split into two services with a deliberate separation of responsibilities. The Bun app is the orchestration layer: it serves the browser client, owns the browser session, handles signaling and WebSocket transport, accepts sampled frames from the canvas pipeline, and relays structured inference results back to the client for overlay rendering. The Python service is the compute layer: it receives compressed frame payloads over a persistent WebSocket, performs detection, embedding, matching, and tracking, then returns normalized JSON results without taking on any frontend or session-management work.

### Recognition Stack

The recognition service uses InsightFace with the `buffalo_l` model pack for face detection and embedding generation, backed by ONNX Runtime with CUDA enabled when available and CPU fallback otherwise. Enrolled identities are loaded from a local directory, reduced to normalized prototype embeddings, and indexed in an in-memory FAISS `IndexFlatIP` index so cosine similarity search stays exact and deterministic for a small closed dataset. ByteTrack-based stabilization is applied inside Python to reduce identity flicker across sampled frames, and the browser renders simple face boxes and labels on a 2D canvas rather than introducing a heavier WebGL path before it is necessary.

### Chosen Constraints

The current vertical slice intentionally samples frames in the browser instead of shipping a full media stream into the server for decode, because that keeps local latency predictable and preserves a clean Bun-orchestration versus Python-inference split. Enrollment is folder-based, with one directory per person and a `metadata.json` carrying `name`, `role`, and `color`, and the Python service rebuilds its in-memory state when the enrollment directory changes so the identity set can evolve during development. This keeps Maya optimized for a single local operator session, fast iterative testing, and a privacy-preserving deployment model where all sensitive recognition logic and data remain on the device.

### How to Run ?

- Just run `bun run dev` in the root of the repo, and it will start both the Bun server and the Python service concurrently. Then open `http://localhost:3000` in a browser that supports WebRTC and WebSockets, allow camera access, and you should see the live recognition overlay in action. The default enrollment set includes a few sample identities, but you can modify or expand it by adding new directories with face images and updating the corresponding `metadata.json` files.
