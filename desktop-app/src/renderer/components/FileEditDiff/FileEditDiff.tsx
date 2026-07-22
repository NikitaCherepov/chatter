import { useMemo } from 'react';
import { diffLines } from 'diff';
import s from './FileEditDiff.module.scss';

type FileEditDiffProps = {
  oldContent: string;
  newContent: string;
};

export function FileEditDiff({ oldContent, newContent }: FileEditDiffProps) {
  const parts = useMemo(
    () => diffLines(oldContent, newContent),
    [oldContent, newContent],
  );

  return (
    <div className={s.diff}>
      {parts.flatMap((part, partIndex) => {
        const lines = part.value.split('\n');
        if (lines[lines.length - 1] === '') lines.pop();

        return lines.map((line, lineIndex) => (
          <div
            key={`${partIndex}-${lineIndex}`}
            className={`${s.line} ${part.added ? s.added : ''} ${part.removed ? s.removed : ''}`}
          >
            <span className={s.prefix}>{part.added ? '+' : part.removed ? '−' : ' '}</span>
            <code className={s.content}>{line || ' '}</code>
          </div>
        ));
      })}
    </div>
  );
}
