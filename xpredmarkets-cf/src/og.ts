/**
 * Dynamic 1200×630 market OG image (PNG via resvg).
 * Design: docs/OG_IMAGE_DESIGN.md
 */

import { initWasm, Resvg } from "@resvg/resvg-wasm";
// Static WASM import — wrangler precompiles (Workers block dynamic compile)
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import interFont from "./fonts/InterVariable.ttf";
import type { MarketView } from "./market";

/** Resvg needs a real font file; system UI fonts are not available in Workers. */
const FONT = "Inter, sans-serif";

let wasmInit: Promise<void> | null = null;

function ensureResvg(): Promise<void> {
  if (!wasmInit) {
    wasmInit = initWasm(resvgWasm as WebAssembly.Module);
  }
  return wasmInit;
}

function fontBytes(): Uint8Array {
  const asset: unknown = interFont;
  if (asset instanceof ArrayBuffer) {
    return new Uint8Array(asset);
  }
  if (asset instanceof Uint8Array) {
    return asset;
  }
  // Some bundlers wrap as { default: ArrayBuffer }
  const anyFont = asset as { buffer?: ArrayBuffer };
  if (anyFont?.buffer instanceof ArrayBuffer) {
    return new Uint8Array(anyFont.buffer);
  }
  throw new Error("Inter font asset failed to load");
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Approx average glyph width as fraction of font size (Inter bold). */
const CHAR_W = 0.58;

function wrapWords(
  words: string[],
  maxChars: number,
  maxLines: number,
): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= maxChars) {
      cur = next;
      continue;
    }
    if (cur) lines.push(cur);
    // Hard-break ultra-long tokens
    if (w.length > maxChars) {
      let rest = w;
      while (rest.length > maxChars && lines.length < maxLines) {
        lines.push(rest.slice(0, maxChars - 1) + "…");
        rest = rest.slice(maxChars - 1);
      }
      cur = rest;
    } else {
      cur = w;
    }
    if (lines.length >= maxLines) {
      cur = "";
      break;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  // Ellipsis if we still have leftover words
  if (lines.length >= maxLines) {
    const used = lines.join(" ").split(/\s+/).length;
    if (used < words.length) {
      const last = lines[lines.length - 1];
      lines[lines.length - 1] =
        last.length > 2 ? last.replace(/\s+\S*$/, "") + "…" : last + "…";
      if (lines[lines.length - 1].length > maxChars) {
        lines[lines.length - 1] = lines[lines.length - 1].slice(0, maxChars - 1) + "…";
      }
    }
  }
  return lines;
}

/**
 * Size title to fill the top band (left-aligned, large type).
 * Short titles scale up to nearly full width; long ones wrap at max size that fits.
 */
