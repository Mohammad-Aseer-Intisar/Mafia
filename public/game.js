/* Mafia client. Renders everything from server snapshots ('state' events).
   There is deliberately no client-side game logic: the server decides what
   this player may see and do, the client only draws it. */
(function () {
  'use strict';

  const CAT = window.MafiaCatalog;

  // --- Session identity ------------------------------------------------------

  let token = localStorage.getItem('mafiaToken');
  if (!token) {
    token = 'p_' + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
    localStorage.setItem('mafiaToken', token);
  }

  const socket = io();

  // --- Local view state --------------------------------------------------------

  let S = null; // latest snapshot from the server
  let lastLogSeq = 0;
  let joining = false;

  const $ = (id) => document.getElementById(id);

  const screens = {
    home: $('screen-home'),
    lobby: $('screen-lobby'),
    game: $('screen-game'),
    end: $('screen-end')
  };

  // --- Tiny DOM helpers ----------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  let toastTimer = null;
  function toast(message) {
    const box = $('toast');
    box.textContent = message;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, 4000);
  }

  function formatSeconds(total) {
    if (total >= 60) {
      const m = Math.floor(total / 60);
      const s = total % 60;
      return `${m}:${String(s).padStart(2, '0')}`;
    }
    return `${total}s`;
  }

  // --- Screen switching ------------------------------------------------------------

  function showScreen(key) {
    for (const [name, node] of Object.entries(screens)) {
      node.hidden = name !== key;
    }
  }

  function myAlignment() {
    const role = S && S.you && S.you.role && CAT.roleById(S.you.role);
    return role ? role.alignment : null;
  }

  // --- Master render -----------------------------------------------------------------

  function render() {
    if (!S) {
      document.body.className = 'phase-lobby';
      showScreen('home');
      return;
    }
    if (S.phase === 'lobby') {
      document.body.className = 'phase-lobby';
      showScreen('lobby');
      renderLobby();
    } else if (S.phase === 'game-over') {
      document.body.className = 'phase-day';
      showScreen('end');
      renderEnd();
    } else {
      document.body.className = S.phase === 'night' ? 'phase-night' : 'phase-day';
      showScreen('game');
      renderGame();
    }
  }

  // --- Lobby ---------------------------------------------------------------------------

  const TIMER_FIELDS = ['nightTimer', 'discussionTimer', 'votingTimer'];

  function renderLobby() {
    const isHost = S.you && S.you.isHost;

    $('lobby-code').textContent = S.code.split('').join(' ');
    $('lobby-count').textContent =
      `${S.players.length} player${S.players.length === 1 ? '' : 's'} · ${S.minPlayers}–${S.maxPlayers} supported`;

    // Roster
    const roster = $('lobby-players');
    clear(roster);
    for (const p of S.players) {
      const li = document.createElement('li');
      li.appendChild(el('span', 'roster-avatar', initials(p.name)));
      const name = el('span', 'roster-name', p.name);
      roster.appendChild(li);
      li.appendChild(name);
      if (p.isHost) li.appendChild(el('span', 'tag tag-gold', 'Host'));
      if (S.you && p.id === S.you.id) li.appendChild(el('span', 'tag tag-purple', 'You'));
    }

    // Suggestion box
    $('suggestion-mode').textContent = S.lobby.auto ? 'Suggested setup' : 'Custom setup';
    $('btn-reset-suggested').hidden = S.lobby.auto || !isHost;
    const reasons = $('suggestion-reasons');
    clear(reasons);
    if (S.lobby.auto) {
      for (const reason of S.lobby.reasons) reasons.appendChild(el('li', null, reason));
    } else {
      reasons.appendChild(el('li', null, 'The host is picking roles by hand. Warnings appear below if the balance looks rough.'));
    }

    renderSteppers(isHost);
    $('villager-count').textContent = String(S.lobby.villagers);

    // Warnings & errors
    const advisories = $('lobby-warnings');
    clear(advisories);
    for (const err of S.lobby.validation.errors) {
      advisories.appendChild(el('div', 'advisory advisory-error', `⛔ ${err}`));
    }
    for (const warning of S.lobby.validation.warnings) {
      advisories.appendChild(el('div', 'advisory advisory-warning', `⚠️ ${warning}`));
    }

    // Timers & toggles reflect server state
    for (const key of TIMER_FIELDS) {
      const select = document.querySelector(`select[data-setting="${key}"]`);
      select.value = String(S.settings[key]);
      select.disabled = !isHost;
    }
    $('set-reveal').checked = S.settings.revealRoleOnDeath;
    $('set-reveal').disabled = !isHost;
    $('set-firstnight').checked = S.settings.firstNightKill;
    $('set-firstnight').disabled = !isHost;

    // Start controls
    const canStart = S.players.length >= S.minPlayers && S.lobby.validation.errors.length === 0;
    $('btn-start').hidden = !isHost;
    $('btn-start').disabled = !canStart;
    $('lobby-waiting').hidden = isHost;
  }

  function renderSteppers(isHost) {
    const wrap = $('role-steppers');
    clear(wrap);
    for (const role of CAT.ROLES) {
      if (role.id === 'villager') continue;
      const count = S.lobby.counts[role.id] || 0;
      const row = el('div', 'stepper-row');

      const label = el('span', 'stepper-role');
      label.appendChild(el('span', 'align-dot', CAT.ALIGNMENTS[role.alignment].icon));
      label.appendChild(el('span', null, `${role.icon} ${role.name}`));
      row.appendChild(label);

      const controls = el('span', 'stepper-controls');
      const minus = el('button', 'stepper-btn', '−');
      minus.type = 'button';
      minus.disabled = !isHost || count <= 0;
      minus.setAttribute('aria-label', `Fewer ${role.name}`);
      const value = el('span', 'stepper-value', String(count));
      value.setAttribute('aria-live', 'polite');
      const plus = el('button', 'stepper-btn', '+');
      plus.type = 'button';
      plus.disabled = !isHost || count >= role.max;
      plus.setAttribute('aria-label', `More ${role.name}`);

      minus.addEventListener('click', () => changeRoleCount(role.id, -1));
      plus.addEventListener('click', () => changeRoleCount(role.id, +1));

      controls.appendChild(minus);
      controls.appendChild(value);
      controls.appendChild(plus);
      row.appendChild(controls);
      wrap.appendChild(row);
    }
  }

  function changeRoleCount(roleId, delta) {
    if (!S || !S.you || !S.you.isHost) return;
    const counts = Object.assign({}, S.lobby.counts);
    counts[roleId] = Math.max(0, (counts[roleId] || 0) + delta);
    sendSettings({ roleMode: 'manual', roleCounts: counts });
  }

  function sendSettings(patch) {
    const settings = Object.assign({}, S.settings, patch);
    socket.emit('update-settings', { settings });
  }

  function initials(name) {
    return name.trim().slice(0, 2).toUpperCase() || '?';
  }

  // --- Game ---------------------------------------------------------------------------------

  const PHASE_META = {
    'night': { icon: '🌑', label: (n) => `Night ${n}` },
    'day-announcement': { icon: '🌅', label: (n) => `Day ${n} — Morning` },
    'day-discussion': { icon: '💬', label: (n) => `Day ${n} — Discussion` },
    'day-voting': { icon: '⚖️', label: (n) => `Day ${n} — Voting` }
  };

  function renderGame() {
    const meta = PHASE_META[S.phase];
    $('phase-icon').textContent = meta.icon;
    $('phase-name').textContent = meta.label(S.dayNumber);

    renderRoleBanner();
    renderPlayerGrid();
    renderChatVisibility();
  }

  function renderRoleBanner() {
    const you = S.you;
    const banner = $('role-banner');
    const role = you.role ? CAT.roleById(you.role) : null;

    banner.className = 'panel role-banner' + (role ? ` align-${role.alignment}` : '') + (you.alive ? '' : ' is-dead');
    $('my-role').textContent = role
      ? `${role.icon} ${role.name}${you.alive ? '' : ' · DEAD'}`
      : '—';

    $('action-prompt').textContent = actionPromptText();

    const buttons = $('action-buttons');
    clear(buttons);

    if (you.alive && S.phase === 'night' && you.nightActionType) {
      const skip = el('button', 'btn btn-ghost btn-small',
        you.nightActionType === 'shoot' ? '🔫 Hold fire tonight' : 'Skip my action');
      skip.type = 'button';
      if (you.myNightAction === 'skip') skip.classList.add('is-selected');
      skip.addEventListener('click', () => socket.emit('night-action', { target: 'skip' }));
      buttons.appendChild(skip);
    }

    if (you.alive && S.phase === 'day-voting') {
      const skipVotes = Object.values(S.votes || {}).filter(v => v === 'skip').length;
      const skip = el('button', 'btn btn-secondary btn-small', `Skip vote (${skipVotes})`);
      skip.type = 'button';
      skip.addEventListener('click', () => socket.emit('day-vote', { target: 'skip' }));
      buttons.appendChild(skip);
      if (you.myVote === 'skip') {
        buttons.appendChild(el('span', 'mark mark-vote', 'You chose to skip'));
      }
    }

    if (you.alive && you.role === 'mayor' && !you.mayorRevealed && S.phase.startsWith('day')) {
      const reveal = el('button', 'btn btn-primary btn-small', '🏛️ Reveal as Mayor');
      reveal.type = 'button';
      reveal.addEventListener('click', () => {
        if (window.confirm('Reveal yourself as the Mayor? Everyone will know — including the Mafia.')) {
          socket.emit('mayor-reveal');
        }
      });
      buttons.appendChild(reveal);
    }

    if (you.isHost && S.phase === 'day-discussion') {
      const endBtn = el('button', 'btn btn-secondary btn-small', 'End discussion → vote');
      endBtn.type = 'button';
      endBtn.addEventListener('click', () => socket.emit('end-discussion'));
      buttons.appendChild(endBtn);
    }
  }

  function actionPromptText() {
    const you = S.you;
    if (!you.alive) {
      return 'You are dead. Spectate quietly — no hints on Discord!';
    }
    if (S.phase === 'night') {
      switch (you.nightActionType) {
        case 'protect': return 'Choose someone to protect tonight. You may protect yourself.';
        case 'guard': return 'Choose someone to guard. If they are attacked, you take the hit for them.';
        case 'investigate': return 'Choose someone to investigate. You will learn if they are Suspicious or Innocent.';
        case 'role-investigate': return 'Choose someone to study. You will learn their exact role.';
        case 'mafia-kill': return 'Vote with your team on tonight\'s target. Most votes wins; ties are a coin flip.';
        case 'kill': return 'Choose tonight\'s victim. You answer to no one.';
        case 'shoot': return 'You have one bullet. Shoot someone — or hold fire. Shooting Town will haunt you.';
        default: return 'Nothing for you to do tonight. Sleep tight and wait for morning.';
      }
    }
    if (S.phase === 'day-announcement') return 'The morning report is in — check the event log.';
    if (S.phase === 'day-discussion') {
      let text = 'Talk it out. Who seems off?';
      if (you.role === 'mayor' && !you.mayorRevealed) text += ' You can reveal as Mayor for a double vote.';
      return text;
    }
    if (S.phase === 'day-voting') return 'Tap a player to vote for their execution, or skip.';
    return '';
  }

  function selectableIds() {
    const you = S.you;
    const ids = new Set();
    if (!you.alive) return ids;

    if (S.phase === 'night' && you.nightActionType) {
      const teammates = new Set((you.teammates || []).map(t => t.id));
      for (const p of S.players) {
        if (!p.alive) continue;
        if (p.id === you.id && you.nightActionType !== 'protect') continue;
        if (you.nightActionType === 'mafia-kill' && (teammates.has(p.id) || p.id === you.id)) continue;
        ids.add(p.id);
      }
    } else if (S.phase === 'day-voting') {
      for (const p of S.players) {
        if (p.alive && p.id !== you.id) ids.add(p.id);
      }
    }
    return ids;
  }

  function renderPlayerGrid() {
    const grid = $('player-grid');
    clear(grid);

    const you = S.you;
    const selectable = selectableIds();
    const teammateRoles = new Map((you.teammates || []).map(t => [t.id, t.role]));

    // Voter names per target during the public vote
    const votersByTarget = new Map();
    if (S.phase === 'day-voting' && S.votes) {
      const nameById = new Map(S.players.map(p => [p.id, p.name]));
      for (const [voterId, target] of Object.entries(S.votes)) {
        if (target === 'skip') continue;
        if (!votersByTarget.has(target)) votersByTarget.set(target, []);
        votersByTarget.get(target).push(nameById.get(voterId) || '?');
      }
    }

    for (const p of S.players) {
      const li = document.createElement('li');
      const card = el('button', 'p-card');
      card.type = 'button';
      card.dataset.id = p.id;

      const isSelf = p.id === you.id;
      const canSelect = selectable.has(p.id);
      const picked = (S.phase === 'night' && you.myNightAction === p.id)
        || (S.phase === 'day-voting' && you.myVote === p.id);

      if (!p.alive) card.classList.add('is-dead');
      if (canSelect) card.classList.add('is-selectable');
      if (picked) card.classList.add('is-selected');
      card.setAttribute('aria-pressed', picked ? 'true' : 'false');
      if (!canSelect) card.setAttribute('aria-disabled', 'true');

      card.appendChild(el('span', 'p-avatar', initials(p.name)));

      let displayName = p.name;
      if (p.isHost) displayName += ' 👑';
      if (isSelf) displayName += ' (you)';
      card.appendChild(el('span', 'p-name', displayName));

      // Status: text + icon, never color alone
      let chip;
      if (!p.alive) chip = el('span', 'chip chip-dead', '☠ Dead');
      else if (!p.connected) chip = el('span', 'chip chip-offline', '⌁ Offline');
      else chip = el('span', 'chip chip-alive', '● Alive');
      card.appendChild(chip);

      // Role tag when known to this viewer
      const knownRole = p.role || (isSelf ? you.role : null) || teammateRoles.get(p.id) || null;
      if (knownRole) {
        const role = CAT.roleById(knownRole);
        card.appendChild(el('span', `p-role-tag align-${role.alignment}`, `${role.icon} ${role.name}`));
      }

      // Marks: my pick, mafia tallies, public voters
      const marks = el('span', 'p-marks');
      if (picked) marks.appendChild(el('span', 'mark mark-target', 'Your pick'));
      if (S.phase === 'night' && you.mafiaKillVotes && you.mafiaKillVotes[p.id]) {
        marks.appendChild(el('span', 'mark mark-target', `🔪 ${you.mafiaKillVotes[p.id]}`));
      }
      for (const voter of votersByTarget.get(p.id) || []) {
        marks.appendChild(el('span', 'mark mark-vote', `🗳 ${voter}`));
      }
      if (marks.childNodes.length > 0) card.appendChild(marks);

      const label = `${p.name}, ${p.alive ? 'alive' : 'dead'}${knownRole ? `, ${CAT.roleById(knownRole).name}` : ''}`;
      card.setAttribute('aria-label', canSelect ? `${label}. Select as target.` : label);

      if (canSelect) {
        card.addEventListener('click', () => {
          if (S.phase === 'night') socket.emit('night-action', { target: p.id });
          else if (S.phase === 'day-voting') socket.emit('day-vote', { target: p.id });
        });
      }

      li.appendChild(card);
      grid.appendChild(li);
    }
  }

  function renderChatVisibility() {
    const inMafia = myAlignment() === 'mafia';
    $('mafia-chat').hidden = !inMafia;
    if (inMafia) {
      const canWrite = S.phase === 'night' && S.you.alive;
      $('chat-input').disabled = !canWrite;
      $('chat-input').placeholder = canWrite ? 'Whisper to the team…' : 'Mafia chat opens at night';
    }
  }

  // --- End screen -------------------------------------------------------------------------------

  function renderEnd() {
    const winner = S.winner || {};
    $('end-title').textContent = titleForWinner(winner.faction);
    $('end-title').className = `end-title win-${winner.faction || 'draw'}`;
    $('end-message').textContent = winner.message || '';
    $('end-cowinners').textContent = (winner.coWinners && winner.coWinners.length > 0)
      ? `🌱 Also winning: ${winner.coWinners.join(', ')} (Survivor)`
      : '';

    const body = $('end-roster');
    clear(body);
    for (const p of S.players) {
      const tr = document.createElement('tr');
      const nameCell = el('td', null, p.name + (S.you && p.id === S.you.id ? ' (you)' : ''));
      const role = p.role ? CAT.roleById(p.role) : null;
      const roleCell = el('td', null, role ? `${role.icon} ${role.name}` : '—');
      const fate = el('td');
      fate.appendChild(p.alive
        ? el('span', 'chip chip-alive', '● Survived')
        : el('span', 'chip chip-dead', '☠ Died'));
      tr.appendChild(nameCell);
      tr.appendChild(roleCell);
      tr.appendChild(fate);
      body.appendChild(tr);
    }

    const isHost = S.you && S.you.isHost;
    $('btn-again').hidden = !isHost;
    $('end-waiting').hidden = isHost;
  }

  function titleForWinner(faction) {
    switch (faction) {
      case 'town': return 'Town wins!';
      case 'mafia': return 'Mafia wins!';
      case 'serialkiller': return 'The Serial Killer wins!';
      case 'jester': return 'The Jester wins!';
      default: return 'Nobody wins';
    }
  }

  // --- Event log & chat ------------------------------------------------------------------------------

  function appendLog(entry) {
    if (entry.seq <= lastLogSeq) return;
    lastLogSeq = entry.seq;
    const feed = $('log-feed');
    feed.appendChild(el('div', `log-entry kind-${entry.kind}`, entry.text));
    feed.scrollTop = feed.scrollHeight;
  }

  function appendChat(msg) {
    const feed = $('chat-feed');
    const row = el('div', 'chat-msg' + (msg.senderId === token ? ' is-me' : ''));
    row.appendChild(el('span', 'sender', msg.senderName));
    row.appendChild(document.createTextNode(msg.text));
    feed.appendChild(row);
    feed.scrollTop = feed.scrollHeight;
  }

  // --- Help / rules panel -------------------------------------------------------------------------------

  function openHelp() {
    buildHelp();
    $('help-panel').hidden = false;
    $('btn-close-help').focus();
    document.addEventListener('keydown', onHelpKeydown);
  }

  function closeHelp() {
    $('help-panel').hidden = true;
    document.removeEventListener('keydown', onHelpKeydown);
    $('btn-help').focus();
  }

  function onHelpKeydown(event) {
    if (event.key === 'Escape') closeHelp();
  }

  function buildHelp() {
    const body = $('help-body');
    clear(body);

    // Which roles to show: only what's in this game once one exists.
    let counts = null;
    let intro;
    if (S && S.activeRoleCounts) {
      counts = S.activeRoleCounts;
      intro = 'Roles in this game:';
    } else if (S && S.lobby) {
      counts = Object.assign({}, S.lobby.counts, { villager: S.lobby.villagers });
      intro = 'Roles in the current setup:';
    } else {
      intro = 'All roles:';
    }

    body.appendChild(el('h3', 'help-section-title', intro));
    for (const role of CAT.ROLES) {
      const inPlay = counts ? (counts[role.id] || 0) : 1;
      if (counts && inPlay === 0) continue;
      const box = el('div', 'help-role');
      const head = el('div', 'help-role-head');
      head.appendChild(el('span', null, `${role.icon} ${role.name}${counts && inPlay > 1 ? ` ×${inPlay}` : ''}`));
      const align = CAT.ALIGNMENTS[role.alignment];
      head.appendChild(el('span',
        `tag ${role.alignment === 'mafia' ? 'tag-crimson' : role.alignment === 'town' ? 'tag-teal' : 'tag-purple'}`,
        `${align.icon} ${align.name}`));
      box.appendChild(head);
      box.appendChild(el('p', null, role.ability));
      box.appendChild(el('p', 'win', `Wins: ${role.win}`));
      body.appendChild(box);
    }

    body.appendChild(el('h3', 'help-section-title', 'How a round flows'));
    for (const phase of CAT.PHASES) {
      const item = el('p', 'help-item');
      item.appendChild(el('strong', null, `${phase.icon} ${phase.name} — `));
      item.appendChild(document.createTextNode(phase.text));
      body.appendChild(item);
    }

    body.appendChild(el('h3', 'help-section-title', 'Night resolution order'));
    body.appendChild(el('p', 'help-item',
      'Doctor and Bodyguard protections lock in first. Attacks land in order: Mafia, then Serial Killer, then Vigilante. ' +
      'For each attack: a Bodyguard dies in the target\'s place (unless the Doctor healed the Bodyguard), otherwise a Doctor save blocks it, otherwise the target dies. ' +
      'Investigations resolve last.'));

    if (S && S.settings) {
      body.appendChild(el('h3', 'help-section-title', 'This game\'s settings'));
      const s = S.settings;
      const timerText = (v) => (v === 0 ? 'no limit' : formatSeconds(v));
      const values = {
        nightTimer: timerText(s.nightTimer),
        discussionTimer: timerText(s.discussionTimer),
        votingTimer: timerText(s.votingTimer),
        revealRoleOnDeath: s.revealRoleOnDeath ? 'on' : 'off',
        firstNightKill: s.firstNightKill ? 'on' : 'off'
      };
      for (const item of CAT.SETTINGS_HELP) {
        const row = el('p', 'help-item');
        row.appendChild(el('strong', null, `${item.name}: ${values[item.key]} — `));
        row.appendChild(document.createTextNode(item.text));
        body.appendChild(row);
      }
    }
  }

  // --- Socket events --------------------------------------------------------------------------------------

  socket.on('connect', () => {
    const code = localStorage.getItem('mafiaRoom');
    if (code && !joining) {
      socket.emit('rejoin-room', { code, token });
    }
  });

  socket.on('joined', ({ code }) => {
    joining = false;
    localStorage.setItem('mafiaRoom', code);
  });

  socket.on('rejoin-failed', () => {
    localStorage.removeItem('mafiaRoom');
    S = null;
    render();
  });

  socket.on('state', (snapshot) => {
    S = snapshot;
    render();
  });

  socket.on('timer', ({ seconds }) => {
    const box = $('timer');
    if (seconds == null) {
      $('timer-value').textContent = '∞';
      box.classList.remove('is-low');
    } else {
      $('timer-value').textContent = formatSeconds(seconds);
      box.classList.toggle('is-low', seconds <= 10);
    }
  });

  socket.on('log', appendLog);

  socket.on('log-history', ({ entries }) => {
    clear($('log-feed'));
    lastLogSeq = 0;
    for (const entry of entries) appendLog(entry);
  });

  socket.on('chat', appendChat);

  socket.on('chat-history', ({ messages }) => {
    clear($('chat-feed'));
    for (const msg of messages) appendChat(msg);
  });

  socket.on('app-error', ({ message }) => {
    joining = false;
    toast(message);
  });

  socket.on('disconnect', () => {
    toast('Connection lost — reconnecting…');
  });

  // --- User input -------------------------------------------------------------------------------------------

  $('form-create').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $('create-name').value.trim();
    if (!name) return;
    joining = true;
    localStorage.setItem('mafiaName', name);
    socket.emit('create-room', { name, token });
  });

  $('form-join').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $('join-name').value.trim();
    const code = $('join-code').value.trim().toUpperCase();
    if (!name || code.length !== 4) return;
    joining = true;
    localStorage.setItem('mafiaName', name);
    socket.emit('join-room', { name, code, token });
  });

  $('btn-copy-code').addEventListener('click', () => {
    if (!S) return;
    navigator.clipboard.writeText(S.code)
      .then(() => toast('Room code copied!'))
      .catch(() => toast(`Room code: ${S.code}`));
  });

  $('btn-start').addEventListener('click', () => socket.emit('start-game'));

  $('btn-reset-suggested').addEventListener('click', () => sendSettings({ roleMode: 'auto' }));

  $('btn-again').addEventListener('click', () => socket.emit('play-again'));

  function leaveRoom() {
    socket.emit('leave-room');
    localStorage.removeItem('mafiaRoom');
    S = null;
    lastLogSeq = 0;
    clear($('log-feed'));
    clear($('chat-feed'));
    render();
  }

  $('btn-leave').addEventListener('click', leaveRoom);
  $('btn-home').addEventListener('click', leaveRoom);

  for (const select of document.querySelectorAll('select[data-setting]')) {
    select.addEventListener('change', () => {
      sendSettings({ [select.dataset.setting]: parseInt(select.value, 10) });
    });
  }
  for (const box of ['set-reveal', 'set-firstnight'].map($)) {
    box.addEventListener('change', () => {
      sendSettings({ [box.dataset.setting]: box.checked });
    });
  }

  $('form-chat').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('mafia-chat', { text });
    input.value = '';
  });

  $('btn-help').addEventListener('click', openHelp);
  $('btn-close-help').addEventListener('click', closeHelp);
  document.querySelector('[data-close-help]').addEventListener('click', closeHelp);

  // Prefill names from the last session
  const savedName = localStorage.getItem('mafiaName');
  if (savedName) {
    $('create-name').value = savedName;
    $('join-name').value = savedName;
  }

  render();
})();
