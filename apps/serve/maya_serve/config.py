from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Settings:
    host: str
    port: int
    enrollment_sync_base_url: str | None
    enrollment_sync_enabled: bool
    model_pack: str
    model_root: str
    detector_width: int
    detector_height: int
    match_threshold: float
    match_top_k: int
    match_margin_threshold: float
    min_detection_confidence: float
    reload_interval_seconds: float
    tracking_enabled: bool
    tracker_activation_threshold: float
    tracker_matching_threshold: float
    tracker_lost_buffer: int
    tracker_minimum_consecutive_frames: int
    tracker_frame_rate: int
    tracker_box_smoothing_alpha: float
    tracker_identity_switch_hits: int
    tracker_stable_confidence_floor: float
    tracker_track_hold_ms: int

    @property
    def detector_size(self) -> tuple[int, int]:
        return (self.detector_width, self.detector_height)


def load_settings() -> Settings:
    return Settings(
        host="127.0.0.1",
        port=8765,
        enrollment_sync_base_url="https://r2-maya.singularityworks.xyz",
        enrollment_sync_enabled=True,
        model_pack="buffalo_l",
        model_root=".insightface",
        detector_width=320,
        detector_height=320,
        match_threshold=0.55,
        match_top_k=5,
        match_margin_threshold=0.04,
        min_detection_confidence=0.5,
        reload_interval_seconds=2.0,
        tracking_enabled=True,
        tracker_activation_threshold=0.35,
        tracker_matching_threshold=0.8,
        tracker_lost_buffer=10,
        tracker_minimum_consecutive_frames=1,
        tracker_frame_rate=6,
        tracker_box_smoothing_alpha=0.58,
        tracker_identity_switch_hits=2,
        tracker_stable_confidence_floor=0.48,
        tracker_track_hold_ms=4_000,
    )
