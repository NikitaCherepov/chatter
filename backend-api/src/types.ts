export type UserPlan = 'free' | 'standart' | 'pro';
export type ChatRole = 'user' | 'assistant';
export type TaskStatus = 'pending' | 'done' | 'error';
export type TaskType = 'message' | 'smart_home' | 'ai_instruction';
export type TaskRecurrenceType = 'once' | 'daily' | 'weekly';
export type TaskNotifyMode = 'always' | 'never' | 'on_match' | 'on_condition';

export type UserRecord = {
  id: number;
  name: string | null;
  role: string;
  is_admin: number;
  status: 'none' | 'approved' | 'disapproved' | 'banned';
  plan: UserPlan;
  language?: string | null;
  selected_prompt_id: number | null;
  custom_prompt_content: string | null;
  core_memory: string | null;
  timezone_offset?: number | null;
  timezone_confirmed?: number;
  daily_message_count: number;
  weekly_tokens_used?: number;
  weekly_tokens_quota?: number;
  weekly_window_started_at?: number;
  weekly_cost_used?: number;
  weekly_cost_quota?: number;
  weekly_cost_quota_limit?: number;
  daily_web_search_count?: number;
  daily_web_search_limit?: number;
  total_web_search_count?: number;
  mail_check_limit?: number;
  imap_provider?: string | null;
  daily_image_gen_count?: number;
  daily_image_gen_limit?: number;
  total_image_gen_count?: number;
  preferred_model?: string | null;
  subagent_mode?: string | null;
  feature_flags?: string | null;
  reasoning_level?: string | null;
  subagent_reasoning_level?: string | null;
  model_settings?: string | null;
  ui_settings?: string | null;
  max_context_tokens_limit?: number;
  max_context_tokens?: number;
  attachment_max_tokens?: number;
  auth_token_version?: number;
  must_change_password?: number;
};

export type AccountIdentityDto = {
  provider: string;
  provider_subject: string;
  username: string | null;
};

export type ChatDto = {
  id: number;
  title: string;
  created_at: number;
  updated_at: number;
  is_active: boolean;
  bot_hidden?: boolean;
};

export type MessageImage = {
  url: string;
  type: 'user_photo' | 'generated';
};

export type MessageAttachment = {
  name: string;
  size_bytes: number;
  mime_type: string;
  extracted_text: string;
  url: string;
  filename: string;
};

export type MessageAudio = {
  url: string;
  tts_type: string;
  voice_id: string;
};

export type NormalizedTokenUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_hit_tokens: number;
  cache_miss_tokens: number;
  reasoning_tokens: number;
};

export type TokenUsageCall = NormalizedTokenUsage & {
  model: string;
  provider: string;
  uniqueId?: string | null;
  /** Real upstream provider from API response (e.g. 'deepinfra', 'together'). */
  upstreamProviderSlug?: string | null;
  /** Actual cost returned by OpenRouter in usage.cost, if available. */
  actualCostUsd?: number | null;
};

export type MessageUsage = {
  latest: NormalizedTokenUsage;
  aggregate: NormalizedTokenUsage;
  calls: TokenUsageCall[];
  context_estimate_tokens?: number;
  context_local_tokens?: number;
};

export type MessageDto = {
  id: number;
  chat_id: number;
  role: ChatRole;
  content: string;
  reasoning_content?: string | null;
  tool_calls?: Array<{ id?: string; name: string; arguments: any; result_preview?: string }> | null;
  images?: MessageImage[] | null;
  audio?: MessageAudio | null;
  telegram_chat_id?: number | null;
  telegram_message_id?: number | null;
  created_at: number;
  archived?: boolean;
  /** Локально посчитанные токены (без reasoning_content). См. MessageTokensDto. */
  token_count?: number;
  reasoning_tokens?: number;
  prompt_name?: string | null;
  model_name?: string | null;
  provider_name?: string | null;
  usage?: MessageUsage | null;
  attachments?: MessageAttachment[] | null;
  /** Полные trace ad-hoc субагентов (если были). */
  subagents?: Array<{
    task: string;
    system_prompt: string;
    tools: string[];
    tools_used: string[];
    answer: string;
    summary: string;
    aborted?: boolean;
    usage?: MessageUsage | null;
    iterations: Array<{
      step: number;
      content: string;
      tool_calls: Array<{ id?: string; name: string; arguments: any }>;
      results: Array<{ id?: string; name: string; content: string }>;
      is_final?: boolean;
    }>;
  }> | null;
};

export type NoteDto = {
  id: number;
  title: string;
  content: string;
  created_at: number;
  updated_at: number;
};

