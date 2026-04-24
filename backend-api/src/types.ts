export type UserPlan = 'free' | 'standart' | 'pro';
export type ChatRole = 'user' | 'assistant';
export type TaskStatus = 'pending' | 'done' | 'error';
export type TaskType = 'message' | 'smart_home' | 'web_search' | 'email_check' | 'ai_instruction';
export type TaskRecurrenceType = 'once' | 'daily' | 'weekly';
export type TaskNotifyMode = 'always' | 'never' | 'on_match' | 'on_condition';

export type UserRecord = {
  id: number;
  name: string | null;
  role: string;
  is_admin: number;
  status: 'none' | 'approved' | 'disapproved' | 'banned';
  plan: UserPlan;
  tg_username: string | null;
  selected_prompt_id: number | null;
  custom_prompt_content: string | null;
  core_memory: string | null;
  timezone_offset?: number | null;
  timezone_confirmed?: number;
  context_window: number;
  context_window_max: number;
  daily_message_count: number;
  daily_message_limit: number;
  daily_tokens_used?: number;
  total_tokens_used?: number;
  daily_cost_rub?: number;
  total_cost_rub?: number;
  daily_web_search_count?: number;
  daily_web_search_limit?: number;
  total_web_search_count?: number;
  mail_check_limit?: number;
  daily_image_gen_count?: number;
  daily_image_gen_limit?: number;
  total_image_gen_count?: number;
  linked_tg_id?: number | null;
};

export type ChatDto = {
  id: number;
  title: string;
  created_at: number;
  updated_at: number;
  is_active: boolean;
};

export type MessageDto = {
  id: number;
  chat_id: number;
  role: ChatRole;
  content: string;
  telegram_chat_id?: number | null;
  telegram_message_id?: number | null;
  created_at: number;
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
};

export type GeneratedImage = {
  image_base64: string;
  prompt_used: string;
};

export type AiSendResult = {
  reply_text: string;
  chat_id: number;
  message_id: number;
  model_fallback_notice?: string | null;
  tool_user_messages?: string[];
  generated_images?: GeneratedImage[];
  display_state?: DisplayStatePayload | null;
  usage: UsageDto;
};

export type DisplayStatePayload = {
  mode?: 'face' | 'media';
  base_mood?: string;
  reactions?: string[];
  media_url?: string;
  loop_reaction?: string;
  clear_loop?: boolean;
};
