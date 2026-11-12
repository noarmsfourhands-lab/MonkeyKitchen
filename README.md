# 🐵 Monkey Kitchen

A Claude Code plugin that turns your session into a kitchen brigade of monkey chefs. The main session is the Head Chef; eleven cooks take the tickets it hands out: ten on Opus, and the Sous Chef on your main model. A local page shows the kitchen live while you prompt as usual, with a running tab of what the work cost.

No API key and no npm dependencies. It needs Node 18 or newer on your PATH as node (Claude Code's native installer does not include Node; check with node --version).

## What it does

- **Routes work to the right cook, many at once.** At session start the plugin gives the Head Chef a short set of rules: which cook gets which kind of ticket, how to keep many tickets cooking in parallel, when to do the work itself, and when to escalate.
- **Shows the kitchen.** Hooks forward session events to a small local server, and a page on http://localhost:4747 animates whoever is working. The page is locked to you: see [The key](#the-key).
- **Keeps a tab.** Token counts per model tier are read from the session transcripts and priced at API list prices, next to an estimate of the same tokens at the Head Chef's price.

## The brigade

| Station | Agent | Model | Effort | Job |
|---|---|---|---|---|
| Head Chef | your main session | whatever you run (Fable recommended) | yours | Splits the order, keeps many tickets cooking at once, checks the plate |
| Sous Chef | `sous-chef` | your main model (inherit) | xhigh | Design decisions, plans, root cause of bugs (can run commands to reproduce, never edits) |
| Senior Cook | `chef-de-partie` | Opus | high | Hard build work in any layer: subtle logic, concurrency, wide refactors, cross-layer features |
| Health Inspector | `inspector` | Opus | high | Independent review of a finished change for bugs, security, and fit to the goal (never edits) |
| Pastry Chef | `frontend-cook` | Opus | medium | Front-end work |
| Grill Cook | `backend-cook` | Opus | medium | Back-end work |
| Line Cook | `line-cook` | Opus | medium | Other build work: scripts, config, tooling |
| Taster | `taster` | Opus | medium | Runs tests and checks, writes tests when asked |
| Prep Cook | `prep-cook` | Opus | medium | Finds and reads code, with quoted evidence (never edits) |
| Runner | `runner` | Opus | medium | Web and docs lookups |
| Menu Scribe | `scribe` | Opus | medium | Docs for existing code |
| Dishwasher | `dishwasher` | Opus | low | Mechanical cleanup |
| Stagiaire | any other agent | varies | varies | Where agents from outside the brigade show up |

Cooks cannot spawn other cooks, so the Head Chef is the only one handing out tickets. It can run several cooks of the same kind at once, and can change a cook's effort or model for a single ticket (the Agent tool's `effort` and `model` parameters). The kitchen shows the tier a cook actually ran on.

Every cook except the Sous Chef runs on Opus; the Sous Chef runs on your main model. What varies is the effort level: low for mechanical work and plain lookups, medium for reading, docs and well-specified building, high and above for hard building, review and planning. The brigade is tuned for accuracy and speed first, and saves usage by keeping work out of the Head Chef's context and by not over-thinking easy tickets. To change a cook, edit the `model:` and `effort:` lines in its `agents/*.md` file.

## How the Head Chef works

The rules are in brigade/head-chef.md, injected at session start and again after compaction. In short: it does small jobs and decisions itself, splits the rest into tickets that never share a file, sends them all at once, matches the cook to the difficulty, passes forward what earlier cooks found, checks each wave's reports against the tree, and has risky changes reviewed before telling you it's done.

## What you see

The kitchen is a top-down pixel-art room. Each agent is a monkey that walks to the spot matching its current tool call:

