# EarthOS design notes

One set of tokens (`frontend/src/index.css`), three surfaces with different jobs. Each surface borrows from a different
public design language (via the MIT-licensed [awesome-design-md](https://github.com/VoltAgent/awesome-design-md)
collection). These are references for tone only: no branding, logos or proprietary fonts are copied.

| Surface | Job | Reference | What we took |
|---|---|---|---|
| Map / explorer | A quiet instrument over a busy globe | IBM Carbon | Plex Sans + Plex Mono, hairline edges, 4–12 px corners, one accent, figures in mono |
| Landing, Methods, Backtest, About | Long reading, arguments with numbers | WIRED (editorial) | Serif headlines (Newsreader), rules instead of cards, newspaper columns, 65–70ch measure |
| Boot screen | Waking a free-tier server without looking broken | SpaceX (austere) | Near-black canvas, one ring, mono micro-label |

## Tokens

- **Type:** `--font-sans` IBM Plex Sans (UI and body), `--font-mono` IBM Plex Mono (coordinates, dates, scores, labels),
  `--font-serif` Newsreader (page headlines only).
- **Colour:** one cool grey family; a single desaturated ocean-teal accent (`--accent`, 5.6:1 on white) chosen so it
  never competes with the hazard colours (red / orange / yellow for susceptibility, magenta for forest loss). Data
  colours in charts are semantic and are not themed.
- **Radius:** `--r-sm` 4 px (badges), `--r-md` 8 px (controls), `--r-lg` 12 px (panels).
- **Shadow:** slate-tinted, with a 1 px hairline ring, so floating panels read on both imagery and dark space.

## Rules that are not negotiable

- The "Screening tool, not an official warning" line must stay fully visible at 375 px on every view (the phone
  status bar drops the wider mono face for this reason).
- Restyling never changes wording of disclaimers, uncertainty labels or the "not safe" / "cause unconfirmed" language.
- Motion is limited to transform/opacity/colour and is switched off under `prefers-reduced-motion`.
- Pages have a skip link, visible focus rings and an `aria-current` nav state (Vercel Web Interface Guidelines).
