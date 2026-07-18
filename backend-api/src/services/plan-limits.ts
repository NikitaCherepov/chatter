import type { UserPlan } from '../types.js';

export type PlanLimits = {
  daily_web_search_limit: number;
  daily_image_gen_limit: number;
  image_attachments_allowed: boolean;
  max_context_tokens: number;
};

export const DEFAULT_USER_PLAN: UserPlan = 'free';

export const PLAN_LIMITS: Record<UserPlan, PlanLimits> = {
  free: {
    daily_web_search_limit: 0,
    daily_image_gen_limit: 0,
    image_attachments_allowed: false,
    max_context_tokens: 30_000,
  },
  standart: {
    daily_web_search_limit: 5,
    daily_image_gen_limit: 2,
    image_attachments_allowed: true,
    max_context_tokens: 60_000,
  },
  pro: {
    daily_web_search_limit: 20,
    daily_image_gen_limit: 5,
    image_attachments_allowed: true,
    max_context_tokens: 1_000_000,
  },
};

export const MAX_IMAGES_PER_REQUEST = 10;

export const getPlanLimits = (plan: string | null | undefined): PlanLimits =>
  PLAN_LIMITS[plan as UserPlan] ?? PLAN_LIMITS[DEFAULT_USER_PLAN];

export const areImageAttachmentsAllowedForPlan = (plan: string | null | undefined, isAdmin = false): boolean =>
  isAdmin || getPlanLimits(plan).image_attachments_allowed;
