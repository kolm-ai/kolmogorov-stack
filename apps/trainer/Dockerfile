# Kolm trainer bridge — minimal image for mock mode (no GPU).
# For real GPU training, base on nvidia/cuda and `pip install .[gpu]`.

FROM python:3.11-slim AS base

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
RUN pip install --no-cache-dir \
    "fastapi>=0.115" "uvicorn[standard]>=0.32" "pydantic>=2.5" "httpx>=0.27" "python-dotenv>=1.0"

COPY main.py trainer_real.py ./

ENV KOLM_TRAINER_MODE=mock
ENV KOLM_TRAINER_JOBS=/data/trainer-jobs.jsonl
ENV KOLM_TRAINER_ADAPTER_DIR=/data/adapters

RUN mkdir -p /data/adapters

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
