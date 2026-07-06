'use strict';

// Game engine: room state, phase machine, night resolution, win conditions.
// The one rule that keeps clients honest: after every state change, sync()
// pushes each player a fresh snapshot tailored to what THEY are allowed to
// see. Clients render only from snapshots — there is no client-side game
// state to drift out of date.

const { roleById } = require('../shared/catalog');
const {
  SPECIAL_ROLES, suggestSetup, validateSetup, totalSpecials, emptyCounts
} = require('./suggestions');

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 16;
const MAX_NAME_LENGTH = 20;
const MAX_CHAT_LENGTH = 240;
const ANNOUNCE_SECONDS = Math.max(1, parseInt(process.env.ANNOUNCE_SECONDS, 10) || 8);

// --- Construction -----------------------------------------------------------

function createRoom(io, code) {
  return {
    io,
    code,
    phase: 'lobby', // lobby | night | day-announcement | day-discussion | day-voting | game-over
    dayNumber: 1,
    players: new Map(), // token -> player
    settings: {
      nightTimer: 45,
      discussionTimer: 120,
      votingTimer: 45,
      revealRoleOnDeath: true,
      firstNightKill: true,
      roleMode: 'auto', // auto = use suggestion for current player count
      roleCounts: {}
    },
    seq: 0,
    logs: [],
    chat: [],
    nightActions: new Map(), // token -> targetToken | 'skip'
    dayVotes: new Map(), // token -> targetToken | 'skip'
    pendingGuilt: null, // vigilante token doomed to die next night
    activeRoleCounts: null,
    winner: null,
    timerHandle: null,
    timerSeconds: null,
    reapTimer: null
  };
}

function createPlayer(token, name, isHost) {
  return {
    token,
    name,
    socketId: null,
    connected: true,
    isHost,
    role: null,
    alive: true,
    deathCause: null,
    shotsLeft: 0,
    mayorRevealed: false,
    usedIntercept: false,
    privateLogs: [],
    disconnectTimer: null
  };
}

// --- Small helpers ----------------------------------------------------------

function alignmentOf(player) {
  const role = player.role && roleById(player.role);
  return role ? role.alignment : null;
}

function alivePlayers(room) {
  return [...room.players.values()].filter(p => p.alive);
}

function mafiaKillersAlive(room) {
  return alivePlayers(room).some(p => p.role === 'mafia' || p.role === 'godfather');
}

function emitAll(room, event, payload) {
  room.io.to(room.code).emit(event, payload);
}

function emitTo(room, player, event, payload) {
  if (player.socketId) room.io.to(player.socketId).emit(event, payload);
}

function log(room, text, kind = 'system') {
  const entry = { seq: ++room.seq, text, kind };
  room.logs.push(entry);
  emitAll(room, 'log', entry);
}

function privateLog(room, player, text, kind = 'private') {
  const entry = { seq: ++room.seq, text, kind, private: true };
  player.privateLogs.push(entry);
  emitTo(room, player, 'log', entry);
}

