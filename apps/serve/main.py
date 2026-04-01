from __future__ import annotations

import asyncio
import contextlib
import http
import logging
import signal
from collections.abc import Awaitable, Callable

from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosedError, ConnectionClosedOK
from websockets.http11 import Request, Response

from maya_serve import (
    FaceRecognitionService,
    install_runtime_compatibility_patches,
    load_settings,
)
from maya_serve.protocol import dumps


class IgnoreInvalidUpgradeFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return record.getMessage() != "opening handshake failed"


async def handle_connection(
    websocket: ServerConnection,
    service: FaceRecognitionService,
) -> None:
    try:
        await websocket.send(dumps(service.ready_message()))

        async for message in websocket:
            response = await service.handle_raw_message(message)
            await websocket.send(response)
    except ConnectionClosedOK:
        return
    except ConnectionClosedError as error:
        print(
            "Maya serve websocket closed unexpectedly: "
            f"code={error.code} reason={error.reason!r}"
        )


def handle_process_request(
    service: FaceRecognitionService,
) -> Callable[[ServerConnection, Request], Awaitable[Response | None]]:
    async def process_request(
        connection: ServerConnection,
        request: Request,
    ) -> Response | None:
        if request.path == "/healthz":
            return connection.respond(http.HTTPStatus.OK, "ok\n")
        if request.path == "/admin/reload":
            changed = await service.refresh_enrollment()
            return connection.respond(
                http.HTTPStatus.OK,
                dumps(
                    {
                        "changed": changed,
                        "enrollment": service.ready_message()["enrollment"],
                        "status": "ok",
                    }
                ),
            )
        return None

    return process_request


async def main() -> None:
    install_runtime_compatibility_patches()
    settings = load_settings()
    service = FaceRecognitionService(settings)
    websocket_logger = logging.getLogger("maya_serve.websockets")
    websocket_logger.addFilter(IgnoreInvalidUpgradeFilter())
    await service.start()

    try:
        async with serve(
            lambda websocket: handle_connection(websocket, service),
            settings.host,
            settings.port,
            logger=websocket_logger,
            max_size=8 * 1024 * 1024,
            process_request=handle_process_request(service),
        ) as server:
            loop = asyncio.get_running_loop()
            for shutdown_signal in (signal.SIGINT, signal.SIGTERM):
                with contextlib.suppress(NotImplementedError):
                    loop.add_signal_handler(shutdown_signal, server.close)
            print(
                f"Maya serve listening on ws://{settings.host}:{settings.port} "
                f"(enrollment source: {settings.enrollment_sync_base_url or 'memory'})"
            )
            await server.wait_closed()
    finally:
        with contextlib.suppress(asyncio.CancelledError):
            await service.stop()


if __name__ == "__main__":
    asyncio.run(main())
