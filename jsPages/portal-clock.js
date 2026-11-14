import { formatPortalTime, portalTimeZone } from './datetime-prefs.js';

// Both pages read the current instant on each wall-clock second, including
// immediately after refresh or returning to a backgrounded tab.
export function watchPortalClock(onTick) {
  let timer;
  const tick = () => {
    clearTimeout(timer);
    const now = new Date();
    const timeZone = portalTimeZone();
    const clock = document.getElementById('live-clock');
    const day = document.getElementById('live-day');
    if (clock) clock.textContent = formatPortalTime(now, { seconds: true });
    if (day) day.textContent = now.toLocaleDateString([], { timeZone, weekday: 'long' });
    onTick?.(now);
    timer = setTimeout(tick, 1000 - Date.now() % 1000);
  };
  const resume = () => { if (!document.hidden) tick(); };
  const preferencesChanged = (event) => {
    if (event.key === 'peakpath-datetime' || event.key === null) tick();
  };
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('pageshow', tick);
  window.addEventListener('storage', preferencesChanged);
  tick();
  return () => {
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('pageshow', tick);
    window.removeEventListener('storage', preferencesChanged);
  };
}
