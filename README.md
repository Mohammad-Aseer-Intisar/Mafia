# Mafia

A browser-based, real-time multiplayer Mafia party game for friend groups.
Create a room, share a 4-letter code, and play — roles, night actions,
timers, and votes are all handled in the browser. Pair it with Discord (or
any voice call) for the arguing.

- 12 roles across Town, Mafia, and Neutral factions
- Smart role suggestions that adapt to your player count and explain their
  reasoning — the host can override anything
- In-game rules panel, one tap away at any point in a game
- Works on phones; ~100 KB initial page load, no external fonts or images
- Reconnect-friendly: refresh mid-game and land back in your seat

**How to play:** see [docs/RULES.md](docs/RULES.md) (also available in-game
via the **? Rules** button). Design notes live in
[docs/DECISIONS.md](docs/DECISIONS.md).

---

## Requirements

- **Node.js 18 or newer** ([nodejs.org](https://nodejs.org)) — that's it.
- For the tunnel option below: no extra installs (uses the SSH client built
  into Windows 10+/macOS/Linux) or `ngrok` if you prefer.

## Quick start

```
git clone https://github.com/RHYTHM1028/mafia.git
cd mafia
npm install
npm start
```

Open http://localhost:3000 — that's the game. 3–16 players per room.

To test alone, open several browser tabs. Note that tabs in the *same*
browser profile share one player identity; use a private window or a second
browser for extra local players.

---

## Option A — Host from your PC (spontaneous game nights)

Run the server locally and expose it through a tunnel. Your PC hosts the
game; friends just open a link.

**1. Start the game** (keep this window open):

```
npm start
```

**2. Open a tunnel** in a second terminal. Two good options:

### localhost.run (nothing to install)

Windows (cmd **or** PowerShell), macOS, Linux — same command:

```
ssh -R 80:127.0.0.1:3000 nokey@localhost.run
```

It prints a public `https://…` URL — send that to your friends.

> **Gotcha:** write `127.0.0.1:3000`, not `localhost:3000`. On many systems
> `localhost` resolves to the IPv6 address `::1`, but the game server listens
> on IPv4 — using `localhost` in the tunnel command can give everyone
> 502 errors.

If SSH complains about host authenticity the first time, type `yes`.

### ngrok (more stable, free account required)

Install from [ngrok.com](https://ngrok.com/download), sign up for the free
auth token, then:

```
ngrok http 3000
```

Copy the `https://….ngrok-free.app` forwarding URL and share it.

**Same Wi-Fi instead?** Skip the tunnel: find your local IP
(`ipconfig` on Windows, `ifconfig`/`ip a` on macOS/Linux) and friends open
`http://YOUR_IP:3000`.

Caveats of local hosting:

- The game dies when you close the terminal or your PC sleeps.
- Free tunnel URLs change every time you restart the tunnel.

## Option B — Free cloud deploy (persistent link, no PC required)

[Render](https://render.com)'s free tier works well for this:

1. Fork or push this repo to your own GitHub account.
2. In Render: **New → Web Service**, connect the repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
4. Deploy. Your game lives at `https://your-app.onrender.com` — bookmark it.

No environment variables are needed. The server reads `PORT` automatically.

Caveats of the free tier:

- **Cold starts:** after ~15 minutes with no traffic the service spins down.
  The first visit takes 30–60 seconds to wake it up — have one person open
  the link a minute before game night starts.
- A spin-down also wipes any in-progress game (state is in memory), which in
  practice never matters — an active game *is* traffic.

Railway and Fly.io also work (any Node host does); Render is documented here
because its free tier currently needs no credit card and no config files.

---

## Project layout

```
server.js          entry point (Express + Socket.IO)
src/
  engine.js        game state machine: phases, night resolution, win checks
  sockets.js       connection lifecycle, reconnect grace, event routing
  suggestions.js   player-count-aware role suggestions + setup validation
shared/
  catalog.js       role/phase/setting descriptions (server + client)
public/            the entire client: index.html, style.css, game.js
docs/              RULES.md (player-facing), DECISIONS.md (technical)
test/e2e.js        end-to-end tests over real sockets (npm test)
```

## Development

```
npm test
```

Boots the real server and plays six full scripted games over real sockets:
kill/vote/win flow, bodyguard intercepts, vigilante guilt, jester win, mayor
vote weight, disconnect-during-night, reconnection resync — plus two standing
invariants checked on every snapshot of every test: dead players are dead on
every client, and no client ever receives a role it shouldn't see.