function layoutTitle(question: string): {
  lines: string[];
  fontSize: number;
  lineHeight: number;
  startY: number;
} {
  const raw = question.trim() || "Untitled market";
  const words = raw.split(/\s+/).filter(Boolean);
  const padX = 48;
  const contentW = 1200 - padX * 2; // 1104
  const bandTop = 36;
  const bandBottom = 296; // cards start 310
  const bandH = bandBottom - bandTop;
  const maxFont = 128;
  const minFont = 36;

  // Ideal single-line size from character count (fill width)
  const idealOneLine = Math.min(
    maxFont,
    Math.floor(contentW / (Math.max(raw.length, 1) * CHAR_W)),
  );

  // Try from large → small so we always pick the biggest that fits the band
  const sizes: number[] = [];
  for (let s = maxFont; s >= minFont; s -= 4) sizes.push(s);
  // Prefer starting near ideal for short titles
  sizes.sort((a, b) => {
    const da = Math.abs(a - Math.max(idealOneLine, 72));
    const db = Math.abs(b - Math.max(idealOneLine, 72));
    if (da !== db) return da - db;
    return b - a; // prefer larger when equidistant
  });
  // But we still need largest fit — re-scan descending
  const trySizes = Array.from(
    new Set([idealOneLine, ...sizes].filter((s) => s >= minFont && s <= maxFont)),
  ).sort((a, b) => b - a);

  for (const fontSize of trySizes) {
    const maxLines = fontSize >= 96 ? 2 : fontSize >= 64 ? 3 : 4;
    const maxChars = Math.max(10, Math.floor(contentW / (fontSize * CHAR_W)));
    const lineHeight = Math.round(fontSize * 1.05);
    const lines = wrapWords(words, maxChars, maxLines);
    // Prefer layouts that use most of the width on the longest line
    const longest = Math.max(...lines.map((l) => l.length), 1);
    const linePx = longest * fontSize * CHAR_W;
    const widthFill = linePx / contentW;
    const blockH = lines.length * lineHeight;
    if (blockH > bandH + 4) continue;
    // Accept if it fills enough width, or it's already small / multi-line
    if (widthFill >= 0.72 || lines.length >= 2 || fontSize <= idealOneLine + 4) {
      const startY =
        bandTop + Math.round((bandH - blockH) / 2) + fontSize * 0.82;
      return { lines, fontSize, lineHeight, startY };
    }
  }

  // Absolute fallback: force max width fill on one or more lines
  const fontSize = minFont;
  const lineHeight = Math.round(fontSize * 1.08);
  const maxChars = Math.floor(contentW / (fontSize * CHAR_W));
  const lines = wrapWords(words, maxChars, 4);
  return {
    lines,
    fontSize,
    lineHeight,
    startY: bandTop + fontSize * 0.9,
  };
}

function cents(p: number): number {
  return Math.round(Math.min(1, Math.max(0, p)) * 100);
}

/**
 * Minimal OG: market name + YES/NO odds + payout only.
 */
