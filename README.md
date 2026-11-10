# 🐵 Monkey Kitchen

A Claude Code plugin that turns your session into a kitchen brigade of monkey chefs. The main session is the Head Chef; ten cooks on cheaper models take the tickets it hands out. A local page shows the kitchen live while you prompt as usual, with a running tab of what the work cost.

No API key and no dependencies. It needs Node 18 or newer.

## What it does

- **Routes work to the right cook, many at once.** At session start the plugin gives the Head Chef a short set of rules: which cook gets which kind of ticket, how to keep many tickets cooking in parallel, when to do the work itself, and when to escalate.
- **Shows the kitchen.** Hooks forward session events to a small local server, and the page at http://localhost:4747 animates whoever is working.
- **Keeps a tab.** Token counts per model tier are read from the session transcripts and priced at API list prices, next to an estimate of the same tokens at the Head Chef's price.

## The brigade

| Station | Agent | Model | Effort | Job |
|---|---|---|---|---|
| Head Chef | your main session | whatever you run (Fable recommended) | yours | Splits the order, keeps many tickets cooking at once, checks the plate |
| Sous Chef | `sous-chef` | Opus | xhigh | Design decisions, plans, root cause of bugs (can run commands to reproduce, never edits) |
| Senior Cook | `chef-de-partie` | Opus | high | Hard build work in any layer: subtle logic, concurrency, wide refactors, cross-layer features |
| Health Inspector | `inspector` | Opus | high | Independent review of a finished change for bugs, security, and fit to the goal (never edits) |
| Pastry Chef | `frontend-cook` | Opus | medium | Front-end work |
| Grill Cook | `backend-cook` | Opus | medium | Back-end work |
| Line Cook | `line-cook` | Opus | medium | Other build work: scripts, config, tooling |
| Taster | `taster` | Opus | medium | Runs tests and checks, writes tests when asked |
| Prep Cook | `prep-cook` | Opus | low | Finds and reads code, with quoted evidence (never edits) |
| Runner | `runner` | Opus | low | Web and docs lookups |
| Menu Scribe | `scribe` | Opus | low | Docs for existing code |
| Dishwasher | `dishwasher` | Opus | low | Mechanical cleanup |
| Stagiaire | any other agent | varies | varies | Where agents from outside the brigade show up |

Cooks cannot spawn other cooks, so the Head Chef is the only one handing out tickets. It can run several cooks of the same kind at once, and can change a cook's effort or model for a single ticket (the Agent tool's `effort` and `model` parameters). The kitchen shows the tier a cook actually ran on.

Every cook runs on Opus. What varies is the effort level: low for lookups and mechanical work, medium for well-specified building, high and above for hard building, review and planning. The brigade is tuned for accuracy and speed first, and saves usage by keeping work out of the Head Chef's context and by not over-thinking easy tickets. To change a cook, edit the `model:` and `effort:` lines in its `agents/*.md` file.

## How the Head Chef works

- Does one- or two-step jobs itself, and keeps any job where the hard part is deciding.
- Fans out: splits the order into every independent ticket it has and sends them together, several cooks of one kind included.
- Keeps the line moving: checks each piece as it comes back while the rest still cook, and never waits when something else could start.
- Never gives two cooks the same file or a shared one, and fixes the contract first for work that crosses front and back end.
- Picks the effort by difficulty up front: low for lookups, medium for well-specified building, the Senior Cook for hard work, Fable for the single hardest ticket.
- Writes each ticket in full: the goal, the files it may touch, the limits, and the check that proves it done.
- Sends prep cooks to every area at once, and checks one quoted line before trusting a summary.
- Reproduces a bug before fixing it, and gives a builder a cause, not just a symptom.
- Reruns a failed ticket once with more effort or with the Senior Cook, and takes over itself if that fails.
- Runs the Taster after build work, and the Health Inspector on risky or large changes.
- Treats a cook's report as a claim until the check output backs it up.
- Skips the kitchen for conversation, quick questions, and anything you ask it to do directly.

## What you see

The kitchen is a top-down pixel-art room. Each agent is a monkey that walks to the spot matching its current tool call:

| The agent is… | The monkey… |
|---|---|
| Reading a file | Goes to the recipe shelf |
| Searching (grep, glob) | Rummages in the pantry or fridge |
| Editing or writing | Works its own station: cutting board, grill, stove, pastry bench, sink, menu board, potatoes |
| Running a command | Cooks at its station (the Pastry Chef uses the oven, the Head Chef takes a stove) |
| Fetching from the web | Leaves by the back door and returns with a crate |
| Delegating (Head Chef) | Turns from the pass and calls the order |
| Finished | Carries a plate to the pass, then goes back on break |
| Waiting for your permission | The Head Chef waves at your table |

The Health Inspector patrols with a clipboard, a failed tool call smashes a plate, extra cooks of the same kind come in through the back door, and when the order is done the Head Chef rings the bell and your table gets its plate.

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

Start a new session, then open http://localhost:4747. The server starts itself on the first event and shuts down after twelve quiet hours.

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

Edit `brigade/head-chef.md` to change the routing rules, `agents/*.md` to change a cook, and `server/pricing.json` to change prices.

## How it works

```
Claude Code ──hooks──▶ scripts/hook.mjs ──POST /hook──▶ server/server.mjs ──SSE /events──▶ web/
```

- `hooks/hooks.json` registers the hooks. All but `SessionStart` run in the background, so they never hold up the session.
- `scripts/hook.mjs` relays each payload and starts the server if it isn't running. It always exits cleanly.
- `scripts/hook.mjs` stamps each payload with a random id and the time it ran, so the server drops repeats and late events can't reopen a finished cook.
- `server/server.mjs` turns hook payloads into kitchen state and pushes a snapshot to the page on every change. It listens on `127.0.0.1` only.
- `server/server.mjs` matches each ticket to a cook using the Agent tool's result, which names the cook's `agentId`. Until that arrives, the oldest unclaimed ticket for the same role is a guess.
- `server/usage.mjs` reads the session transcript and `subagents/agent-*.jsonl` beside it.

## Limits of the tab

- Prices are API list prices. On a subscription plan nothing is billed per token, so read the figures as relative weight.
- The cache-write prices and the Haiku cache-read price in `pricing.json` are assumptions; check them against the current price list.
- The "Head Chef alone" figure prices the same token counts at the main model's rate. A real solo run would use a different number of tokens, so treat it as a rough comparison.
- Older models in a transcript are priced at their tier's current rate.

## License

MIT
