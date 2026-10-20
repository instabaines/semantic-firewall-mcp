// Provenance of destination arguments.
//
// A call that sends data somewhere (an e-mail recipient, an IBAN, a URL, a user or
// channel) is suspicious when its destination did not come from the user and was
// not retrieved legitimately during the session. The proxy can check this itself:
//
//  - The issuer puts salted hashes of the prompt's word sequences (up to
//    MAX_NGRAM words) into the passport, so the proxy can test whether a value came
//    from the user without the passport carrying the prompt.
//  - The proxy indexes the word sequences of every tool result it forwards.
//  - A taint detector marks result segments that look like instructions to an AI;
//    values found only in such segments do not count as legitimately retrieved.
import { createHash } from "node:crypto";

export const MAX_NGRAM = 4;

const DESTINATION_ARG = /(recipient|iban|url|link|user|channel|email|participant|^to$|account|address|phone)/i;

// Lowercased word tokens; keeps characters that occur inside addresses and ids.
export function tokens(text) {
  return String(text ?? "").toLowerCase().match(/[a-z0-9@._+\-/:]+/g)?.map((t) => t.replace(/^[.:/-]+|[.:/-]+$/g, "")).filter(Boolean) ?? [];
}

function ngrams(words, max = MAX_NGRAM) {
  const out = new Set();
  for (let i = 0; i < words.length; i += 1) {
    for (let n = 1; n <= max && i + n <= words.length; n += 1) {
      out.add(words.slice(i, i + n).join(" "));
    }
  }
  return out;
}

const hashOf = (salt, value) => createHash("sha256").update(`${salt}\u0000${value}`).digest("base64url").slice(0, 16);

// Issuer side: the hashes that go into the passport (claim `user_values`).
export function promptValueHashes(prompt, salt) {
  return [...ngrams(tokens(prompt))].map((gram) => hashOf(salt, gram));
}

// A value is "user-provided" if its token sequence occurs in the prompt.
export function fromUser(value, userHashes, salt) {
  const words = tokens(value);
  if (words.length === 0 || words.length > MAX_NGRAM) return false;
  return new Set(userHashes).has(hashOf(salt, words.join(" ")));
}

// Splits a tool result into segments (sentences / lines / JSON fields) so taint can
// be assigned at a finer grain than the whole result.
export function segments(text) {
  return String(text ?? "").split(/(?<=[.!?])\s+|\n+|",\s*"|',\s*'/).map((s) => s.trim()).filter(Boolean);
}

function containsSequence(haystackWords, needleWords) {
  if (needleWords.length === 0) return false;
  outer: for (let i = 0; i + needleWords.length <= haystackWords.length; i += 1) {
    for (let j = 0; j < needleWords.length; j += 1) {
      if (haystackWords[i + j] !== needleWords[j]) continue outer;
    }
    return true;
  }
  return false;
}

// Session side: classify where a value appears in the observed results.
//   "data"          in at least one untainted segment
//   "injected-only" only in tainted segments
//   "novel"         nowhere
export function sessionProvenance(value, history, isTainted) {
  const needle = tokens(value);
  let seenTainted = false;
  for (const step of history || []) {
    for (const segment of segments(step.result)) {
      if (!containsSequence(tokens(segment), needle)) continue;
      if (isTainted(segment)) {
        seenTainted = true;
      } else {
        return "data";
      }
    }
  }
  return seenTainted ? "injected-only" : "novel";
}

export function destinationValues(args) {
  const out = [];
  for (const [key, value] of Object.entries(args || {})) {
    if (!DESTINATION_ARG.test(key)) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== null && item !== undefined && String(item).trim()) out.push(String(item).trim());
    }
  }
  return out;
}

// Verdict for one call. `isTainted(segment)` is the taint detector.
export function provenanceDecision({ call, userHashes, salt, history, isTainted }) {
  const values = destinationValues(call?.arguments);
  if (values.length === 0) {
    return { applicable: false, violation: false, labels: [] };
  }
  const labels = values.map((value) => (fromUser(value, userHashes, salt) ? "prompt" : sessionProvenance(value, history, isTainted)));
  const violation = labels.some((label) => label === "injected-only" || label === "novel");
  return { applicable: true, violation, labels };
}
