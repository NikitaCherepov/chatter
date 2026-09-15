import { useEffect, useMemo, useState } from 'react';
import { DEMO_NEWSPAPER_ISSUE } from './demo/newspaperDemo';
import { DEMO_WIZARDING_ISSUE } from './demo/wizardingDemo';
import { DEMO_BROADSHEET_ISSUE } from './demo/broadsheetDemo';
import { DEMO_DEUS_EX_ISSUE } from './demo/deusExDemo';
import { DEMO_MASS_EFFECT_ISSUE } from './demo/massEffectDemo';
import { distributeIssue } from './layout/distributeIssue';
import { NewspaperReader } from './NewspaperReader';
import type { NewspaperVisualStyle } from './types';
import { distributeWizardingIssue } from './templates/WizardingTemplate/wizardingPagination';
import { distributeBroadsheetIssue } from './templates/BroadsheetTemplate/broadsheetPagination';
import { distributeDeusExIssue } from './templates/DeusExTemplate/deusExPagination';
import { distributeMassEffectIssue } from './templates/MassEffectTemplate/massEffectPagination';
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
  const pages = useMemo(
    () => style === 'wizarding'
      ? distributeWizardingIssue(DEMO_WIZARDING_ISSUE)
      : style === 'broadsheet'
        ? distributeBroadsheetIssue(DEMO_BROADSHEET_ISSUE)
        : style === 'deusEx'
          ? distributeDeusExIssue(DEMO_DEUS_EX_ISSUE)
        : style === 'massEffect'
          ? distributeMassEffectIssue(DEMO_MASS_EFFECT_ISSUE)
        : distributeIssue(DEMO_NEWSPAPER_ISSUE, style),
    [style],
  );

  useEffect(() => setPageIndex(index => Math.min(index, pages.length - 1)), [pages.length]);

  const changeStyle = (next: NewspaperVisualStyle) => {
    setStyle(next);
    setPageIndex(0);
    localStorage.setItem(STYLE_KEY, next);
  };
  const openIssue = () => {
    setPageIndex(0);
    setOpen(true);
  };

  return <div className={s.root}>
    <div className={s.toolbar}><div><strong>Ваши газеты</strong><span>Локальный прототип оформления выпуска</span></div><button type="button" onClick={openIssue}>Открыть выпуск</button></div>
    <div className={s.scroll}><section className={s.newspaper}><header><div><strong>Chatter Daily</strong><span>Тестовый макет</span></div><span className={s.style}>{pages.length} стр.</span></header><div className={s.issueList}><div className={s.issueRow}><button type="button" className={s.issue} onClick={openIssue}><div className={s.issueNumber}>№1</div><div className={s.issueInfo}><strong>Утренний выпуск</strong><span>14 сентября 2026 г. · локальное демо</span></div><span className={s.openArrow}>↗</span></button></div></div></section></div>
    <NewspaperReader issue={open ? pages[pageIndex] : null} style={style} pageNumber={pageIndex + 1} pageCount={pages.length} canGoPrevious={pageIndex > 0} canGoNext={pageIndex < pages.length - 1} onPrevious={() => setPageIndex(index => Math.max(0, index - 1))} onNext={() => setPageIndex(index => Math.min(pages.length - 1, index + 1))} onClose={() => setOpen(false)} onStyleChange={changeStyle} previousLabel="Предыдущая страница" nextLabel="Следующая страница" closeLabel="Закрыть"/>
  </div>;
}
