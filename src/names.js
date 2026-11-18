const ALLOWED = /^[\p{L}\p{N} '.-]+$/u;
const HAS_LETTER = /\p{L}/u;
const MARKUP = /[<>&\u0000-\u001f\u007f]/;

export function normalizeName(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\.+$/, '')
    .trim();
}

export function validateName(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'name_required' };
  const display = raw.replace(/\s+/g, ' ').trim();
  if (!display) return { ok: false, error: 'name_required' };
  if (display.length > 20) return { ok: false, error: 'name_too_long' };
  if (MARKUP.test(display) || !ALLOWED.test(display) || !HAS_LETTER.test(display)) {
    return { ok: false, error: 'name_invalid' };
  }
  return { ok: true, display, norm: normalizeName(display) };
}
