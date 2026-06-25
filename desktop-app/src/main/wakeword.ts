import * as fs from 'fs';
import * as path from 'path';
import * as ort from 'onnxruntime-node';

type WakeWordPayload = {
  type: 'wakeword';
  name: string;
  score: number;
  ts: number;
};

type WakeWordModelConfig = {
  name: string;
  fileName: string;
  inputFrames: number;
  classMapping?: Record<number, string>;
};

const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 1280;
const MEL_CONTEXT_SAMPLES = 160 * 3;
const MEL_BINS = 32;
const MEL_WINDOW_FRAMES = 76;
const EMBEDDING_DIM = 96;
const FEATURE_BUFFER_MAX_FRAMES = 120;
const MEL_BUFFER_MAX_FRAMES = 10 * 97;

const WAKE_WORD_MODELS: WakeWordModelConfig[] = [
  { name: 'alexa', fileName: 'alexa_v0.1.onnx', inputFrames: 16 },
  { name: 'hey_mycroft', fileName: 'hey_mycroft_v0.1.onnx', inputFrames: 16 },
  { name: 'hey_jarvis', fileName: 'hey_jarvis_v0.1.onnx', inputFrames: 16 },
  { name: 'hey_rhasspy', fileName: 'hey_rhasspy_v0.1.onnx', inputFrames: 16 },
  {
    name: 'timer',
    fileName: 'timer_v0.1.onnx',
    inputFrames: 34,
    classMapping: {
      1: '1_minute_timer',
      2: '5_minute_timer',
      3: '10_minute_timer',
      4: '20_minute_timer',
      5: '30_minute_timer',
      6: '1_hour_timer',
    },
  },
  { name: 'weather', fileName: 'weather_v0.1.onnx', inputFrames: 22 },
];

type LoadedWakeWordModel = WakeWordModelConfig & {
  session: ort.InferenceSession;
};

type WakeWordOptions = {
  threshold: number;
  debounceMs: number;
  vadThreshold: number;
  modelsDir: string;
  onDetected: (payload: WakeWordPayload) => void;
};

const concatInt16 = (left: Int16Array, right: Int16Array) => {
  if (left.length === 0) return right;
  const combined = new Int16Array(left.length + right.length);
  combined.set(left, 0);
  combined.set(right, left.length);
  return combined;
};

const toInt16Array = (buffer: ArrayBuffer | ArrayBufferView) => {
  if (buffer instanceof ArrayBuffer) {
    return new Int16Array(buffer);
  }

  const view = buffer as ArrayBufferView;
  return new Int16Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
};

const rowsFromFlat = (data: Float32Array, rowLength: number) => {
  const rows: Float32Array[] = [];
  for (let offset = 0; offset + rowLength <= data.length; offset += rowLength) {
    rows.push(data.slice(offset, offset + rowLength));
  }
  return rows;
};

const flattenRows = (rows: Float32Array[]) => {
  const rowLength = rows[0]?.length ?? 0;
  const flattened = new Float32Array(rows.length * rowLength);
  rows.forEach((row, index) => flattened.set(row, index * rowLength));
  return flattened;
};

const trimRows = (rows: Float32Array[], maxRows: number) => {
  if (rows.length <= maxRows) return rows;
  return rows.slice(rows.length - maxRows);
};

export class WakeWordOnnxService {
  private readonly options: WakeWordOptions;
  private melspecSession: ort.InferenceSession | null = null;
  private embeddingSession: ort.InferenceSession | null = null;
  private vadSession: ort.InferenceSession | null = null;
  private models: LoadedWakeWordModel[] = [];
  private active = false;
  private initPromise: Promise<void> | null = null;
  private processingChain: Promise<void> = Promise.resolve();

  private rawDataBuffer: number[] = [];
  private melBuffer: Float32Array[] = [];
  private featureBuffer: Float32Array[] = [];
  private rawDataRemainder = new Int16Array(0);
  private accumulatedSamples = 0;
  private predictionBuffer = new Map<string, number[]>();
  private vadPredictionBuffer: number[] = [];
  private vadH = new Float32Array(2 * 1 * 64);
  private vadC = new Float32Array(2 * 1 * 64);
  private lastDetectionAt = 0;

  constructor(options: WakeWordOptions) {
    this.options = options;
  }

