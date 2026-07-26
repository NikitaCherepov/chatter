import TelegramIcon from '../assets/integrations/telegram.webp';
import type { UiSettings } from './api';

/** A single slide inside an announcement. */
export type AnnouncementSlide = {
  /** Unique id among slides of this announcement. */
  id: string;
  /** i18n key for the slide title (Markdown). */
  titleKey: string;
  /** i18n key for the slide body (Markdown). */
  bodyKey: string;
  /** Optional imported image to display above the text. */
  image?: string;
};

/** A named multi-slide announcement shown to users who have not seen it yet. */
export type Announcement = {
  /** Unique announcement id stored in `seen_announcements` on the server. */
  id: string;
  slides: AnnouncementSlide[];
};

/**
 * Registry of all announcements that ever existed.
 *
 * To add a new feature announcement, append a new `Announcement` entry
 * to this array.  Once all users have seen it and the announcement is
 * retired, it can be kept (it will be skipped for users who already saw
 * it) or removed from here — removing it has no effect on existing
 * `seen_announcements` on the server.
 */
const DESKTOP_ANNOUNCEMENTS: Announcement[] = [
  {
    id: 'welcome_v1',
    slides: [
      {
        id: 'telegram',
        titleKey: 'onboarding.welcome.telegram.title',
        image: TelegramIcon,
        bodyKey: 'onboarding.welcome.telegram.body',
      },
      {
        id: 'features',
        titleKey: 'onboarding.welcome.features.title',
        bodyKey: 'onboarding.welcome.features.body',
      },
      {
        id: 'experimental',
        titleKey: 'onboarding.welcome.experimental.title',
        bodyKey: 'onboarding.welcome.experimental.body',
      },
    ],
  },
];

/**
 * Returns announcements that the user has NOT seen yet, in registry order.
 */
export function getUnseenAnnouncements(
  settings: UiSettings | null | undefined,
): Announcement[] {
  if (!settings) return [];
  const seen = new Set(settings.seen_announcements ?? []);
  return DESKTOP_ANNOUNCEMENTS.filter((a) => !seen.has(a.id));
}
