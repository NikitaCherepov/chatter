import { VirtualRow, type VirtualRowProps } from './VirtualRows';
import s from './VirtualMessage.module.scss';

export function VirtualMessage(props: Omit<VirtualRowProps, 'className'>) {
  return <VirtualRow {...props} className={s.row} />;
}
