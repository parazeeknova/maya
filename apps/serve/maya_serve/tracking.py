from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
import supervision as sv

from .config import Settings


@dataclass(frozen=True, slots=True)
class MatchCandidate:
    identity_id: str | None
    confidence: float
    is_unknown: bool


@dataclass(frozen=True, slots=True)
class TrackedFace:
    bbox: np.ndarray
    candidate: MatchCandidate
    track_age_frames: int
    track_id: int | None


@dataclass(slots=True)
class TrackMemory:
    bbox: np.ndarray
    candidate: MatchCandidate
    hold_unknown_frames: int
    last_seen_ms: int
    pending_candidate: MatchCandidate | None
    pending_hits: int
    seen_frames: int
    velocity: np.ndarray


class TrackingController:
    def __init__(self, settings: Settings) -> None:
        self._tracker = sv.ByteTrack(
            track_activation_threshold=settings.tracker_activation_threshold,
            lost_track_buffer=settings.tracker_lost_buffer,
            minimum_matching_threshold=settings.tracker_matching_threshold,
            minimum_consecutive_frames=settings.tracker_minimum_consecutive_frames,
            frame_rate=settings.tracker_frame_rate,
        )
        self._box_smoothing_alpha = settings.tracker_box_smoothing_alpha
        self._identity_switch_hits = settings.tracker_identity_switch_hits
        self._max_unknown_hold = 2
        self._memory: dict[int, TrackMemory] = {}
        self._stable_confidence_floor = settings.tracker_stable_confidence_floor
        self._stale_track_window_ms = settings.tracker_track_hold_ms

    def reset(self) -> None:
        self._tracker.reset()
        self._memory.clear()

    def update(
        self,
        boxes: Sequence[np.ndarray],
        candidates: Sequence[MatchCandidate],
        scores: Sequence[float],
        now_ms: int,
    ) -> list[TrackedFace]:
        self._prune(now_ms)
        if not boxes:
            return []

        track_ids = self._assign_track_ids(boxes, scores)
        tracked_faces: list[TrackedFace] = []

        for bbox, candidate, track_id in zip(boxes, candidates, track_ids, strict=True):
            if track_id is None:
                tracked_faces.append(
                    TrackedFace(
                        bbox=bbox,
                        candidate=candidate,
                        track_age_frames=1,
                        track_id=None,
                    )
                )
                continue

            tracked_faces.append(self._update_memory(track_id, bbox, candidate, now_ms))

        return tracked_faces

    def _assign_track_ids(
        self,
        boxes: Sequence[np.ndarray],
        scores: Sequence[float],
    ) -> list[int | None]:
        xyxy = np.asarray(boxes, dtype=np.float32)
        confidence = np.asarray(scores, dtype=np.float32)
        class_id = np.zeros((len(boxes),), dtype=np.int32)
        detections = sv.Detections(
            xyxy=xyxy,
            confidence=confidence,
            class_id=class_id,
        )
        tracked = self._tracker.update_with_detections(detections)
        tracked_ids = getattr(tracked, "tracker_id", None)
        if tracked_ids is None:
            return [None for _ in boxes]

        tracked_boxes = np.asarray(tracked.xyxy, dtype=np.float32)
        aligned: list[int | None] = [None for _ in boxes]
        used_indices: set[int] = set()

        for original_index, original_box in enumerate(xyxy):
            best_iou = 0.0
            best_match: int | None = None

            for tracked_index, tracked_box in enumerate(tracked_boxes):
                if tracked_index in used_indices:
                    continue
                iou = _intersection_over_union(original_box, tracked_box)
                if iou > best_iou:
                    best_iou = iou
                    best_match = tracked_index

            if best_match is None:
                continue

            used_indices.add(best_match)
            tracker_id = tracked_ids[best_match]
            aligned[original_index] = (
                int(tracker_id) if tracker_id is not None else None
            )

        return aligned

    def _update_memory(
        self,
        track_id: int,
        bbox: np.ndarray,
        candidate: MatchCandidate,
        now_ms: int,
    ) -> TrackedFace:
        memory = self._memory.get(track_id)
        if memory is None:
            memory = TrackMemory(
                bbox=bbox.copy(),
                candidate=candidate,
                hold_unknown_frames=0,
                last_seen_ms=now_ms,
                pending_candidate=None,
                pending_hits=0,
                seen_frames=1,
                velocity=np.zeros_like(bbox, dtype=np.float32),
            )
            self._memory[track_id] = memory
            return TrackedFace(
                bbox=memory.bbox.copy(),
                candidate=memory.candidate,
                track_age_frames=memory.seen_frames,
                track_id=track_id,
            )

        smoothed_bbox = _smooth_bbox(
            current_bbox=memory.bbox,
            next_bbox=bbox,
            alpha=self._box_smoothing_alpha,
        )
        memory.velocity = smoothed_bbox - memory.bbox
        memory.bbox = smoothed_bbox
        memory.last_seen_ms = now_ms
        memory.seen_frames += 1
        memory.candidate = self._resolve_candidate(memory, candidate)

        return TrackedFace(
            bbox=memory.bbox.copy(),
            candidate=memory.candidate,
            track_age_frames=memory.seen_frames,
            track_id=track_id,
        )

    def _resolve_candidate(
        self,
        memory: TrackMemory,
        candidate: MatchCandidate,
    ) -> MatchCandidate:
        resolved_candidate = candidate

        if candidate.is_unknown:
            if not memory.candidate.is_unknown:
                memory.hold_unknown_frames += 1
                if memory.hold_unknown_frames <= self._max_unknown_hold:
                    return memory.candidate

            memory.pending_candidate = None
            memory.pending_hits = 0
        elif memory.candidate.is_unknown:
            memory.hold_unknown_frames = 0
            memory.pending_candidate = None
            memory.pending_hits = 0
        elif candidate.identity_id == memory.candidate.identity_id:
            memory.hold_unknown_frames = 0
            memory.pending_candidate = None
            memory.pending_hits = 0
            resolved_candidate = MatchCandidate(
                identity_id=candidate.identity_id,
                confidence=max(candidate.confidence, memory.candidate.confidence),
                is_unknown=False,
            )
        elif (
            memory.candidate.confidence >= self._stable_confidence_floor
            and candidate.confidence <= memory.candidate.confidence
        ):
            resolved_candidate = memory.candidate
        else:
            memory.hold_unknown_frames = 0
            if memory.pending_candidate == candidate:
                memory.pending_hits += 1
            else:
                memory.pending_candidate = candidate
                memory.pending_hits = 1

            if memory.pending_hits < self._identity_switch_hits:
                resolved_candidate = memory.candidate
            else:
                memory.pending_candidate = None
                memory.pending_hits = 0

        return resolved_candidate

    def _prune(self, now_ms: int) -> None:
        stale = [
            track_id
            for track_id, memory in self._memory.items()
            if now_ms - memory.last_seen_ms > self._stale_track_window_ms
        ]
        for track_id in stale:
            self._memory.pop(track_id, None)


def _intersection_over_union(a: np.ndarray, b: np.ndarray) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b

    inter_x1 = max(ax1, bx1)
    inter_y1 = max(ay1, by1)
    inter_x2 = min(ax2, bx2)
    inter_y2 = min(ay2, by2)

    inter_w = max(0.0, inter_x2 - inter_x1)
    inter_h = max(0.0, inter_y2 - inter_y1)
    intersection = inter_w * inter_h
    if intersection <= 0.0:
        return 0.0

    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - intersection
    return 0.0 if union <= 0.0 else float(intersection / union)


def _smooth_bbox(
    current_bbox: np.ndarray,
    next_bbox: np.ndarray,
    alpha: float,
) -> np.ndarray:
    return ((1.0 - alpha) * current_bbox) + (alpha * next_bbox)
