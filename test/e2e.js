'use strict';

/* End-to-end tests: boots the real server and plays full games over real
   sockets. Run with `npm test`.

   Covered:
   - full game loop (create → join → night → day → vote → win)
   - the two historical sync bugs: dead players must show as dead in every
     client's snapshot, and hidden roles must never reach other clients
   - bodyguard intercept, vigilante guilt, jester win, mayor reveal/weight
   - disconnect during night must not stall the game; reconnect resyncs */

const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');
const { roleById } = require('../shared/catalog');

const PORT = 3999;
const URL = `http://127.0.0.1:${PORT}`;

let failures = 0;

function ok(condition, label) {
  if (condition) {
    console.log(`  ✔ ${label}`);
  } else {
    failures++;
    console.error(`  ✘ FAIL: ${label}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Bot: one simulated player ------------------------------------------------

class Bot {
  constructor(name) {
    this.name = name;
    this.token = `t_${name}_${Math.random().toString(36).slice(2, 8)}`;
    this.snap = null;
    this.logs = [];
    this.errors = [];
    this.waiters = [];
    this.auto = null;
    this.leakFailures = [];
    this.game = null; // shared per-scenario context { rolesById, reveal }
    this.sock = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.sock = io(URL, { transports: ['websocket'], forceNew: true, reconnection: false });
      this.sock.on('connect', resolve);
      this.sock.on('connect_error', reject);
      this.sock.on('state', snap => this.onState(snap));
      this.sock.on('log', entry => this.logs.push(entry));
      this.sock.on('log-history', ({ entries }) => { this.logs = entries.slice(); });
      this.sock.on('app-error', ({ message }) => this.errors.push(message));
    });
  }

  onState(snap) {
    this.snap = snap;
    this.checkVisibility(snap);
    if (this.auto) this.auto(snap, this);
    this.waiters = this.waiters.filter(w => {
      if (w.pred(snap)) { w.resolve(snap); return false; }
      return true;
    });
  }

  // No hidden information may ever reach this client.
  checkVisibility(snap) {
    if (!this.game || !this.game.rolesById) return;
    const { rolesById, reveal } = this.game;
    for (const p of snap.players) {
      if (p.role == null) continue;
      if (p.role !== rolesById.get(p.id)) {
        this.leakFailures.push(`${this.name} saw wrong role ${p.role} for ${p.name}`);
        continue;
      }
      const allowed = snap.phase === 'game-over'
        || (!p.alive && reveal)
        || (p.alive && p.role === 'mayor'); // legit only via reveal; role match checked above
      if (!allowed) {
        this.leakFailures.push(`${this.name} saw hidden role of ${p.name} (${p.role}) in phase ${snap.phase}`);
      }
    }
    if (snap.you && snap.you.teammates) {
      const myRole = rolesById.get(this.token);
      if (!myRole || roleById(myRole).alignment !== 'mafia') {
        this.leakFailures.push(`${this.name} (${myRole}) received mafia teammate list`);
      }
    }
  }

  waitFor(pred, label, timeoutMs = 8000) {
    if (this.snap && pred(this.snap)) return Promise.resolve(this.snap);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout: ${this.name} waiting for ${label}`)),
        timeoutMs
      );
      this.waiters.push({ pred, resolve: (snap) => { clearTimeout(timer); resolve(snap); } });
    });
  }

  emit(event, payload) {
    this.sock.emit(event, payload);
  }

  close() {
    if (this.sock) this.sock.disconnect();
  }
}

// --- Scenario helpers -------------------------------------------------------------

async function setupRoom(names, roleCounts) {
  const bots = names.map(n => new Bot(n));
  for (const bot of bots) await bot.connect();

  const host = bots[0];
  host.emit('create-room', { name: host.name, token: host.token });
  await host.waitFor(s => s.phase === 'lobby', 'lobby after create');
  const code = host.snap.code;

  for (const bot of bots.slice(1)) {
    bot.emit('join-room', { name: bot.name, code, token: bot.token });
    await bot.waitFor(s => s.phase === 'lobby', `${bot.name} in lobby`);
  }
  await host.waitFor(s => s.players.length === bots.length, 'all players in lobby');

  host.emit('update-settings', {
    settings: Object.assign({}, host.snap.settings, {
      nightTimer: 0,
      discussionTimer: 0,
      votingTimer: 0,
      roleMode: 'manual',
      roleCounts
    })
  });
  await host.waitFor(s => s.settings.roleMode === 'manual', 'manual roles applied');
  return { bots, host, code };
}

