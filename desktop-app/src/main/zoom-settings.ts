import * as fs from 'fs';
import * as path from 'path';

const MIN_ZOOM_LEVEL = Math.log(0.4) / Math.log(1.2);
const MAX_ZOOM_LEVEL = Math.log(2) / Math.log(1.2);

export function isValidZoomLevel(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= MIN_ZOOM_LEVEL && value <= MAX_ZOOM_LEVEL;
}

export function readZoomLevel(userDataPath: string): number | null {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(userDataPath, 'zoom-settings.json'), 'utf8'));
    return isValidZoomLevel(settings?.level) ? settings.level : null;
  } catch {
    return null;
  }
}

export function saveZoomLevel(userDataPath: string, level: number): void {
  if (!isValidZoomLevel(level)) throw new Error('invalid_zoom_level');
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(path.join(userDataPath, 'zoom-settings.json'), JSON.stringify({ level }), 'utf8');
}