| The agent is… | The monkey… |
|---|---|
| Reading a file | Goes to the recipe shelf |
| Searching (grep, glob) | Rummages in the pantry or fridge |
| Editing or writing | Works its own station: cutting board (Prep Cook), grill (Grill Cook), stove (Line Cook), pastry bench (Pastry Chef), sink (Dishwasher), menu board (Menu Scribe), soup pot (Taster), planning desk (Sous Chef), mixing bowl (Senior Cook), potatoes (guest agents) |
| Running a command | Cooks at its station (the Pastry Chef uses the oven, the Head Chef takes a stove) |
| Fetching from the web | Leaves by the back door and returns with a crate |
| Delegating (Head Chef) | Turns from the pass and calls the order |
| Finished | Carries a plate to the pass, then goes back on break |
| Waiting for your permission | The Head Chef waves at your table |

A cook that has gone quiet for a long time dozes at its station and is shown as "quiet", not finished. The side panel "On the line" has a card per cook with its model, effort, elapsed time, ticket, steps and final report; hovering a monkey shows the same at a glance.

The Health Inspector patrols with a clipboard, a failed tool call smashes a plate, extra cooks of the same kind come in through the back door, and when the order is done the Head Chef rings the bell and your table gets its plate.

## Requirements and cost

- Node 18+ on PATH as `node`. Without it every hook fails: no kitchen view, and the Head Chef gets no rules.
- Opus access for the cooks; Fable recommended for your main session (the Sous Chef runs on it).
- The cooks run on Opus (the Sous Chef on your main model) and the Head Chef runs up to about ten at once, so a big job uses plan limits faster than a single session. The rules add about 1,700 tokens to each session.
- Privacy: hooks send only the fields the kitchen uses, never file contents or command output, and only to 127.0.0.1. The server makes no outbound calls and writes one file, the key. While it starts the server, a hook also keeps a short-lived lock file in the system temp folder.

## Install

From a clone on disk:

```
/plugin marketplace add /path/to/MonkeyKitchen
/plugin install monkey-kitchen@monkey-kitchen
```

From GitHub, once published:

```
/plugin marketplace add <owner>/<repo>
/plugin install monkey-kitchen@monkey-kitchen
```

For a single session while developing: `claude --plugin-dir /path/to/MonkeyKitchen`.

Start a new session, then run `/monkey-kitchen:kitchen` (or ask the Head Chef for the kitchen link). You get a link of the form `http://localhost:4747/?k=<key>`. Open it once; from then on plain http://localhost:4747 works in that browser. The server starts when a session starts, and shuts itself down after twelve hours with no events and no page open.

## Try it without spending tokens

```
npm run demo
```

This plays a scripted service through the real hook relay, with a fake transcript so the tab has numbers.

## Settings

