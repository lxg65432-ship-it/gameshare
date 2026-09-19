# GameShare

> English | [简体中文](README.md)

> **Built for games, and beyond.**
> Play with friends a thousand miles away — and it feels like they're sitting
> right next to you.

![GameShare main window](docs/screenshots/main-window.png)

![Float overlay above a fullscreen game](docs/screenshots/float-overlay.jpg)

A few of my friends and I play different games in different homes, and we wanted
to see what everyone else is playing. That is the whole idea behind this tool:
share your game window, see your friends' game windows, get on with the game.

GameShare is a lightweight Windows screen-sharing tool. Join a room, pick a
window, start sharing. That's it.

It supports 2 to 4 players in a full mesh over WebRTC. Each player runs their
own game locally and shares just that game's window. Audio can be limited to
the shared application, the whole PC, or turned off entirely. A mini overlay
can float above your fullscreen game without stealing focus.

## Where the project stands

**v1.0** — feature development is frozen here: it does what my friends and I
need, and the parts that matter are guarded by automated acceptance checks.
Milestones M0 through M6 are done. M7 through M10 (network stats panel, TURN
relay, auto-reconnect, performance benchmarking) are deliberately not planned;
see `docs/ROADMAP.md` if you want to pick one up.
**v1.1** — the first batch of updates from real playtesting: selectable frame
rate, bitrate that adapts to high-resolution sources, a drag-and-resize sidebar,
and a fix for float windows growing while dragged.

