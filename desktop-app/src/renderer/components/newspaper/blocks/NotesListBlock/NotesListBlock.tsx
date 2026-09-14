import type { NotesListBlockData } from '../../types';
import { NoteContent } from '../NoteBlock/NoteBlock';
import s from '../../Newspaper.module.scss';

export function NotesListBlock({ list, numbered = false, className }: { list: NotesListBlockData; numbered?: boolean; className?: string }) {
  return <div className={`${numbered ? s.numberedNews : s.newsItems} ${className || ''}`}>{list.items.map((item, index) => <article key={item.id || `${item.title || item.text}-${index}`}><span className={s.newsIndex}>{String(index + 1).padStart(2, '0')}</span><div><NoteContent note={item}/></div></article>)}</div>;
}
