/**
 * Fuzzy wake-name matching for the stt-tts lane (PHA-3428, tightened in PHA-3605).
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
 *
 * PHA-3605 added the guard rails a day of live logs asked for:
 *  - the first letter must agree ("next one", "stat on" no longer open a gate);
 *  - a joined word pair gets one edit, not two, and may not be shorter than the
 *    name ("be on", "sex to" no longer open a gate; "sex ton" still does);
 *  - aliases: exact spellings whisper is known to produce for a name
 *    ("sections", "sex and"), accepted without any edit budget;
 *  - exclusions: the other bot's names. A hearing at least as close to an
 *    excluded name as to one of ours is theirs, not ours ("bexton" is one edit
 *    from "sexton"; both bots used to answer it).
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
 * One edit per three characters, at least one, at most two, for a single word.
 *
 * Two is what "Sexton" needs: whisper's real hearings include "Saxton" and
 * "Sexin", both within two. A joined word pair gets one: two words that
 * together are two edits from the name are far more often two ordinary words
 * ("stat on", "sets on", "next one") than a name whisper split in half.
 */
function budgetFor(name: string, span: 1 | 2): number {
  const single = Math.max(1, Math.min(2, Math.round(name.length / 3)));
  return span === 1 ? single : Math.min(single, 1);
}

export type FuzzyWakeMatch = {
  /** The utterance with the matched name removed; may be empty. */
  text: string;
  /** The configured wake name that matched, not the mangled hearing. */
  activationName: string;
  /** What whisper actually produced, for the log. */
  heardAs: string;
};

export type FuzzyWakeOptions = {
  /**
   * Exact spellings (after normalization) that count as the first wake name.
   * "sections" and "sex and" are three edits from "sexton", past any sane
   * budget, yet they are what whisper base.en makes of the name in flowing
   * speech. Aliases carry no edit budget of their own: a budget on "sexin"
   * would let "sex to" back in through the side door.
   */
  aliases?: readonly string[] | undefined;
  /**
   * Names that are not ours -- the other bot in the channel. A hearing that
   * is at least as close to one of these as to one of our names is declined.
   */
  excludeNames?: readonly string[] | undefined;
};

export type FuzzyWakeResult = {
  match?: FuzzyWakeMatch;
  /**
   * Set when a candidate hearing was thrown out because it was as close or
   * closer to an excluded name, and nothing else matched: the configured
   * excluded name that won. For the `excludedBy=` field on the declined line.
   */
  excludedBy?: string;
};

type Candidate = { name: string; key: string };

function toCandidates(names: readonly string[]): Candidate[] {
  return names
    .map((name) => ({ name, key: normalize(name).replace(/\s+/g, "") }))
    .filter((candidate) => candidate.key.length >= 3);
}

type Best = { index: number; span: number; name: string; heard: string; distance: number };

/**
 * Find a configured wake name anywhere in a transcript, tolerating whisper's
 * spelling. `match` is undefined when nothing is close enough; `excludedBy`
 * names the other bot when that is the reason.
 */
export function evaluateFuzzyWakeName(
  transcript: string,
  wakeNames: readonly string[],
  options: FuzzyWakeOptions = {},
): FuzzyWakeResult {
  const words = normalize(transcript).split(" ").filter(Boolean);
  if (words.length === 0) return {};

  const candidates = toCandidates(wakeNames);
  const excluded = toCandidates(options.excludeNames ?? []);
  const aliasKeys = new Set(
    (options.aliases ?? [])
      .map((alias) => normalize(alias).replace(/\s+/g, ""))
      .filter((key) => key.length >= 3),
  );
  const aliasName = wakeNames.map((name) => name.trim()).find((name) => name.length > 0);
  if (candidates.length === 0 && (aliasKeys.size === 0 || !aliasName)) return {};

  let best: Best | undefined;
  let excludedBy: string | undefined;

  for (let i = 0; i < words.length; i += 1) {
    // span 1 catches "saxton"; span 2 catches "sex ton", which is what whisper
    // does with the name about a third of the time.
    for (const span of [1, 2] as const) {
      if (i + span > words.length) continue;
      const heard = words.slice(i, i + span).join(" ");
      const joined = heard.replace(/\s+/g, "");

      // An alias is an exact hearing; it wins outright.
      if (aliasName && aliasKeys.has(joined)) {
        if (!best || best.distance > 0) {
          best = { index: i, span, name: aliasName, heard, distance: 0 };
        }
        continue;
      }

      for (const candidate of candidates) {
        const budget = budgetFor(candidate.key, span);
        const distance = editDistance(joined, candidate.key, budget);
        if (distance > budget) continue;

        // Is it theirs? A tie goes to the other bot, because answering to its
        // name is worse than missing one hearing of our own. Checked before
        // the shape rules below so the log can say "excludedBy=Bexton" for
        // "bexton" itself, not just "declined".
        const rival = excluded.find(
          (other) => editDistance(joined, other.key, distance) <= distance,
        );
        if (rival) {
          excludedBy = excludedBy ?? rival.name;
          continue;
        }
        // Whisper mangles the middle and the end of a name, not its onset.
        if (joined[0] !== candidate.key[0]) continue;
        // A split name is not shorter than the name: "sex ton", never "sex to".
        if (span === 2 && joined.length < candidate.key.length) continue;
        if (!best || distance < best.distance) {
          best = { index: i, span, name: candidate.name, heard, distance };
        }
      }
    }
  }

  if (!best) {
    return excludedBy ? { excludedBy } : {};
  }
  const found: Best = best;
  const remainder = [...words.slice(0, found.index), ...words.slice(found.index + found.span)]
    .join(" ")
    .trim();
  return {
    match: { text: remainder, activationName: found.name, heardAs: found.heard },
  };
}

/**
 * `evaluateFuzzyWakeName` without the decline reason, for callers that only
 * want the match.
 */
export function matchFuzzyWakeName(
  transcript: string,
  wakeNames: readonly string[],
  options: FuzzyWakeOptions = {},
): FuzzyWakeMatch | undefined {
  return evaluateFuzzyWakeName(transcript, wakeNames, options).match;
}
