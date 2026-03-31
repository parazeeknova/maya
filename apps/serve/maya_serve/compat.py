from __future__ import annotations

from typing import Any, cast

import numpy as np
from insightface.utils import face_align
from skimage import transform as trans


def install_runtime_compatibility_patches() -> None:
    estimate_norm_value = face_align.__dict__.get("estimate_norm")
    if callable(estimate_norm_value) and getattr(
        estimate_norm_value,
        "_maya_patched",
        False,
    ):
        return

    def estimate_norm(
        lmk: np.ndarray,
        image_size: int = 112,
        mode: str = "arcface",
    ) -> np.ndarray:
        del mode
        assert lmk.shape == (5, 2)
        assert image_size % 112 == 0 or image_size % 128 == 0
        if image_size % 112 == 0:
            ratio = float(image_size) / 112.0
            diff_x = 0.0
        else:
            ratio = float(image_size) / 128.0
            diff_x = 8.0 * ratio

        dst = face_align.arcface_dst * ratio
        dst[:, 0] += diff_x
        tform = cast(Any, trans.SimilarityTransform).from_estimate(lmk, dst)
        params = np.asarray(tform.params, dtype=np.float32)
        return params[0:2, :]

    estimate_norm._maya_patched = True  # type: ignore[attr-defined]
    face_align.estimate_norm = estimate_norm
