function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, " ").trim();
}
function editDistance(a, b, cap) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        row[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost
      );
      row.push(value);
      if (value < best) best = value;
    }
    if (best > cap) return cap + 1;
    prev = row;
  }
  return prev[b.length];
}
function budgetFor(name, span) {
  const single = Math.max(1, Math.min(2, Math.round(name.length / 3)));
  return span === 1 ? single : Math.min(single, 1);
}
function toCandidates(names) {
  return names.map((name) => ({ name, key: normalize(name).replace(/\s+/g, "") })).filter((candidate) => candidate.key.length >= 3);
}
function evaluateFuzzyWakeName(transcript, wakeNames, options = {}) {
  const words = normalize(transcript).split(" ").filter(Boolean);
  if (words.length === 0) return {};
  const candidates = toCandidates(wakeNames);
  const excluded = toCandidates(options.excludeNames ?? []);
  const aliasKeys = new Set(
    (options.aliases ?? []).map((alias) => normalize(alias).replace(/\s+/g, "")).filter((key) => key.length >= 3)
  );
  const aliasName = wakeNames.map((name) => name.trim()).find((name) => name.length > 0);
  if (candidates.length === 0 && (aliasKeys.size === 0 || !aliasName)) return {};
  let best;
  let excludedBy;
  for (let i = 0; i < words.length; i += 1) {
    for (const span of [1, 2]) {
      if (i + span > words.length) continue;
      const heard = words.slice(i, i + span).join(" ");
      const joined = heard.replace(/\s+/g, "");
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
        const rival = excluded.find(
          (other) => editDistance(joined, other.key, distance) <= distance
        );
        if (rival) {
          excludedBy = excludedBy ?? rival.name;
          continue;
        }
        if (joined[0] !== candidate.key[0]) continue;
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
  const found = best;
  const remainder = [...words.slice(0, found.index), ...words.slice(found.index + found.span)].join(" ").trim();
  return {
    match: { text: remainder, activationName: found.name, heardAs: found.heard }
  };
}
function matchFuzzyWakeName(transcript, wakeNames, options = {}) {
  return evaluateFuzzyWakeName(transcript, wakeNames, options).match;
}
export {
  editDistance,
  evaluateFuzzyWakeName,
  matchFuzzyWakeName
};
