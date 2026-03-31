from __future__ import annotations

import asyncio
import base64
import contextlib
import ctypes
import io
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

import faiss
import numpy as np
import onnxruntime as ort
from insightface.app import FaceAnalysis
from PIL import Image

from .config import Settings
from .enrollment import IdentityMetadata, directory_signature, scan_enrollment_sources
from .protocol import dumps, expect_type, parse_message
from .tracking import MatchCandidate, TrackingController

if TYPE_CHECKING:
    from insightface.app import Face


@dataclass(frozen=True, slots=True)
class IdentityRecord:
    metadata: IdentityMetadata
    references: int


@dataclass(frozen=True, slots=True)
class IndexState:
    version: int
    signature: tuple[tuple[str, int, int], ...]
    records: tuple[IdentityRecord, ...]
    index: faiss.IndexFlatIP | None
    reference_identity_ids: tuple[str, ...]
    warnings: tuple[str, ...]


class FaceRecognitionService:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._analysis, self._providers = self._build_face_analysis()
        self._tracking = (
            TrackingController(settings) if settings.tracking_enabled else None
        )
        self._index_state = IndexState(
            version=0,
            signature=tuple(),
            records=tuple(),
            index=None,
            reference_identity_ids=tuple(),
            warnings=tuple(),
        )
        self._index_lock = asyncio.Lock()
        self._reload_task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        await asyncio.to_thread(self.rebuild_index, True)
        self._reload_task = asyncio.create_task(self._reload_loop())

    async def stop(self) -> None:
        if self._reload_task is not None:
            self._reload_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._reload_task

    def ready_message(self) -> dict[str, Any]:
        return {
            "type": "service.ready",
            "providers": self._providers,
            "detectorSize": {
                "width": self._settings.detector_width,
                "height": self._settings.detector_height,
            },
            "trackingEnabled": self._tracking is not None,
            "matchThreshold": self._settings.match_threshold,
            "recognitionConfig": {
                "marginThreshold": self._settings.match_margin_threshold,
                "minDetectionConfidence": self._settings.min_detection_confidence,
                "topK": self._settings.match_top_k,
            },
            "enrollment": {
                "directory": str(self._settings.enrollment_dir),
                "identities": len(self._index_state.records),
                "version": self._index_state.version,
                "warnings": list(self._index_state.warnings),
            },
            "trackingConfig": {
                "boxSmoothingAlpha": self._settings.tracker_box_smoothing_alpha,
                "identitySwitchHits": self._settings.tracker_identity_switch_hits,
                "trackHoldMs": self._settings.tracker_track_hold_ms,
            },
        }

    async def handle_raw_message(self, message: str | bytes) -> str:
        payload = parse_message(message)
        expect_type(payload, "frame.process")
        response = await asyncio.to_thread(self._process_frame, payload)
        return dumps(response)

    def rebuild_index(self, force: bool = False) -> bool:
        signature = directory_signature(self._settings.enrollment_dir)
        if not force and signature == self._index_state.signature:
            return False

        sources, warnings = scan_enrollment_sources(self._settings.enrollment_dir)
        records: list[IdentityRecord] = []
        reference_identity_ids: list[str] = []
        vectors: list[np.ndarray] = []

        for source in sources:
            embeddings = self._load_identity_embeddings(source.image_paths, warnings)
            if not embeddings:
                warnings.append(
                    "Skipping "
                    f"'{source.metadata.id}' because no usable faces "
                    "were found in its references."
                )
                continue

            for embedding in embeddings:
                vectors.append(embedding.astype(np.float32))
                reference_identity_ids.append(source.metadata.id)
            records.append(
                IdentityRecord(
                    metadata=source.metadata,
                    references=len(embeddings),
                )
            )

        if vectors:
            matrix = np.vstack(vectors).astype(np.float32)
            index = faiss.IndexFlatIP(matrix.shape[1])
            index.add(matrix)
        else:
            index = None

        self._index_state = IndexState(
            version=self._index_state.version + 1,
            signature=signature,
            records=tuple(records),
            index=index,
            reference_identity_ids=tuple(reference_identity_ids),
            warnings=tuple(warnings),
        )

        if self._tracking is not None:
            self._tracking.reset()

        return True

    def _build_face_analysis(self) -> tuple[FaceAnalysis, list[str]]:
        available = ort.get_available_providers()
        providers = [
            provider for provider in ("CPUExecutionProvider",) if provider in available
        ]
        if "CUDAExecutionProvider" in available and _cuda_runtime_is_compatible():
            providers.insert(0, "CUDAExecutionProvider")
        if not providers:
            providers = ["CPUExecutionProvider"]

        ctx_id = 0 if "CUDAExecutionProvider" in providers else -1
        analysis = FaceAnalysis(
            name=self._settings.model_pack,
            root=str(self._settings.model_root),
            allowed_modules=["detection", "recognition"],
            providers=providers,
        )
        analysis.prepare(ctx_id=ctx_id, det_size=self._settings.detector_size)
        return analysis, providers

    def _load_identity_embeddings(
        self,
        image_paths: tuple[Path, ...],
        warnings: list[str],
    ) -> list[np.ndarray]:
        embeddings: list[np.ndarray] = []
        for image_path in image_paths:
            image = self._decode_image_bytes(image_path.read_bytes())
            faces = self._analysis.get(image)
            if not faces:
                warnings.append(
                    f"No face detected in enrollment image {image_path.name}."
                )
                continue

            face = max(faces, key=lambda candidate: _box_area(candidate.bbox))
            embeddings.append(_normalized_embedding(face))

        return embeddings

    def _process_frame(self, payload: dict[str, Any]) -> dict[str, Any]:
        started_at = time.time_ns()

        session_id = str(payload["sessionId"])
        frame_id = int(payload["frameId"])
        sample_interval_ms = int(payload.get("sampleIntervalMs", 180))
        image_payload = payload["image"]
        captured_at = int(payload.get("capturedAt", 0))
        width = int(image_payload["width"])
        height = int(image_payload["height"])
        image = self._decode_image_payload(str(image_payload["data"]))

        faces = [
            face
            for face in self._analysis.get(image)
            if float(getattr(face, "det_score", 1.0))
            >= self._settings.min_detection_confidence
        ]
        boxes = [np.asarray(face.bbox, dtype=np.float32) for face in faces]
        candidates = [self._match_face(face) for face in faces]
        scores = [float(getattr(face, "det_score", 1.0)) for face in faces]
        tracked_faces = (
            self._tracking.update(
                boxes=boxes,
                candidates=candidates,
                scores=scores,
                now_ms=time.time_ns() // 1_000_000,
            )
            if self._tracking is not None
            else []
        )

        results: list[dict[str, Any]] = []
        for index, face in enumerate(faces):
            tracked_face = tracked_faces[index] if tracked_faces else None
            candidate = (
                tracked_face.candidate
                if tracked_face is not None
                else candidates[index]
            )
            metadata = self._metadata_for(candidate.identity_id)
            bbox = _bbox_payload(
                tracked_face.bbox if tracked_face is not None else face.bbox
            )
            result = {
                "detConfidence": round(scores[index], 4),
                "bbox": bbox,
                "confidence": round(candidate.confidence, 4),
                "isUnknown": candidate.is_unknown,
                "trackAgeFrames": (
                    tracked_face.track_age_frames if tracked_face is not None else 1
                ),
                "trackId": tracked_face.track_id if tracked_face is not None else None,
                "identity": (
                    {
                        "id": metadata.id,
                        "name": metadata.name,
                        "role": metadata.role,
                        "color": metadata.color,
                    }
                    if metadata is not None
                    else None
                ),
            }
            results.append(result)

        ended_at = time.time_ns()

        return {
            "type": "frame.result",
            "sessionId": session_id,
            "frameId": frame_id,
            "capturedAt": captured_at,
            "sampleIntervalMs": sample_interval_ms,
            "sourceSize": {"width": width, "height": height},
            "latencyMs": round((ended_at - started_at) / 1_000_000, 2),
            "providers": self._providers,
            "indexVersion": self._index_state.version,
            "faces": results,
        }

    def _match_face(self, face: Face) -> MatchCandidate:
        state = self._index_state
        if state.index is None or not state.records:
            return MatchCandidate(identity_id=None, confidence=0.0, is_unknown=True)

        embedding = _normalized_embedding(face).reshape(1, -1)
        top_k = min(self._settings.match_top_k, len(state.reference_identity_ids))
        distances, indices = state.index.search(embedding, top_k)
        scores_by_identity: dict[str, list[float]] = {}

        for score, match_index in zip(distances[0], indices[0], strict=True):
            if match_index < 0:
                continue
            identity_id = state.reference_identity_ids[int(match_index)]
            scores_by_identity.setdefault(identity_id, []).append(float(score))

        if not scores_by_identity:
            return MatchCandidate(identity_id=None, confidence=0.0, is_unknown=True)

        ranked_identities = sorted(
            (
                (
                    _aggregate_identity_score(identity_scores),
                    identity_id,
                )
                for identity_id, identity_scores in scores_by_identity.items()
            ),
            reverse=True,
        )
        best_score, best_identity_id = ranked_identities[0]
        second_score = ranked_identities[1][0] if len(ranked_identities) > 1 else 0.0

        if (
            best_score < self._settings.match_threshold
            or (best_score - second_score) < self._settings.match_margin_threshold
        ):
            return MatchCandidate(
                identity_id=None,
                confidence=best_score,
                is_unknown=True,
            )

        return MatchCandidate(
            identity_id=best_identity_id,
            confidence=best_score,
            is_unknown=False,
        )

    def _metadata_for(self, identity_id: str | None) -> IdentityMetadata | None:
        if identity_id is None:
            return None

        for record in self._index_state.records:
            if record.metadata.id == identity_id:
                return record.metadata
        return None

    def _decode_image_payload(self, data: str) -> np.ndarray:
        return self._decode_image_bytes(base64.b64decode(data))

    def _decode_image_bytes(self, data: bytes) -> np.ndarray:
        image = Image.open(io.BytesIO(data)).convert("RGB")
        rgb = np.asarray(image, dtype=np.uint8)
        return np.ascontiguousarray(rgb[:, :, ::-1])

    async def _reload_loop(self) -> None:
        while True:
            await asyncio.sleep(self._settings.reload_interval_seconds)
            async with self._index_lock:
                await asyncio.to_thread(self.rebuild_index, False)


