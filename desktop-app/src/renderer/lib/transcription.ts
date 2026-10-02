import { transcribeAudioOnServer } from './api';
import { getSpeechRecognitionSource } from './speechRecognition';

const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};

export async function transcribeRecordedAudio(
  arrayBuffer: ArrayBuffer,
  language: string,
): Promise<string> {
  if (getSpeechRecognitionSource() === 'local') {
    return window.electronAPI.transcribeAudio(arrayBuffer, language);
  }
  const wav = await window.electronAPI.prepareAudioWav(arrayBuffer);
  const result = await transcribeAudioOnServer(arrayBufferToBase64(wav), language);
  return result.text;
}
