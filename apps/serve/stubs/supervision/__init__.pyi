from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

@dataclass
class Detections:
    xyxy: np.ndarray
    mask: np.ndarray | None = None
    confidence: np.ndarray | None = None
    class_id: np.ndarray | None = None
    tracker_id: np.ndarray | None = None
    data: dict[str, np.ndarray | list[Any]] = ...
    metadata: dict[str, Any] = ...

class ByteTrack:
    def __init__(
        self,
        track_activation_threshold: float = 0.25,
        lost_track_buffer: int = 30,
        minimum_matching_threshold: float = 0.8,
        frame_rate: int = 30,
        minimum_consecutive_frames: int = 1,
    ) -> None: ...
    def reset(self) -> None: ...
    def update_with_detections(self, detections: Detections) -> Detections: ...
