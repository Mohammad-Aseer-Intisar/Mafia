// Game catalog shared by server and client: roles, alignments, phases,
// and host-setting descriptions. Keep all player-facing wording here so
// the in-game help panel and the server never drift apart.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MafiaCatalog = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ALIGNMENTS = {
    town: {
      id: 'town',
      name: 'Town',
      icon: '☀️',
      blurb: 'Wins when every Mafia member and the Serial Killer are gone.'
    },
    mafia: {
      id: 'mafia',
      name: 'Mafia',
      icon: '🔪',
      blurb: 'Knows its teammates. Wins when the Mafia matches or outnumbers everyone else.'
    },
    neutral: {
      id: 'neutral',
      name: 'Neutral',
      icon: '🎭',
      blurb: 'Plays for itself. Each neutral role has its own win condition.'
    }
  };

  // `max` caps the host's manual count stepper. Roles with a night action
  // list it under `nightAction` (used for docs and prompts, not logic).
  const ROLES = [
    {
      id: 'villager',
      name: 'Villager',
      icon: '🧑‍🌾',
      alignment: 'town',
      max: 99,
      summary: 'No special powers — just your voice and your vote.',
      ability: 'You have no night action. Listen during the day, spot the liars, and vote the evil roles out.',
      win: 'Win with the Town: eliminate all Mafia and the Serial Killer.'
    },
    {
      id: 'doctor',
      name: 'Doctor',
      icon: '💉',
      alignment: 'town',
      max: 2,
      nightAction: 'Protect one player (yourself included) from being killed tonight.',
      summary: 'Quietly saves one player from death each night.',
      ability: 'Each night, pick one player to protect. If they are attacked that night, they survive and no one learns who saved them. You may protect yourself.',
      win: 'Win with the Town: eliminate all Mafia and the Serial Killer.'
    },
    {
      id: 'detective',
      name: 'Detective',
      icon: '🕵️',
      alignment: 'town',
      max: 2,
      nightAction: 'Investigate one player and learn if they are Suspicious or Innocent.',
      summary: 'Investigates one player each night.',
      ability: 'Each night, pick one player. You learn whether they are SUSPICIOUS (Mafia or Serial Killer) or INNOCENT. Careful: the Godfather shows up as Innocent.',
      win: 'Win with the Town: eliminate all Mafia and the Serial Killer.'
    },
    {
      id: 'bodyguard',
      name: 'Bodyguard',
      icon: '🛡️',
      alignment: 'town',
      max: 2,
      nightAction: 'Guard one other player. If they are attacked, you die in their place.',
      summary: 'Takes the bullet for whoever they guard.',
      ability: 'Each night, pick another player to guard. If they are attacked, you die fighting the attacker and they survive. Unlike the Doctor’s quiet save, everyone hears you fell defending someone. If a Doctor protected you that same night, you survive the fight.',
      win: 'Win with the Town: eliminate all Mafia and the Serial Killer.'
    },
    {
      id: 'vigilante',
      name: 'Vigilante',
      icon: '🔫',
      alignment: 'town',
      max: 2,
      nightAction: 'Once per game, shoot one player at night — or hold fire.',
      summary: 'One bullet, one chance. Use it well.',
      ability: 'You carry a single bullet. On any night you may shoot one player, or hold fire. If you kill a Town member, the guilt kills you the following night — nothing can save you.',
      win: 'Win with the Town: eliminate all Mafia and the Serial Killer.'
    },
    {
      id: 'mayor',
      name: 'Mayor',
      icon: '🏛️',
      alignment: 'town',
      max: 1,
      summary: 'Can go public for a double vote — at a price.',
      ability: 'At any point during the day you may reveal yourself as the Mayor. From then on your vote counts twice, but everyone (including the Mafia) knows exactly who you are. You cannot un-reveal.',
      win: 'Win with the Town: eliminate all Mafia and the Serial Killer.'
    },
    {
      id: 'mafia',
      name: 'Mafia',
      icon: '🕶️',
      alignment: 'mafia',
      max: 6,
      nightAction: 'Vote with your team on one player to kill tonight.',
      summary: 'Kills one player per night with the team.',
      ability: 'You know who your teammates are and share a private night chat. Each night the Mafia votes on one victim; the most-voted target dies. Blend in during the day.',
      win: 'Win with the Mafia: match or outnumber all remaining non-Mafia players.'
    },
    {
      id: 'godfather',
      name: 'Godfather',
      icon: '🎩',
      alignment: 'mafia',
      max: 1,
      nightAction: 'Vote with your team on one player to kill tonight.',
      summary: 'Leads the Mafia and looks Innocent to the Detective.',
      ability: 'You run the Mafia and join the nightly kill vote like any other member — but Detective investigations report you as INNOCENT. Regular Mafia members still show up as Suspicious.',
      win: 'Win with the Mafia: match or outnumber all remaining non-Mafia players.'
    },
    {
      id: 'consigliere',
      name: 'Consigliere',
      icon: '📜',
      alignment: 'mafia',
      max: 1,
      nightAction: 'Learn the exact role of one player each night.',
      summary: 'The Mafia’s own investigator — learns exact roles.',
      ability: 'Each night, pick one player and learn their exact role (not just their alignment). You share the Mafia’s night chat. If every Mafia killer is dead, you pick up the gun and choose the night kill yourself.',
      win: 'Win with the Mafia: match or outnumber all remaining non-Mafia players.'
    },
    {
      id: 'jester',
      name: 'Jester',
      icon: '🃏',
      alignment: 'neutral',
      max: 1,
      summary: 'Wants to be voted out. Yes, really.',
      ability: 'You have no night action. Your only goal is to get yourself executed by the town’s day vote. Act suspicious — but not too obviously. Dying at night does NOT count.',
      win: 'Win alone: get executed by the day vote. The game ends immediately when you succeed.'
    },
    {
      id: 'serialkiller',
      name: 'Serial Killer',
      icon: '🗡️',
      alignment: 'neutral',
      max: 1,
      nightAction: 'Kill one player each night.',
      summary: 'Kills nightly and answers to no one.',
      ability: 'Every night you kill one player of your choice. You are not on the Mafia’s side — they can kill you and you can kill them. Investigations show you as Suspicious.',
      win: 'Win alone: survive until at most one other player remains.'
    },
    {
      id: 'survivor',
      name: 'Survivor',
      icon: '🌱',
      alignment: 'neutral',
      max: 2,
      summary: 'No powers, no side — just stay alive.',
      ability: 'You have no night action and no allegiance. You simply want to be alive when the game ends, whoever wins it.',
      win: 'Win alongside whoever wins: be alive when the game ends.'
    }
  ];

  const PHASES = [
    {
      id: 'night',
      name: 'Night',
      icon: '🌑',
      text: 'Roles with night actions secretly pick their targets. Everyone else waits. The phase ends when the timer runs out or everyone has acted.'
    },
    {
      id: 'day-announcement',
      name: 'Morning',
      icon: '🌅',
      text: 'The night’s events are announced: who died, who was saved. Take a breath and read the log.'
    },
    {
      id: 'day-discussion',
      name: 'Discussion',
      icon: '💬',
      text: 'Talk it out (on Discord or in person). Who is acting strange? The host can end discussion early.'
    },
    {
      id: 'day-voting',
      name: 'Voting',
      icon: '⚖️',
      text: 'Vote to execute a player, or vote Skip. Ties and a Skip majority mean no one is executed. Votes are public.'
    }
  ];

  const SETTINGS_HELP = [
    { key: 'nightTimer', name: 'Night timer', text: 'How long night lasts. It ends early once everyone with a night action has acted. “No limit” waits for everyone.' },
    { key: 'discussionTimer', name: 'Discussion timer', text: 'How long the town talks before voting. The host can always cut it short.' },
    { key: 'votingTimer', name: 'Voting timer', text: 'How long the vote stays open. It closes early once every living player has voted.' },
    { key: 'revealRoleOnDeath', name: 'Reveal role on death', text: 'When on, a dead player’s role is shown to everyone. When off, deaths stay anonymous — harder for the town.' },
    { key: 'firstNightKill', name: 'First-night kills', text: 'When off, night 1 is a truce: no one can die, but investigations still happen. Gentler for new groups.' }
  ];

  function roleById(id) {
    for (let i = 0; i < ROLES.length; i++) {
      if (ROLES[i].id === id) return ROLES[i];
    }
    return null;
  }

  return { ALIGNMENTS, ROLES, PHASES, SETTINGS_HELP, roleById };
});
