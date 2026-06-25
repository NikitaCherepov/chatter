const WAKE_WORD_CHUNK_SAMPLES = 1280;
const PROCESSOR_BUFFER_SIZE = 2048;

let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let processorNode: ScriptProcessorNode | null = null;
let muteGainNode: GainNode | null = null;
let pendingSamples: number[] = [];

const floatToPcm16 = (samples: number[]) => {
  const pcm16 = new Int16Array(samples.length);

  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return pcm16;
};

export async function startWakeWordAudioStream() {
  if (audioContext) return;

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      sampleRate: 16000,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  audioContext = new AudioContext({ sampleRate: 16000 });
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  processorNode = audioContext.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
  muteGainNode = audioContext.createGain();
  muteGainNode.gain.value = 0;
  pendingSamples = [];

  processorNode.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    for (let i = 0; i < input.length; i += 1) {
      pendingSamples.push(input[i]);
    }

    while (pendingSamples.length >= WAKE_WORD_CHUNK_SAMPLES) {
      const chunk = pendingSamples.slice(0, WAKE_WORD_CHUNK_SAMPLES);
      pendingSamples = pendingSamples.slice(WAKE_WORD_CHUNK_SAMPLES);
      const pcm16 = floatToPcm16(chunk);
      window.electronAPI.sendWakeWordAudioChunk(pcm16.buffer);
    }
  };

  sourceNode.connect(processorNode);
  processorNode.connect(muteGainNode);
  muteGainNode.connect(audioContext.destination);
}

export async function stopWakeWordAudioStream() {
  processorNode?.disconnect();
  sourceNode?.disconnect();
  muteGainNode?.disconnect();

  processorNode = null;
  sourceNode = null;
  muteGainNode = null;
  pendingSamples = [];

  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;

  if (audioContext && audioContext.state !== 'closed') {
    await audioContext.close();
  }
  audioContext = null;
}
