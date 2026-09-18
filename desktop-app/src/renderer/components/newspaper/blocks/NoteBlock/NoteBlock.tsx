import type { NewspaperNote, NoteBlockData } from '../../types';
import { safeImageUrl, safeUrl } from '../../utils/media';
import { noteMaterial, useNewspaperMaterialViewer } from '../../NewspaperMaterialContext';
import s from '../../Newspaper.module.scss';

export function NoteContent({ note, fallbackId = 'note' }: { note: NewspaperNote | NoteBlockData; fallbackId?: string }) {
  const openMaterial = useNewspaperMaterialViewer();
  const url = safeUrl(note.url);
  const image = safeImageUrl(note.image_url, 640);
  const open = () => openMaterial?.(noteMaterial(note, fallbackId));
  return <div className={s.materialNote} data-material-open={openMaterial ? 'true' : undefined} role={openMaterial ? 'button' : undefined} tabIndex={openMaterial ? 0 : undefined} onClick={openMaterial ? open : undefined} onKeyDown={openMaterial ? event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); open(); } } : undefined}>{image && <img className={s.noteImage} src={image} alt=""/>}{note.title && ((url || openMaterial) ? <a data-note-link="true" href={url ?? undefined} target={url ? '_blank' : undefined} rel={url ? 'noreferrer' : undefined} onClick={openMaterial ? event => { event.preventDefault(); event.stopPropagation(); open(); } : undefined}>{note.title}</a> : <strong>{note.title}</strong>)}{note.text && <p>{note.text}</p>}{!note.title && url && (openMaterial ? <a data-note-link="true" href={url} onClick={event => { event.preventDefault(); event.stopPropagation(); open(); }}>Открыть</a> : <a data-note-link="true" href={url} target="_blank" rel="noreferrer">Открыть</a>)}</div>;
}

export function NoteBlock({ note, className, prefix }: { note: NoteBlockData; className?: string; prefix?: string }) {
  return <aside className={className}>{prefix && <b>{prefix}</b>}<div className={s.noteBody}><NoteContent note={note}/></div></aside>;
}
