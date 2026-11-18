const CHICAGO = 'America/Chicago';

const FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: CHICAGO,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const pad = (n) => String(n).padStart(2, '0');

export function ctParts(ms = Date.now()) {
  const raw = {};
  for (const part of FORMATTER.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') raw[part.type] = part.value;
  }
  return {
    year: Number(raw.year),
    month: Number(raw.month),
    day: Number(raw.day),
    hour: raw.hour === '24' ? 0 : Number(raw.hour),
    minute: Number(raw.minute),
    second: Number(raw.second),
  };
}

export function centralDay(now = Date.now()) {
  const p = ctParts(now);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function nextCentralMidnight(now = Date.now()) {
  const p = ctParts(now);
  const targetWall = Date.UTC(p.year, p.month - 1, p.day + 1);
  let guess = targetWall;
  for (let i = 0; i < 3; i += 1) {
    const q = ctParts(guess);
    const actualWall = Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, q.second);
    const delta = targetWall - actualWall;
    if (delta === 0) break;
    guess += delta;
  }
  return guess;
}

export function weekStart(day) {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay();
  const back = dow === 0 ? 6 : dow - 1;
  date.setUTCDate(date.getUTCDate() - back);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}
