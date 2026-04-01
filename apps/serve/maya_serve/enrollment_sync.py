from __future__ import annotations

import json
from typing import Any, cast
from urllib.parse import quote
from urllib.request import urlopen

from .config import Settings
from .enrollment import EnrollmentImage, EnrollmentSource, build_source


def load_remote_enrollment_sources(settings: Settings) -> tuple[EnrollmentSource, ...]:
    if (
        not settings.enrollment_sync_enabled
        or settings.enrollment_sync_base_url is None
    ):
        return tuple()

    base_url = settings.enrollment_sync_base_url.rstrip("/")
    manifest = _fetch_manifest(base_url)
    identities = _parse_identities(manifest)
    return tuple(_load_identity(base_url, identity) for identity in identities)


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


def _load_identity(base_url: str, identity: dict[str, object]) -> EnrollmentSource:
    identity_id = identity.get("id")
    files = identity.get("files")
    if not isinstance(identity_id, str) or not isinstance(files, list):
        raise ValueError("Manifest identity must include id and files.")

    file_entries = cast(list[object], files)
    images = tuple(
        EnrollmentImage(
            data=_download_file(base_url, identity_id, filename),
            name=filename,
        )
        for filename in _parse_filenames(file_entries)
    )
    return build_source(identity_id, identity.get("metadata"), images)


def _parse_filenames(files: list[object]) -> tuple[str, ...]:
    parsed: list[str] = []
    for filename in files:
        if not isinstance(filename, str):
            raise ValueError("Manifest file entries must be strings.")
        parsed.append(filename)
    return tuple(parsed)


def _download_file(base_url: str, identity_id: str, filename: str) -> bytes:
    file_url = f"{base_url}/{quote(identity_id)}/{quote(filename)}"
    with urlopen(file_url) as response:
        return response.read()
