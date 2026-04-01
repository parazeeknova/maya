from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast
from urllib.parse import quote
from urllib.request import urlopen

from .config import Settings


def sync_enrollment_from_remote(settings: Settings) -> bool:
    if (
        not settings.enrollment_sync_enabled
        or settings.enrollment_sync_base_url is None
    ):
        return False

    base_url = settings.enrollment_sync_base_url.rstrip("/")
    manifest = _fetch_manifest(base_url)
    identities = _parse_identities(manifest)
    root = settings.enrollment_dir
    root.mkdir(parents=True, exist_ok=True)

    active_ids: set[str] = set()
    for identity in identities:
        identity_id = _sync_identity(base_url, identity, root)
        active_ids.add(identity_id)

    _prune_removed_identities(root, active_ids)
    return True


def _fetch_manifest(base_url: str) -> object:
    manifest_url = f"{base_url}/manifest.json"
    with urlopen(manifest_url) as response:
        return json.loads(response.read().decode("utf-8"))


def _parse_identities(manifest: object) -> list[dict[str, object]]:
    if not isinstance(manifest, dict):
        raise ValueError("Enrollment manifest must be a JSON object.")

    manifest_dict = cast(dict[str, Any], manifest)
    identities = manifest_dict.get("identities")
    if not isinstance(identities, list):
        raise ValueError("Enrollment manifest must contain an identities list.")

    parsed: list[dict[str, object]] = []
    for identity in cast(list[object], identities):
        if not isinstance(identity, dict):
            raise ValueError("Each manifest identity must be a JSON object.")
        parsed.append(cast(dict[str, object], identity))
    return parsed


def _sync_identity(
    base_url: str,
    identity: dict[str, object],
    root: Path,
) -> str:
    identity_id = identity.get("id")
    files = identity.get("files")
    if not isinstance(identity_id, str) or not isinstance(files, list):
        raise ValueError("Manifest identity must include id and files.")

    target_dir = root / identity_id
    target_dir.mkdir(parents=True, exist_ok=True)
    _write_metadata(identity.get("metadata"), target_dir)

    expected_files: set[str] = set()
    for filename_value in cast(list[object], files):
        filename = filename_value
        if not isinstance(filename, str):
            raise ValueError("Manifest file entries must be strings.")
        expected_files.add(filename)
        _download_file(base_url, identity_id, filename, target_dir)

    _prune_removed_files(target_dir, expected_files)
    return identity_id


def _write_metadata(metadata: object, target_dir: Path) -> None:
    if not isinstance(metadata, dict):
        return

    (target_dir / "metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=True),
        encoding="utf-8",
    )


def _download_file(
    base_url: str,
    identity_id: str,
    filename: str,
    target_dir: Path,
) -> None:
    file_url = f"{base_url}/{quote(identity_id)}/{quote(filename)}"
    with urlopen(file_url) as response:
        (target_dir / filename).write_bytes(response.read())


def _prune_removed_files(target_dir: Path, expected_files: set[str]) -> None:
    for existing in target_dir.iterdir():
        if existing.name == "metadata.json":
            continue
        if existing.name not in expected_files:
            existing.unlink()


def _prune_removed_identities(root: Path, active_ids: set[str]) -> None:
    for existing_dir in root.iterdir():
        if not existing_dir.is_dir() or existing_dir.name.startswith("."):
            continue
        if existing_dir.name in active_ids:
            continue
        for path in existing_dir.iterdir():
            if path.is_file():
                path.unlink()
        existing_dir.rmdir()