async function startGame(bots, host) {
  host.emit('start-game');
  await Promise.all(bots.map(b => b.waitFor(s => s.phase === 'night', `${b.name} sees night 1`)));

  // Record true roles; from here on, every snapshot is leak-checked.
  const rolesById = new Map();
  for (const bot of bots) rolesById.set(bot.token, bot.snap.you.role);
  const game = { rolesById, reveal: host.snap.settings.revealRoleOnDeath };
  for (const bot of bots) bot.game = game;
  return game;
}

function byRole(bots, role) {
  return bots.filter(b => b.snap.you.role === role);
}

function finish(bots) {
  let leaks = 0;
  for (const bot of bots) {
    for (const msg of bot.leakFailures) {
      leaks++;
      console.error(`  ✘ LEAK: ${msg}`);
    }
    bot.close();
  }
  ok(leaks === 0, 'no role information leaked to any client');
}

// Wait out the morning announcement, cut discussion short, reach the vote.
async function advanceToVoting(bots, host) {
  await host.waitFor(s => s.phase === 'day-discussion', 'discussion phase');
  host.emit('end-discussion');
  const alive = bots.filter(b => b.sock.connected && b.snap.you.alive);
  await Promise.all(alive.map(b => b.waitFor(s => s.phase === 'day-voting', `${b.name} voting`)));
  return alive;
}

// Standard auto-pilot used by the chaos game. The harness knows all roles,
// so town "cheats" toward mafia to make games converge quickly.
function autoPilot(bot, plan) {
  return (snap) => {
    const you = snap.you;
    if (snap.phase === 'night' && you.alive && you.nightActionType && you.myNightAction == null) {
      bot.emit('night-action', { target: plan.night(snap, you) });
    }
    if (snap.phase === 'day-discussion' && you.isHost) {
      bot.emit('end-discussion');
    }
    if (snap.phase === 'day-voting' && you.alive && you.myVote == null) {
      bot.emit('day-vote', { target: plan.vote(snap, you) });
    }
  };
}

// --- Scenarios ---------------------------------------------------------------------

async function scenarioBasicGame() {
  console.log('\nScenario: 4-player game — kill, sync check, vote out mafia, town wins');
  const { bots, host } = await setupRoom(['Ana', 'Ben', 'Cle', 'Dev'], { mafia: 1, doctor: 1 });
  const game = await startGame(bots, host);

  const mafia = byRole(bots, 'mafia')[0];
  const doctor = byRole(bots, 'doctor')[0];
  const victim = bots.find(b => b !== mafia && b !== doctor);

  doctor.emit('night-action', { target: doctor.token }); // self-protect
  mafia.emit('night-action', { target: victim.token });

  // THE regression test: every client must see the victim as dead.
  await Promise.all(bots.map(b =>
    b.waitFor(
      s => s.phase !== 'night' && s.players.some(p => p.id === victim.token && !p.alive),
      `${b.name} sees ${victim.name} dead`
    )
  ));
  ok(true, 'all 4 clients see the night victim as dead (was the critical bug)');
  ok(victim.snap.you.alive === false, 'victim self-view is dead');
  ok(bots.every(b => b.logs.some(l => l.text.includes(victim.name) && l.kind === 'death')),
    'death announced in every client log');

  // Day: everyone votes the mafia out.
  const alive = await advanceToVoting(bots, host);
  for (const bot of alive) {
    if (bot !== mafia) bot.emit('day-vote', { target: mafia.token });
    else bot.emit('day-vote', { target: 'skip' });
  }

  await Promise.all(bots.map(b => b.waitFor(s => s.phase === 'game-over', `${b.name} game over`)));
  ok(host.snap.winner.faction === 'town', 'town wins after voting out the mafia');
  ok(host.snap.players.every(p => p.role === game.rolesById.get(p.id)), 'all roles revealed at game over');

  finish(bots);
}

