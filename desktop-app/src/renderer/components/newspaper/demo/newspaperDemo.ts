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
  blocks_count: 12,
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
      { id: 'hero', type: 'hero', priority: 100, title: 'Маленькие агенты собирают большую картину', summary: 'Редактор распределяет исследование между короткими независимыми задачами, проверяет источники и превращает результат в один ясный выпуск.', image_url: agentNetwork, sources: [{ title: 'Исследования OpenAI', url: 'https://openai.com/research/' }] },
      { id: 'briefs', type: 'news_list', priority: 80, title: 'Коротко', items: [
        { title: 'React развивает серверный рендеринг', summary: 'Инструменты постепенно становятся проще для продуктовых команд.', url: 'https://react.dev/blog' },
        { title: 'Веб-интерфейсы показывают прогресс агентов', summary: 'Фоновые процессы становятся заметными, но не мешают работе.', url: 'https://github.blog/' },
        { title: 'Открытые архивы ускоряют научную проверку', summary: 'Команды сопоставляют результаты разных миссий без ручного обмена наборами данных.', url: 'https://science.nasa.gov/' },
        { title: 'Локальные модели учатся работать экономнее', summary: 'Новые способы квантизации уменьшают требования к памяти.', url: 'https://huggingface.co/blog' },
        { title: 'Дизайн-системы становятся динамическими', summary: 'Компоненты начинают учитывать контекст и плотность информации.', url: 'https://web.dev/' },
        { title: 'Инженеры испытывают автономную навигацию', summary: 'Аппараты смогут быстрее реагировать на редкие события.', url: 'https://www.jpl.nasa.gov/' },
      ] },
      { id: 'article-context', type: 'article', priority: 70, title: 'Почему редактору не нужен огромный контекст', summary: 'Каждый исследователь возвращает только факты и ссылки. Редактор сравнивает материалы, удаляет повторы и определяет, что действительно достойно первой полосы.', sources: [{ title: 'Agents guide', url: 'https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/' }] },
      { id: 'article-tools', type: 'article', priority: 65, title: 'Инструменты становятся частью интерфейса', summary: 'Вместо длинного лога пользователь видит короткое объяснение, текущий этап и готовый результат. Сложность остаётся внутри системы.', sources: [{ title: 'GitHub Blog', url: 'https://github.blog/' }] },
      { id: 'article-observatories', type: 'article', priority: 60, title: 'Телескопы готовятся к новому поколению наблюдений', summary: 'Новые инструменты должны видеть более тусклые объекты и быстрее передавать результаты исследовательским группам.', sources: [{ title: 'NASA Science', url: 'https://science.nasa.gov/universe/' }] },
      { id: 'article-data', type: 'article', priority: 55, title: 'Данные важнее красивого снимка', summary: 'За каждым изображением скрываются спектры, измерения и месяцы проверки. Хорошая научная история показывает не только результат, но и путь к нему.', sources: [{ title: 'NASA Data', url: 'https://data.nasa.gov/' }] },
      { id: 'article-cache', type: 'article', priority: 50, title: 'Кэш перестаёт быть невидимой оптимизацией', summary: 'Пользовательские интерфейсы начинают объяснять происхождение результата и показывать, когда сохранённые данные действительно экономят время.' },
      { id: 'article-layout', type: 'article', priority: 45, title: 'Макет следует за материалом', summary: 'Полоса больше не обязана быть фиксированным контейнером: важность, формат и объём истории определяют её место в выпуске.' },
      { id: 'image-observatory', type: 'image', priority: 40, title: 'Орбитальная обсерватория', image_url: orbitalObservatory, caption: 'Художественная схема обсерватории следующего поколения.' },
      { id: 'image-editorial', type: 'image', priority: 35, title: 'Редакционная карта', image_url: agentNetwork, caption: 'Так независимые исследования сходятся в единую историю.' },
      { id: 'humor', type: 'humor', priority: 10, title: 'Последняя строка', text: 'Дедлайн был настолько гибким, что в итоге стал дорожной картой.' },
    ],
  },
};
