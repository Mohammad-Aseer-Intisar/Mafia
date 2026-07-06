# Design Decisions

Short notes on the non-obvious choices in this codebase.

## Stack: Node + Express + Socket.IO + vanilla JS

Kept the original stack on purpose:

- **Socket.IO** over raw WebSockets: automatic reconnection, transport
  fallback for flaky mobile connections, and room broadcasting for free.
- **No build step, no framework, no TypeScript**: the whole game is ~2.5k
  lines. Anyone can clone it and have it running in two commands, on any
  machine with Node — that matters more here than type safety. The UI is
  four screens rendered from a single state object; a framework would add
  weight without removing complexity.
- **In-memory state**: games are ephemeral by nature. A crash loses at most
  one round of a party game; a database would add setup friction for zero
  practical benefit.

## Server-authoritative snapshots

The old codebase kept parallel game state on each client and patched it with
ad-hoc events. That's exactly how the "dead player still looks alive" bug
happened — and worse, the server broadcast every player's secret role to
every client, so anyone could open devtools and read who the Mafia were.

Now the server pushes a per-player **snapshot** after every state change
(`src/engine.js → snapshotFor`). Each snapshot contains only what that player
is allowed to see; the client renders from the latest snapshot and keeps no
game state of its own. Reconnection is the same code path: bind the socket,
resend history, push a snapshot.

## Fonts and page weight

No webfonts. Display type is the system serif stack (Palatino/Georgia),
body is the system UI stack. Icons are emoji and two inline SVGs. Initial
page weight is roughly 100 KB total including the Socket.IO client — fine
on a bad phone connection.

## Rule choices worth knowing

- **Jester execution ends the game immediately.** The alternative (game
  continues, jester gloats) drags for everyone else; instant endings keep
  party energy up and rounds short.
- **Bodyguard vs Doctor on the same target:** the guard intercepts first.
  A healed Bodyguard survives their intercept — that interaction rewards a
  coordinated town.
- **Serial Killer wins standoffs** (alive with ≤1 other player). Someone has
  to win the 1v1 and the SK's whole identity is out-surviving factions.
- **Detective sees the Serial Killer as Suspicious**, and the Godfather as
  Innocent. The SK needs *some* counterplay; the Godfather is the town's
  reason to distrust clean investigation results.
- **Consigliere inherits the kill** when all Mafia killers are dead —
  otherwise a Consigliere-only Mafia can never win and the endgame stalls.
- **Vigilante guilt** (die the night after killing Town) rather than instant
  self-reveal: it gives the table one full day to figure out what happened.

## Suggested role distributions

`src/suggestions.js` computes a distribution from the live player count
instead of a lookup table: ~1 evil seat per 3.5 players, special roles unlock
as the lobby grows (Godfather at 8+, Serial Killer at 10+, trading away a
Mafia seat), and a floor of plain Villagers is enforced so the table stays
readable. The reasoning is generated alongside the numbers and shown in the
lobby, so the host understands *why* — and can override any count, with
warnings instead of blocks.