| Environment variable | Effect |
|---|---|
| `MONKEY_KITCHEN_PORT` | Port for the server and page. Default `4747`. |
| `MONKEY_KITCHEN_ROUTING=off` | Keep the visualization but don't give the Head Chef the routing rules. |
| `MONKEY_KITCHEN_STALE_MS` | How long a cook can be silent before it is shown as quiet. Default 900000 (15 minutes). |
| `MONKEY_KITCHEN_TOKEN` | The key, as 32 hex characters. When unset or not 32 hex characters, the key file is used (see [The key](#the-key)). |

Edit `brigade/head-chef.md` to change the routing rules, `agents/*.md` to change a cook, and `server/pricing.json` to change prices.

A plugin installed from a local folder marketplace is read in place, so edits take effect at the next session start or after `/reload-plugins`, with no version bump. A plugin installed from GitHub is copied into `~/.claude/plugins/cache/` per version, and an update is only detected when `version` in `.claude-plugin/plugin.json` changes, so bump it on every release. To update, run `/plugin marketplace update monkey-kitchen`, then update the plugin from `/plugin` (or in a shell: `claude plugin marketplace update monkey-kitchen`, then `claude plugin update monkey-kitchen@monkey-kitchen`), then restart the session. A running kitchen server from an older version is replaced automatically the next time a session starts.

## The key

The server and the hooks share a secret key. It is kept in `~/.claude/monkey-kitchen/token`, created on first use and readable only by you on macOS and Linux. When `MONKEY_KITCHEN_TOKEN` holds 32 hex characters, that is used instead.

- Hooks send the key with every event, and only to a server that first proves it holds the same key. Another program sitting on the port gets nothing.
- The page uses a second, read-only key derived from the first. At session start the Head Chef is given a link of the form `http://localhost:4747/?k=<page key>`. Opening it once sets a cookie in that browser, and from then on plain http://localhost:4747 works there. Run `/monkey-kitchen:kitchen` in a session to have the Head Chef give you the link.
- The page key can only read. It cannot add events or stop the server, and the main key never appears in the link, the cookie, or the session transcript.
- Without the key the page loads but shows "This kitchen is locked" and no session data. `/health` and the page's own files stay open.
- With `MONKEY_KITCHEN_ROUTING=off` the session still gets the link; only the routing rules are left out.

What it protects, and what it does not:

- It stops other users on the machine, and other programs that cannot read your files. A program running as you can read the key file (and your transcripts) anyway.
- The link contains the page key. Anyone who has it and can reach your machine's loopback address can read the kitchen, so do not paste it into public places.
- Browser cookies for `localhost` are shared across ports, so other local web servers you visit can see the page key cookie. That is why it is read-only. A second kitchen on another port with a different key replaces the cookie.
- On Windows the key folder's permissions are tightened to your account when it is created. On macOS and Linux the file is created readable only by you.
- To change the key, delete `~/.claude/monkey-kitchen/token`. The next event creates a new one, the running server picks it up, and open pages lock until you open the new link.

## Turn it off for one project

- Turn the whole plugin off there: run `claude plugin disable monkey-kitchen@monkey-kitchen --scope local` in that project, or set `"enabledPlugins": { "monkey-kitchen@monkey-kitchen": false }` in the project's `.claude/settings.local.json`.
- Keep the view, drop the routing: add `"env": { "MONKEY_KITCHEN_ROUTING": "off" }` to the project's `.claude/settings.local.json`.

Project settings apply once you have trusted the folder.

## How it works

```
Claude Code ──hooks──▶ scripts/hook.mjs ──POST /hook──▶ server/server.mjs ──SSE /events──▶ web/
```

- `hooks/hooks.json` registers ten hooks. All but `SessionStart` run in the background, and `PostToolUse` fires only for the Agent tool.
- `scripts/hook.mjs` sends only the fields the kitchen uses, never file contents or command output, with the key. It stamps each event with an id and the time, starts the server when it is not running, replaces an older server after a plugin update, and always exits cleanly.
- `server/server.mjs` keeps the state in memory and listens on `127.0.0.1` only. It pairs each ticket to its cook using the Agent tool's result, ignores late and duplicate events, and streams the watched session to the page. When the server restarts mid-session (a crash, a plugin update, the idle shutdown), the next event from that session makes it rebuild the current order and its cooks (ticket, steps, report) from the session's transcript files.
- `server/usage.mjs` reads the session transcript and the subagent transcripts beside it, and prices each message by its model.

`.claude-plugin/icon.png` is generated from the page's own pixel art by `node tools/make-icon.mjs`.

## Limits of the tab

- Prices are API list prices. On a subscription plan nothing is billed per token, so read the figures as relative weight.
- Input and output prices are list prices per model. Cache-write prices and some cache-read prices in `server/pricing.json` are assumptions; its `note` field says which.
- The "Head Chef alone" figure prices the same token counts at the main model's rate. A real solo run would use a different number of tokens, so treat it as a rough comparison.
- Models not listed in `pricing.json` are priced at their tier's current rate.

## Tests

`npm test` runs the suite in `test/` (124 tests) with Node's built-in runner. It starts its own servers on random ports and needs no setup.

`.github/workflows/test.yml` runs the suite on Windows, macOS and Linux with Node 18, 20, 22 and 24 on every push and pull request. Locally it has only been run on Windows with Node 24 so far.

## License

MIT
