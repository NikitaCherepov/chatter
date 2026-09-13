import type { NewspaperSource } from '../../types';
import { safeUrl } from '../../utils/media';
import s from '../../Newspaper.module.scss';

export function SourcesBlock({ sources }: { sources?: NewspaperSource[] }) {
  const safe = (sources || []).map(source => ({ ...source, url: safeUrl(source.url) })).filter(source => source.url);
  if (!safe.length) return null;
  return <div className={s.sources}>{safe.map(source => <a key={`${source.title}-${source.url}`} href={source.url!} target="_blank" rel="noreferrer">{source.title}</a>)}</div>;
}
