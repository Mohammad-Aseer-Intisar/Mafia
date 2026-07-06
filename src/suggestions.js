'use strict';

const { roleById } = require('../shared/catalog');

// Roles the suggestion engine may hand out, in the order they unlock as the
// lobby grows. Villagers always fill the remaining seats.
const SPECIAL_ROLES = [
  'mafia', 'godfather', 'consigliere', 'serialkiller',
  'doctor', 'detective', 'bodyguard', 'vigilante',
  'mayor', 'jester', 'survivor'
];

function emptyCounts() {
  const counts = {};
  for (const id of SPECIAL_ROLES) counts[id] = 0;
  return counts;
}

function totalSpecials(counts) {
  let total = 0;
  for (const id of SPECIAL_ROLES) total += counts[id] || 0;
  return total;
}

// Suggest a full role distribution for `n` players, with human-readable
// reasoning. The core balance idea: roughly 1 evil seat per 3.5 players,
// special roles unlock gradually with lobby size, and enough plain
// Villagers must remain for the evil roles to hide among.
function suggestSetup(n) {
  const counts = emptyCounts();
  const reasons = [];

  if (n < 3) {
    counts.mafia = 1;
    reasons.push('Mafia needs at least 3 players — invite more friends to get a real game going.');
    return { counts, reasons };
  }

  let evilSeats = Math.max(1, Math.round(n / 3.5));
  const withSerialKiller = n >= 10;
  if (withSerialKiller) {
    counts.serialkiller = 1;
    evilSeats = Math.max(1, evilSeats - 1);
  }

  const withGodfather = n >= 8 && evilSeats >= 2;
  const withConsigliere = evilSeats >= 3;
  counts.godfather = withGodfather ? 1 : 0;
  counts.consigliere = withConsigliere ? 1 : 0;
  counts.mafia = evilSeats - counts.godfather - counts.consigliere;

  counts.doctor = n >= 4 ? 1 : 0;
  counts.detective = n >= 6 ? 1 : 0;
  counts.jester = n >= 8 ? 1 : 0;
  counts.mayor = n >= 9 ? 1 : 0;
  counts.bodyguard = n >= 10 ? 1 : 0;
  counts.vigilante = n >= 11 ? 1 : 0;
  counts.survivor = n >= 12 ? 1 : 0;

  // Keep a floor of plain Villagers: a table where everyone has a gimmick
  // is impossible to read. Trim the least essential extras first.
  const villagerFloor = Math.max(1, Math.floor(n * 0.2));
  const trimOrder = ['survivor', 'vigilante', 'jester', 'bodyguard', 'mayor', 'detective'];
  let villagers = n - totalSpecials(counts);
  for (const id of trimOrder) {
    if (villagers >= villagerFloor) break;
    if (counts[id] > 0) {
      counts[id]--;
      villagers++;
    }
  }

  const evilTotal = counts.mafia + counts.godfather + counts.consigliere;
  const threatTotal = evilTotal + counts.serialkiller;
  reasons.push(
    `${threatTotal} of ${n} players ${threatTotal === 1 ? 'works' : 'work'} against the town — roughly the 1-in-3 ratio that gives both sides a real shot.`
  );
  if (withSerialKiller) {
    reasons.push('A Serial Killer stalks both sides, so one Mafia seat was traded away to keep the body count fair.');
  }
  if (withGodfather) {
    reasons.push('The Godfather reads as Innocent, so the town can’t lean on investigations alone.');
  }
  if (withConsigliere) {
    reasons.push('A Consigliere gives the larger Mafia team its own investigator without adding another gun.');
  }
  if (counts.doctor > 0) {
    reasons.push('One Doctor gives the town a fighting chance against night kills.');
  }
  if (counts.detective > 0) {
    reasons.push('One Detective — enough information to work with, not enough to solve the game.');
  }
  if (counts.bodyguard > 0) {
    reasons.push('A Bodyguard adds a second, louder layer of protection for bigger nights.');
  }
  if (counts.vigilante > 0) {
    reasons.push('At this size a Vigilante can take a risky shot without single-handedly ending the game.');
  }
  if (counts.mayor > 0) {
    reasons.push('A Mayor gives the town a rallying point when votes get messy.');
  }
  if (counts.jester > 0) {
    reasons.push('A Jester punishes lazy mob voting.');
  }
  if (counts.survivor > 0) {
    reasons.push('A Survivor muddies the water without hurting anyone.');
  }
  reasons.push(
    `${villagers} plain Villager${villagers === 1 ? '' : 's'} keep${villagers === 1 ? 's' : ''} enough ordinary townsfolk for the evil roles to hide among.`
  );

  return { counts, reasons };
}

// Check a (possibly host-edited) setup. `errors` block the game from
// starting; `warnings` are advice only — it's a party game, the host rules.
function validateSetup(counts, n) {
  const errors = [];
  const warnings = [];

  const total = totalSpecials(counts);
  const evil = (counts.mafia || 0) + (counts.godfather || 0) + (counts.consigliere || 0);
  const evilKillers = (counts.mafia || 0) + (counts.godfather || 0);
  const sk = counts.serialkiller || 0;
  const villagers = n - total;

  if (n < 3) {
    errors.push('You need at least 3 players to start.');
  }
  if (total > n) {
    errors.push(`This setup deals ${total} special roles but only ${n} players are here.`);
  }
  if (evil + sk === 0) {
    errors.push('There are no evil roles at all — the town would have nothing to hunt.');
  }

  for (const id of SPECIAL_ROLES) {
    const max = roleById(id).max;
    if ((counts[id] || 0) > max) {
      errors.push(`At most ${max} ${roleById(id).name}${max > 1 ? 's are' : ' is'} allowed.`);
    }
  }

  if (errors.length > 0) return { errors, warnings };

  if (evil * 2 >= n) {
    warnings.push(`${evil} Mafia in a lobby of ${n} starts at (or past) parity — the town can barely win.`);
  } else if ((evil + sk) * 2 >= n) {
    warnings.push('Evil and neutral killers together match half the lobby — expect a very short, brutal game.');
  }

  const killCapable = evilKillers + sk + (counts.vigilante || 0);
  if (n >= 6 && killCapable > Math.max(2, Math.floor(n / 3))) {
    warnings.push(`${killCapable} kill-capable roles for ${n} players — nights will be a bloodbath.`);
  }

  if (villagers === 0) {
    warnings.push('No plain Villagers — with a gimmick on every player, reads get chaotic.');
  }

  if ((counts.doctor || 0) + (counts.bodyguard || 0) === 0 && evilKillers + sk >= 2 && n >= 6) {
    warnings.push('Multiple killers and no protective roles — the town has no way to stop the bleeding.');
  }

  if (evil > 0 && evilKillers === 0) {
    warnings.push('The Mafia team has no killer — the Consigliere will have to pull the trigger themselves.');
  }

  return { errors, warnings };
}

module.exports = { SPECIAL_ROLES, suggestSetup, validateSetup, totalSpecials, emptyCounts };
