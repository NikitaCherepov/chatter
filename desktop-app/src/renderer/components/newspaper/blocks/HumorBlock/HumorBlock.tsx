import type { HumorBlockData } from '../../types';

export function HumorBlock({ humor, className, prefix }: { humor: HumorBlockData; className?: string; prefix?: string }) {
  return <aside className={className}>{prefix && <b>{prefix}</b>}<h2>{humor.title}</h2><p>{humor.text}</p></aside>;
}
