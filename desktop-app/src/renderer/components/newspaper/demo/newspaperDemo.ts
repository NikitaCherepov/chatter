import agentNetwork from '../../../assets/newspaper/agent-network.svg';
import orbitalObservatory from '../../../assets/newspaper/orbital-observatory.svg';
import type { NewspaperIssue } from '../../../lib/api';

const publishedAt = Math.floor(new Date('2026-09-14T08:00:00+07:00').getTime() / 1000);

export const DEMO_NEWSPAPER_ISSUE: NewspaperIssue = {
  id: -1,
  newspaper_id: -1,
  issue_number: 1,
  title: 'Chatter Daily',
  subtitle: 'Утренний выпуск',
  status: 'ready',
  blocks_count: 15,
  published_at: publishedAt,
  document: {
    version: 1,
    title: 'Chatter Daily',
    subtitle: 'Утренний выпуск · Выпуск №1',
    date: '14 сентября 2026 г.',
    blocks: [
      { id: 'weather', type: 'weather', title: 'Погода на день', location: 'Томск', condition: 'Переменная облачность', details: 'Без сильного ветра и осадков.', periods: [
        { label: 'Утро', temperature: 9, condition: 'Облачно' }, { label: 'День', temperature: 14, condition: 'Ясно' }, { label: 'Вечер', temperature: 10, condition: 'Прохладно' },
      ] },
      { id: 'hero', type: 'article', role: 'hero', title: 'Маленькие агенты собирают большую картину', text: 'Редактор распределяет исследование между короткими независимыми задачами, проверяет источники и превращает результат в один ясный выпуск.', url: 'https://openai.com/research/', image_url: agentNetwork, sources: [{ title: 'Исследования OpenAI', url: 'https://openai.com/research/' }] },
      { id: 'briefs', type: 'notes_list', title: 'Коротко', items: [
        { title: 'React развивает серверный рендеринг', text: 'Инструменты постепенно становятся проще для продуктовых команд.', url: 'https://react.dev/blog' },
        { title: 'Веб-интерфейсы показывают прогресс агентов', text: 'Фоновые процессы становятся заметными, но не мешают работе.', image_url: agentNetwork },
        { title: 'Открытые архивы научных наблюдений', url: 'https://science.nasa.gov/' },
      ] },
      { id: 'untitled-notes', type: 'notes_list', items: [
        { text: 'Иногда лучшая короткая заметка обходится вообще без заголовка.' },
        { url: 'https://www.jpl.nasa.gov/' },
      ] },
      { id: 'article-context', type: 'article', role: 'feature', title: 'Почему редактору не нужен огромный контекст', text: 'Каждый исследователь возвращает только факты и ссылки. Редактор сравнивает материалы, удаляет повторы и определяет, что действительно достойно первой полосы.', url: 'https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/', sources: [{ title: 'Agents guide', url: 'https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/' }] },
      { id: 'article-tools', type: 'article', role: 'standard', title: 'Инструменты становятся частью интерфейса', text: 'Вместо длинного лога пользователь видит короткое объяснение, текущий этап и готовый результат. Сложность остаётся внутри системы.', url: 'https://github.blog/', sources: [{ title: 'GitHub Blog', url: 'https://github.blog/' }] },
      { id: 'article-observatories', type: 'article', role: 'feature', title: 'Телескопы готовятся к новому поколению наблюдений', text: 'Новые инструменты должны видеть более тусклые объекты и быстрее передавать результаты исследовательским группам.', url: 'https://science.nasa.gov/universe/', image_url: orbitalObservatory, sources: [{ title: 'NASA Science', url: 'https://science.nasa.gov/universe/' }] },
      { id: 'article-data', type: 'article', role: 'hero', title: 'Данные важнее красивого снимка', text: 'За каждым изображением скрываются спектры, измерения и месяцы проверки. Хорошая научная история показывает не только результат, но и путь к нему.', url: 'https://data.nasa.gov/', image_url: orbitalObservatory, sources: [{ title: 'NASA Data', url: 'https://data.nasa.gov/' }] },
      { id: 'article-cache', type: 'article', role: 'standard', title: 'Кэш перестаёт быть невидимой оптимизацией', text: 'Пользовательские интерфейсы начинают объяснять происхождение результата и показывать, когда сохранённые данные действительно экономят время.' },
      { id: 'article-layout', type: 'article', role: 'standard', title: 'Макет следует за материалом', text: 'Полоса больше не обязана быть фиксированным контейнером: важность, формат и объём истории определяют её место в выпуске.' },
      { id: 'image-observatory', type: 'image', title: 'Орбитальная обсерватория', image_url: orbitalObservatory, caption: 'Художественная схема обсерватории следующего поколения.' },
      { id: 'image-editorial', type: 'image', title: 'Редакционная карта', image_url: agentNetwork, caption: 'Так независимые исследования сходятся в единую историю.' },
      { id: 'last-line', type: 'note', title: 'Последняя строка', text: 'Дедлайн был настолько гибким, что в итоге стал дорожной картой.' },
      { id: 'text-only-note', type: 'note', text: 'Эта самостоятельная заметка намеренно не имеет заголовка.' },
      { id: 'illustrated-note', type: 'note', title: 'Схема дня', text: 'Картинка появляется внутри заметки только тогда, когда помогает понять её смысл.', url: 'https://openai.com/research/', image_url: agentNetwork },
    ],
  },
};
