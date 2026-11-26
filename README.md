# Dwarfwatch

A little pixel-art dwarven mine that shows what your Claude Code sessions are doing.

![Dwarfwatch demo](demo.gif)

Each running Claude Code session is a dwarf digging its own tunnel; subagents are gnomes that come down
to help. You can see at a glance which sessions are working, which have finished, and which are waiting
for you (their dwarf climbs up to the surface with a green "!").

## What it shows

- **Sessions as dwarves.** The tunnel grows with the session's tool calls. The dwarf's animation follows
  what it is doing: a lantern for reading, hammer and chisel for edits, an ore cart for shell commands, a
  spyglass for web and browser tools, a wave when it calls in subagents, a pickaxe for everything else.
- **Subagents as gnomes,** dressed by type: explorers dig, general-purpose helpers carry a lantern,
  planners carry a sack.
- **The model by its pickaxe:** wood, copper, iron, gold or diamond, by the model's price.
- **Context** per session on its tunnel sign: how full the context window is, with a coloured bar.
- **Plan usage:** an estimate of your 5-hour and weekly limits (see below).
- **A crew that grows.** Dwarves are kept in a roster: free dwarves take new sessions (preferring ones
  that know the project), earn XP per tool call, level up (with fireworks), and can be renamed and
  restyled in the tavern.
- **Ore.** Mined ore fills each tunnel's cart; full carts are hauled up by the windlass onto an ore store
  that grows over time. No ore is lost to restarts or closed sessions.
- **Day and night** follow your working hours (set them with the ☀ button), with sunrise, sunset and a
  moon.
- **Click a dwarf or a sign** to open that session in the Claude desktop app.

## Running it

Requirements: [Node.js](https://nodejs.org) 18 or later, and Claude Code on the same machine.

```
node server.js
```

Then open <http://localhost:4777>. The page lists the sessions as cards under the mine; **Pop out** puts
the mine in a small always-on-top window (Chrome).

### The desktop overlay (Windows)

`overlay/` is a small borderless, always-on-top window (WinForms + WebView2) that shows just the mine.
It snaps to screen edges and corners, remembers where you put it, and starts the server itself if
nothing is running on the port.

Requirements: the .NET 10 SDK and the WebView2 runtime (part of current Windows).

```
cd overlay
dotnet publish -c Release -o app
app\Dwarfwatch.exe
```

Drag it by its top bar; hold **Alt** while dragging to place it without snapping.

## How it works

`server.js` (no dependencies) reads Claude Code's own local files:

- `~/.claude/sessions/*.json`, the running sessions and whether each is busy or idle;
- each session's transcript (`~/.claude/projects/...jsonl`), read incrementally, for the model, tool
  calls, tokens, the last prompt and whether the last reply asked you something;
- the subagent transcripts next to it, for the gnomes.

It serves the page and a small JSON API on `127.0.0.1` only. `mine.js` is the canvas engine that draws
the mine; `index.html` is the page and the overlay's UI.

Opening a session in the Claude desktop app uses the app's `claude://code/continue?session=...` link.
That link is not documented, so an app update could change it.

### Plan usage (an estimate)

The usage meters are worked out from the token use in your local transcripts, scaled to match numbers
you read off the Claude app once. Copy `usage-calibration.example.json` to `usage-calibration.json` and
fill in the 5-hour and weekly percentages and reset times the app shows you at a given moment. Without
that file the meters are hidden. Usage from other devices or claude.ai in a browser is not included, so
the estimate drifts over time; update the file now and then.

### Your data

Everything stays on your machine. The overlay keeps its window position, and the server keeps the dwarf
roster, the ore and your day-and-night hours, in `%LOCALAPPDATA%\Dwarfwatch\` (`~/.local/share/Dwarfwatch`
elsewhere). It used to be called Agent Watch; data in an old `AgentWatch` folder is copied over on first
start, and the old `AGENT_WATCH_*` settings below still work.

### Settings

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `4777` | the server's port |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | where Claude Code keeps its sessions and transcripts |
| `DWARFWATCH_ROSTER` | `%LOCALAPPDATA%\Dwarfwatch\roster.json` | the dwarf roster and ore file |
| `CONTEXT_WINDOW` | `1000000` | the context window size the tunnel signs measure against |
| `DWARFWATCH_PORT` | `4777` | the port the overlay app connects to |
| `DWARFWATCH_SERVER` | found next to the app | the `server.js` the overlay app starts when none is running |
