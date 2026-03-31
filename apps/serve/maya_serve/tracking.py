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


@dataclass(slots=True)
class TrackMemory:
    candidate: MatchCandidate
    last_seen_ms: int
    hold_unknown_frames: int = 0


class TrackingController:
    def __init__(self, settings: Settings) -> None:
        self._tracker = sv.ByteTrack(
            track_activation_threshold=settings.tracker_activation_threshold,
            lost_track_buffer=settings.tracker_lost_buffer,
            minimum_matching_threshold=settings.tracker_matching_threshold,
            minimum_consecutive_frames=settings.tracker_minimum_consecutive_frames,
            frame_rate=settings.tracker_frame_rate,
        )
        self._memory: dict[int, TrackMemory] = {}
        self._max_unknown_hold = 2
        self._stale_track_window_ms = 5_000

    def reset(self) -> None:
        self._tracker.reset()
        self._memory.clear()

    def assign_track_ids(self, boxes: Sequence[np.ndarray]) -> list[int | None]:
        if not boxes:
            return []

        xyxy = np.asarray(boxes, dtype=np.float32)
        confidence = np.ones((len(boxes),), dtype=np.float32)
        class_id = np.zeros((len(boxes),), dtype=np.int32)
        detections = sv.Detections(
            xyxy=xyxy,
            confidence=confidence,
            class_id=class_id,
        )
        tracked = self._tracker.update_with_detections(detections)
        tracked_ids = getattr(tracked, "tracker_id", None)
        if tracked_ids is None:
            empty: list[int | None] = [None for _ in boxes]
            return empty

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

    def stabilize(
        self,
        track_id: int | None,
        candidate: MatchCandidate,
        now_ms: int,
    ) -> MatchCandidate:
        self._prune(now_ms)
        if track_id is None:
            return candidate

        memory = self._memory.get(track_id)
        if candidate.is_unknown:
            if memory and not memory.candidate.is_unknown:
                memory.last_seen_ms = now_ms
                memory.hold_unknown_frames += 1
                if memory.hold_unknown_frames <= self._max_unknown_hold:
                    return memory.candidate

            self._memory[track_id] = TrackMemory(
                candidate=candidate,
                last_seen_ms=now_ms,
            )
            return candidate

        stabilized = MatchCandidate(
            identity_id=candidate.identity_id,
            confidence=max(
                candidate.confidence,
                memory.candidate.confidence if memory else 0.0,
            ),
            is_unknown=False,
        )
        self._memory[track_id] = TrackMemory(
            candidate=stabilized,
            last_seen_ms=now_ms,
        )
        return stabilized

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
