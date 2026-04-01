from __future__ import annotations

import asyncio
import base64
import contextlib
import ctypes
import io
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

import faiss
import numpy as np
import onnxruntime as ort
from insightface.app import FaceAnalysis
from PIL import Image, ImageOps

from .config import Settings
from .enrollment import (
    EnrollmentImage,
    EnrollmentSource,
    IdentityMetadata,
    SourceSignature,
    build_source,
    source_signature,
)
from .enrollment_sync import load_remote_enrollment_sources
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
    diagnostics: tuple[dict[str, Any], ...]
    version: int
    signature: SourceSignature
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
            diagnostics=tuple(),
            version=0,
            signature=tuple(),
            records=tuple(),
            index=None,
            reference_identity_ids=tuple(),
            warnings=tuple(),
        )
        self._enrollment_sources: tuple[EnrollmentSource, ...] = tuple()
        self._index_lock = asyncio.Lock()
        self._reload_task: asyncio.Task[None] | None = None
        self._sync_warning: str | None = None

    async def start(self) -> None:
        if self._settings.enrollment_sync_enabled:
            await self._sync_remote_enrollment()
        await asyncio.to_thread(self.rebuild_index, True)
        self._reload_task = asyncio.create_task(self._reload_loop())

    async def refresh_enrollment(self) -> bool:
        async with self._index_lock:
            if self._settings.enrollment_sync_enabled:
                await self._sync_remote_enrollment()
            return await asyncio.to_thread(self.rebuild_index, True)

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
                "diagnostics": list(self._index_state.diagnostics),
                "identities": len(self._index_state.records),
                "source": self._settings.enrollment_sync_base_url or "memory",
                "version": self._index_state.version,
                "warnings": [
                    *list(self._index_state.warnings),
                    *([self._sync_warning] if self._sync_warning is not None else []),
                ],
            },
            "trackingConfig": {
                "boxSmoothingAlpha": self._settings.tracker_box_smoothing_alpha,
                "identitySwitchHits": self._settings.tracker_identity_switch_hits,
                "trackHoldMs": self._settings.tracker_track_hold_ms,
            },
        }

    async def handle_raw_message(self, message: str | bytes) -> str:
        payload = parse_message(message)
        message_type = payload.get("type")
        if message_type == "frame.process":
            response = await asyncio.to_thread(self._process_frame, payload)
        elif message_type == "admin.upsert-identity":
            response = await self._handle_admin_upsert(payload)
        elif message_type == "admin.delete-identity":
            response = await self._handle_admin_delete(payload)
        else:
            expect_type(payload, "frame.process")
            raise AssertionError("Unreachable")
        return dumps(response)

    async def _handle_admin_upsert(self, payload: dict[str, Any]) -> dict[str, Any]:
        identity_id = payload.get("id")
        metadata = payload.get("metadata")
        files = payload.get("files")
        if (
            not isinstance(identity_id, str)
            or not isinstance(metadata, dict)
            or not isinstance(files, list)
        ):
            raise ValueError("Invalid admin upsert payload.")

        metadata_payload = cast(dict[str, Any], metadata)
        file_payloads = cast(list[object], files)
        source = build_source(
            identity_id,
            metadata_payload,
            tuple(self._parse_admin_images(file_payloads)),
        )

        async with self._index_lock:
            self._enrollment_sources = tuple(
                sorted(
                    (
                        *(
                            existing
                            for existing in self._enrollment_sources
                            if existing.metadata.id != identity_id
                        ),
                        source,
                    ),
                    key=lambda candidate: candidate.metadata.id,
                )
            )
            changed = await asyncio.to_thread(self.rebuild_index, True)
        return {
            "changed": changed,
            "enrollment": self.ready_message()["enrollment"],
            "status": "ok",
            "type": "admin.result",
        }

    async def _handle_admin_delete(self, payload: dict[str, Any]) -> dict[str, Any]:
        identity_id = payload.get("id")
        if not isinstance(identity_id, str):
            raise ValueError("Invalid admin delete payload.")

        async with self._index_lock:
            self._enrollment_sources = tuple(
                source
                for source in self._enrollment_sources
                if source.metadata.id != identity_id
            )
            changed = await asyncio.to_thread(self.rebuild_index, True)
        return {
            "changed": changed,
            "enrollment": self.ready_message()["enrollment"],
            "status": "ok",
            "type": "admin.result",
        }

    def rebuild_index(self, force: bool = False) -> bool:
        signature = source_signature(self._enrollment_sources)
        if not force and signature == self._index_state.signature:
            return False

        sources = self._enrollment_sources
        warnings: list[str] = []
        diagnostics: list[dict[str, Any]] = []
        records: list[IdentityRecord] = []
        reference_identity_ids: list[str] = []
        vectors: list[np.ndarray] = []

        for source in sources:
            if not source.images:
                warning = (
                    f"Skipping '{source.metadata.id}' because it has "
                    "no reference images."
                )
                warnings.append(warning)
                diagnostics.append(
                    {
                        "embeddingCount": 0,
                        "fileCount": 0,
                        "id": source.metadata.id,
                        "name": source.metadata.name,
                        "warnings": [warning],
                    }
                )
                continue

            embeddings, embedding_warnings = self._load_identity_embeddings(
                source.images,
            )
            if not embeddings:
                warning = (
                    "Skipping "
                    f"'{source.metadata.id}' because no usable faces "
                    "were found in its references."
                )
                warnings.append(warning)
                diagnostics.append(
                    {
                        "embeddingCount": 0,
                        "fileCount": len(source.images),
                        "id": source.metadata.id,
                        "name": source.metadata.name,
                        "warnings": [*embedding_warnings, warning],
                    }
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
            diagnostics.append(
                {
                    "embeddingCount": len(embeddings),
                    "fileCount": len(source.images),
                    "id": source.metadata.id,
                    "name": source.metadata.name,
                    "warnings": embedding_warnings,
                }
            )
            warnings.extend(embedding_warnings)

        if vectors:
            matrix = np.vstack(vectors).astype(np.float32)
            index = faiss.IndexFlatIP(matrix.shape[1])
            index.add(matrix)
        else:
            index = None

        self._index_state = IndexState(
            diagnostics=tuple(diagnostics),
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
        images: tuple[EnrollmentImage, ...],
    ) -> tuple[list[np.ndarray], list[str]]:
        embeddings: list[np.ndarray] = []
        warnings: list[str] = []
        for image_payload in images:
            image = self._decode_image_bytes(image_payload.data)
            faces = self._analysis.get(image)
            if not faces:
                warnings.append(
                    f"No face detected in enrollment image {image_payload.name}."
                )
                continue

            face = max(faces, key=lambda candidate: _box_area(candidate.bbox))
            embeddings.append(_normalized_embedding(face))

        return embeddings, warnings

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
        image = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
        rgb = np.asarray(image, dtype=np.uint8)
        return np.ascontiguousarray(rgb[:, :, ::-1])

    async def _reload_loop(self) -> None:
        while True:
            await asyncio.sleep(self._settings.reload_interval_seconds)
            async with self._index_lock:
                if self._settings.enrollment_sync_enabled:
                    await self._sync_remote_enrollment()
                await asyncio.to_thread(self.rebuild_index, False)

    async def _sync_remote_enrollment(self) -> None:
        try:
            self._enrollment_sources = await asyncio.to_thread(
                load_remote_enrollment_sources,
                self._settings,
            )
            self._sync_warning = None
        except Exception as error:
            self._sync_warning = (
                f"Remote enrollment sync failed: {error.__class__.__name__}: {error}"
            )

    def _parse_admin_images(
        self,
        file_payloads: list[object],
    ) -> list[EnrollmentImage]:
        images: list[EnrollmentImage] = []
        for file_payload in file_payloads:
            if not isinstance(file_payload, dict):
                raise ValueError("Invalid file payload.")
            file_data = cast(dict[str, Any], file_payload)
            filename = file_data.get("name")
            data = file_data.get("data")
            if not isinstance(filename, str) or not isinstance(data, str):
                raise ValueError("Invalid file payload.")
            images.append(
                EnrollmentImage(
                    data=base64.b64decode(data),
                    name=filename,
                )
            )
        return images


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
    required_device_nodes = ("/dev/nvidia0", "/dev/nvidiactl")
    required_libraries = (
        "libcublasLt.so.12",
        "libcublas.so.12",
        "libcudart.so.12",
        "libcufft.so.11",
        "libcudnn.so.9",
    )

    for device_node in required_device_nodes:
        if not Path(device_node).exists():
            _ensure_nvidia_device_nodes()
            break

    for device_node in required_device_nodes:
        if not Path(device_node).exists():
            return False

    for library in required_libraries:
        try:
            ctypes.CDLL(library)
        except OSError:
            return False

    return True


def _ensure_nvidia_device_nodes() -> None:
    executable = shutil.which("nvidia-modprobe")
    if executable is None:
        return

    subprocess.run(
        [executable, "-u", "-c=0"],
        check=False,
        stderr=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
    )
