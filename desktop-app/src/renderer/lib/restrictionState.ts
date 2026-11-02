import type { FeatureFlags } from './api';
export function restrictionOverride(key: keyof FeatureFlags, flags: FeatureFlags): 'full' | 'guest' | null {
  if (flags.disable_pc_control_full && (key === 'disable_pc_control_lite' || key === 'disable_pc_commands')) return 'full';
  if (flags.disable_personal && key === 'disable_memory_write') return 'guest';
  return null;
}
