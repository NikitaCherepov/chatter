import type { UserPlan } from '../types.js';

export type PlanLimits = {
  daily_web_search_limit: number;
  daily_image_gen_limit: number;
  max_images_per_request: number;
  max_context_tokens: number;
};

export const DEFAULT_USER_PLAN: UserPlan = 'free';

export const PLAN_LIMITS: Record<UserPlan, PlanLimits> = {
  free: {
    daily_web_search_limit: 0,
    daily_image_gen_limit: 0,
    max_images_per_request: 0,
    max_context_tokens: 30_000,
  },
  standart: {
    daily_web_search_limit: 5,
    daily_image_gen_limit: 2,
    max_images_per_request: 5,
    max_context_tokens: 60_000,
  },
  pro: {
    daily_web_search_limit: 20,
    daily_image_gen_limit: 5,
    max_images_per_request: 10,
    max_context_tokens: 1_000_000,
  },
};

export const getPlanLimits = (plan: string | null | undefined): PlanLimits =>
  PLAN_LIMITS[plan as UserPlan] ?? PLAN_LIMITS[DEFAULT_USER_PLAN];