def _normalized_embedding(face: Face) -> np.ndarray:
    normed = getattr(face, "normed_embedding", None)
    if normed is not None:
        return np.asarray(normed, dtype=np.float32)

    embedding = np.asarray(face.embedding, dtype=np.float32)
    faiss.normalize_L2(embedding.reshape(1, -1))
    return embedding


def _bbox_payload(raw_bbox: np.ndarray) -> dict[str, float]:
    x1, y1, x2, y2 = np.asarray(raw_bbox, dtype=np.float32)
    return {
        "x": round(float(x1), 2),
        "y": round(float(y1), 2),
        "width": round(float(x2 - x1), 2),
        "height": round(float(y2 - y1), 2),
    }


def _box_area(raw_bbox: np.ndarray) -> float:
    x1, y1, x2, y2 = np.asarray(raw_bbox, dtype=np.float32)
    return float(max(0.0, x2 - x1) * max(0.0, y2 - y1))


def _aggregate_identity_score(scores: list[float]) -> float:
    best_score = max(scores)
    mean_score = float(np.mean(scores, dtype=np.float32))
    return (best_score * 0.8) + (mean_score * 0.2)


def _cuda_runtime_is_compatible() -> bool:
    required_libraries = (
        "libcublasLt.so.12",
        "libcublas.so.12",
        "libcudart.so.12",
        "libcufft.so.11",
        "libcudnn.so.9",
    )

    for library in required_libraries:
        try:
            ctypes.CDLL(library)
        except OSError:
            return False

    return True
