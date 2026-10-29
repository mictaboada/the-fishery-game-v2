(() => {
  const cfg = window.FISHERY_CONFIG || {};
  const configured = /^https?:\/\/.+/.test(cfg.SUPABASE_URL || '') && !/YOUR-/.test(cfg.SUPABASE_URL + cfg.SUPABASE_ANON_KEY);

  const $ = (id) => document.getElementById(id);
  const nameInput = $('player-name');
  const takeBtn = $('btn-take');
  const skipBtn = $('btn-skip');
  const messageEl = $('message');

  let game = null;
  let rounds = [];

  const NAME_KEY = 'fisheryPlayerName';
  try { nameInput.value = localStorage.getItem(NAME_KEY) || ''; } catch {}

  async function rest(path, options = {}) {
    const headers = { apikey: cfg.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
    // Legacy anon keys are JWTs and go in Authorization too; newer publishable keys must not.
    if (cfg.SUPABASE_ANON_KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${cfg.SUPABASE_ANON_KEY}`;
    const res = await fetch(`${cfg.SUPABASE_URL}/rest/v1/${path}`, { ...options, headers });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error((body && (body.message || body.hint)) || `Request failed (${res.status})`);
    return body;
  }

  function showMessage(text, ok) {
    messageEl.textContent = text;
    messageEl.className = `message ${ok ? 'ok' : 'bad'}`;
  }
  function clearMessage() {
    messageEl.className = 'message hidden';
    messageEl.textContent = '';
  }
  function setButtons(disabled) {
    takeBtn.disabled = disabled;
    skipBtn.disabled = disabled;
  }

  async function load() {
    try {
      const [g, r] = await Promise.all([
        rest('game_state?select=*&id=eq.1'),
        rest('rounds?select=*&order=round.asc'),
      ]);
      game = g[0];
      rounds = r;
      $('load-error').classList.add('hidden');
      render();
      if (game && game.status === 'open') await refreshSubmittedState();
    } catch (err) {
      $('load-error').textContent = `Couldn't load the game: ${err.message}`;
      $('load-error').classList.remove('hidden');
    }
  }

  function render() {
    if (!game) return;
    $('game-block').classList.remove('hidden');
    $('stat-round').textContent = `${game.current_round} / ${game.total_rounds}`;
    $('stat-pool').textContent = `${game.fish_pool} 🐟`;

    const last = rounds[rounds.length - 1];
    const lastEl = $('last-round');
    if (last) {
      lastEl.textContent = `Round ${last.round} closed: ${last.requested} asked for a fish, ${last.caught} caught. Pool ${last.pool_before} → ${last.pool_after}.`;
      lastEl.classList.remove('hidden');
    } else {
      lastEl.classList.add('hidden');
    }

    const open = game.status === 'open';
    $('choose-block').classList.toggle('hidden', !open);
    $('end-block').classList.toggle('hidden', open);
    if (!open) {
      const banner = $('end-banner');
      if (game.status === 'won') {
        banner.textContent = `🎉 The group survived all ${game.total_rounds} rounds!`;
        banner.className = 'result-banner big pass';
      } else {
        banner.textContent = '💥 The fishery collapsed. The game is over.';
        banner.className = 'result-banner big fail';
      }
    }

    $('history-block').classList.toggle('hidden', rounds.length === 0);
    const table = $('history-table');
    table.innerHTML = '';
    const head = document.createElement('tr');
    ['Round', 'Pool before', 'Asked', 'Caught', 'Pool after'].forEach((h) => {
      const th = document.createElement('th');
      th.textContent = h;
      head.appendChild(th);
    });
    table.appendChild(head);
    rounds.forEach((rd) => {
      const tr = document.createElement('tr');
      if (rd.collapse) tr.className = 'fail-row';
      [rd.round, rd.pool_before, rd.requested, rd.caught, rd.pool_after].forEach((v) => {
        const td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
  }

  async function refreshSubmittedState() {
    const name = nameInput.value.trim();
    if (!name || !game || game.status !== 'open') {
      setButtons(false);
      clearMessage();
      return;
    }
    try {
      const done = await rest('rpc/has_submitted', { method: 'POST', body: JSON.stringify({ p_name: name }) });
      if (done === true) {
        setButtons(true);
        showMessage(`Your choice for round ${game.current_round} is recorded. Check back after the round closes.`, true);
      } else {
        setButtons(false);
        clearMessage();
      }
    } catch {
      // Not critical: submitting still reports "already chosen" if needed.
    }
  }

  async function submit(choice) {
    const name = nameInput.value.trim();
    if (!name) {
      showMessage('Please enter your name first.', false);
      nameInput.focus();
      return;
    }
    try { localStorage.setItem(NAME_KEY, name); } catch {}
    setButtons(true);
    clearMessage();
    try {
      await rest('rpc/submit_choice', { method: 'POST', body: JSON.stringify({ p_name: name, p_choice: choice }) });
      showMessage(
        `Recorded: you chose ${choice === 1 ? 'to take a fish' : 'to take none'}. Check back after the round closes.`,
        true
      );
    } catch (err) {
      const m = err.message || '';
      if (/already_submitted/.test(m)) {
        showMessage("You've already chosen for this round.", false);
      } else if (/game_over/.test(m)) {
        showMessage('The game is over, so no more choices can be recorded.', false);
        await load();
      } else if (/invalid_name/.test(m)) {
        showMessage('Please enter a valid name (up to 40 characters).', false);
        setButtons(false);
      } else {
        showMessage(`Couldn't record your choice: ${m}. Please try again.`, false);
        setButtons(false);
      }
    }
  }

  takeBtn.onclick = () => submit(1);
  skipBtn.onclick = () => submit(0);
  $('btn-refresh').onclick = load;
  nameInput.addEventListener('change', () => {
    try { localStorage.setItem(NAME_KEY, nameInput.value.trim()); } catch {}
    refreshSubmittedState();
  });

  if (!configured) {
    $('setup-notice').classList.remove('hidden');
    return;
  }

  load();
  setInterval(() => { if (!document.hidden) load(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
})();