function roleReveal(room, player) {
  if (!room.settings.revealRoleOnDeath) return '';
  return ` They were the ${roleById(player.role).name}.`;
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function mapToObject(map) {
  const obj = {};
  for (const [key, value] of map) obj[key] = value;
  return obj;
}

// --- Timers -----------------------------------------------------------------

function stopTimer(room) {
  if (room.timerHandle) {
    clearInterval(room.timerHandle);
    room.timerHandle = null;
  }
  room.timerSeconds = null;
}

function startTimer(room, seconds, onDone) {
  stopTimer(room);
  if (!seconds || seconds <= 0) {
    emitAll(room, 'timer', { seconds: null });
    return;
  }
  room.timerSeconds = seconds;
  emitAll(room, 'timer', { seconds });
  room.timerHandle = setInterval(() => {
    room.timerSeconds--;
    emitAll(room, 'timer', { seconds: room.timerSeconds });
    if (room.timerSeconds <= 0) {
      stopTimer(room);
      onDone();
    }
  }, 1000);
}

// --- Snapshots: the single source of truth for clients -----------------------

function publicRoleOf(room, player) {
  if (!player.role) return null;
  if (room.phase === 'game-over') return player.role;
  if (player.mayorRevealed) return 'mayor';
  if (!player.alive && room.settings.revealRoleOnDeath) return player.role;
  return null;
}

// What night action (if any) this player may take right now. Also used by
// the client (via snapshot) so prompts can never disagree with the server.
function nightActionTypeFor(room, player) {
  if (room.phase !== 'night' || !player.alive || !player.role) return null;
  if (room.pendingGuilt === player.token) return null; // doomed vigilante
  switch (player.role) {
    case 'doctor': return 'protect';
    case 'bodyguard': return 'guard';
    case 'detective': return 'investigate';
    case 'serialkiller': return 'kill';
    case 'vigilante': return player.shotsLeft > 0 ? 'shoot' : null;
    case 'mafia':
    case 'godfather': return 'mafia-kill';
    // If every Mafia killer is dead, the Consigliere picks up the gun.
    case 'consigliere': return mafiaKillersAlive(room) ? 'role-investigate' : 'mafia-kill';
    default: return null;
  }
}

function currentCounts(room) {
  if (room.settings.roleMode === 'manual') {
    const counts = emptyCounts();
    for (const id of SPECIAL_ROLES) {
      const value = room.settings.roleCounts[id];
      counts[id] = Number.isInteger(value) && value >= 0 ? Math.min(value, roleById(id).max) : 0;
    }
    return counts;
  }
  return suggestSetup(room.players.size).counts;
}

function snapshotFor(room, viewer) {
  const players = [...room.players.values()].map(p => ({
    id: p.token,
    name: p.name,
    isHost: p.isHost,
    alive: p.alive,
    connected: p.connected,
    role: publicRoleOf(room, p)
  }));

  const snap = {
    code: room.code,
    phase: room.phase,
    dayNumber: room.dayNumber,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    settings: room.settings,
    players
  };

  if (room.phase === 'lobby') {
    const n = room.players.size;
    const counts = currentCounts(room);
    snap.lobby = {
      counts,
      villagers: Math.max(0, n - totalSpecials(counts)),
      auto: room.settings.roleMode === 'auto',
      reasons: suggestSetup(n).reasons,
      validation: validateSetup(counts, n)
    };
  }

  if (room.activeRoleCounts) snap.activeRoleCounts = room.activeRoleCounts;
  if (room.phase === 'day-voting') snap.votes = mapToObject(room.dayVotes);
  if (room.winner) snap.winner = room.winner;

  if (viewer) {
    const you = {
      id: viewer.token,
      name: viewer.name,
      isHost: viewer.isHost,
      role: viewer.role,
      alive: viewer.alive,
      shotsLeft: viewer.shotsLeft,
      mayorRevealed: viewer.mayorRevealed,
      nightActionType: nightActionTypeFor(room, viewer),
      myNightAction: room.nightActions.get(viewer.token) ?? null,
      myVote: room.dayVotes.get(viewer.token) ?? null
    };
    if (viewer.role && alignmentOf(viewer) === 'mafia') {
      you.teammates = [...room.players.values()]
        .filter(p => p !== viewer && alignmentOf(p) === 'mafia')
        .map(p => ({ id: p.token, name: p.name, role: p.role }));
      if (room.phase === 'night') {
        const tallies = {};
        for (const [token, target] of room.nightActions) {
          const actor = room.players.get(token);
          if (!actor || !actor.alive || !target || target === 'skip') continue;
          if (nightActionTypeFor(room, actor) === 'mafia-kill') {
            tallies[target] = (tallies[target] || 0) + 1;
          }
        }
        you.mafiaKillVotes = tallies;
      }
    }
    snap.you = you;
  }

  return snap;
}

function sync(room) {
  for (const player of room.players.values()) {
    if (player.socketId) {
      emitTo(room, player, 'state', snapshotFor(room, player));
    }
  }
}

// --- Lobby management --------------------------------------------------------

function sanitizeName(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

function addPlayer(room, token, rawName, isHost) {
  const base = sanitizeName(rawName);
  if (!base) return { error: 'Pick a name first.' };

  let name = base;
  let suffix = 1;
  const taken = [...room.players.values()].map(p => p.name.toLowerCase());
  while (taken.includes(name.toLowerCase())) {
    suffix++;
    name = `${base} (${suffix})`;
  }

  const player = createPlayer(token, name, isHost);
  room.players.set(token, player);
  return { player };
}

function afterJoin(room, player) {
  emitTo(room, player, 'log-history', { entries: room.logs });
  log(room, `${player.name} ${player.isHost ? 'created the room' : 'joined the lobby'}.`, 'system');
  emitTo(room, player, 'timer', { seconds: room.timerSeconds });
  sync(room);
}

function ensureHost(room) {
  if ([...room.players.values()].some(p => p.isHost && p.connected)) return;
  const next = [...room.players.values()].find(p => p.connected);
  if (!next) return;
  for (const p of room.players.values()) p.isHost = false;
  next.isHost = true;
  log(room, `👑 ${next.name} is now the host.`, 'system');
}

function updateSettings(room, player, incoming) {
  if (!player.isHost || room.phase !== 'lobby' || !incoming || typeof incoming !== 'object') return;
  const s = room.settings;

  for (const key of ['nightTimer', 'discussionTimer', 'votingTimer']) {
    const value = parseInt(incoming[key], 10);
    if (Number.isInteger(value) && value >= 0 && value <= 600) s[key] = value;
  }
  if (typeof incoming.revealRoleOnDeath === 'boolean') s.revealRoleOnDeath = incoming.revealRoleOnDeath;
  if (typeof incoming.firstNightKill === 'boolean') s.firstNightKill = incoming.firstNightKill;
  if (incoming.roleMode === 'auto' || incoming.roleMode === 'manual') s.roleMode = incoming.roleMode;
  if (incoming.roleCounts && typeof incoming.roleCounts === 'object') {
    const counts = {};
    for (const id of SPECIAL_ROLES) {
      const value = parseInt(incoming.roleCounts[id], 10);
      counts[id] = Number.isInteger(value) && value >= 0 ? Math.min(value, roleById(id).max) : 0;
    }
    s.roleCounts = counts;
  }
  sync(room);
}

// --- Game start ---------------------------------------------------------------

function startGame(room, player) {
  if (!player.isHost) return 'Only the host can start the game.';
  if (room.phase !== 'lobby') return 'The game is already running.';

  const n = room.players.size;
  if (n < MIN_PLAYERS) return `You need at least ${MIN_PLAYERS} players.`;

  const counts = currentCounts(room);
  const { errors } = validateSetup(counts, n);
  if (errors.length > 0) return errors[0];

  const deck = [];
  for (const id of SPECIAL_ROLES) {
    for (let i = 0; i < (counts[id] || 0); i++) deck.push(id);
  }
  while (deck.length < n) deck.push('villager');
  shuffle(deck);

  const active = {};
  let i = 0;
  for (const p of room.players.values()) {
    p.role = deck[i++];
    p.alive = true;
    p.deathCause = null;
    p.shotsLeft = p.role === 'vigilante' ? 1 : 0;
    p.mayorRevealed = false;
    p.usedIntercept = false;
    p.privateLogs = [];
    active[p.role] = (active[p.role] || 0) + 1;
  }

  room.activeRoleCounts = active;
  room.dayNumber = 1;
  room.winner = null;
  room.pendingGuilt = null;
  room.logs = [];
  room.chat = [];
  emitAll(room, 'log-history', { entries: [] });
  emitAll(room, 'chat-history', { messages: [] });

  log(room, '🎬 The game begins. Your role is at the top of your screen — tap Help anytime to see what it does.', 'phase');

  for (const p of room.players.values()) {
    const role = roleById(p.role);
    privateLog(room, p, `${role.icon} You are the ${role.name}. ${role.summary}`);
    if (alignmentOf(p) === 'mafia') {
      const team = [...room.players.values()]
        .filter(m => m !== p && alignmentOf(m) === 'mafia')
        .map(m => `${m.name} (${roleById(m.role).name})`);
      privateLog(room, p, team.length > 0
        ? `🤝 Your team: ${team.join(', ')}.`
        : '🤝 You work alone tonight — no other Mafia members.');
    }
  }

  startNight(room);
  return null;
}

// --- Night -------------------------------------------------------------------

function startNight(room) {
  room.phase = 'night';
  room.nightActions.clear();
  for (const p of room.players.values()) p.usedIntercept = false;

  log(room, `--- Night ${room.dayNumber} ---`, 'phase');
  log(room, '🌑 Night falls. Roles with night actions, choose your targets.', 'system');
  sync(room);
  startTimer(room, room.settings.nightTimer, () => resolveNight(room));

  // Nobody left with a night action (or everyone doomed/dry) — don't stall.
  if (nightComplete(room)) resolveNight(room);
}

function nightComplete(room) {
  for (const p of room.players.values()) {
    if (!p.alive || !p.connected) continue;
    if (!nightActionTypeFor(room, p)) continue;
    if (!room.nightActions.has(p.token)) return false;
  }
  return true;
}

function handleNightAction(room, player, target) {
  if (room.phase !== 'night' || !player.alive) return;
  const type = nightActionTypeFor(room, player);
  if (!type) return;

  if (target !== 'skip') {
    const t = room.players.get(target);
    if (!t || !t.alive) return;
    if (t === player && type !== 'protect') return;
    if (type === 'mafia-kill' && alignmentOf(t) === 'mafia') return;
  }

  room.nightActions.set(player.token, target);
  sync(room);
  if (nightComplete(room)) resolveNight(room);
}

function resolveNight(room) {
  if (room.phase !== 'night') return;
  stopTimer(room);

  const truce = room.dayNumber === 1 && !room.settings.firstNightKill;
  const events = [];

  // 1. Guilt: a Vigilante who shot a Town member dies now. Unpreventable.
  if (room.pendingGuilt) {
    const doomed = room.players.get(room.pendingGuilt);
    room.pendingGuilt = null;
    if (doomed && doomed.alive) {
      doomed.alive = false;
      doomed.deathCause = 'guilt';
      events.push({
        text: `💀 ${doomed.name} was found dead — they couldn't live with what they'd done.${roleReveal(room, doomed)}`,
        kind: 'death'
      });
    }
  }

  // 2. Collect actions.
  const heals = new Set();
  const guards = new Map(); // target token -> bodyguard
  const mafiaVotes = [];
  const skAttacks = [];
  const vigAttacks = [];
  const investigations = [];

  for (const [token, target] of room.nightActions) {
    const actor = room.players.get(token);
    if (!actor || target === 'skip' || target == null) continue;
    switch (nightActionTypeFor(room, actor)) {
      case 'protect': heals.add(target); break;
      case 'guard': if (!guards.has(target)) guards.set(target, actor); break;
      case 'mafia-kill': mafiaVotes.push(target); break;
      case 'kill': skAttacks.push({ attacker: actor, target, source: 'serialkiller' }); break;
      case 'shoot': vigAttacks.push({ attacker: actor, target, source: 'vigilante' }); break;
      case 'investigate': investigations.push({ actor, target, exact: false }); break;
      case 'role-investigate': investigations.push({ actor, target, exact: true }); break;
    }
  }

  // 3. Mafia kill: plurality of the team's votes, ties broken randomly.
  const attacks = [];
  if (mafiaVotes.length > 0) {
    const tally = new Map();
    for (const target of mafiaVotes) tally.set(target, (tally.get(target) || 0) + 1);
    let best = 0;
    let leaders = [];
    for (const [target, count] of tally) {
      if (count > best) { best = count; leaders = [target]; }
      else if (count === best) leaders.push(target);
    }
    const chosen = leaders[Math.floor(Math.random() * leaders.length)];
    attacks.push({ attacker: null, target: chosen, source: 'mafia' });
  }
  attacks.push(...skAttacks, ...vigAttacks);

  // 4. Resolve attacks in order: Mafia, then Serial Killer, then Vigilante.
  //    For each: Bodyguard intercept first, then Doctor save, then death.
  if (truce) {
    events.push({ text: '🕊️ First-night truce — no one can die tonight.', kind: 'save' });
  } else {
    for (const attack of attacks) {
      if (attack.attacker && !attack.attacker.alive) continue; // dead men fire no shots
      const target = room.players.get(attack.target);
      if (!target || !target.alive) continue; // already died tonight

      if (attack.source === 'vigilante') {
        if (attack.attacker.shotsLeft <= 0) continue;
        attack.attacker.shotsLeft--;
      }

      const guard = guards.get(target.token);
      if (guard && guard.alive && !guard.usedIntercept) {
        guard.usedIntercept = true;
        if (heals.has(guard.token)) {
          events.push({
            text: `🛡️ ${guard.name} fought off an attacker while guarding someone — the Doctor patched them up.`,
            kind: 'save'
          });
        } else {
          guard.alive = false;
          guard.deathCause = 'guard';
          events.push({
            text: `🛡️ ${guard.name} died defending another player.${roleReveal(room, guard)}`,
            kind: 'death'
          });
        }
        continue;
      }

      if (heals.has(target.token)) {
        events.push({ text: '💉 Someone was attacked tonight, but the Doctor saved them.', kind: 'save' });
        continue;
      }

      target.alive = false;
      target.deathCause = 'night';
      events.push({ text: `💀 ${target.name} was killed in the night.${roleReveal(room, target)}`, kind: 'death' });

      if (attack.source === 'vigilante' && alignmentOf(target) === 'town') {
        room.pendingGuilt = attack.attacker.token;
        privateLog(room, attack.attacker, '🔫 You shot a member of the Town. The guilt will kill you tomorrow night — nothing can stop it.', 'warning');
      }
    }

    if (!events.some(e => e.kind === 'death' || e.kind === 'save')) {
      events.push({ text: '🕊️ The night passed quietly. No one died.', kind: 'system' });
    }
  }

  // 5. Investigations (investigators who died tonight get nothing).
  for (const inv of investigations) {
    if (!inv.actor.alive) continue;
    const target = room.players.get(inv.target);
    if (!target) continue;
    if (inv.exact) {
      privateLog(room, inv.actor, `📜 You studied ${target.name}: they are the ${roleById(target.role).name}.`);
    } else {
      const suspicious = (alignmentOf(target) === 'mafia' && target.role !== 'godfather')
        || target.role === 'serialkiller';
      privateLog(room, inv.actor, `🔎 Investigation: ${target.name} is ${suspicious ? 'SUSPICIOUS' : 'INNOCENT'}.`);
    }
  }

  room.nightActions.clear();

  log(room, `--- Day ${room.dayNumber} ---`, 'phase');
  for (const event of events) log(room, event.text, event.kind);

  const win = checkWin(room);
  if (win) return endGame(room, win);

  room.phase = 'day-announcement';
  sync(room);
  startTimer(room, ANNOUNCE_SECONDS, () => startDiscussion(room));
}

// --- Day ----------------------------------------------------------------------

function startDiscussion(room) {
  if (room.phase !== 'day-announcement') return;
  room.phase = 'day-discussion';
  log(room, '💬 Discussion is open. Who seems off? The host can end it early.', 'system');
  sync(room);
  startTimer(room, room.settings.discussionTimer, () => startVoting(room));
}

function handleEndDiscussion(room, player) {
  if (!player.isHost || room.phase !== 'day-discussion') return;
  startVoting(room);
}

function startVoting(room) {
  if (room.phase !== 'day-discussion') return;
  stopTimer(room);
  room.phase = 'day-voting';
  room.dayVotes.clear();
  log(room, '⚖️ Voting is open. Pick a player, or skip.', 'system');
  sync(room);
  startTimer(room, room.settings.votingTimer, () => resolveVoting(room));
}

function votingComplete(room) {
  for (const p of room.players.values()) {
    if (!p.alive || !p.connected) continue;
    if (!room.dayVotes.has(p.token)) return false;
  }
  return true;
}

function handleDayVote(room, player, target) {
  if (room.phase !== 'day-voting' || !player.alive) return;
  if (target !== 'skip') {
    const t = room.players.get(target);
    if (!t || !t.alive || t === player) return;
  }
  room.dayVotes.set(player.token, target);
  sync(room);
  if (votingComplete(room)) resolveVoting(room);
}

function handleMayorReveal(room, player) {
  if (!player.alive || player.role !== 'mayor' || player.mayorRevealed) return;
  if (!room.phase.startsWith('day')) return;
  player.mayorRevealed = true;
  log(room, `🏛️ ${player.name} has revealed themselves as the Mayor! Their vote now counts twice.`, 'system');
  sync(room);
}

function resolveVoting(room) {
  if (room.phase !== 'day-voting') return;
  stopTimer(room);

  let skipWeight = 0;
  const weightByTarget = new Map();
  for (const [token, target] of room.dayVotes) {
    const voter = room.players.get(token);
    if (!voter || !voter.alive) continue;
    const weight = voter.mayorRevealed ? 2 : 1;
    if (target === 'skip') skipWeight += weight;
    else weightByTarget.set(target, (weightByTarget.get(target) || 0) + weight);
  }

  let best = 0;
  let leaders = [];
  for (const [target, weight] of weightByTarget) {
    if (weight > best) { best = weight; leaders = [target]; }
    else if (weight === best) leaders.push(target);
  }

  let executed = null;
  if (best === 0) {
    log(room, '🕊️ No votes were cast. No one is executed.', 'vote');
  } else if (skipWeight >= best) {
    log(room, `🕊️ The town voted to skip (${skipWeight} vote${skipWeight === 1 ? '' : 's'}). No one is executed.`, 'vote');
  } else if (leaders.length > 1) {
    log(room, '⚖️ The vote tied. No one is executed.', 'vote');
  } else {
    executed = room.players.get(leaders[0]);
    if (executed) {
      executed.alive = false;
      executed.deathCause = 'executed';
      log(room, `⚖️ ${executed.name} was executed by the town (${best} vote${best === 1 ? '' : 's'}).${roleReveal(room, executed)}`, 'death');
    }
  }
  room.dayVotes.clear();

  if (executed && executed.role === 'jester') {
    log(room, `🃏 ${executed.name} grins from the gallows — being executed was the Jester's plan all along!`, 'death');
    return endGame(room, { faction: 'jester', name: executed.name });
  }

  const win = checkWin(room);
  if (win) return endGame(room, win);

  room.dayNumber++;
  startNight(room);
}

// --- Endgame ------------------------------------------------------------------

function checkWin(room) {
  const alive = alivePlayers(room);
  const mafia = alive.filter(p => alignmentOf(p) === 'mafia').length;
  const serialKillers = alive.filter(p => p.role === 'serialkiller');

  if (alive.length === 0) return { faction: 'draw' };
  if (serialKillers.length > 0 && alive.length <= 2) {
    return { faction: 'serialkiller', name: serialKillers[0].name };
  }
  if (mafia === 0 && serialKillers.length === 0) return { faction: 'town' };
  if (serialKillers.length === 0 && mafia >= alive.length - mafia) return { faction: 'mafia' };
  return null;
}

function endGame(room, win) {
  stopTimer(room);
  room.phase = 'game-over';
  room.pendingGuilt = null;
  room.nightActions.clear();
  room.dayVotes.clear();

  const messages = {
    town: '☀️ Town victory! Every threat has been eliminated.',
    mafia: '🔪 Mafia victory! The town belongs to the syndicate now.',
    serialkiller: `🗡️ ${win.name} — the Serial Killer — is the last one standing.`,
    jester: `🃏 ${win.name} wins alone: the town executed the Jester.`,
    draw: '💀 Everyone is dead. Nobody wins.'
  };
  const coWinners = [...room.players.values()]
    .filter(p => p.alive && p.role === 'survivor')
    .map(p => p.name);

  room.winner = {
    faction: win.faction,
    name: win.name || null,
    message: messages[win.faction],
    coWinners
  };

  log(room, room.winner.message, 'phase');
  for (const name of coWinners) {
    log(room, `🌱 ${name} lived to the end — the Survivor wins too.`, 'system');
  }
  sync(room);
}

// --- Chat ----------------------------------------------------------------------

function handleChat(room, player, rawText) {
  if (room.phase !== 'night' || !player.alive || alignmentOf(player) !== 'mafia') return;
  const text = String(rawText || '').trim().slice(0, MAX_CHAT_LENGTH);
  if (!text) return;
  const msg = { senderId: player.token, senderName: player.name, text };
  room.chat.push(msg);
  for (const p of room.players.values()) {
    if (alignmentOf(p) === 'mafia') emitTo(room, p, 'chat', msg);
  }
}

// --- Reconnection & departure ---------------------------------------------------

function rejoin(room, player) {
  const entries = [...room.logs, ...player.privateLogs].sort((a, b) => a.seq - b.seq);
  emitTo(room, player, 'log-history', { entries });
  if (player.role && alignmentOf(player) === 'mafia') {
    emitTo(room, player, 'chat-history', { messages: room.chat });
  }
  emitTo(room, player, 'timer', { seconds: room.timerSeconds });
  log(room, `⚡ ${player.name} reconnected.`, 'system');
  sync(room);
}

function markDisconnected(room, player) {
  player.connected = false;
  player.socketId = null;

  if (room.phase === 'lobby') {
    room.players.delete(player.token);
    ensureHost(room);
    if (room.players.size > 0) {
      log(room, `${player.name} left the lobby.`, 'system');
      sync(room);
    }
    return;
  }

  log(room, `⌁ ${player.name} disconnected.`, 'system');
  sync(room);

  // A dropout must never stall the game.
  if (room.phase === 'night' && nightComplete(room)) return resolveNight(room);
  if (room.phase === 'day-voting' && votingComplete(room)) return resolveVoting(room);
}

// Grace period expired: the player is treated as having left for good.
function eliminateAbandoned(room, player) {
  player.disconnectTimer = null;
  if (!room.players.has(player.token) || player.connected) return;
  if (room.phase === 'lobby' || room.phase === 'game-over') return;

  if (!player.alive) {
    if (player.isHost) { ensureHost(room); sync(room); }
    return;
  }

  player.alive = false;
  player.deathCause = 'abandoned';
  log(room, `💨 ${player.name} abandoned the game and was eliminated.${roleReveal(room, player)}`, 'death');
  if (player.isHost) ensureHost(room);

  const win = checkWin(room);
  if (win) return endGame(room, win);

  sync(room);
  if (room.phase === 'night' && nightComplete(room)) return resolveNight(room);
  if (room.phase === 'day-voting' && votingComplete(room)) return resolveVoting(room);
}

function handlePlayAgain(room, player) {
  if (!player.isHost || room.phase !== 'game-over') return;

  for (const p of [...room.players.values()]) {
    if (!p.connected) room.players.delete(p.token);
  }
  for (const p of room.players.values()) {
    p.role = null;
    p.alive = true;
    p.deathCause = null;
    p.shotsLeft = 0;
    p.mayorRevealed = false;
    p.usedIntercept = false;
    p.privateLogs = [];
  }

  room.phase = 'lobby';
  room.dayNumber = 1;
  room.winner = null;
  room.activeRoleCounts = null;
  room.pendingGuilt = null;
  room.logs = [];
  room.chat = [];
  room.nightActions.clear();
  room.dayVotes.clear();
  ensureHost(room);

  emitAll(room, 'log-history', { entries: [] });
  emitAll(room, 'chat-history', { messages: [] });
  log(room, `🔄 ${player.name} reset the lobby. Same crew, new game.`, 'system');
  sync(room);
}

function destroyRoom(room) {
  stopTimer(room);
  if (room.reapTimer) {
    clearTimeout(room.reapTimer);
    room.reapTimer = null;
  }
  for (const p of room.players.values()) {
    if (p.disconnectTimer) {
      clearTimeout(p.disconnectTimer);
      p.disconnectTimer = null;
    }
  }
}

module.exports = {
  MIN_PLAYERS,
  MAX_PLAYERS,
  createRoom,
  addPlayer,
  afterJoin,
  rejoin,
  updateSettings,
  startGame,
  handleNightAction,
  handleDayVote,
  handleMayorReveal,
  handleEndDiscussion,
  handleChat,
  handlePlayAgain,
  markDisconnected,
  eliminateAbandoned,
  destroyRoom,
  sync
};
