# Expedition — one shared run

The five-campaign milestone system is replaced by a single shared weekly
expedition. The party travels together; any rep in any domain moves everyone,
and the character whose domain earned it leads the animation beat. Class
identity survives in the art. Domain status chips still carry the per-area
signal in QUESTS.

## League math (the contract)

| Event | Leagues |
|---|---|
| Habit hit | 1 |
| Quest complete | 2 |
| Quest complete, due this week | 3 (2 + 1 punctuality bonus) |
| Tavern sorting / tavern completion | 0 |

- Habits earn a full, legible unit — repeatable actions are the engine,
  quests are guests. Never fractional leagues; "LEAGUE 17" must stay one
  readable number.
- **Crit = a multiplier, not a flat bonus.** A crit doubles that event's
  league value (habit 1→2, due-quest 3→6).
- Crit rate: base ~10%, +3% per LUCKY CHARM tier (two tiers), hard cap 16%.
  Pity timer unchanged: force-crit at 15 misses.
- **Undo subtracts exactly what was granted** via a current-week ledger,
  floor 0.
- Week target: ~20–35 leagues for a decent week (15–25 habit hits + 2–4
  quests). A mediocre week (~20 leagues) must afford the first Outfitter
  purchase.

## Landmarks

- Every **5 leagues** — at 25 a typical week starves the reinforcement loop;
  at 5 a decent week hits four to six small ceremonies.
- Cosmetic variety (waystone, bridge, shrine, village) seeded from the week
  string — the same week always rolls the same route.
- Each landmark banks **+3 gold** for week's end (+2 with PACK MULE).

## Gold and the Outfitter

Gold is a new currency. Campfire tokens are NOT renamed or merged — they
stay exactly as they are (streak repair, cap 2); one shop item grants one.
The milestone system is replaced by the Outfitter. All effects route through
one `EXPEDITION.mods`-style derivation.

| Item | Cost | Effect |
|---|---|---|
| TRAILHEAD I / II / III | 15 / 40 / 90 | start each run at +3 / +6 / +10 leagues |
| LUCKY CHARM I / II | 25 / 60 | +3% crit per tier, 16% cap |
| PACK MULE | 20 | landmark bonus +2 gold |
| CAMPFIRE KIT | 10 | +1 campfire token, respects cap of 2 |
| BANNERS & GEAR (≥3 items) | 10–30 | cosmetic |

## Route view (side-scroller, replaces the world map)

- No tileset: ground band, sky band, the good sprites walking, small
  landmark markers. The clashing terrain layer is deleted, not fixed.
  (Anchored scenes are deferred — they can become camp vignettes later;
  build nothing for them now.)
- All five sprites walk as a loose cluster; the domain that earned the
  leagues leads the step animation.
- Camera follows the party; swipe to peek ahead; snaps back.
- Quests due this week show as waypoints ahead (clear them for bonus
  leagues, walk past them for free). **Debt never appears on the route** —
  overdue quests do not become obstacles; the route only ever shows
  possibility. The QUESTS list and MAKE CAMP keep handling debt.
- Personal best shows ahead as the FARTHEST CAMP flag.

## Rollover ceremony

- Fires **once**, on first open in a new ISO week, before the normal view.
- "THE EXPEDITION RETURNS — 27 LEAGUES, 5 LANDMARKS. +42 GOLD," then
  "A NEW ROUTE AWAITS," with a button into the Outfitter and a dismiss.
- Modal card (same pattern as MAKE CAMP), not a long animated sequence.
- Zero-rep week shows only "THE PARTY RESTED. A NEW ROUTE AWAITS." —
  no numbers, no red, nothing else, ever. The quietest copy in the app.
- Guard against double-firing. This is the single most-felt moment in the
  loop — verify on a real Monday.

## Migration (schema v5)

- Legacy milestones convert at **25 gold each**, celebrated once — founding
  wealth, not zero.
- This week's existing completions seed as leagues one-time, so the party
  is already mid-route on ship day.

## Build order

Smoke tests for league math and rollover are REQUIRED before any rendering
work starts. Then: engine + migration → Outfitter + ceremony → route view.
The acceptance behaviors above are the contract.
