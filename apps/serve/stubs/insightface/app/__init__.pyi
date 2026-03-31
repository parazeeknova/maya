from __future__ import annotations

import numpy as np

class Face:
    bbox: np.ndarray
    embedding: np.ndarray
    normed_embedding: np.ndarray | None

class FaceAnalysis:
    def __init__(
        self,
        name: str = "buffalo_l",
        root: str = "~/.insightface",
        allowed_modules: list[str] | None = None,
        **kwargs: object,
    ) -> None: ...
    def prepare(
        self,
        ctx_id: int,
        det_thresh: float = 0.5,
        det_size: tuple[int, int] = (640, 640),
    ) -> None: ...
    def get(self, img: np.ndarray, max_num: int = 0) -> list[Face]: ...