  async start() {
    await this.ensureInitialized();
    await this.reset();
    this.active = true;
    return { ok: true, alreadyRunning: false };
  }

  stop() {
    const wasActive = this.active;
    this.active = false;
    return { ok: true, alreadyStopped: !wasActive };
  }

  processAudioChunk(buffer: ArrayBuffer | ArrayBufferView) {
    if (!this.active) return;

    const pcm16 = toInt16Array(buffer);
    if (pcm16.length === 0) return;

    this.processingChain = this.processingChain
      .then(() => this.processChunk(pcm16))
      .catch((error) => {
        console.error('[wakeword:onnx] inference error:', error);
      });
  }

  private async ensureInitialized() {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.loadModels();
    return this.initPromise;
  }

  private async loadModels() {
    const requiredFiles = [
      'melspectrogram.onnx',
      'embedding_model.onnx',
      'silero_vad.onnx',
      ...WAKE_WORD_MODELS.map((model) => model.fileName),
    ];

    const missing = requiredFiles.filter((fileName) => !fs.existsSync(path.join(this.options.modelsDir, fileName)));
    if (missing.length > 0) {
      throw new Error(`wakeword ONNX models missing: ${missing.join(', ')}`);
    }

    const sessionOptions: ort.InferenceSession.SessionOptions = {
      executionProviders: ['cpu'],
      interOpNumThreads: 1,
      intraOpNumThreads: 1,
    };

    this.melspecSession = await ort.InferenceSession.create(
      path.join(this.options.modelsDir, 'melspectrogram.onnx'),
      sessionOptions,
    );
    this.embeddingSession = await ort.InferenceSession.create(
      path.join(this.options.modelsDir, 'embedding_model.onnx'),
      sessionOptions,
    );
    this.vadSession = await ort.InferenceSession.create(
      path.join(this.options.modelsDir, 'silero_vad.onnx'),
      sessionOptions,
    );

    this.models = await Promise.all(
      WAKE_WORD_MODELS.map(async (model) => ({
        ...model,
        session: await ort.InferenceSession.create(path.join(this.options.modelsDir, model.fileName), sessionOptions),
      })),
    );

    console.log('[wakeword:onnx] models loaded:', this.models.map((model) => model.name).join(', '));
  }

  private async reset() {
    this.rawDataBuffer = [];
    this.melBuffer = Array.from({ length: MEL_WINDOW_FRAMES }, () => new Float32Array(MEL_BINS).fill(1));
    this.rawDataRemainder = new Int16Array(0);
    this.accumulatedSamples = 0;
    this.predictionBuffer = new Map();
    this.vadPredictionBuffer = [];
    this.vadH = new Float32Array(2 * 1 * 64);
    this.vadC = new Float32Array(2 * 1 * 64);
    this.lastDetectionAt = 0;

    const warmupAudio = new Int16Array(SAMPLE_RATE * 4);
    for (let i = 0; i < warmupAudio.length; i += 1) {
      warmupAudio[i] = Math.round((Math.random() * 2 - 1) * 1000);
    }

    this.featureBuffer = await this.computeEmbeddingsFromAudio(warmupAudio);
    this.featureBuffer = trimRows(this.featureBuffer, FEATURE_BUFFER_MAX_FRAMES);
  }

  private async processChunk(inputChunk: Int16Array) {
    if (!this.active) return;

    const preparedSamples = await this.prepareFeatures(inputChunk);
    if (preparedSamples < CHUNK_SAMPLES) return;

    const predictions = await this.predictWakeWords(preparedSamples);
    this.updatePredictionBuffers(predictions);
    await this.applyVad(inputChunk, predictions);

    const detected = Object.entries(predictions).reduce<{ name: string; score: number } | null>((best, [name, score]) => {
      if (!best || score > best.score) return { name, score };
      return best;
    }, null);

    const now = Date.now();
    if (
      detected
      && detected.score >= this.options.threshold
      && now - this.lastDetectionAt >= this.options.debounceMs
    ) {
      this.lastDetectionAt = now;
      this.options.onDetected({
        type: 'wakeword',
        name: detected.name,
        score: detected.score,
        ts: now / 1000,
      });
    }
  }

