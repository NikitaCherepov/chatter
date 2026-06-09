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
  preferred_model?: string | null;
};

export type ChatDto = {
  id: number;
  title: string;
  created_at: number;
  updated_at: number;
  is_active: boolean;
};

export type MessageImage = {
  url: string;
  type: 'user_photo' | 'generated';
};

export type MessageDto = {
  id: number;
  chat_id: number;
  role: ChatRole;
  content: string;
  images?: MessageImage[] | null;
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
  image_url?: string;
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
  desktop_action?: DesktopActionPayload | null;
  aborted?: boolean;
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

export type DesktopActionPayload = {
  action: 'open_widget' | 'close_widget' | 'set_widget_data' | 'open_note' | 'read_widget_state' | 'toggle_panel' | 'execute_macro' | 'suggest_macro' | 'devops_confirmation' | 'suggest_devops_runbook' | 'suggest_server_creds_update' | 'chat_title_update';
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