- 2–4 player WebRTC mesh, each stream independently decoded and quality-controlled
- Game window capture (borderless windowed recommended; exclusive fullscreen won't work)
- **Three audio modes**: only the shared app's audio (captured per process tree),
  the whole PC minus GameShare itself, or silence
- **Per-peer volume control**, with voice and shared audio as separate tracks
- **Float overlay**: a mini window above your fullscreen game, no focus stealing,
  can split into independent tiles
- Double-click to enlarge one stream, with automatic quality rebalancing
  (the focused stream goes 1080p, the rest step down to save upload)
- **Selectable frame rate** (30/60/120) with bitrate adapting to the source
  resolution — 2K / ultrawide captures no longer get crushed to low quality
- 200+ automated acceptance checks: 17 signaling cases, decoded-frame assertions,
  audio spectrum isolation, 3-track media structure, overlay z-order and tiles

## Read this before you use it: security

This tool **has no authentication**. The only thing keeping strangers out is
that the address and room code stay within your group. These are ground rules,
not suggestions:

1. **Never share the public address anywhere public.** The `https://*.trycloudflare.com`
   address from the "remote access" switch, and the public IPv6 address shown in
   the sidebar, are effectively a public entrance to your machine. Send them in
   a private chat to the people you're playing with — not in a group, not on a
   forum, not on any web page. If it leaks, anyone with the address can start
   brute-forcing the 6-character room code (about 1.07 billion combinations,
   and the server does not rate-limit).
2. **Same for the room code — private chat only.** The code is the only gate.
   Anyone who guesses it **immediately sees your shared screen**. There is no
   confirmation prompt and no kick function.
3. **Close the tunnel when you're done.** Brute-forcing takes time; a tunnel
   that's up for five minutes is a very different risk than one left up all day.
   The switch is off by default — keep that habit.
4. LAN addresses (`192.168.x.x`) are low risk, but still only for your group.
5. **Symmetric NAT cannot connect, and there is no relay fallback.** If either
   side is behind one, the connection will just sit at "negotiating".
6. The threat model is "small group of friends". **If you want to serve
   strangers, add authentication and rate limiting first** — the signaling
   server is a plain Node service, and modifying it is straightforward.

## Quick start (end users)

Both machines only need the installed client — no Node.js, no command line.

### Same LAN (the default case)

1. Open GameShare on both machines. The host enables the **built-in signaling
   server** in the sidebar panel, then clicks **create room**;
2. Click **copy invite** next to the room code and send the text to your friend
   (WeChat / QQ / anything);
3. Your friend pastes the whole message into the **room code** box — the address
   gets filled in, the client connects and joins automatically. Nothing to type;
4. On first launch, Windows Firewall asks for permission — **click "Allow"**.
   Clicking "Cancel" makes the other side hang on "connecting" with no error
   on either end (how to fix it later: see troubleshooting in the docs).

> Want a custom nickname? Type it before pasting the invite. The old manual flow
> (typing the server address by hand) is still there, tucked into the
> "network settings" fold. If both clients are open, the first one gets port
> 8080 and the second shows "port in use" — that's fine, it still works as a client.

### Across networks (remote)

Turn on the "remote access" switch (off by default). The client starts a
temporary tunnel on its own. Then it's the same: **create room → copy invite →
send it over** — your friend pastes it into the room code box and is in.
**Turn the switch off when you're done.**

> That address is a public entrance to your machine. See rule 1 above.

The packaged build ships with `cloudflared.exe`, no manual download needed.
Only the source mode needs `tools/cloudflared.exe` (see `docs/REMOTE-TESTING.md`).

### Sharing a window with sound

Click "enumerate windows / screens", pick the game window (thumbnails included),
and it appears on the other side. Audio has three modes, switchable before or
during sharing (switching mid-share re-captures once):

| Mode | What it does |
| --- | --- |
| **This app only** (default for windows) | Sends only the selected window's audio (including direct child processes). Not available for full-screen sources — picking it there falls back to "whole PC", visibly |
| **Whole PC** | Sends all system output except GameShare itself, so your friends' voices don't get re-captured. Attenuation, not elimination — wearing headphones is still a good idea |
| **Silent** | No audio, video unaffected |

If system audio can't be captured, it **does not silently downgrade**: the video
keeps going and you get a warning with three choices (switch to whole-PC audio /
continue silent / cancel sharing).

Each remote tile has a volume button: **voice and shared audio have separate
sliders**, local only. Badges on the tile show which tracks are live.

### Watching: double-click to enlarge

Double-click a remote tile to fill the stage; the rest collapse into a
thumbnail strip. Double-click again or press `Esc` to go back. Enlarging
automatically bumps that stream to 1080p and steps the others down to 360p.

### The float overlay

`Ctrl+Alt+G` collapses the shared streams into a mini window above your
fullscreen game: no focus stealing, draggable, opacity adjustable, can split
into independent tiles. Put your game in borderless windowed mode first —
exclusive fullscreen can't be captured or overlaid, that's a Windows
limitation, not a bug here.

## Building from source

Requirements: **Node.js ≥ 20**, Windows 10 / 11.

```bash
npm install            # install all workspace dependencies
npm run dev:desktop    # run the client (Vite + Electron, hot reload)
```

If you'd rather not open a terminal, double-click the bat files in the repo root:

| File | What it does |
| --- | --- |
| `run.bat` | Launch the latest packaged build (no build, no install) |
| `dev.bat` | Run from source (Vite dev server + Electron) |
| `build-exe.bat` | One-click packaging, about 40 seconds, prints the output path |
| `diagnose-capture.bat` | Diagnose "the window is running but not in the capture list" |
| `tunnel.bat` | Manually start the remote tunnel (the client already has a switch) |

Build output lands in `apps/desktop/release/`: `GameShare Setup 1.1.5.exe`
(installer) or `win-unpacked/GameShare.exe` (portable).

> The bat files look for node.exe via the `GAMESHARE_NODE_DIR` environment
> variable, then PATH. Machine-specific build pitfalls (intercepted npm,
> electron-builder cache, file locks) are documented in `docs/BUILD-NOTES.md`.

## The test suite

Every script judges pass/fail on its own:

```bash
npm run smoke              # signaling: 17 cases (rooms, limits, forgery, cleanup, heartbeat)
npm run smoke:p2p          # link layer: real Electron windows, asserts getStats() decoded frames keep rising
npm run check:app-audio    # app audio: real windows, real test tones, FFT isolation measurement (67 checks)
npm run check:media-tracks # 3-track media structure + digital feedback loop: 4-window model, two rounds
npm run check:embedded     # embedded signaling server, verified against the packaged build
npm run check:standalone   # standalone deployment artifact: zero-dependency boot, dual-stack
npm run check:topmost      # overlay z-order and focus (22 checks)
npm run check:tiles        # overlay split mode (117 checks, 8 groups)
npm run check:network      # local P2P capability diagnosis (public IPv6 / NAT type)
npm run check:stun         # STUN node health (can Chromium get srflx here)
```

A few principles behind it: assertions compare actual values against
protocol-derived expectations; key criteria have a control group (turn the
audio back on and it must be audible again, otherwise your meter is deaf);
important assertions have been verified to fail when they should. `smoke:p2p`
covers synthetic sources; real system audio is `check:app-audio`'s job. Whether
a real game window carries its real sound can only be checked by ear.

## Documentation

| If you want to | Read |
| --- | --- |
| Understand the project and run it | This file |
| Change code: what to read, what to run, what bites | `docs/CONVENTIONS.md` |
| Why a constraint exists | `docs/ARCHITECTURE.md` §4 |
| Roadmap, milestones, and deliberate non-goals | `docs/ROADMAP.md` |
| Cross-network testing and diagnosis (NAT / tunnel / IPv6) | `docs/REMOTE-TESTING.md` |
| Machine-specific build pitfalls | `docs/BUILD-NOTES.md` |
| Contributing | `CONTRIBUTING.md` |

## Known limitations

1. Exclusive fullscreen can't be captured (Windows limitation) — use borderless windowed;
2. Symmetric NAT can't connect and there's no TURN fallback (that's M8);
3. No authentication — see the security section;
4. Kernel-level anti-cheat systems (EAC / BattlEye / Vanguard) may treat screen
   capture specially. Use at your own risk; try a game without anti-cheat first;
5. Windows-only for system audio capture (per-app / whole-PC both rely on
   Windows process-tree loopback).

## Contributing

Issues, forks, and PRs are welcome. Read `docs/CONVENTIONS.md` first — it maps
each kind of change to required reading, required checks, and the mistakes
already made for you. New features come with acceptance scripts; bug fixes come
with an assertion that fails before the fix.

M7 (network stats), M8 (TURN + auth), M9 (stability), and M10 (performance
baselines) are the known open areas. For changes that touch the security model
(auth, rate limiting, key handling), open an issue first.

## License

[MIT](LICENSE)

---

## Disclaimer

This software is provided "as is", without warranty of any kind. It transmits
your screen and audio to other people in the room — use it only with people you
know and trust. The signaling link has no authentication or access control;
managing public addresses and room codes is your responsibility. Do not use
this software for anything that violates your local laws.
