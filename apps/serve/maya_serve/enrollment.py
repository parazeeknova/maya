from __future__ import annotations

import json
from dataclasses import dataclass
from hashlib import sha1
from typing import Any, cast


@dataclass(frozen=True, slots=True)
class IdentityMetadata:
    id: str
    name: str
    role: str
    color: str


@dataclass(frozen=True, slots=True)
class EnrollmentImage:
    data: bytes
    name: str


@dataclass(frozen=True, slots=True)
class EnrollmentSource:
    metadata: IdentityMetadata
    images: tuple[EnrollmentImage, ...]


type SourceImageSignature = tuple[str, int, str]
type SourceSignatureEntry = tuple[
    str,
    str,
    str,
    str,
    tuple[SourceImageSignature, ...],
]
type SourceSignature = tuple[SourceSignatureEntry, ...]


def build_source(
    identity_id: str,
    metadata_payload: object,
    images: tuple[EnrollmentImage, ...],
) -> EnrollmentSource:
    return EnrollmentSource(
        metadata=identity_metadata_from_object(identity_id, metadata_payload),
        images=images,
    )


def identity_metadata_from_object(
    identity_id: str,
    payload: object,
) -> IdentityMetadata:
    metadata = cast(dict[str, Any], payload) if isinstance(payload, dict) else {}
    name = _string_value(metadata.get("name"), identity_id.replace("-", " ").title())
    role = _string_value(metadata.get("role"), "Unspecified")
    color = _string_value(metadata.get("color"), "#38bdf8")
    return IdentityMetadata(id=identity_id, name=name, role=role, color=color)


def source_signature(sources: tuple[EnrollmentSource, ...]) -> SourceSignature:
    return tuple(
        (
            source.metadata.id,
            source.metadata.name,
            source.metadata.role,
            source.metadata.color,
            tuple(
                sorted(
                    (
                        image.name,
                        len(image.data),
                        sha1(image.data).hexdigest(),
                    )
                    for image in source.images
                )
            ),
        )
        for source in sorted(sources, key=lambda candidate: candidate.metadata.id)
    )


def source_to_json_metadata(source: EnrollmentSource) -> str:
    return json.dumps(
        {
            "color": source.metadata.color,
            "name": source.metadata.name,
            "role": source.metadata.role,
        },
        ensure_ascii=True,
        separators=(",", ":"),
    )


def _string_value(value: object, fallback: str) -> str:
    return value if isinstance(value, str) and value else fallback
