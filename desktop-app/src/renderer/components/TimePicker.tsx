import React from 'react';
import { Select } from './Select';

const timeOptions = (count: number) => Array.from({ length: count }, (_, index) => {
  const value = String(index).padStart(2, '0');
  return { value, label: value };
});

const hours = timeOptions(24);
const minutes = timeOptions(60);

export function TimePicker({ value, onChange, hourLabel, minuteLabel }: {
  value: string;
  onChange: (value: string) => void;
  hourLabel: string;
  minuteLabel: string;
}) {
  const [hour, minute] = value.split(':');

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '72px auto 72px', alignItems: 'center', gap: 4 }}>
      <Select options={hours} value={hour} ariaLabel={hourLabel} onChange={next => onChange(next + ':' + minute)} />
      <span aria-hidden="true">:</span>
      <Select options={minutes} value={minute} ariaLabel={minuteLabel} onChange={next => onChange(hour + ':' + next)} />
    </div>
  );
}
