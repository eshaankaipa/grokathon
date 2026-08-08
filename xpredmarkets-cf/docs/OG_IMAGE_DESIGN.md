# Market OG Image Design

**Size:** 1200 × 630 (Open Graph / X card standard)
**Format:** SVG source of truth → rasterize to PNG at deploy/share time
**Brand:** X Prediction Markets (`@XPredMarkets`) — dark UI aligned with xpred.aidenhuang.com

---

## Goal

When a market is shared (X, iMessage, Discord, Slack), the preview card must answer in one glance:

1. **What is the market?** (question / name)
2. **What can I pick?** (options)
3. **What are the odds / payouts?** (implied probability + $1-at-resolution framing)

---

## Layout (single frame)

```
┌──────────────────────────────────────────────────────────────┐
│  [logo mark]  X PREDICTION MARKETS              OPEN · LIVE  │  header 72px
├──────────────────────────────────────────────────────────────┤
│                                                              │
│   Will Grokathon ship markets today?                         │  title block
│                                                              │  ~200px
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│   ┌─────────────────────┐    ┌─────────────────────┐         │
│   │  YES                │    │  NO                 │         │  option cards
│   │  66¢                │    │  34¢                │         │  ~220px
│   │  ████████████░░░░   │    │  ████░░░░░░░░░░░░   │         │
│   │  Pays $1.00 if yes  │    │  Pays $1.00 if no   │         │
│   └─────────────────────┘    └─────────────────────┘         │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  xpred.aidenhuang.com                    Vol 65 · Binary     │  footer 64px
└──────────────────────────────────────────────────────────────┘
```

### Regions (px from top-left)

| Region | Box | Content |
|--------|-----|---------|
| Header | y=0–72, full width | Brand left, status pill right |
| Title | y=96–280, x=64–1136 | Market question, up to 3 lines |
| Options | y=300–540 | Two equal cards (YES / NO) |
| Footer | y=566–630 | Site URL + meta (volume, type) |

**Safe margins:** 48–64px left/right so crop/safe zones on mobile previews don’t clip text.

---

## Visual system

### Color

| Token | Hex | Use |
|-------|-----|-----|
| `bg` | `#0A0A0B` | Canvas |
| `bg-elevated` | `#141416` | Option cards |
| `border` | `#27272A` | Card strokes |
| `text` | `#FAFAFA` | Title |
| `muted` | `#A1A1AA` | Labels, footer |
| `accent` | `#1D9BF0` | Brand / LIVE |
| `yes` | `#22C55E` | YES price + bar |
| `no` | `#EF4444` | NO price + bar |
| `yes-dim` | `#052E16` | YES card wash |
| `no-dim` | `#450A0A` | NO card wash |

Background: flat dark + soft radial blue/violet glow (same family as the site), low opacity so text stays crisp when compressed.

### Type

| Role | Spec |
|------|------|
| Brand | 22px, semibold, tracking wide, muted or accent |
| Status pill | 18px, uppercase, weight 600 |
| Question | 44–52px, bold, tight leading 1.15, max 3 lines, ellipsis if overflow |
| Option label | 22px, uppercase, tracking, muted→colored |
| Price | 72px, bold, tabular nums (`66¢` or `66%`) |
| Payout line | 20px, muted |
| Footer | 20px, muted |

Prefer system UI / Inter / SF Pro style geometric sans. **No decorative script.**

### Components

**Status pill** (header right)

| Market status | Label | Color |
|---------------|-------|-------|
| `open` | OPEN · LIVE | green border/text |
| `locked` | LOCKED | amber |
| `resolved` | RESOLVED · YES/NO | blue |
| `voided` | VOIDED | zinc |

**Option card**

- Rounded 20px, 1px border
- Left/top accent wash matching side
- Contents top→bottom: label → **big price** → probability bar → payout caption
- Price primary unit: **¢ per share** (implied prob × 100), with `%` as secondary or equal
- Payout always: `Pays $1.00 if {yes|no}` for binary play-money (1 credit = $1 framing on card)

**Probability bar**

- Full width inside card, 10px height, rounded
- Fill = `p_yes` or `p_no`
- Track `#27272A`, fill yes green / no red

---

## Data binding (dynamic fields)

| Field | Source | Display rules |
|-------|--------|----------------|
| `question` | `market.question` | Max ~90 chars shown; wrap 3 lines; truncate with `…` |
| `status` | `market.status` | Maps to pill |
| `resolution` | `market.resolution` | If resolved, show winning side on pill + dim losing card |
| `p_yes` / `p_no` | pools | Round to integer ¢ / % (banker’s or half-up) |
| `volume` | sum buy cost | `Vol 65` optional; omit if 0 |
| `brand` | fixed | `X PREDICTION MARKETS` |
| `url` | fixed | `xpred.aidenhuang.com` |

**Price formatting**

```
cents = round(p * 100)
show  "{cents}¢"   // primary
// optional small "{cents}%" under or beside
```

If resolved YES: YES card full emphasis, price → `$1.00`, NO → `$0.00`, bar full/empty.

---

## States

### 1. Open (default share card)

- Two live prices
- OPEN · LIVE pill
- Both cards equal weight

### 2. Locked

- Same as open but pill LOCKED
- Optional subtitle under title: `Trading closed — awaiting resolution`

### 3. Resolved

- Winning option: thick border, price `$1.00`, checkmark
- Losing option: opacity 0.45, price `$0.00`
- Pill: `RESOLVED · YES`

### 4. Voided

- Both options muted
- Center or footer: `Market voided · stakes refunded`

### 5. Long question

- Font steps down: 52 → 44 → 36 if needed
- Never overflow into option cards

---

## What not to put on the OG image

- User balances, API keys, wallet addresses
- Full trade history
- Tiny footnotes that won’t survive compression
- More than two options (v1 is binary only; multi-outcome = horizontal chip row later)
- Live sparklines (too noisy at 630px height when compressed)

---

## Implementation plan (later)

1. **SVG template** (`og-market.svg` or generated string) with placeholders.
2. Worker route: `GET /markets/:id/og.png` or `/og/markets/:id`
   - Load market from D1
   - Fill SVG
   - Rasterize (Workers: `@resvg/resvg-wasm`, or Cloudflare Images, or pre-render cache in R2)
3. HTML market page meta:

```html
<meta property="og:title" content="{question}" />
<meta property="og:description" content="YES {p}¢ · NO {q}¢ — trade on X Prediction Markets" />
<meta property="og:image" content="https://xpred.aidenhuang.com/markets/{id}/og.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
```

4. Cache: `Cache-Control: public, max-age=60` while open; immutable after resolve.

---

## Example content (mock)

| Field | Value |
|-------|--------|
| Question | Will Grokathon ship markets today? |
| YES | 66¢ · Pays $1.00 if yes |
| NO | 34¢ · Pays $1.00 if no |
| Status | OPEN · LIVE |
| Volume | 65 |

---

## Files

| File | Role |
|------|------|
| `docs/OG_IMAGE_DESIGN.md` | This spec |
| `docs/og-market-open.svg` | Open-state mock |
| `docs/og-market-resolved.svg` | Resolved-state mock |
| `docs/og-preview.html` | Side-by-side browser preview at 1× scale |
