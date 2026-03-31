from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _get_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def _get_int(name: str, default: int) -> int:
    value = os.getenv(name)
    return int(value) if value is not None else default


def _get_float(name: str, default: float) -> float:
    value = os.getenv(name)
    return float(value) if value is not None else default


@dataclass(frozen=True, slots=True)
class Settings:
    host: str
    port: int
    enrollment_dir: Path
    model_root: Path
    detector_width: int
    detector_height: int
    match_threshold: float
    reload_interval_seconds: float
    tracking_enabled: bool
    tracker_activation_threshold: float
    tracker_matching_threshold: float
    tracker_lost_buffer: int
    tracker_minimum_consecutive_frames: int
    tracker_frame_rate: int

    @property
    def detector_size(self) -> tuple[int, int]:
        return (self.detector_width, self.detector_height)


def load_settings() -> Settings:
    project_root = Path(__file__).resolve().parents[1]
    enrollment_dir = Path(
        os.getenv(
            "MAYA_ENROLLMENT_DIR",
            project_root / "data" / "enrolled",
        )
    ).resolve()

    return Settings(
        host=os.getenv("MAYA_SERVE_HOST", "127.0.0.1"),
        port=_get_int("MAYA_SERVE_PORT", 8765),
        enrollment_dir=enrollment_dir,
        model_root=Path(
            os.getenv("MAYA_MODEL_ROOT", project_root / ".insightface")
        ).resolve(),
        detector_width=_get_int("MAYA_DETECTOR_WIDTH", 640),
        detector_height=_get_int("MAYA_DETECTOR_HEIGHT", 640),
        match_threshold=_get_float("MAYA_MATCH_THRESHOLD", 0.55),
        reload_interval_seconds=_get_float("MAYA_RELOAD_INTERVAL_SECONDS", 2.0),
        tracking_enabled=_get_bool("MAYA_TRACKING_ENABLED", True),
        tracker_activation_threshold=_get_float(
            "MAYA_TRACKER_ACTIVATION_THRESHOLD",
            0.35,
        ),
        tracker_matching_threshold=_get_float(
            "MAYA_TRACKER_MATCHING_THRESHOLD",
            0.8,
        ),
        tracker_lost_buffer=_get_int("MAYA_TRACKER_LOST_BUFFER", 10),
        tracker_minimum_consecutive_frames=_get_int(
            "MAYA_TRACKER_MINIMUM_CONSECUTIVE_FRAMES",
            1,
        ),
        tracker_frame_rate=_get_int("MAYA_TRACKER_FRAME_RATE", 6),
    )
