FROM node:20-bookworm-slim AS whisper-build

ARG WHISPER_CPP_REF=v1.8.6

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        cmake \
        curl \
        git \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch "${WHISPER_CPP_REF}" \
        https://github.com/ggml-org/whisper.cpp.git /src/whisper.cpp \
    && cmake -S /src/whisper.cpp -B /src/whisper.cpp/build \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF \
        -DWHISPER_BUILD_EXAMPLES=ON \
    && cmake --build /src/whisper.cpp/build --config Release --parallel 2 \
    && /src/whisper.cpp/models/download-ggml-model.sh small


FROM node:20-bookworm-slim AS python-build

ENV VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        libsndfile1 \
        python3 \
        python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv "$VIRTUAL_ENV"

COPY requirements.txt /tmp/requirements.txt

# Install the CPU-only PyTorch wheel so the image does not pull CUDA libraries.
RUN pip install --no-cache-dir \
        --index-url https://download.pytorch.org/whl/cpu \
        "torch==2.5.1+cpu" \
    && pip install --no-cache-dir -r /tmp/requirements.txt \
    && mkdir -p /opt/models/piper \
    && cd /opt/models/piper \
    && python -m piper.download_voices en_US-lessac-medium


FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    VOICE_API_PORT=3030 \
    TORCH_HOME=/home/node/.cache/torch \
    WHISPER_BIN=/opt/whisper/whisper-cli \
    WHISPER_MODEL=/opt/whisper/ggml-small.bin \
    PYTHON_BIN=/opt/venv/bin/python \
    PIPER_MODEL_PATH=/opt/models/piper/en_US-lessac-medium.onnx \
    PATH=/opt/venv/bin:$PATH

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        ffmpeg \
        libgomp1 \
        libsndfile1 \
        python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY index.js silero_tts.py piper_tts_worker.py ./
COPY --from=whisper-build /src/whisper.cpp/build/bin/whisper-cli /opt/whisper/whisper-cli
COPY --from=whisper-build /src/whisper.cpp/models/ggml-small.bin /opt/whisper/ggml-small.bin
COPY --from=python-build /opt/venv /opt/venv
COPY --from=python-build /opt/models /opt/models

RUN mkdir -p /app/tmp /home/node/.cache/torch \
    && chown -R node:node /app/tmp /opt/models /home/node/.cache

USER node

EXPOSE 3030

CMD ["node", "index.js"]
