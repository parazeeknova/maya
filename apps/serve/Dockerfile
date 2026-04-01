FROM python:3.14-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV UV_CACHE_DIR=/tmp/uv-cache
ENV UV_LINK_MODE=copy
ENV MPLCONFIGDIR=/app/.mplconfig

RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential \
  && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv

WORKDIR /app

COPY .python-version ./
COPY package.json pyproject.toml uv.lock main.py ./
COPY data ./data
COPY maya_serve ./maya_serve
COPY stubs ./stubs
COPY .insightface ./.insightface

RUN uv sync --frozen --no-dev

EXPOSE 8765

CMD ["sh", "-lc", "ALBUMENTATIONS_DISABLE_VERSION_CHECK=1 LD_LIBRARY_PATH=.venv/lib/python3.14/site-packages/nvidia/cublas/lib:.venv/lib/python3.14/site-packages/nvidia/cuda_runtime/lib:.venv/lib/python3.14/site-packages/nvidia/cuda_nvrtc/lib:.venv/lib/python3.14/site-packages/nvidia/cufft/lib:/usr/lib:$LD_LIBRARY_PATH uv run python main.py"]
