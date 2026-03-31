from __future__ import annotations

import asyncio
import contextlib

from websockets.asyncio.server import ServerConnection, serve

from maya_serve import FaceRecognitionService, load_settings
from maya_serve.protocol import dumps


async def handle_connection(
    websocket: ServerConnection,
    service: FaceRecognitionService,
) -> None:
    await websocket.send(dumps(service.ready_message()))

    async for message in websocket:
        response = await service.handle_raw_message(message)
        await websocket.send(response)


async def main() -> None:
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
            print(
                f"Maya serve listening on ws://{settings.host}:{settings.port} "
                f"(enrollment dir: {settings.enrollment_dir})"
            )
            await server.serve_forever()
    finally:
        with contextlib.suppress(asyncio.CancelledError):
            await service.stop()


if __name__ == "__main__":
    asyncio.run(main())
