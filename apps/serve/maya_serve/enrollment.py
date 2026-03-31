from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


@dataclass(frozen=True, slots=True)
class IdentityMetadata:
    id: str
    name: str
    role: str
    color: str


@dataclass(frozen=True, slots=True)
class EnrollmentSource:
    metadata: IdentityMetadata
    image_paths: tuple[Path, ...]


def directory_signature(root: Path) -> tuple[tuple[str, int, int], ...]:
    if not root.exists():
        return tuple()

    entries: list[tuple[str, int, int]] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        stat = path.stat()
        entries.append((str(path.relative_to(root)), stat.st_mtime_ns, stat.st_size))
    return tuple(entries)


def scan_enrollment_sources(root: Path) -> tuple[list[EnrollmentSource], list[str]]:
    sources: list[EnrollmentSource] = []
    warnings: list[str] = []

    if not root.exists():
        warnings.append(f"Enrollment directory does not exist: {root}")
        return sources, warnings

    for identity_dir in sorted(
        path
        for path in root.iterdir()
        if path.is_dir() and not path.name.startswith(".")
    ):
        metadata = _load_metadata(identity_dir)
        image_paths = tuple(
            sorted(
                path
                for path in identity_dir.iterdir()
                if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
            )
        )

        if not image_paths:
            warnings.append(
                f"Skipping '{identity_dir.name}' because it has no reference images."
            )
            continue

        sources.append(EnrollmentSource(metadata=metadata, image_paths=image_paths))

    return sources, warnings


def _load_metadata(identity_dir: Path) -> IdentityMetadata:
    metadata_path = identity_dir / "metadata.json"
    if metadata_path.exists():
        raw_payload: object = json.loads(metadata_path.read_text(encoding="utf-8"))
        if not isinstance(raw_payload, dict):
            raise ValueError(f"Expected object metadata in {metadata_path}")
        payload = cast(dict[str, Any], raw_payload)
    else:
        payload = {}

    name = _string_value(
        payload.get("name"),
        identity_dir.name.replace("-", " ").title(),
    )
    role = _string_value(payload.get("role"), "Unspecified")
    color = _string_value(payload.get("color"), "#38bdf8")

    return IdentityMetadata(id=identity_dir.name, name=name, role=role, color=color)


def _string_value(value: object, fallback: str) -> str:
    return value if isinstance(value, str) and value else fallback
