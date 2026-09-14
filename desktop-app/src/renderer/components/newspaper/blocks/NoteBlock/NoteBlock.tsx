import type { NewspaperNote, NoteBlockData } from '../../types';
import { safeImageUrl, safeUrl } from '../../utils/media';
import s from '../../Newspaper.module.scss';

export function NoteContent({ note }: { note: NewspaperNote | NoteBlockData }) {
  const url = safeUrl(note.url);
  const image = safeImageUrl(note.image_url);
  return <>{image && <img className={s.noteImage} src={image} alt=""/>}{note.title && (url ? <a href={url} target="_blank" rel="noreferrer">{note.title}</a> : <strong>{note.title}</strong>)}{note.text && <p>{note.text}</p>}{!note.title && url && <a href={url} target="_blank" rel="noreferrer">Открыть</a>}</>;
}

export function NoteBlock({ note, className, prefix }: { note: NoteBlockData; className?: string; prefix?: string }) {
  return <aside className={className}>{prefix && <b>{prefix}</b>}<div className={s.noteBody}><NoteContent note={note}/></div></aside>;
}
