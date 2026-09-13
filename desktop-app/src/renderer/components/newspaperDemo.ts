import agentNetwork from '../assets/newspaper/agent-network.svg';
import orbitalObservatory from '../assets/newspaper/orbital-observatory.svg';
import type { NewspaperIssue } from '../lib/api';

const publishedAt = Math.floor(new Date('2026-09-14T08:00:00+07:00').getTime() / 1000);

export const DEMO_NEWSPAPER_PAGES: NewspaperIssue[] = [
  {
    id: -1, newspaper_id: -1, issue_number: 1, title: 'Chatter Daily', subtitle: 'Утренний выпуск', status: 'ready', blocks_count: 6, published_at: publishedAt,
    document: {
      version: 1, title: 'Chatter Daily', subtitle: 'Утренний выпуск · Выпуск №1', date: '14 сентября 2026 г.',
      blocks: [
        { id: 'weather', type: 'weather', title: 'Погода на день', location: 'Томск', condition: 'Переменная облачность', details: 'Без сильного ветра и осадков.', periods: [
          { label: 'Утро', temperature: 9, condition: 'Облачно' }, { label: 'День', temperature: 14, condition: 'Ясно' }, { label: 'Вечер', temperature: 10, condition: 'Прохладно' },
        ] },
        { id: 'hero', type: 'hero', title: 'Маленькие агенты собирают большую картину', summary: 'Редактор распределяет исследование между короткими независимыми задачами, проверяет источники и превращает результат в один ясный выпуск.', image_url: agentNetwork, sources: [{ title: 'Исследования OpenAI', url: 'https://openai.com/research/' }] },
        { id: 'brief', type: 'news_list', title: 'Коротко', items: [
          { title: 'React развивает серверный рендеринг', summary: 'Инструменты постепенно становятся проще для продуктовых команд.', url: 'https://react.dev/blog' },
          { title: 'Веб-интерфейсы показывают прогресс агентов', summary: 'Фоновые процессы становятся заметными, но не мешают работе.', url: 'https://github.blog/' },
        ] },
        { id: 'article', type: 'article', title: 'Почему редактору не нужен огромный контекст', summary: 'Каждый исследователь возвращает только факты и ссылки. Редактор сравнивает материалы, удаляет повторы и определяет, что действительно достойно первой полосы.', sources: [{ title: 'Agents guide', url: 'https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/' }] },
        { id: 'article-tools', type: 'article', title: 'Инструменты становятся частью интерфейса', summary: 'Вместо длинного лога пользователь видит короткое объяснение, текущий этап и готовый результат. Сложность остаётся внутри системы.', sources: [{ title: 'GitHub Blog', url: 'https://github.blog/' }] },
        { id: 'humor', type: 'humor', title: 'Последняя строка', text: 'Дедлайн был настолько гибким, что в итоге стал дорожной картой.' },
      ],
    },
  },
  {
    id: -2, newspaper_id: -1, issue_number: 1, title: 'Chatter Daily', subtitle: 'Продолжение выпуска', status: 'ready', blocks_count: 4, published_at: publishedAt,
    document: {
      version: 1, title: 'Chatter Daily', subtitle: 'Утренний выпуск · Страница 2', date: '14 сентября 2026 г.',
      blocks: [
        { id: 'hero-space', type: 'hero', title: 'Орбитальные телескопы готовятся к новому поколению наблюдений', summary: 'Новые инструменты должны одновременно видеть более тусклые объекты и быстрее передавать результаты исследовательским группам.', image_url: orbitalObservatory, sources: [{ title: 'NASA Science', url: 'https://science.nasa.gov/universe/' }] },
        { id: 'space-brief', type: 'news_list', title: 'Наука', items: [
          { title: 'Архивы наблюдений становятся открытее', summary: 'Исследователям проще сопоставлять данные разных миссий.', url: 'https://science.nasa.gov/' },
          { title: 'Инженеры тестируют автономную навигацию', summary: 'Аппараты смогут быстрее реагировать на редкие события.', url: 'https://www.jpl.nasa.gov/' },
        ] },
        { id: 'space-article', type: 'article', title: 'Данные важнее красивого снимка', summary: 'За каждым изображением скрываются спектры, измерения и месяцы проверки. Хорошая научная история показывает не только результат, но и путь к нему.', sources: [{ title: 'NASA Data', url: 'https://data.nasa.gov/' }] },
        { id: 'image-space', type: 'image', title: 'Изображение выпуска', image_url: orbitalObservatory, caption: 'Художественная схема орбитальной обсерватории.' },
      ],
    },
  },
];
