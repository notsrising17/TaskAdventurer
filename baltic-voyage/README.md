# Baltic Voyage 🧭

An interactive, installable travel companion for a summer journey through the
Baltic: **Helsinki → Tallinn → Riga → Vilnius**.

It's a single-file Progressive Web App — no build step, no backend. Everything
you enter is stored privately on your own device (`localStorage`). Add it to your
phone's home screen and it works offline.

## Features

- **Trip** — at-a-glance overview with a live countdown and your four-city route.
- **Days** — a day-by-day itinerary you build and edit on the go.
- **Hotels** — every stay with check-in / check-out, confirmation numbers,
  address, phone (tap to call) and one-tap directions.
- **Places** — an interactive map (tap to drop a pin) plus a list of spots per
  city, with a curated set of starter sights you can keep or delete.
- **Tools**
  - 🎒 **Packing** checklist with progress.
  - 💬 **Phrasebook** for Finnish, Estonian, Latvian & Lithuanian (with
    pronunciation and tap-to-speak).
  - ⛅ **Weather** — live 4-day forecast per city (Open-Meteo, no API key).
  - 💶 **Currency** — all four countries use the euro; convert from your home
    currency with live rates (cached for offline).

## Design

A Baltic / Hanseatic palette — amber gold, Baltic teal, birch cream and
terracotta old-town roofs — with Art Nouveau touches as a nod to Riga, an
elegant Cormorant Garamond display face, and a hand-drawn sea-wave hero.

## Run it

It's fully static. Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8080
# then visit http://localhost:8080
```

For phone install, host it anywhere static (e.g. GitHub Pages) over HTTPS and
use **Add to Home Screen**.

## Privacy

All trip data lives only in your browser. Clearing site data removes it; nothing
is sent anywhere except the live weather and exchange-rate lookups.
