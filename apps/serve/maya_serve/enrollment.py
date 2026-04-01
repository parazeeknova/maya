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
    works_at: str | None = None
    linkedin_id: str | None = None
    github_username: str | None = None
    email: str | None = None
    phone_number: str | None = None


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
    str | None,
    str | None,
    str | None,
    str | None,
    str | None,
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
    works_at = _optional_string(metadata.get("worksAt"))
    linkedin_id = _optional_string(metadata.get("linkedinId"))
    github_username = _optional_string(metadata.get("githubUsername"))
    email = _optional_string(metadata.get("email"))
    phone_number = _optional_string(metadata.get("phoneNumber"))
    return IdentityMetadata(
        id=identity_id,
        name=name,
        role=role,
        color=color,
        works_at=works_at,
        linkedin_id=linkedin_id,
        github_username=github_username,
        email=email,
        phone_number=phone_number,
    )


def source_signature(sources: tuple[EnrollmentSource, ...]) -> SourceSignature:
    return tuple(
        (
            source.metadata.id,
            source.metadata.name,
            source.metadata.role,
            source.metadata.color,
            source.metadata.works_at,
            source.metadata.linkedin_id,
            source.metadata.github_username,
            source.metadata.email,
            source.metadata.phone_number,
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
            "email": source.metadata.email,
            "githubUsername": source.metadata.github_username,
            "linkedinId": source.metadata.linkedin_id,
            "name": source.metadata.name,
            "phoneNumber": source.metadata.phone_number,
            "role": source.metadata.role,
            "worksAt": source.metadata.works_at,
        },
        ensure_ascii=True,
        separators=(",", ":"),
    )


def _string_value(value: object, fallback: str) -> str:
    return value if isinstance(value, str) and value else fallback


def _optional_string(value: object) -> str | None:
    if isinstance(value, str):
        normalized = value.strip()
        return normalized if normalized else None
    return None
