/**
 * Audio file storage for TTS-generated audio.
 *
 * Saves MP3/WAV files to uploads/audio/ directory.
 * Follows the same pattern as image-storage.ts.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

const UPLOADS_DIR = path.resolve(
  process.env.UPLOADS_DIR || path.resolve(__dirname, '../../uploads')
);

const AUDIO_DIR = path.join(UPLOADS_DIR, 'audio');

/** Ensure audio uploads directory exists */
const ensureAudioDir = () => {
  if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
  }
};

export type SavedAudio = {
  url: string;       // relative URL: /api/v1/audio/abc123.mp3
  filename: string;  // abc123.mp3
};

/**
 * Save a TTS-generated audio buffer to disk.
 * Returns the relative URL and filename.
 */
export const saveTtsAudio = async (
  buffer: Buffer,
  ext: string = '.mp3'
): Promise<SavedAudio> => {
  ensureAudioDir();

  const id = crypto.randomBytes(12).toString('hex');
  const filename = `${id}${ext}`;
  const filepath = path.join(AUDIO_DIR, filename);

  await fs.promises.writeFile(filepath, buffer);

  return { url: `/api/v1/audio/${filename}`, filename };
};

/**
 * Get absolute filepath for a given audio filename.
 * Returns null if file doesn't exist.
 */
export const resolveAudioFile = (filename: string): string | null => {
  // Prevent path traversal
  const safeName = path.basename(filename);
  const filepath = path.join(AUDIO_DIR, safeName);
  if (!fs.existsSync(filepath)) return null;
  return filepath;
};
