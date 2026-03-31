from __future__ import annotations

import asyncio
import contextlib
import signal

from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosedError, ConnectionClosedOK

from maya_serve import (
    FaceRecognitionService,
    install_runtime_compatibility_patches,
    load_settings,
)
from maya_serve.protocol import dumps


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


async def main() -> None:
    install_runtime_compatibility_patches()
    settings = load_settings()
    service = FaceRecognitionService(settings)
    await service.start()

    try:
        async with serve(
            lambda websocket: handle_connection(websocket, service),
            settings.host,
            settings.port,
            max_size=8 * 1024 * 1024,
        ) as server:
            loop = asyncio.get_running_loop()
            for shutdown_signal in (signal.SIGINT, signal.SIGTERM):
                with contextlib.suppress(NotImplementedError):
                    loop.add_signal_handler(shutdown_signal, server.close)
            print(
                f"Maya serve listening on ws://{settings.host}:{settings.port} "
                f"(enrollment dir: {settings.enrollment_dir})"
            )
            await server.wait_closed()
    finally:
        with contextlib.suppress(asyncio.CancelledError):
            await service.stop()


if __name__ == "__main__":
    asyncio.run(main())