  private async prepareFeatures(chunk: Int16Array) {
    let x = concatInt16(this.rawDataRemainder, chunk);
    this.rawDataRemainder = new Int16Array(0);

    if (this.accumulatedSamples + x.length >= CHUNK_SAMPLES) {
      const remainder = (this.accumulatedSamples + x.length) % CHUNK_SAMPLES;
      if (remainder !== 0) {
        const evenLength = x.length - remainder;
        const evenChunks = x.slice(0, evenLength);
        this.bufferRawData(evenChunks);
        this.accumulatedSamples += evenChunks.length;
        this.rawDataRemainder = x.slice(evenLength);
      } else {
        this.bufferRawData(x);
        this.accumulatedSamples += x.length;
      }
    } else {
      this.bufferRawData(x);
      this.accumulatedSamples += x.length;
    }

    if (this.accumulatedSamples < CHUNK_SAMPLES || this.accumulatedSamples % CHUNK_SAMPLES !== 0) {
      return this.accumulatedSamples;
    }

    await this.streamingMelspectrogram(this.accumulatedSamples);

    const chunkCount = Math.floor(this.accumulatedSamples / CHUNK_SAMPLES);
    for (let i = chunkCount - 1; i >= 0; i -= 1) {
      let endIndex = -8 * i;
      endIndex = endIndex !== 0 ? this.melBuffer.length + endIndex : this.melBuffer.length;
      const melWindow = this.melBuffer.slice(endIndex - MEL_WINDOW_FRAMES, endIndex);
      if (melWindow.length === MEL_WINDOW_FRAMES) {
        this.featureBuffer.push(await this.computeEmbeddingFromMelWindow(melWindow));
      }
    }

    this.featureBuffer = trimRows(this.featureBuffer, FEATURE_BUFFER_MAX_FRAMES);

    const processedSamples = this.accumulatedSamples;
    this.accumulatedSamples = 0;
    return processedSamples;
  }

  private bufferRawData(chunk: Int16Array) {
    this.rawDataBuffer.push(...chunk);
    const maxSamples = SAMPLE_RATE * 10;
    if (this.rawDataBuffer.length > maxSamples) {
      this.rawDataBuffer = this.rawDataBuffer.slice(this.rawDataBuffer.length - maxSamples);
    }
  }

  private async streamingMelspectrogram(newSamples: number) {
    const samples = this.rawDataBuffer.slice(-newSamples - MEL_CONTEXT_SAMPLES);
    const melRows = await this.computeMelspectrogram(Int16Array.from(samples));
    this.melBuffer.push(...melRows);
    this.melBuffer = trimRows(this.melBuffer, MEL_BUFFER_MAX_FRAMES);
  }

  private async computeMelspectrogram(audio: Int16Array) {
    if (!this.melspecSession) throw new Error('melspectrogram session is not initialized');

    const input = new Float32Array(audio.length);
    for (let i = 0; i < audio.length; i += 1) {
      input[i] = audio[i];
    }

    const tensor = new ort.Tensor('float32', input, [1, input.length]);
    const result = await this.melspecSession.run({ [this.melspecSession.inputNames[0]]: tensor });
    const output = result[this.melspecSession.outputNames[0]];
    const transformed = new Float32Array(output.data.length);

    for (let i = 0; i < output.data.length; i += 1) {
      transformed[i] = (output.data[i] as number) / 10 + 2;
    }

    return rowsFromFlat(transformed, MEL_BINS);
  }

  private async computeEmbeddingFromMelWindow(melWindow: Float32Array[]) {
    if (!this.embeddingSession) throw new Error('embedding session is not initialized');

    const input = flattenRows(melWindow);
    const tensor = new ort.Tensor('float32', input, [1, MEL_WINDOW_FRAMES, MEL_BINS, 1]);
    const result = await this.embeddingSession.run({ [this.embeddingSession.inputNames[0]]: tensor });
    const output = result[this.embeddingSession.outputNames[0]];
    return Float32Array.from(output.data as Float32Array);
  }

  private async computeEmbeddingsFromAudio(audio: Int16Array) {
    const melRows = await this.computeMelspectrogram(audio);
    const embeddings: Float32Array[] = [];

    for (let i = 0; i < melRows.length; i += 8) {
      const window = melRows.slice(i, i + MEL_WINDOW_FRAMES);
      if (window.length === MEL_WINDOW_FRAMES) {
        embeddings.push(await this.computeEmbeddingFromMelWindow(window));
      }
    }

    return embeddings;
  }