export type TaskDto = {
  id: number;
  execute_at: number;
  task_type: TaskType;
  payload: string;
  status: TaskStatus;
  recurrence_type: TaskRecurrenceType;
  recurrence_weekday: number | null;
  timezone_offset: number | null;
  notify_mode: TaskNotifyMode;
  notify_condition: string | null;
};

export type UsageDto = {
  tokens_used: number;
  used_model: string;
  used_provider: string;
  prompt_tokens: number;
  completion_tokens: number;
  cache_hit_tokens: number;
  cache_miss_tokens: number;
  reasoning_tokens: number;
  calls: TokenUsageCall[];
};

/**
 * Токены сообщения, посчитанные локально через gpt-tokenizer (o200k_base).
 *  - token_count: вес сообщения в AI-контексте (reasoning_content НЕ входит).
 *  - reasoning_tokens: отдельный счётчик reasoning_content (только для assistant).
 */
export type MessageTokensDto = {
  token_count: number;
  reasoning_tokens: number;
};

export type GeneratedImage = {
  image_base64: string;
  image_url?: string;
  prompt_used: string;
};

export type AiSendResult = {
  reply_text: string;
  reasoning_content?: string | null;
  chat_id: number;
  message_id: number;
  user_message_id?: number;
  user_message_images?: MessageImage[];
  model_fallback_notice?: string | null;
  tool_user_messages?: string[];
  generated_images?: GeneratedImage[];
  display_state?: DisplayStatePayload | null;
  desktop_action?: DesktopActionPayload | null;
  aborted?: boolean;
  tool_calls?: Array<{ id?: string; name: string; arguments: any; result_preview?: string }>;
  /** Полные trace ad-hoc субагентов (для UI-блока «Сабагенты»). */
  subagents?: Array<{
    task: string;
    system_prompt: string;
    tools: string[];
    tools_used: string[];
    answer: string;
    summary: string;
    aborted?: boolean;
    usage?: MessageUsage | null;
    iterations: Array<{
      step: number;
      content: string;
      tool_calls: Array<{ id?: string; name: string; arguments: any }>;
      results: Array<{ id?: string; name: string; content: string }>;
      is_final?: boolean;
    }>;
  }>;
  usage: UsageDto;
  /** Токены ответа ассистента (без reasoning). См. MessageTokensDto. */
  token_count?: number;
  /** Токены reasoning_content ответа ассистента. */
  reasoning_tokens?: number;
  /** Токены user-сообщения (если было сохранено новое). См. MessageTokensDto. */
  user_token_count?: number;
  prompt_name?: string | null;
  model_name?: string | null;
  provider_name?: string | null;
  message_usage?: MessageUsage | null;
  /** Результат броска d20 (1..20) в режиме Dice Roll Mode, иначе отсутствует. */
  dice_roll?: number;
};

export type DisplayStatePayload = {
  mode?: 'face' | 'media';
  base_mood?: string;
  reactions?: string[];
  media_url?: string;
  loop_reaction?: string;
  clear_loop?: boolean;
};

export type DesktopActionPayload = {
  action: 'open_widget' | 'close_widget' | 'set_widget_data' | 'open_note' | 'read_widget_state' | 'toggle_panel' | 'execute_macro' | 'suggest_macro' | 'devops_confirmation' | 'pc_command_confirmation' | 'browser_action_confirmation' | 'browser_action_confirmation_resolved' | 'browser_download_confirmation' | 'browser_download_confirmation_resolved' | 'file_action_confirmation' | 'edit_file_lines_confirmation' | 'email_confirmation' | 'suggest_devops_runbook' | 'suggest_server_creds_update' | 'chat_title_update' | 'webcam_capture_confirmation' | 'suggest_chat_link';
  target?: 'notebook' | string;
  value?: unknown;
};

export type DesktopActionResult = {
  status: 'success' | 'error' | 'state';
  message?: string;
  state?: unknown;
};

export type TransitStop = {
  coords: [number, number]; // [lat, lng]
  name: string;
};

export type NearbyPlace = {
  id: number;
  lat: number;
  lng: number;
  name: string;
  address?: string;
  hours?: string;
  category?: string;
};

export type MapUpdatePayload = {
  action: 'show_place' | 'draw_route' | 'transit_route' | 'poi_search';
  lat?: number;
  lng?: number;
  label?: string;
  from?: { lat: number; lng: number; label: string };
  to?: { lat: number; lng: number; label: string };
  route?: [number, number][]; // [lat, lng][]
  // transit_route fields
  routeName?: string;
  path?: [number, number][]; // [lat, lng][] — full route polyline
  stops?: TransitStop[];
  // poi_search fields
  places?: NearbyPlace[];
  query?: string;
};
