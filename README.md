# Totem — friend-finding compass

A festival friend-finder PWA: a compass puck where every friend is a glowing
dot at their true direction. Built for terrible reception — the app shell,
your GPS, and the device compass all work with zero connectivity; positions
sync opportunistically in tiny payloads whenever any signal gets through.

**Use it:** https://philduggan88.github.io/totem/ — open in Safari/Chrome on
your phone and *Add to Home Screen*.

- **I am…** — pick who you are; your dot follows this phone's GPS.
- **⚑ Drop Totem** — pin a meet-up point at your current spot (works offline).
- **Ring / Radar** — tap the puck to switch between direction-only lights and
  a distance-scaled radar.
- **⚙ Sync** — point every phone at a shared sync worker + crew code for live
  dots (see `worker/` in the parent project). Friends can also install
  [OwnTracks](https://owntracks.org) (HTTP mode) for background updates while
  their phone is locked.
- **Export / Import crew** — share the crew setup (names, colors, sync
  settings travel by crew code) between phones as a JSON file.

No accounts, no tracking, no analytics. Positions only go to the sync worker
you deploy yourself, keyed by an unguessable crew code.
