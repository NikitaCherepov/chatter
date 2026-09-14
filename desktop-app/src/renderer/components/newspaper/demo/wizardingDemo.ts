import type { NewspaperBlock, NewspaperIssue } from '../types';
import { DEMO_NEWSPAPER_ISSUE } from './newspaperDemo';

const sourceBlocks = new Map(DEMO_NEWSPAPER_ISSUE.document.blocks.map(block => [block.id, block]));

function block(id: string): NewspaperBlock {
  const value = sourceBlocks.get(id);
  if (!value) throw new Error(`Missing wizarding demo block: ${id}`);
  return value;
}

function hero(id: string): NewspaperBlock {
  const value = block(id);
  if (value.type !== 'article') throw new Error(`Wizarding hero must be an article: ${id}`);
  return { ...value, role: 'hero' };
}

function page(pageNumber: number, blocks: NewspaperBlock[]): NewspaperIssue {
  return {
    ...DEMO_NEWSPAPER_ISSUE,
    id: DEMO_NEWSPAPER_ISSUE.id * 100 - pageNumber,
    subtitle: pageNumber === 1 ? DEMO_NEWSPAPER_ISSUE.subtitle : `${DEMO_NEWSPAPER_ISSUE.subtitle} · Страница ${pageNumber}`,
    blocks_count: blocks.length,
    document: {
      ...DEMO_NEWSPAPER_ISSUE.document,
      subtitle: pageNumber === 1 ? DEMO_NEWSPAPER_ISSUE.document.subtitle : `${DEMO_NEWSPAPER_ISSUE.document.subtitle} · Страница ${pageNumber}`,
      blocks,
    },
  };
}

const crowdedNotes: NewspaperBlock = {
  id: 'crowded-notes',
  type: 'notes_list',
  title: 'Совиная почта',
  items: [
    { title: 'Телескопы сверяют новые каталоги', text: 'Наблюдения объединяются в общедоступные архивы.' },
    { title: 'Интерфейсы становятся спокойнее', text: 'Сложная работа остаётся за аккуратной полосой прогресса.' },
    { title: 'Команды ускоряют проверку источников', text: 'Короткие независимые отчёты проще сравнивать между собой.' },
    { title: 'Макеты следуют за материалом', text: 'Форма страницы меняется вместе с объёмом выпуска.' },
    { title: 'Архив открыт до полуночи', text: 'Редакционные заметки доступны для повторной проверки.' },
    { title: 'Кот редакции снова занял клавиатуру', text: 'Выпуск всё-таки удалось отправить вовремя.' },
  ],
};

function crowdedNotesCopy(index: number): NewspaperBlock {
  if (crowdedNotes.type !== 'notes_list') throw new Error('Wizarding demo notes must be a notes list');
  return {
    ...crowdedNotes,
    id: `${crowdedNotes.id}-${index}`,
    title: `${crowdedNotes.title} · Подборка ${index}`,
  };
}

const weeklyWeather: NewspaperBlock = {
  id: 'weekly-weather',
  type: 'weather',
  title: 'Небесный прогноз на неделю',
  location: 'Томск',
  condition: 'Неделя переменчивого неба',
  details: 'К выходным станет теплее; самые ясные часы ожидаются в субботу днём.',
  periods: [
    { label: 'Пн', temperature: 9, condition: 'Облачно' },
    { label: 'Вт', temperature: 11, condition: 'Дождь' },
    { label: 'Ср', temperature: 12, condition: 'Облачно' },
    { label: 'Чт', temperature: 14, condition: 'Ясно' },
    { label: 'Пт', temperature: 13, condition: 'Ветер' },
    { label: 'Сб', temperature: 16, condition: 'Солнце' },
    { label: 'Вс', temperature: 15, condition: 'Ясно' },
  ],
};

export const DEMO_WIZARDING_PAGES: NewspaperIssue[] = [
  page(1, [
    block('weather'),
    block('hero'),
    block('briefs'),
    block('article-context'),
    block('article-tools'),
    block('image-editorial'),
  ]),
  page(2, [
    block('article-data'),
    block('untitled-notes'),
    block('article-cache'),
    block('article-tools'),
  ]),
  page(3, [
    block('article-data'),
    block('article-layout'),
    block('article-cache'),
  ]),
  page(4, [
    block('article-observatories'),
    block('weather'),
    block('briefs'),
    block('text-only-note'),
    block('image-editorial'),
  ]),
  page(5, [
    crowdedNotes,
    block('article-context'),
    block('article-tools'),
    block('image-observatory'),
    block('illustrated-note'),
    block('last-line'),
  ]),
  page(6, [
    weeklyWeather,
    block('article-layout'),
    block('briefs'),
    block('text-only-note'),
  ]),
];

/**
 * The same visual cases expressed as one editor-ordered stream. Unlike the
 * reference pages above, every material occurs once; page boundaries are
 * produced exclusively by the Wizarding pagination profile.
 */
const wizardingBlocks: NewspaperBlock[] = [
  block('weather'),
  block('hero'),
  block('briefs'),

  block('image-editorial'),
  hero('article-context'),
  block('article-tools'),

  block('article-data'),
  block('untitled-notes'),
  block('article-cache'),

  hero('article-observatories'),
  block('article-layout'),

  crowdedNotes,
  block('image-observatory'),
  block('last-line'),

  weeklyWeather,
  block('illustrated-note'),
  block('text-only-note'),

  ...Array.from({ length: 6 }, (_, index) => crowdedNotesCopy(index + 1)),
];

export const DEMO_WIZARDING_ISSUE: NewspaperIssue = {
  ...DEMO_NEWSPAPER_ISSUE,
  blocks_count: wizardingBlocks.length,
  document: {
    ...DEMO_NEWSPAPER_ISSUE.document,
    blocks: wizardingBlocks,
  },
};
