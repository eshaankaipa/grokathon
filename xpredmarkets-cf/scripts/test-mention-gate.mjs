/**
 * Local smoke test for the binary mention gate.
 * - Always runs deterministic unit checks (inline)
 * - If XAI_API_KEY is set, calls Grok on sample mentions
 *
 * Usage (from xpredmarkets-cf/):
 *   node --env-file=../.env scripts/test-mention-gate.mjs
 *   # or:
 *   export $(grep -v '^#' ../.env | xargs) && node scripts/test-mention-gate.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../..");

// Load ../.env manually if present
function loadEnv() {
  const candidates = [
    resolve(root, ".env"),
    resolve(__dirname, "../.env"),
    resolve(process.cwd(), ".env"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      if (m[1].startsWith("#")) continue;
      let v = m[2].trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (process.env[m[1]] == null) process.env[m[1]] = v;
    }
    console.log(`loaded env from ${p}`);
    break;
  }
}

loadEnv();

// --- inline deterministic checks (mirror binary_gate) ---
const YES_NO_OPENER =
  /^(will|is|are|does|did|has|have|can|could|would|should)\b/i;
const OPEN_ENDED =
  /^\s*(who|whom|whose|which|what|when|where|why|how(?:\s+many|\s+much|\s+long|\s+often)?)\b/i;
const OPEN_ENDED_INLINE =
  /\b(who will|who won|who wins|which (?:team|one|player|candidate|company)|what will|how many|how much)\b/i;
const SUBJECTIVE = /\b(best|worst|greatest|amazing|overrated|underrated|goat)\b/i;

function looksOpenEnded(t) {
  return OPEN_ENDED.test(t.trim()) || OPEN_ENDED_INLINE.test(t.trim());
}
function looksBinary(t) {
  const q = t.trim();
  if (looksOpenEnded(q)) return false;
  if (SUBJECTIVE.test(q)) return false;
  const withQ = q.endsWith("?") ? q : `${q}?`;
  return YES_NO_OPENER.test(withQ) && withQ.length >= 10;
}

const cases = [
  {
    name: "open-ended who wins",
    text: "@XPredMarkets who will win this hackathon",
    expectCreate: false,
  },
  {
    name: "open-ended which team",
    text: "which team is going to take the trophy @XPredMarkets",
    expectCreate: false,
  },
  {
    name: "subjective best",
    text: "@XPredMarkets is Grok the best model ever?",
    expectCreate: false,
  },
  {
    name: "clean binary named team",
    text: "@XPredMarkets Will team Grok win the hackathon?",
    expectCreate: true,
  },
  {
    name: "clean binary with date",
    text: "@XPredMarkets Will the Golden State Warriors defeat the Los Angeles Lakers on June 15, 2027?",
    expectCreate: true,
  },
  {
    name: "clean binary bitcoin",
    text: "@XPredMarkets Will Bitcoin close above $100,000 on December 31, 2026?",
    expectCreate: true,
  },
];

console.log("\n=== Deterministic pre-checks ===\n");
let failed = 0;
for (const c of cases) {
  const cleaned = c.text
    .replace(/@\w+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const open = looksOpenEnded(cleaned);
  const binary = looksBinary(cleaned);
  const wouldCreate = binary && !open;
  const ok = wouldCreate === c.expectCreate;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${c.name}\n` +
      `       cleaned=${JSON.stringify(cleaned)}\n` +
      `       openEnded=${open} binary=${binary} wouldCreate=${wouldCreate} expectedCreate=${c.expectCreate}`,
  );
  if (!ok) failed += 1;
}

// --- Live Grok gate ---
const apiKey = process.env.XAI_API_KEY;
if (!apiKey) {
  console.log("\n(no XAI_API_KEY — skipping live Grok calls)\n");
  process.exit(failed ? 1 : 0);
}

console.log("\n=== Live Grok assessMentionWithGrok ===\n");

const CATEGORIES = [
  "Sports",
  "Politics",
  "Tech",
  "Crypto",
  "Entertainment",
  "Science",
  "Other",
];

async function assess(text) {
  const cleaned = text
    .replace(/@XPredMarkets\b/gi, " ")
    .replace(/@\w+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const now = new Date().toISOString();
  const prompt = `You are a gatekeeper for a BINARY prediction-market bot (YES/NO only).

Decide whether this tweet can become ONE clean, objectively resolvable yes/no market.

decision must be exactly one of:
- CREATE — single verifiable YES/NO claim. Question starts with Will/Is/Are/Does/Has/Can and ends with ?.
- CLARIFY — real topic but not yes/no yet (who/which/what/how many, vague). Do NOT force a random binary rewrite into CREATE.
- REJECT — subjective, joke, already resolved, unverifiable, harmful.

Hard rules:
- NEVER CREATE for "who will win…", "which team…", "what will happen…", "how many…"
- NEVER CREATE subjective "best/worst" without an objective public metric
- DO CREATE when the user already wrote a clear Will/Is yes/no with a named subject, even if the event is informal (e.g. "Will team Grok win the hackathon?")
- On CLARIFY or REJECT, suggestions MUST be 2-3 valid yes/no alternatives close in spirit, each starting with Will/Is/Are and ending with ?, under 120 chars
- On CREATE, suggestions may be []

Tweet: ${cleaned}

Return ONLY JSON:
{"decision":"CREATE|CLARIFY|REJECT","reason":"","question":"","description":"","resolution_criteria":"","category":"Other","closes_at":"","suggestions":["",""]}`;

  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "grok-latest",
      messages: [
        {
          role: "system",
          content: `You gate binary prediction markets. Current UTC: ${now}. JSON only. Prefer CLARIFY over CREATE when unsure.`,
        },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`xAI ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const raw = json.choices?.[0]?.message?.content ?? "";
  return JSON.parse(raw);
}

for (const c of cases) {
  try {
    const out = await assess(c.text);
    const decision = String(out.decision || "").toUpperCase();
    const created = decision === "CREATE";
    // Open-ended must not create
    const ok = c.expectCreate ? created : !created;
    const suggestions = Array.isArray(out.suggestions) ? out.suggestions : [];
    console.log(
      `${ok ? "PASS" : "FAIL"}  [grok] ${c.name}\n` +
        `       decision=${decision}\n` +
        `       reason=${out.reason || ""}\n` +
        `       question=${out.question || "(none)"}\n` +
        `       suggestions=${JSON.stringify(suggestions)}`,
    );
    if (!ok) failed += 1;
    if (!c.expectCreate && suggestions.length === 0) {
      console.log("       WARN  expected suggestions for non-create");
    }
    // Simulate reply
    if (!created && suggestions.length) {
      const reply =
        "That isn't a yes/no market yet.\nTry one of these and tag me again:\n" +
        suggestions
          .slice(0, 2)
          .map((s) => `• ${s}`)
          .join("\n");
      console.log(`       reply (${reply.length} chars):\n${reply.split("\n").map((l) => "         " + l).join("\n")}`);
    }
  } catch (e) {
    console.log(`FAIL  [grok] ${c.name}: ${e.message}`);
    failed += 1;
  }
}

console.log(failed ? `\n${failed} failure(s)\n` : "\nAll checks passed\n");
process.exit(failed ? 1 : 0);
