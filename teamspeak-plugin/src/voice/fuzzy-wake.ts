/**
 * Fuzzy wake-name matching for the stt-tts lane (PHA-3428).
 *
 * The SDK's `matchRealtimeVoiceActivationName` wants the name at the head or
 * tail of the utterance and spelled the way it is configured. Local whisper
 * base.en does not cooperate: "Sexton" comes back as "Saxton", "Section",
 * "sex ton", "Sex done", and it lands mid-sentence as often as not. Every one
 * of those is a person saying the bot's name, and the gate declining them is
 * the difference between a bot that answers and one that sits there.
 *
 * So: normalize, then compare the name against every word and every adjacent
 * word pair, with an edit-distance budget that scales with the name's length.
 * The matched span is removed so the agent is not handed its own name as the
 * question.
 */

/** Lowercase, drop punctuation, collapse whitespace. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Levenshtein distance, capped: we only ever care about "<= budget". */
export function editDistance(a: string, b: string, cap: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (row[j - 1] as number) + 1,
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
      row.push(value);
      if (value < best) best = value;
    }
    // Whole row already worse than the budget: no later row can recover.
    if (best > cap) return cap + 1;
    prev = row;
  }
  return prev[b.length] as number;
}

/**
 * One edit per three characters, at least one, at most two.
 *
 * Two is what "Sexton" needs: whisper's real hearings include "Section" and
 * "Sex done", both distance 2. Two edits on a six-letter name does invite the
 * occasional false open — "sector", "sextant" — which is why the follow-up
 * window below it is short rather than generous.
 */
function budgetFor(name: string): number {
  return Math.max(1, Math.min(2, Math.round(name.length / 3)));
}

export type FuzzyWakeMatch = {
  /** The utterance with the matched name removed; may be empty. */
  text: string;
  /** The configured wake name that matched, not the mangled hearing. */
  activationName: string;
  /** What whisper actually produced, for the log. */
  heardAs: string;
};

/**
 * Find a configured wake name anywhere in a transcript, tolerating whisper's
 * spelling. Returns undefined when nothing is close enough.
 */
export function matchFuzzyWakeName(
  transcript: string,
  wakeNames: readonly string[],
): FuzzyWakeMatch | undefined {
  const words = normalize(transcript).split(" ").filter(Boolean);
  if (words.length === 0) return undefined;

  const candidates = wakeNames
    .map((name) => ({ name, key: normalize(name).replace(/\s+/g, "") }))
    .filter((candidate) => candidate.key.length >= 3);
  if (candidates.length === 0) return undefined;

  let best: { index: number; span: number; name: string; heard: string; distance: number } | undefined;

  for (let i = 0; i < words.length; i += 1) {
    // span 1 catches "saxton"; span 2 catches "sex ton", which is what whisper
    // does with the name about a third of the time.
    for (const span of [1, 2] as const) {
      if (i + span > words.length) continue;
      const heard = words.slice(i, i + span).join(" ");
      const joined = heard.replace(/\s+/g, "");
      for (const candidate of candidates) {
        const distance = editDistance(joined, candidate.key, budgetFor(candidate.key));
        if (distance > budgetFor(candidate.key)) continue;
        if (!best || distance < best.distance) {
          best = { index: i, span, name: candidate.name, heard, distance };
        }
      }
    }
  }

  if (!best) return undefined;

  const remainder = [...words.slice(0, best.index), ...words.slice(best.index + best.span)]
    .join(" ")
    .trim();
  return { text: remainder, activationName: best.name, heardAs: best.heard };
}