async function scenarioBodyguardAndMayor() {
  console.log('\nScenario: bodyguard intercept + mayor reveal and double vote');
  const { bots, host } = await setupRoom(
    ['Kip', 'Lou', 'Mia', 'Nia', 'Oli', 'Pax'],
    { mafia: 1, bodyguard: 1, doctor: 1, mayor: 1 }
  );
  await startGame(bots, host);

  const mafia = byRole(bots, 'mafia')[0];
  const bodyguard = byRole(bots, 'bodyguard')[0];
  const doctor = byRole(bots, 'doctor')[0];
  const mayor = byRole(bots, 'mayor')[0];
  const target = bots.find(b => ![mafia, bodyguard, doctor, mayor].includes(b));
  const others = bots.filter(b => ![mafia, bodyguard, doctor, mayor, target].includes(b));

  bodyguard.emit('night-action', { target: target.token });
  doctor.emit('night-action', { target: doctor.token });
  mafia.emit('night-action', { target: target.token });

  await Promise.all(bots.map(b =>
    b.waitFor(s => s.phase.startsWith('day'), `${b.name} reaches day`)
  ));
  ok(host.snap.players.find(p => p.id === bodyguard.token).alive === false,
    'bodyguard died intercepting the attack');
  ok(host.snap.players.find(p => p.id === target.token).alive === true,
    'guarded target survived');

  // Mayor reveals; everyone must see it while the mayor is alive.
  mayor.emit('mayor-reveal');
  await Promise.all(bots.map(b =>
    b.waitFor(
      s => s.players.some(p => p.id === mayor.token && p.alive && p.role === 'mayor'),
      `${b.name} sees mayor reveal`
    )
  ));
  ok(true, 'mayor reveal visible to all players');

  // Double-vote check: without the mayor's ×2 it would be a 2–2 tie
  // (no execution); with it, the mafia falls 3–2.
  await advanceToVoting(bots, host);
  mayor.emit('day-vote', { target: mafia.token });
  doctor.emit('day-vote', { target: mafia.token });
  target.emit('day-vote', { target: doctor.token });
  others[0].emit('day-vote', { target: doctor.token });
  mafia.emit('day-vote', { target: 'skip' });

  await host.waitFor(s => s.phase === 'game-over', 'mafia executed → town wins');
  ok(host.snap.players.find(p => p.id === mafia.token).alive === false,
    'mayor double vote broke the tie — mafia executed 3–2');
  ok(host.logs.some(l => l.text.includes('(3 votes)')), 'weighted vote count logged');
  ok(host.snap.winner.faction === 'town', 'town wins once the mafia falls');

  finish(bots);
}

async function scenarioVigilanteGuilt() {
  console.log('\nScenario: vigilante shoots town → dies of guilt; mafia reaches parity');
  const { bots, host } = await setupRoom(
    ['Qui', 'Rex', 'Sol', 'Tam', 'Uma', 'Vic'],
    { mafia: 1, vigilante: 1 }
  );
  await startGame(bots, host);

  const mafia = byRole(bots, 'mafia')[0];
  const vigilante = byRole(bots, 'vigilante')[0];
  const villagers = bots.filter(b => b !== mafia && b !== vigilante);

  mafia.emit('night-action', { target: villagers[0].token });
  vigilante.emit('night-action', { target: villagers[1].token }); // shoots town → guilt

  await Promise.all(bots.map(b => b.waitFor(s => s.phase.startsWith('day'), `${b.name} day 1`)));
  ok(!host.snap.players.find(p => p.id === villagers[0].token).alive, 'mafia victim dead');
  ok(!host.snap.players.find(p => p.id === villagers[1].token).alive, 'vigilante victim dead');

  const alive = await advanceToVoting(bots, host);
  for (const bot of alive) bot.emit('day-vote', { target: 'skip' });

  await Promise.all(alive.map(b => b.waitFor(s => s.phase === 'night', `${b.name} night 2`)));
  ok(vigilante.snap.you.nightActionType === null, 'doomed vigilante has no night action');
  mafia.emit('night-action', { target: villagers[2].token });

  await host.waitFor(s => s.phase === 'game-over', 'game over', 10000);
  ok(!host.snap.players.find(p => p.id === vigilante.token).alive, 'vigilante died of guilt');
  ok(host.snap.winner.faction === 'mafia', 'mafia wins at parity');

  finish(bots);
}

async function scenarioJesterWin() {
  console.log('\nScenario: jester gets voted out and wins alone');
  const { bots, host } = await setupRoom(
    ['Wes', 'Xan', 'Yui', 'Zed', 'Abe'],
    { mafia: 1, jester: 1 }
  );
  await startGame(bots, host);

  const jester = byRole(bots, 'jester')[0];
  const mafia = byRole(bots, 'mafia')[0];
  mafia.emit('night-action', { target: 'skip' });

  await Promise.all(bots.map(b => b.waitFor(s => s.phase.startsWith('day'), `${b.name} day`)));
  await advanceToVoting(bots, host);

  for (const bot of bots) {
    bot.emit('day-vote', {
      target: bot === jester ? bots.find(b => b !== jester).token : jester.token
    });
  }

  await Promise.all(bots.map(b => b.waitFor(s => s.phase === 'game-over', `${b.name} end`)));
  ok(host.snap.winner.faction === 'jester', 'jester wins by execution');
  ok(host.snap.winner.name === jester.name, 'winner names the jester');

  finish(bots);
}

