import { projectMemory, type MapVector } from './memory-projection';
self.onmessage = (event: MessageEvent<MapVector[]>) => {
  try { self.postMessage({ result: projectMemory(event.data) }); }
  catch { self.postMessage({ error: 'projection_failed' }); }
};