export function renderMarketOgSvg(market: MarketView): string {
  const { lines, fontSize, lineHeight, startY } = layoutTitle(market.question);
  const resolved = market.status === "resolved";
  const voided = market.status === "voided";
  const winnerYes = resolved && market.resolution === "yes";
  const winnerNo = resolved && market.resolution === "no";

  let pYes = market.p_yes;
  let pNo = market.p_no;
  if (winnerYes) {
    pYes = 1;
    pNo = 0;
  } else if (winnerNo) {
    pYes = 0;
    pNo = 1;
  }

  const yesCents = cents(pYes);
  const noCents = cents(pNo);

  const yesOdds = resolved
    ? winnerYes
      ? "$1.00"
      : "$0.00"
    : voided
      ? "—"
      : `${yesCents}¢`;
  const noOdds = resolved
    ? winnerNo
      ? "$1.00"
      : "$0.00"
    : voided
      ? "—"
      : `${noCents}¢`;

  const yesPay = resolved
    ? winnerYes
      ? "Pays $1.00"
      : "Pays $0.00"
    : voided
      ? "Refund"
      : "Pays $1.00 if yes";
  const noPay = resolved
    ? winnerNo
      ? "Pays $1.00"
      : "Pays $0.00"
    : voided
      ? "Refund"
      : "Pays $1.00 if no";

  const yesOpacity = resolved && !winnerYes ? "0.45" : "1";
  const noOpacity = resolved && !winnerNo ? "0.45" : "1";
  const yesStroke = winnerYes ? "#22c55e" : "#27272a";
  const yesStrokeW = winnerYes ? "3" : "1.5";
  const noStroke = winnerNo ? "#ef4444" : "#27272a";
  const noStrokeW = winnerNo ? "3" : "1.5";

  const titleTspans = lines
    .map((line, i) => {
      const dy = i === 0 ? 0 : lineHeight;
      return `<tspan x="48" dy="${dy}">${esc(line)}</tspan>`;
    })
    .join("");

  // Tight tracking on huge titles so they use the width
  const tracking =
    fontSize >= 100 ? "-2.5" : fontSize >= 80 ? "-1.8" : fontSize >= 64 ? "-1" : "0";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${esc(market.question)}">
  <defs>
    <radialGradient id="glowL" cx="15%" cy="0%" r="55%">
      <stop offset="0%" stop-color="#1e3a5f" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="#1e3a5f" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowR" cx="95%" cy="10%" r="45%">
      <stop offset="0%" stop-color="#3b0764" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#3b0764" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="yesWash" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#052e16" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#141416" stop-opacity="0.3"/>
    </linearGradient>
    <linearGradient id="noWash" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#450a0a" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="#141416" stop-opacity="0.3"/>
    </linearGradient>
  </defs>

  <rect width="1200" height="630" fill="#0a0a0b"/>
  <rect width="1200" height="630" fill="url(#glowL)"/>
  <rect width="1200" height="630" fill="url(#glowR)"/>

  <!-- Market name: left-aligned, auto-scaled to fill top band -->
  <text x="48" y="${startY}" text-anchor="start" font-family="${FONT}" font-size="${fontSize}" font-weight="700" letter-spacing="${tracking}" fill="#fafafa">
    ${titleTspans}
  </text>

  <!-- YES -->
  <g transform="translate(48, 310)" opacity="${yesOpacity}">
    <rect width="540" height="250" rx="24" fill="#141416" stroke="${yesStroke}" stroke-width="${yesStrokeW}"/>
    <rect width="540" height="250" rx="24" fill="url(#yesWash)"/>
    <text x="40" y="56" font-family="${FONT}" font-size="26" font-weight="700" letter-spacing="3" fill="#22c55e">YES</text>
    <text x="40" y="145" font-family="${FONT}" font-size="80" font-weight="700" fill="#fafafa">${esc(yesOdds)}</text>
    <rect x="40" y="172" width="468" height="14" rx="7" fill="#27272a"/>
    <rect x="40" y="172" width="${Math.max(0, Math.round(468 * (yesCents / 100)))}" height="14" rx="7" fill="#22c55e"/>
    <text x="40" y="220" font-family="${FONT}" font-size="24" font-weight="500" fill="#a1a1aa">${esc(yesPay)}</text>
  </g>

  <!-- NO -->
  <g transform="translate(612, 310)" opacity="${noOpacity}">
    <rect width="540" height="250" rx="24" fill="#141416" stroke="${noStroke}" stroke-width="${noStrokeW}"/>
    <rect width="540" height="250" rx="24" fill="url(#noWash)"/>
    <text x="40" y="56" font-family="${FONT}" font-size="26" font-weight="700" letter-spacing="3" fill="#ef4444">NO</text>
    <text x="40" y="145" font-family="${FONT}" font-size="80" font-weight="700" fill="#fafafa">${esc(noOdds)}</text>
    <rect x="40" y="172" width="468" height="14" rx="7" fill="#27272a"/>
    <rect x="40" y="172" width="${Math.max(0, Math.round(468 * (noCents / 100)))}" height="14" rx="7" fill="#ef4444"/>
    <text x="40" y="220" font-family="${FONT}" font-size="24" font-weight="500" fill="#a1a1aa">${esc(noPay)}</text>
  </g>
</svg>
`;
}

export async function marketOgResponse(
  market: MarketView,
  format: "png" | "svg" = "png",
): Promise<Response> {
  const svg = renderMarketOgSvg(market);
  const resolved =
    market.status === "resolved" || market.status === "voided";
  const cacheControl = resolved
    ? "public, max-age=86400, immutable"
    : "public, max-age=60";

  if (format === "svg") {
    return new Response(svg, {
      status: 200,
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": cacheControl,
        "access-control-allow-origin": "*",
      },
    });
  }

  await ensureResvg();
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 1200 },
    background: "#0a0a0b",
    font: {
      fontBuffers: [fontBytes()],
      defaultFontFamily: "Inter",
      defaultFontSize: 16,
      sansSerifFamily: "Inter",
    },
  });
  const png = resvg.render().asPng();

  return new Response(Uint8Array.from(png), {
    status: 200,
    headers: {
      "content-type": "image/png",
      "cache-control": cacheControl,
      "access-control-allow-origin": "*",
    },
  });
}
