import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import type { NewspaperIssue, NewspaperSource, NewspaperStyle } from '../lib/api';
import { Select, type SelectOption } from './Select';
import s from './NewspaperReader.module.scss';

type Props = {
  issue: NewspaperIssue | null;
  style: NewspaperStyle;
  canGoPrevious: boolean;
  canGoNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
  onStyleChange: (style: NewspaperStyle) => void;
  leadLabel: string;
  previousLabel: string;
  nextLabel: string;
  closeLabel: string;
};

const safeUrl = (value?: string) => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
};

function Sources({ sources }: { sources?: NewspaperSource[] }) {
  const safe = (sources || []).map(source => ({ ...source, url: safeUrl(source.url) })).filter(source => source.url);
  if (!safe.length) return null;
  return (
    <div className={s.sources}>
      {safe.map(source => (
        <a key={`${source.title}-${source.url}`} href={source.url!} target="_blank" rel="noreferrer">
          {source.title}
        </a>
      ))}
    </div>
  );
}

const styleOptions: SelectOption[] = [
  { value: 'classic', label: 'Классика' },
  { value: 'modern', label: 'Современный' },
  { value: 'magical', label: 'Магический' },
];

export function NewspaperReader({ issue, style, canGoPrevious, canGoNext, onPrevious, onNext, onClose, onStyleChange, leadLabel, previousLabel, nextLabel, closeLabel }: Props) {
  useEffect(() => {
    if (!issue) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft' && canGoPrevious) onPrevious();
      if (event.key === 'ArrowRight' && canGoNext) onNext();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canGoNext, canGoPrevious, issue, onClose, onNext, onPrevious]);

  return createPortal(
    <AnimatePresence>
      {issue && (
        <motion.div className={s.backdrop} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={onClose}>
          <motion.div
            className={s.dialog}
            initial={{ opacity: 0, y: 26, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 18, scale: 0.985 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            onMouseDown={event => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <header className={s.toolbar}>
              <div className={s.issueMeta}>
                <strong>№{issue.issue_number}</strong>
                <span>{issue.document.date}</span>
              </div>
              <div className={s.styleSelect}>
                <Select options={styleOptions} value={style} onChange={value => onStyleChange(value as NewspaperStyle)} />
              </div>
              <nav className={s.navigation}>
                <button type="button" onClick={onPrevious} disabled={!canGoPrevious} aria-label={previousLabel}>‹</button>
                <button type="button" onClick={onNext} disabled={!canGoNext} aria-label={nextLabel}>›</button>
                <button type="button" onClick={onClose} aria-label={closeLabel}>×</button>
              </nav>
            </header>

            <div className={s.viewport}>
              <motion.article
                key={issue.id}
                className={`${s.paper} ${s[style]}`}
                initial={{ opacity: 0, x: 18 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.18 }}
              >
                <header className={s.masthead}>
                  <div className={s.rule} />
                  <h1>{issue.document.title}</h1>
                  <div className={s.mastMeta}>
                    <span>{issue.document.subtitle || issue.subtitle}</span>
                    <span>{issue.document.date}</span>
                  </div>
                  <div className={s.rule} />
                </header>

                <div className={s.grid}>
                  {issue.document.blocks.map(block => {
                    if (block.type === 'weather') return (
                      <section key={block.id} className={`${s.block} ${s.weather}`}>
                        <span className={s.kicker}>{block.location}</span>
                        <h2>{block.condition}</h2>
                        <div className={s.forecast}>
                          {block.periods.map(period => (
                            <div className={s.forecastPeriod} key={period.label}>
                              <span>{period.label}</span>
                              <strong>{Math.round(period.temperature)}°</strong>
                              {period.condition && <small>{period.condition}</small>}
                            </div>
                          ))}
                        </div>
                        {block.details && <p>{block.details}</p>}
                        <Sources sources={block.sources} />
                      </section>
                    );
                    if (block.type === 'news_list') return (
                      <section key={block.id} className={`${s.block} ${s.newsList}`}>
                        <h2>{block.title}</h2>
                        <ol>
                          {block.items.map((item, index) => {
                            const url = safeUrl(item.url);
                            return (
                              <li key={`${item.title}-${index}`}>
                                {url ? <a href={url} target="_blank" rel="noreferrer">{item.title}</a> : <strong>{item.title}</strong>}
                                {item.summary && <p>{item.summary}</p>}
                              </li>
                            );
                          })}
                        </ol>
                        <Sources sources={block.sources} />
                      </section>
                    );
                    if (block.type === 'image') {
                      const imageUrl = safeUrl(block.image_url);
                      return (
                        <figure key={block.id} className={`${s.block} ${s.imageBlock}`}>
                          {imageUrl
                            ? <img src={imageUrl} alt={block.caption || block.title} />
                            : <div className={s.imagePlaceholder}><span>🐈</span><small>{block.prompt}</small></div>}
                          <figcaption><strong>{block.title}</strong>{block.caption && <span>{block.caption}</span>}</figcaption>
                          <Sources sources={block.sources} />
                        </figure>
                      );
                    }
                    if (block.type === 'humor') return (
                      <aside key={block.id} className={`${s.block} ${s.humor}`}>
                        <span>✦</span><h2>{block.title}</h2><p>{block.text}</p>
                      </aside>
                    );
                    return (
                      <section key={block.id} className={`${s.block} ${block.type === 'hero' ? s.hero : s.article}`}>
                        {block.type === 'hero' && <span className={s.kicker}>{leadLabel}</span>}
                        <h2>{block.title}</h2>
                        <p>{block.summary}</p>
                        <Sources sources={block.sources} />
                      </section>
                    );
                  })}
                </div>
              </motion.article>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
