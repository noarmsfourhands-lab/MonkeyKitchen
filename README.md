# 🐵 Monkey Kitchen

A Claude Code plugin that turns your session into a kitchen brigade of monkey chefs. The main session is the Head Chef; ten cooks on cheaper models take the tickets it hands out. A local page shows the kitchen live while you prompt as usual, with a running tab of what the work cost.

No API key and no dependencies. It needs Node 18 or newer.

## What it does

- **Routes work to the cheapest capable model.** At session start the plugin gives the Head Chef a short set of rules: which cook gets which kind of ticket, when to do the work itself, and when to escalate.
- **Shows the kitchen.** Hooks forward session events to a small local server, and the page at http://localhost:4747 animates whoever is working.
- **Keeps a tab.** Token counts per model tier are read from the session transcripts and priced at API list prices, next to an estimate of the same tokens at the Head Chef's price.

## The brigade

| Station | Agent | Model | Job |
|---|---|---|---|
| Head Chef | your main session | whatever you run (Fable recommended) | Splits the order, delegates, checks the plate |
| Sous Chef | `sous-chef` | Opus | Design decisions, plans, stubborn bugs (read-only) |
| Pastry Chef | `frontend-cook` | Sonnet | Front-end work |
| Grill Cook | `backend-cook` | Sonnet | Back-end work |
| Line Cook | `line-cook` | Sonnet | Other build work: scripts, config, tooling |
| Taster | `taster` | Sonnet | Runs tests and checks |
| Health Inspector | `inspector` | Sonnet | Independent code review (read-only) |
| Prep Cook | `prep-cook` | Haiku | Finds and reads code, returns summaries (read-only) |
| Runner | `runner` | Haiku | Web and docs lookups |
| Dishwasher | `dishwasher` | Haiku | Mechanical cleanup |
| Menu Scribe | `scribe` | Haiku | Docs for existing code |
| Stagiaire | any other agent | varies | Where agents from outside the brigade show up |

Cooks cannot spawn other cooks, so the Head Chef is the only one handing out tickets.

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
- `server/server.mjs` turns hook payloads into kitchen state and pushes a snapshot to the page on every change. It listens on `127.0.0.1` only.
- `server/usage.mjs` reads the session transcript and `subagents/agent-*.jsonl` beside it.

## Limits of the tab

- Prices are API list prices. On a subscription plan nothing is billed per token, so read the figures as relative weight.
- The cache-write prices and the Haiku cache-read price in `pricing.json` are assumptions; check them against the current price list.
- The "Head Chef alone" figure prices the same token counts at the main model's rate. A real solo run would use a different number of tokens, so treat it as a rough comparison.
- Older models in a transcript are priced at their tier's current rate.

## License

MIT
