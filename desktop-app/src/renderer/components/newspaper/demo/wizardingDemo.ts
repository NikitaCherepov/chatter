import type { NewspaperBlock, NewspaperIssue } from '../types';
import { DEMO_NEWSPAPER_ISSUE } from './newspaperDemo';

const sourceBlocks = new Map(DEMO_NEWSPAPER_ISSUE.document.blocks.map(block => [block.id, block]));

function block(id: string): NewspaperBlock {
  const value = sourceBlocks.get(id);
  if (!value) throw new Error(`Missing wizarding demo block: ${id}`);
  return value;
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
];
