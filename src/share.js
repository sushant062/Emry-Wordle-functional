const EMOJI = {
  absent: '⬛',
  present: '🟨',
  correct: '🟩',
};

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export function formatShare({ rows = [], elapsedMs = 0, hints = 0 } = {}) {
  const time = formatDuration(elapsedMs);
  const hintText = hints > 0 ? ` (${hints} hint${hints === 1 ? '' : 's'})` : '';
  const grid = rows
    .filter((row) => Array.isArray(row) && row.length > 0)
    .map((row) => row.map((cell) => EMOJI[cell] ?? '').join(''))
    .join('\n');
  return `Emry Hall 1st Floor — ${time} ⏱${hintText}${grid ? `\n${grid}` : ''}`;
}
