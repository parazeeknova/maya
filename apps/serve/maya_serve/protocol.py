from __future__ import annotations

import json
from typing import Any, cast


def parse_message(message: str | bytes) -> dict[str, Any]:
    raw = message.decode("utf-8") if isinstance(message, bytes) else message
    raw_payload: object = json.loads(raw)
    if not isinstance(raw_payload, dict):
        raise ValueError("Expected a JSON object.")
    return cast(dict[str, Any], raw_payload)


def dumps(message: dict[str, Any]) -> str:
    return json.dumps(message, separators=(",", ":"), ensure_ascii=True)


def expect_type(payload: dict[str, Any], expected: str) -> None:
    message_type = payload.get("type")
    if message_type != expected:
        raise ValueError(
            f"Expected message type '{expected}', received '{message_type}'."
        )
