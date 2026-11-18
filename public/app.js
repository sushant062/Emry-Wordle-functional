import { formatShare } from '/share.js?v=1';

'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const NAME_KEY = 'emry_name';
  const MAX_HINTS = 2;
  const KEY_ROWS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
  const hintKey = (day) => `emry_hint_${day}`;

  const state = {
    screen: 'loading',
    day: null,
    names: [],
    skew: 0,
    mode: 'ranked',
    busy: false,
    starting: false,
    rows: [],
    reveals: [],
    current: '',
    hints: 0,
    penaltyMs: 0,
    startedAt: null,
    practiceStartedAt: null,
    practiceId: null,
    finished: false,
    solved: false,
    elapsedMs: null,
    hintText: null,
    timerId: null,
    flipRow: -1,
  };

  const MESSAGES = {
    invalid_word: 'Not in the word list',
    no_attempt: 'Tap Play to start the clock',
    already_finished: 'You already played today',
    day_over: 'That puzzle just closed',
    max_hints: 'No hints left today',
    not_started: 'Start a puzzle first',
    finished: 'This puzzle is already done',
    rate_limited: 'Slow down a second',
    no_practice_word: 'No past words to practice yet',
    today_word: 'Practice cannot use today\u2019s word',
  };

  const messageFor = (code) => MESSAGES[code] || 'Something went wrong';

  // ---------- DOM helpers ----------

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value !== false && value != null) node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children) if (child != null) node.append(child);
    return node;
  }

  function formatTime(ms) {
    if (ms == null) return '—';
    const safe = Math.max(0, Math.round(ms));
    const minutes = Math.floor(safe / 60000);
    const seconds = Math.floor((safe % 60000) / 1000);
    const tenths = Math.floor((safe % 1000) / 100);
    return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths}`;
  }

  function formatDay(day) {
    if (!day) return '';
    const date = new Date(`${day}T12:00:00`);
    return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }

  function formatMonth(month) {
    if (!month) return '';
    const date = new Date(`${month}-15T12:00:00`);
    return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  function toast(text) {
    if (!text) return;
    const node = $('toast');
    node.textContent = text;
    node.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove('show'), 1900);
  }

  // ---------- HTTP ----------

  async function api(path, options = {}) {
    const res = await fetch(path, { credentials: 'same-origin', ...options });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const error = new Error(body && body.error ? body.error : `http_${res.status}`);
      error.status = res.status;
      throw error;
    }
    return body;
  }

  function post(path, payload) {
    const init = { method: 'POST' };
    if (payload !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(payload);
    }
    return api(path, init);
  }

  // ---------- Rendering ----------

  function renderBoard() {
    const board = $('board');
    board.replaceChildren();
    for (let r = 0; r < 6; r += 1) {
      const row = el('div', { class: 'row' });
      const committed = state.rows[r];
      for (let c = 0; c < 5; c += 1) {
        let letter = '';
        let cls = 'tile';
        if (committed) {
          letter = committed.word[c] || '';
          cls += ` filled ${committed.results[c]}`;
        } else if (r === state.rows.length && state.screen === 'playing' && !state.finished) {
          letter = state.current[c] || '';
          if (letter) cls += ' filled';
        }
        const tile = el('div', { class: cls, text: letter });
        if (state.flipRow === r && committed) {
          tile.classList.add('flip');
          tile.style.animationDelay = `${c * 70}ms`;
        }
        row.append(tile);
      }
      board.append(row);
    }
  }

  function renderHints() {
    const strip = $('hintStrip');
    if (state.reveals.length === 0) {
      strip.hidden = true;
    } else {
      strip.hidden = false;
      strip.replaceChildren();
      for (let i = 0; i < 5; i += 1) {
        const reveal = state.reveals.find((r) => r.position === i);
        strip.append(
          el('div', {
            class: reveal ? 'mini on' : 'mini',
            text: reveal ? reveal.letter : '·',
          }),
        );
      }
    }

    const clue = $('clueBar');
    if (state.hintText) {
      clue.hidden = false;
      clue.textContent = `Hint: ${state.hintText}`;
    } else {
      clue.hidden = true;
    }

    $('hintBar').hidden = state.mode === 'practice';
    $('hintBtn').disabled = state.finished || state.hints >= MAX_HINTS || state.mode === 'practice';
    $('hintCount').textContent = `${state.hints}/${MAX_HINTS}`;
  }

  function renderKeyboard() {
    const statuses = new Map();
    const rank = { absent: 0, present: 1, correct: 2 };
    for (const row of state.rows) {
      for (let i = 0; i < row.results.length; i += 1) {
        const letter = row.word[i];
        const result = row.results[i];
        const previous = statuses.get(letter);
        if (!previous || rank[result] > rank[previous]) statuses.set(letter, result);
      }
    }
    for (const reveal of state.reveals) statuses.set(reveal.letter, 'correct');

    for (const button of $('keyboard').querySelectorAll('.key[data-letter]')) {
      const status = statuses.get(button.dataset.letter);
      button.classList.remove('correct', 'present', 'absent');
      if (status) button.classList.add(status);
    }
  }

  function renderAll() {
    renderBoard();
    renderHints();
    renderKeyboard();
    fitBoard();
    updateTimer();
    state.flipRow = -1;
  }

  function fitBoard() {
    const play = $('playView');
    if (!play.clientHeight) return;
    const children = [...play.children];
    const others = children
      .filter((node) => node.id !== 'board' && !node.hidden && getComputedStyle(node).position !== 'fixed')
      .reduce((sum, node) => sum + node.offsetHeight, 0);
    const available = Math.max(140, play.clientHeight - others - 32);
    const width = Math.max(120, Math.floor(Math.min(play.clientWidth, 330, ((available - 30) * 5) / 6)));
    const tile = (width - 24) / 5;
    const height = Math.floor(tile * 6 + 30);
    const board = $('board');
    board.style.width = `${width}px`;
    board.style.height = `${height}px`;
    $('hintStrip').style.width = `${width}px`;
  }

  // ---------- Timer ----------

  function elapsedNow() {
    if (state.finished && state.elapsedMs != null) return state.elapsedMs;
    if (state.mode === 'practice') {
      return state.practiceStartedAt ? Date.now() - state.practiceStartedAt : 0;
    }
    if (!state.startedAt) return 0;
    return Math.max(0, Date.now() + state.skew - state.startedAt + state.penaltyMs);
  }

  function updateTimer() {
    const timer = $('timer');
    if (state.screen !== 'playing' && state.screen !== 'idle') return;
    timer.hidden = !(state.mode === 'practice' || state.startedAt || state.finished);
    if (!timer.hidden) timer.textContent = formatTime(elapsedNow());
  }

  function startTimer() {
    stopTimer();
    state.timerId = setInterval(updateTimer, 100);
    updateTimer();
  }

  function stopTimer() {
    if (state.timerId) clearInterval(state.timerId);
    state.timerId = null;
  }

  // ---------- Overlays ----------

  function hideOverlay() {
    $('overlay').hidden = true;
  }

  function showOverlay(card) {
    const host = $('overlayCard');
    host.replaceChildren(...card);
    $('overlay').hidden = false;
  }

  function showWelcome() {
    state.screen = 'idle';
    stopTimer();
    $('timer').hidden = true;
    renderAll();

    const saved = localStorage.getItem(NAME_KEY) || '';
    const input = el('input', {
      id: 'nameInput',
      maxlength: '20',
      autocomplete: 'off',
      autocapitalize: 'words',
      placeholder: 'First name and last initial',
      value: saved,
      'aria-label': 'Your name',
    });
    const list = el('datalist', { id: 'nameOptions' });
    for (const name of state.names) list.append(el('option', { value: name }));
    input.setAttribute('list', 'nameOptions');

    const play = el('button', { class: 'btn primary', type: 'button', text: 'Play' });

    const start = async () => {
      const name = input.value.replace(/\s+/g, ' ').trim();
      if (!name) {
        input.focus();
        toast('Type your name first');
        return;
      }
      if (name.length > 20 || !/^[\p{L}\p{N} '.-]+$/u.test(name)) {
        toast('Letters, digits, spaces, . \' - only');
        return;
      }
      localStorage.setItem(NAME_KEY, name);
      hideOverlay();
      beginPlaying();
      try {
        await post('/api/session', { name });
      } catch {
        toast('Name not saved — check the connection');
      }
    };

    play.addEventListener('click', start);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        start();
      }
    });

    showOverlay([
      el('h2', { text: 'Emry Hall 1st Floor' }),
      el('p', { text: 'One word a day. Fastest solve of the week wins the flex. Hints cost 20 seconds each.' }),
      el('label', { for: 'nameInput', text: 'Your name' }),
      input,
      list,
      play,
      el('p', { class: 'tiny', text: 'Same device, same streak. One ranked attempt per day.' }),
    ]);

    setTimeout(() => input.focus(), 60);
  }

  function beginPlaying() {
    state.screen = 'playing';
    state.mode = 'ranked';
    state.finished = false;
    $('timer').hidden = false;
    $('hintBar').hidden = false;
    renderAll();
    toast('Type a word to start the clock');
  }

  function shareText() {
    return formatShare({
      rows: state.rows.map((row) => row.results),
      elapsedMs: state.elapsedMs ?? elapsedNow(),
      hints: state.hints,
    });
  }

  function copyFallback(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    document.body.append(area);
    area.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    area.remove();
    return copied;
  }

  async function copyShare() {
    const text = shareText();
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else if (!copyFallback(text)) {
        throw new Error('copy_failed');
      }
      toast('Copied — paste it in the group chat');
    } catch {
      if (copyFallback(text)) toast('Copied — paste it in the group chat');
      else toast('Could not copy on this phone');
    }
  }

  function showResult() {
    state.screen = 'finished';
    stopTimer();
    $('timer').hidden = false;
    $('timer').textContent = formatTime(state.elapsedMs ?? elapsedNow());
    renderAll();

    const card = [];
    if (state.mode === 'practice') {
      card.push(el('h2', { text: 'Practice done' }));
      card.push(el('p', { text: state.solved ? 'You got it. This one does not count.' : 'Not this time. Practice stays off the board.' }));
    } else {
      card.push(el('h2', { text: state.solved ? 'Solved!' : 'Out of guesses' }));
      card.push(el('p', { text: state.solved ? 'That time is on the board.' : 'Six guesses gone. Tomorrow resets everything.' }));
    }
    card.push(el('div', { class: 'big-time', text: formatTime(state.elapsedMs ?? elapsedNow()) }));
    const rankLine = el('p', { class: 'rank-line', text: 'Checking today\u2019s board…' });
    card.push(rankLine);
    if (state.hints > 0) {
      card.push(el('p', { text: `${state.hints} hint${state.hints === 1 ? '' : 's'} used · +${state.hints * 20}s` }));
    }

    if (state.mode === 'ranked') {
      if (state.solved) {
        const share = el('button', { class: 'btn primary', type: 'button', text: 'Copy result' });
        share.addEventListener('click', copyShare);
        card.push(share);
      }
      const practice = el('button', { class: 'btn', type: 'button', text: 'Practice on a past word' });
      practice.addEventListener('click', startPractice);
      card.push(practice);
    } else {
      const back = el('button', { class: 'btn primary', type: 'button', text: 'Back to today' });
      back.addEventListener('click', () => location.reload());
      card.push(back);
    }

    const board = el('button', { class: 'btn', type: 'button', text: 'Leaderboard' });
    board.addEventListener('click', () => openBoard('day'));
    card.push(board);

    showOverlay(card);
    updateRank(rankLine);
  }

  async function updateRank(line) {
    try {
      const data = await api('/api/leaderboard?range=day');
      const index = data.rows.findIndex(
        (row) => row.elapsedMs === state.elapsedMs && row.name === (localStorage.getItem(NAME_KEY) || row.name),
      );
      if (index >= 0) line.textContent = `#${index + 1} on today\u2019s board`;
      else if (state.solved) line.textContent = 'On today\u2019s board';
      else line.textContent = 'Not ranked today';
    } catch {
      line.textContent = '';
    }
  }

  // ---------- Keyboard ----------

  function buildKeyboard() {
    const keyboard = $('keyboard');
    keyboard.replaceChildren();
    KEY_ROWS.forEach((letters, index) => {
      const row = el('div', { class: 'key-row' });
      if (index === 2) row.append(el('button', { class: 'key wide', type: 'button', text: 'Enter', 'data-key': 'ENTER' }));
      for (const letter of letters) {
        row.append(el('button', { class: 'key', type: 'button', text: letter, 'data-letter': letter, 'data-key': letter }));
      }
      if (index === 2) row.append(el('button', { class: 'key wide', type: 'button', text: 'Del', 'data-key': 'BACK' }));
      keyboard.append(row);
    });

    keyboard.addEventListener('click', (event) => {
      const button = event.target.closest('.key');
      if (button) handleKey(button.dataset.key);
    });
  }

  function shakeRow(index) {
    const row = $('board').children[index];
    if (!row) return;
    row.classList.remove('shake');
    void row.offsetWidth;
    row.classList.add('shake');
    setTimeout(() => row.classList.remove('shake'), 340);
  }

  function handleKey(key) {
    if (!key || state.screen !== 'playing' || state.busy) return;
    if (key === 'ENTER') {
      submitGuess();
      return;
    }
    if (key === 'BACK') {
      state.current = state.current.slice(0, -1);
      renderBoard();
      return;
    }
    if (/^[A-Z]$/.test(key)) typeLetter(key);
  }

  async function beginAttempt() {
    state.starting = true;
    try {
      const data = await post('/api/attempt/start');
      state.startedAt = data.attempt.startedAt;
      state.penaltyMs = data.attempt.penaltyMs || 0;
      state.hints = data.attempt.hints || 0;
      startTimer();
    } catch (error) {
      if (error.message === 'already_finished') {
        toast('You already played today');
        setTimeout(() => location.reload(), 800);
      } else {
        toast(messageFor(error.message));
      }
    } finally {
      state.starting = false;
    }
  }

  function typeLetter(letter) {
    if (state.current.length >= 5 || state.finished) return;
    if (state.mode === 'ranked' && !state.startedAt && !state.starting) beginAttempt();
    state.current += letter;
    renderBoard();
  }

  async function submitGuess() {
    if (state.current.length !== 5) {
      toast('Five letters, then Enter');
      shakeRow(state.rows.length);
      return;
    }
    if (state.mode === 'ranked' && !state.startedAt) {
      toast('Tap Play to start');
      return;
    }
    state.busy = true;
    const guess = state.current;
    try {
      const data =
        state.mode === 'practice'
          ? await post('/api/practice/guess', { practiceId: state.practiceId, guess })
          : await post('/api/guess', { guess });
      const rowIndex = state.rows.length;
      state.rows.push({ word: guess, results: data.results });
      state.current = '';
      state.busy = false;
      state.flipRow = rowIndex;
      renderBoard();
      renderKeyboard();
      if (data.finished) {
        finishRound(data.solved, data.elapsedMs ?? elapsedNow());
      } else if (data.remaining === 1) {
        toast('Last guess');
      }
    } catch (error) {
      state.busy = false;
      if (error.message === 'invalid_word') {
        toast('Not in the word list');
        shakeRow(state.rows.length);
      } else if (error.message === 'already_finished' || error.message === 'day_over') {
        toast(messageFor(error.message));
        setTimeout(() => location.reload(), 900);
      } else {
        toast(messageFor(error.message));
      }
    }
  }

  function finishRound(solved, elapsedMs) {
    state.finished = true;
    state.solved = Boolean(solved);
    state.elapsedMs = elapsedMs;
    state.flipRow = -1;
    showResult();
  }

  // ---------- Hints ----------

  async function requestHint() {
    if (state.mode !== 'ranked' || state.finished || state.hints >= MAX_HINTS) return;
    try {
      const data = await post('/api/hint');
      state.hints = data.hints;
      state.penaltyMs = data.hints * 20000;
      if (data.text) {
        state.hintText = data.text;
        localStorage.setItem(hintKey(state.day), data.text);
        toast('Clue unlocked · +20s');
      }
      if (data.letter) {
        state.reveals.push({ letter: data.letter, position: data.position });
        toast(`Position ${data.position + 1} is ${data.letter} · +20s`);
      }
      renderAll();
    } catch (error) {
      if (error.message === 'max_hints') state.hints = MAX_HINTS;
      toast(messageFor(error.message));
      renderAll();
    }
  }

  function restoreHintText() {
    if (state.hints > 0 && state.day) {
      state.hintText = localStorage.getItem(hintKey(state.day)) || null;
    }
  }

  // ---------- Practice ----------

  async function startPractice() {
    try {
      const data = await post('/api/practice/start');
      state.mode = 'practice';
      state.practiceId = data.practiceId;
      state.rows = [];
      state.reveals = [];
      state.current = '';
      state.hints = 0;
      state.penaltyMs = 0;
      state.startedAt = null;
      state.finished = false;
      state.solved = false;
      state.elapsedMs = null;
      state.practiceStartedAt = Date.now();
      state.screen = 'playing';
      state.hintText = null;
      hideOverlay();
      $('hintBar').hidden = true;
      $('clueBar').hidden = true;
      $('hintStrip').hidden = true;
      startTimer();
      renderAll();
      toast('Practice word · not ranked');
    } catch (error) {
      toast(messageFor(error.message));
    }
  }

  // ---------- Board ----------

  async function openBoard(range) {
    stopTimer();
    $('timer').hidden = true;
    state.screen = 'board';
    hideOverlay();
    $('playView').hidden = true;
    $('boardView').hidden = false;
    await loadBoard(range);
  }

  function closeBoard() {
    $('boardView').hidden = true;
    $('playView').hidden = false;
    if (state.finished) {
      state.screen = 'finished';
      showResult();
    } else if (state.screen === 'board') {
      if (state.startedAt || state.mode === 'practice') {
        state.screen = 'playing';
        startTimer();
      } else {
        showWelcome();
      }
      updateTimer();
      renderAll();
    }
  }

  async function loadBoard(range) {
    for (const tab of document.querySelectorAll('.tab')) {
      const on = tab.dataset.range === range;
      tab.classList.toggle('is-on', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    const list = $('boardList');
    list.replaceChildren(el('div', { class: 'empty', text: 'Loading…' }));
    try {
      const data = await api(`/api/leaderboard?range=${encodeURIComponent(range)}`);
      list.replaceChildren();
      if (range === 'month') {
        renderBoardSection(list, 'Fastest this month', data.fastest);
        renderStreaks(list, data.streaks, 'Longest streaks');
        renderHall(list, data.hallOfFame);
      } else {
        renderBoardSection(list, range === 'week' ? 'Fastest single solve this week' : 'Today\u2019s board', data.rows, range === 'week');
      }
    } catch {
      list.replaceChildren(el('div', { class: 'empty', text: 'The board is not answering.' }));
    }
  }

  function renderBoardSection(list, title, rows, showDay) {
    list.append(el('div', { class: 'board-head', text: title }));
    if (!rows || rows.length === 0) {
      list.append(el('div', { class: 'empty', text: 'Nobody yet. Be the first.' }));
      return;
    }
    rows.forEach((row, index) => {
      const hintMark = row.hints > 0 ? `${row.hints} hint${row.hints === 1 ? '' : 's'}` : '';
      const mine = row.name === (localStorage.getItem(NAME_KEY) || '');
      list.append(
        el(
          'div',
          { class: `board-row${mine ? ' me' : ''}` },
          el('span', { class: 'place', text: `${index + 1}.` }),
          el('span', { class: 'who', text: row.name }),
          el('span', { class: 'time', text: formatTime(row.elapsedMs) }),
          el('span', { class: 'hint-mark', text: hintMark }),
        ),
      );
    });
  }

  function renderStreaks(list, rows, title) {
    list.append(el('div', { class: 'board-head', text: title }));
    if (!rows || rows.length === 0) {
      list.append(el('div', { class: 'empty', text: 'No streaks yet this month.' }));
      return;
    }
    rows.forEach((row, index) => {
      list.append(
        el(
          'div',
          { class: 'board-row' },
          el('span', { class: 'place', text: `${index + 1}.` }),
          el('span', { class: 'who', text: row.name }),
          el('span', { class: 'time', text: `${row.streak} day${row.streak === 1 ? '' : 's'}` }),
          el('span', { class: 'hint-mark', text: formatTime(row.elapsedMs) }),
        ),
      );
    });
  }

  function renderHall(list, months) {
    list.append(el('div', { class: 'board-head', text: 'Hall of Fame' }));
    if (!months || months.length === 0) {
      list.append(el('div', { class: 'empty', text: 'The first month is still being written.' }));
      return;
    }
    for (const month of months) {
      list.append(
        el(
          'div',
          { class: 'board-row' },
          el('span', { class: 'place', text: '★' }),
          el('span', { class: 'who', text: `${formatMonth(month.month)} · ${month.name}` }),
          el('span', { class: 'time', text: `${month.streak} day${month.streak === 1 ? '' : 's'}` }),
          el('span', { class: 'hint-mark', text: month.elapsedMs != null ? formatTime(month.elapsedMs) : '' }),
        ),
      );
    }
  }

  // ---------- Boot ----------

  async function boot() {
    buildKeyboard();
    wireEvents();
    try {
      const data = await api('/api/today');
      state.day = data.day;
      state.names = data.names || [];
      state.skew = (data.serverNow || Date.now()) - Date.now();
      $('dateLabel').textContent = formatDay(data.day);

      if (data.attempt) {
        adoptAttempt(data.attempt);
        restoreHintText();
        if (state.finished) {
          showResult();
        } else {
          state.screen = 'playing';
          hideOverlay();
          $('timer').hidden = false;
          startTimer();
          renderAll();
        }
      } else {
        showWelcome();
      }
    } catch {
      toast('The game is not reachable. Retrying…');
      setTimeout(boot, 2500);
    }
  }

  function adoptAttempt(attempt) {
    state.rows = [];
    state.reveals = [];
    state.hintText = null;
    for (const entry of attempt.guesses || []) {
      if (entry.word && Array.isArray(entry.results)) state.rows.push({ word: entry.word, results: entry.results });
      else if (entry.reveal && Number.isInteger(entry.reveal.position)) state.reveals.push(entry.reveal);
    }
    state.mode = 'ranked';
    state.hints = attempt.hints || 0;
    state.penaltyMs = attempt.penaltyMs || 0;
    state.startedAt = attempt.startedAt;
    state.finished = Boolean(attempt.finishedAt);
    state.solved = Boolean(attempt.solved);
    state.elapsedMs = attempt.elapsedMs ?? null;
    state.current = '';
    state.busy = false;
    state.starting = false;
    state.practiceStartedAt = null;
    state.practiceId = null;
  }

  function wireEvents() {
    document.addEventListener('keydown', (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const active = document.activeElement;
      if (active && active.tagName === 'INPUT' && active.id !== 'nameInput') return;
      if (active && active.tagName === 'INPUT') return;
      if (state.screen !== 'playing') return;
      if (event.key === 'Enter') {
        event.preventDefault();
        handleKey('ENTER');
      } else if (event.key === 'Backspace') {
        event.preventDefault();
        handleKey('BACK');
      } else if (/^[a-zA-Z]$/.test(event.key)) {
        event.preventDefault();
        handleKey(event.key.toUpperCase());
      }
    });

    $('hintBtn').addEventListener('click', requestHint);
    $('boardBtn').addEventListener('click', () => openBoard('day'));
    $('backToPlay').addEventListener('click', closeBoard);
    window.addEventListener('resize', fitBoard);
    window.addEventListener('orientationchange', fitBoard);
    for (const tab of document.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => loadBoard(tab.dataset.range));
    }
  }

  boot();
})();
