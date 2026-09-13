import type { WeatherBlockData } from '../../types';
import s from '../../Newspaper.module.scss';

export function WeatherForecast({ weather, compact = false }: { weather?: WeatherBlockData; compact?: boolean }) {
  if (!weather) return null;
  return <div className={compact ? s.forecastCompact : s.forecast}>{weather.periods.map(period => <div className={s.forecastPeriod} key={period.label}><span>{period.label}</span><strong>{Math.round(period.temperature)}°</strong><small>{period.condition}</small></div>)}</div>;
}