  private getFeatures(frameCount: number, startIndex = -1) {
    const rows = startIndex === -1
      ? this.featureBuffer.slice(-frameCount)
      : (() => {
          const resolvedStart = startIndex < 0 ? this.featureBuffer.length + startIndex : startIndex;
          return this.featureBuffer.slice(resolvedStart, resolvedStart + frameCount);
        })();

    const padded = rows.length >= frameCount
      ? rows
      : [
          ...Array.from({ length: frameCount - rows.length }, () => new Float32Array(EMBEDDING_DIM)),
          ...rows,
        ];

    return new ort.Tensor('float32', flattenRows(padded), [1, frameCount, EMBEDDING_DIM]);
  }

  private async predictWakeWords(preparedSamples: number) {
    const predictions: Record<string, number> = {};

    for (const model of this.models) {
      let bestOutput: Float32Array | null = null;

      if (preparedSamples > CHUNK_SAMPLES) {
        const chunkCount = Math.floor(preparedSamples / CHUNK_SAMPLES);
        for (let i = chunkCount - 1; i >= 0; i -= 1) {
          const startIndex = -model.inputFrames - i;
          const output = await this.runWakeWordModel(model, this.getFeatures(model.inputFrames, startIndex));
          if (!bestOutput || Math.max(...output) > Math.max(...bestOutput)) {
            bestOutput = output;
          }
        }
      } else {
        bestOutput = await this.runWakeWordModel(model, this.getFeatures(model.inputFrames));
      }

      if (!bestOutput) continue;

      if (bestOutput.length === 1) {
        predictions[model.name] = bestOutput[0];
      } else if (model.classMapping) {
        for (const [index, label] of Object.entries(model.classMapping)) {
          predictions[label] = bestOutput[Number(index)] ?? 0;
        }
      }
    }

    for (const label of Object.keys(predictions)) {
      if ((this.predictionBuffer.get(label)?.length ?? 0) < 5) {
        predictions[label] = 0;
      }
    }

    return predictions;
  }

  private async runWakeWordModel(model: LoadedWakeWordModel, tensor: ort.Tensor) {
    const result = await model.session.run({ [model.session.inputNames[0]]: tensor });
    const output = result[model.session.outputNames[0]];
    return Float32Array.from(output.data as Float32Array);
  }

  private updatePredictionBuffers(predictions: Record<string, number>) {
    for (const [label, score] of Object.entries(predictions)) {
      const buffer = this.predictionBuffer.get(label) ?? [];
      buffer.push(score);
      if (buffer.length > 30) buffer.shift();
      this.predictionBuffer.set(label, buffer);
    }
  }

  private async applyVad(chunk: Int16Array, predictions: Record<string, number>) {
    if (this.options.vadThreshold <= 0 || !this.vadSession) return;

    const score = await this.predictVad(chunk);
    this.vadPredictionBuffer.push(score);
    if (this.vadPredictionBuffer.length > 125) this.vadPredictionBuffer.shift();

    const vadFrames = this.vadPredictionBuffer.slice(-7, -4);
    const vadMaxScore = vadFrames.length > 0 ? Math.max(...vadFrames) : 0;
    if (vadMaxScore >= this.options.vadThreshold) return;

    for (const label of Object.keys(predictions)) {
      predictions[label] = 0;
    }
  }

  private async predictVad(chunk: Int16Array) {
    if (!this.vadSession) throw new Error('VAD session is not initialized');

    const frameSize = 160 * 4;
    const scores: number[] = [];

    for (let offset = 0; offset + frameSize <= chunk.length; offset += frameSize) {
      const input = new Float32Array(frameSize);
      for (let i = 0; i < frameSize; i += 1) {
        input[i] = chunk[offset + i] / 32767;
      }

      const result = await this.vadSession.run({
        input: new ort.Tensor('float32', input, [1, frameSize]),
        sr: new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), []),
        h: new ort.Tensor('float32', this.vadH, [2, 1, 64]),
        c: new ort.Tensor('float32', this.vadC, [2, 1, 64]),
      });

      const output = result.output.data as Float32Array;
      this.vadH = Float32Array.from(result.hn.data as Float32Array);
      this.vadC = Float32Array.from(result.cn.data as Float32Array);
      scores.push(output[0] ?? 0);
    }

    if (scores.length === 0) return 0;
    return scores.reduce((sum, score) => sum + score, 0) / scores.length;
  }
}
