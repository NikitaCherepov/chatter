import React, { useState } from 'react';
import { NewspaperReader, type NewspaperVisualStyle } from './NewspaperReader';
import { DEMO_NEWSPAPER_PAGES } from './newspaperDemo';
import s from './NewspaperTool.module.scss';

const STYLE_KEY = 'chatter:newspaper-preview-style';
const readStyle = (): NewspaperVisualStyle => {
  const value = localStorage.getItem(STYLE_KEY);
  return value === 'wizarding' || value === 'broadsheet' || value === 'deusEx' || value === 'massEffect' ? value : 'wizarding';
};

export function NewspaperTool() {
  const [open, setOpen] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [style, setStyle] = useState<NewspaperVisualStyle>(readStyle);

  const changeStyle = (next: NewspaperVisualStyle) => {
    setStyle(next);
    localStorage.setItem(STYLE_KEY, next);
  };

  const openIssue = () => {
    setPageIndex(0);
    setOpen(true);
  };

  return (
    <div className={s.root}>
      <div className={s.toolbar}>
        <div><strong>Ваши газеты</strong><span>Локальный прототип оформления выпуска</span></div>
        <button type="button" onClick={openIssue}>Открыть выпуск</button>
      </div>
      <div className={s.scroll}>
        <section className={s.newspaper}>
          <header><div><strong>Chatter Daily</strong><span>Тестовый макет</span></div><span className={s.style}>2 страницы</span></header>
          <div className={s.issueList}>
            <div className={s.issueRow}>
              <button type="button" className={s.issue} onClick={openIssue}>
                <div className={s.issueNumber}>№1</div>
                <div className={s.issueInfo}><strong>Утренний выпуск</strong><span>14 сентября 2026 г. · локальное демо</span></div>
                <span className={s.openArrow}>↗</span>
              </button>
            </div>
          </div>
        </section>
      </div>
      <NewspaperReader
        issue={open ? DEMO_NEWSPAPER_PAGES[pageIndex] : null}
        style={style}
        pageNumber={pageIndex + 1}
        pageCount={DEMO_NEWSPAPER_PAGES.length}
        canGoPrevious={pageIndex > 0}
        canGoNext={pageIndex < DEMO_NEWSPAPER_PAGES.length - 1}
        onPrevious={() => setPageIndex(index => Math.max(0, index - 1))}
        onNext={() => setPageIndex(index => Math.min(DEMO_NEWSPAPER_PAGES.length - 1, index + 1))}
        onClose={() => setOpen(false)}
        onStyleChange={changeStyle}
        leadLabel="Главная история"
        previousLabel="Предыдущая страница"
        nextLabel="Следующая страница"
        closeLabel="Закрыть"
      />
    </div>
  );
}
