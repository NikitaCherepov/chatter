import type { FeatureFlags } from './api';
export function restrictionOverride(key: keyof FeatureFlags, flags: FeatureFlags): 'full' | 'guest' | 'avatar' | null {
  if (flags.disable_pc_control_full && (key === 'disable_pc_control_lite' || key === 'disable_pc_commands')) return 'full';
  if (flags.disable_personal && key === 'disable_memory_write') return 'guest';
  if (flags.hide_pixel_avatar && key === 'disable_avatar_control') return 'avatar';
  return null;
}