async function scenarioDisconnectAndReconnect() {
  console.log('\nScenario: disconnect during night does not stall; reconnect resyncs');
  const { bots, host, code } = await setupRoom(
    ['Fay', 'Gil', 'Hana', 'Ito', 'Jun'],
    { mafia: 1, doctor: 1 }
  );
  await startGame(bots, host);

  const mafia = byRole(bots, 'mafia')[0];
  const doctor = byRole(bots, 'doctor')[0];
  const victim = bots.find(b => b !== mafia && b !== doctor);
  mafia.emit('night-action', { target: victim.token });

  await sleep(500);
  ok(bots.filter(b => b !== doctor).every(b => b.snap.phase === 'night'),
    'night waits for the doctor (no timer)');

  // Doctor drops mid-night → the night must resolve without them.
  const doctorToken = doctor.token;
  doctor.close();
  const rest = bots.filter(b => b !== doctor);
  await Promise.all(rest.map(b =>
    b.waitFor(s => s.phase.startsWith('day'), `${b.name} day after dropout`, 5000)
  ));
  ok(true, 'night resolved after actor disconnected (stall fix)');
  ok(rest[0].snap.players.find(p => p.id === doctorToken).connected === false,
    'doctor shown as offline to others');

  // Reconnect with the same token — must land back in the same seat.
  const doctor2 = new Bot('Gil-again');
  doctor2.token = doctorToken;
  doctor2.game = rest[0].game;
  await doctor2.connect();
  doctor2.emit('rejoin-room', { code, token: doctorToken });
  await doctor2.waitFor(s => s.you && s.you.role === 'doctor', 'reconnected as doctor');
  ok(doctor2.snap.phase.startsWith('day'), 'reconnected client synced to current phase');
  ok(doctor2.logs.length > 0, 'log history resent on reconnect');
  ok(doctor2.snap.players.find(p => p.id === victim.token).alive === false,
    'reconnected client sees earlier death correctly');

  finish([...rest, doctor2]);
}

async function scenarioFullRosterChaos() {
  console.log('\nScenario: 12 players, every role enabled, play to completion');
  const names = ['P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10', 'P11', 'P12'];
  const { bots, host } = await setupRoom(names, {
    godfather: 1, mafia: 1, consigliere: 1, serialkiller: 1,
    doctor: 1, detective: 1, bodyguard: 1, vigilante: 1,
    mayor: 1, jester: 1, survivor: 1
  });
  await startGame(bots, host);
  const game = bots[0].game;

  const isEvil = id => {
    const role = game.rolesById.get(id);
    return roleById(role).alignment === 'mafia';
  };
  const isThreat = id => isEvil(id) || game.rolesById.get(id) === 'serialkiller';

  for (const bot of bots) {
    bot.auto = autoPilot(bot, {
      night(snap, you) {
        const alive = snap.players.filter(p => p.alive && p.id !== you.id);
        switch (you.nightActionType) {
          case 'protect': return you.id;
          case 'guard': return alive[0].id;
          case 'investigate':
          case 'role-investigate': return alive[alive.length - 1].id;
          case 'mafia-kill': {
            const team = new Set((you.teammates || []).map(t => t.id));
            const target = alive.find(p => !team.has(p.id));
            return target ? target.id : 'skip';
          }
          case 'kill': return alive[0].id;
          case 'shoot': return 'skip';
          default: return 'skip';
        }
      },
      vote(snap, you) {
        const threat = snap.players.find(p => p.alive && p.id !== you.id && isThreat(p.id));
        return threat ? threat.id : 'skip';
      }
    });
    // Kick auto-pilot with the current snapshot.
    bot.onState(bot.snap);
  }

  const end = await host.waitFor(s => s.phase === 'game-over', 'chaos game completes', 60000);
  ok(['town', 'mafia', 'serialkiller', 'jester', 'draw'].includes(end.winner.faction),
    `game completed with winner: ${end.winner.faction}`);
  ok(end.players.every(p => p.role === game.rolesById.get(p.id)),
    'endgame reveals all true roles');

  const sawTeam = byRole(bots, 'godfather')[0];
  ok((sawTeam.snap.you.teammates || []).length === 2, 'godfather saw both teammates');

  finish(bots);
}

// --- Runner ---------------------------------------------------------------------------

async function main() {
  console.log('Starting server for tests…');
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), ANNOUNCE_SECONDS: '1' }),
    stdio: ['ignore', 'pipe', 'inherit']
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', chunk => {
      if (String(chunk).includes('running')) resolve();
    });
    server.on('exit', code => reject(new Error(`server exited early (${code})`)));
    setTimeout(() => reject(new Error('server did not start')), 8000);
  });

  try {
    await scenarioBasicGame();
    await scenarioBodyguardAndMayor();
    await scenarioVigilanteGuilt();
    await scenarioJesterWin();
    await scenarioDisconnectAndReconnect();
    await scenarioFullRosterChaos();
  } catch (err) {
    failures++;
    console.error(`\n✘ Scenario crashed: ${err.message}`);
  } finally {
    server.kill();
  }

  console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
