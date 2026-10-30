import { useTranslation } from 'react-i18next';
import { MarkdownRenderer } from './MarkdownRenderer';
import s from './ReasoningDisclosure.module.scss';
import { AnimatedCollapse } from './AnimatedDisclosure';

export function ReasoningDisclosure({content,streaming,open,onToggle,tokens,onImageClick}: {
  content: string; streaming: boolean; open: boolean; onToggle:()=>void;
  tokens?:number; onImageClick?:(src:string)=>void;
}) {
 const {t}=useTranslation();
 return <div className={s.reasoning}>
  <button type="button" className={s.toggle} aria-expanded={open} onClick={onToggle}>
   {streaming?<span className={s.spinner}/>:<svg className={open?s.open:''} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>}
   <span>{streaming?t('reasoningDisclosure.thinking'):t('chat.message.reasoningLabel')}</span>
   {!streaming&&typeof tokens==='number'&&tokens>0&&<span className={s.tokens}>· {tokens} tk</span>}
  </button>
  <AnimatedCollapse open={open}><div className={s.content}><MarkdownRenderer content={content} onImageClick={onImageClick}/></div></AnimatedCollapse>
 </div>;
}
