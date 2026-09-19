/**
 * The house band's sound, and the way it gets introduced (PHA-3554).
 *
 * Bexton "composes": the agent writes the title and the lyrics, and this
 * module turns the room's request into the two prompts a music generator
 * wants — a short style field that leads with genre and instruments (MiniMax
 * weights the first clause hardest) and a Suno-shaped tag line with the
 * band-leader vocal in front when the song has a singer — plus the line the
 * band leader says over the mic before the count-in.
 *
 * Everything here is deterministic given the `rng`, which is what the tests
 * hand in. Variation is the point (Brandon: "a lot of good variation ... like
 * those long running bands on SNL, Conan"), so the base sound is fixed and
 * the accents, the mood reading and the announcement are drawn per song. The
 * extra keywords are deliberately rationed ("random keywords (dont overuse)").
 */

export const DEFAULT_BAND_NAME = "The Velvet Vice Lounge Band";

/**
 * The band's other billing (Brandon, 2026-09-18: "additional names for bexton:
 * sgt. bexton and the digital heart club band"). The primary name gets most of
 * the introductions; an alias gets the rest, so the room hears both.
 */
export const DEFAULT_BAND_ALIASES: readonly string[] = [
  "Sgt. Bexton and the Digital Heart Club Band",
];

/**
 * Who sings. The band has two leads (Brandon, 2026-09-18: "Trixie from The
 * Ballad of Topher Based as a singer choice as well. so male or female lead").
 *
 * - `bexton`: the band leader himself.
 * - `trixie`: the Velvet Vice's waitress. In the Ballad she has the album's
 *   second track ("Half for Later") and the duet with Rotten Johnny; painted
 *   brows, gum, cheap perfume, and sharper than the act suggests.
 */
export type BandSinger = "bexton" | "trixie";

export const BAND_SINGERS: readonly BandSinger[] = ["bexton", "trixie"];

/** The vocal, when the request wants a singer. Goes in FRONT of the style. */
export const BAND_VOCAL_PREFIX =
  "one weathered male band-leader crooner, velvet baritone gone to gravel, martini-dry delivery, spoken-word patter between sung lines, addresses the room by name";

/** Trixie's vocal. Same slot, in front of the style. */
export const TRIXIE_VOCAL_PREFIX =
  "one female lead, a wasteland torch singer from the Velvet Vice, smoky mezzo with a gum-snapping brassy edge, world-weary and tender underneath, cheap-glamour diner-waitress swagger, half-spoken asides to the room, a Chip Mates half-for-later ache in the held notes";

export const BAND_VOCAL_PREFIXES: Readonly<Record<BandSinger, string>> = {
  bexton: BAND_VOCAL_PREFIX,
  trixie: TRIXIE_VOCAL_PREFIX,
};

export function readSinger(value: string | undefined): BandSinger {
  const wanted = value?.trim().toLowerCase();
  if (!wanted) {
    return "bexton";
  }
  if (/\b(trixie|female|woman|girl|her|she)\b/u.test(wanted)) {
    return "trixie";
  }
  return "bexton";
}

/** The MiniMax-shaped base: genre first, instruments second, everything else after. */
export const BAND_STYLE_GENRE = "Vintage lounge jazz, big band vaudeville with rat-pack swagger.";

export const BAND_INSTRUMENTS = [
  "upright bass",
  "brushed drums",
  "muted trumpet",
  "trombone slides",
  "vibraphone",
  "honky-tonk piano",
  "baritone sax",
  "horn stabs",
  "finger snaps",
] as const;

/** Tempo / structure accents. One per song. */
export const BAND_STRUCTURES = [
  "Slinky burlesque tempo, stop-time breaks, building to a brassy full-band finale.",
  "Slinky burlesque tempo with stop-time breaks, dramatic swells, a razzle-dazzle full-band finish and a cold quiet button.",
  "Mid-tempo strut, call-and-answer horns, a drum break, then a shout chorus to close.",
  "Slow-burn intro on bass and brushes, the horns arrive late, one long swell into a big brassy ending.",
  "Up-tempo jump swing, double-time shout chorus, a stop-time break for the band leader, then a tag ending.",
  "Loose lounge shuffle, a vibraphone solo in the middle, the whole band back in for a stomping last chorus.",
] as const;

/** The room. One per song. */
export const BAND_ROOMS = [
  "Smoky, cocky, worn-in, a house band in a post-apocalyptic strip club. Warm analog room sound.",
  "Warm dusty analog room sound, glasses clinking, a half-empty crowd.",
  "Warm analog room sound, close-miked horns, a small crowd that has heard this set before.",
  "Worn velvet and ruin, a room that smells like gin, warm tape saturation.",
] as const;

/** Rationed. At most two per song, and often none. */
export const BAND_KEYWORDS = [
  "smoky post-war lounge house band in a velvet-and-ruin strip club",
  "1920s vaudeville big band crossed with rat-pack sleaze",
  "walking upright bass, brushed swing drums, finger snaps",
  "sleazy muted trumpet, greasy trombone slides",
  "one wailing baritone sax, stabbing horn hits",
  "confident, cocky, slightly drunk, a band that's played this room every night for ten years",
  "dramatic swells and a cold quiet button",
  "a razzle-dazzle full-band finish",
  // From The Ballad of Topher Based: the Velvet Vice is a New Roswell strip club
  // in Fallout: New Mexico, and this is its house band.
  "the house band of the Velvet Vice, a strip club in New Roswell, Fallout New Mexico wasteland lounge",
  "post-apocalyptic cabaret, a ghoul bartender polishing glasses, a nail-studded bat under the counter",
] as const;

/**
 * How the band reads the room. The first matching row wins, and the
 * `style` clause slots in after the instruments — before the room sound, so
 * it still lands inside the part of the prompt the generator weights.
 */
export const BAND_MOODS: readonly { id: string; match: RegExp; style: string; tags: string }[] = [
  {
    id: "mournful",
    match: /\b(sad|blue|mourn|funeral|breakup|broke up|heartbr|miss(ing)?|lonely|goodbye|rip|dead|died)\b/iu,
    style: "Slow and mournful, muted trumpet lead over brushes only, wistful, late-night, restrained until the last chorus.",
    tags: "slow, mournful, torch song, muted trumpet, brushes",
  },
  {
    id: "celebration",
    match: /\b(birthday|party|celebrat|congrat|anniversar|promotion|won|winner|champion|cheers|wedding)\b/iu,
    style: "Celebratory and brassy, champagne-pop stop-time hits, the crowd whoops, a big triumphant finale.",
    tags: "celebratory, brassy, big finish, crowd noise",
  },
  {
    id: "menace",
    match: /\b(angry|anger|revenge|hate|fight|threat|menac|villain|evil|dark|kill|war)\b/iu,
    style: "Menacing and low, baritone sax growl, snarling brass, a slow stalking tempo that erupts at the end.",
    tags: "menacing, dark, low brass, slow burn",
  },
  {
    id: "romance",
    match: /\b(love|romance|romantic|kiss|crush|date|valentine|baby|darling|sexy)\b/iu,
    style: "Slinky and late-night, vibraphone shimmer, whispered brushes, the trumpet stays muted and close.",
    tags: "slinky, romantic, late night, vibraphone",
  },
  {
    id: "drunk",
    match: /\b(drunk|wasted|hungover|hangover|beer|whisk(e)?y|tequila|shots|bourbon|gin)\b/iu,
    style: "Sloppy and loose, half a beat behind, slurred trombone, a piano that keeps falling over itself, big and happy.",
    tags: "loose, sloppy, drunk swing, slurred trombone",
  },
  {
    id: "jump",
    match: /\b(fast|upbeat|dance|hype|energy|energetic|banger|wild|party time|pump)\b/iu,
    style: "Up-tempo jump swing, double-time shout chorus, the drummer is working, stop-time break, big tag ending.",
    tags: "up-tempo, jump swing, shout chorus, high energy",
  },
  {
    id: "roast",
    match: /\b(roast|diss|insult|make fun|mock|loser|idiot|dumb|stupid|sucks)\b/iu,
    style: "Cocky and sneering, sleazy muted trumpet commentary, trombone laughs, a vaudeville rimshot feel.",
    tags: "cocky, vaudeville, comedic, rimshots",
  },
];

/** The stock intro. Weighted toward the canonical line. */
const ANNOUNCEMENT_TEMPLATES: readonly { weight: number; text: string }[] = [
  { weight: 5, text: "Ladies and gentlemen, {band}!" },
  { weight: 3, text: "Ladies and gentlemen, {band}. This one's called {title}." },
  { weight: 2, text: "Ladies and gentlemen. {band}." },
  { weight: 2, text: "Once again, for the tenth year running, {band}." },
  { weight: 2, text: "{requester} asked for this. We don't know why either. {band}." },
  { weight: 2, text: "Alright. {title}. Nobody talk over the bridge this time. {band}!" },
  { weight: 1, text: "Ladies and gentlemen, and {requester}, {band}." },
  { weight: 1, text: "Fresh off a two-minute rehearsal, {band}." },
  { weight: 1, text: "Put your drinks down. Or don't. {band}." },
  { weight: 1, text: "The band would like it noted they had other plans tonight. {title}. Hit it." },
  { weight: 1, text: "For {dedicatee}, who did not ask for this. {band}." },
];

/** When Trixie takes the mic. She is billed; the band leader still does the talking. */
const TRIXIE_ANNOUNCEMENT_TEMPLATES: readonly { weight: number; text: string }[] = [
  { weight: 4, text: "Ladies and gentlemen, {band}, with Trixie on the mic." },
  { weight: 3, text: "Ladies and gentlemen, Trixie. Put the trays down, doll. {band}." },
  { weight: 2, text: "Off the floor and onto the stage, our own Trixie, with {band}. This one's called {title}." },
  { weight: 2, text: "Trixie's off shift for three minutes. Nobody order anything. {band}." },
  { weight: 2, text: "{requester} asked for the girl. Fine. Trixie, with {band}." },
  { weight: 1, text: "Half now, half for later. Trixie, and {band}." },
  { weight: 1, text: "For {dedicatee}. Trixie's singing it, so behave. {band}." },
  { weight: 1, text: "Same room, same band, different voice. Trixie. {title}. Hit it." },
];

/** What the leader says when the band cannot deliver. In character, not an error dump. */
const FAILURE_TEMPLATES: readonly string[] = [
  "The band's out back and they're not coming in. Try me again in a minute.",
  "No song. The horn section walked. Ask again later.",
  "That one's not happening tonight. The piano player's asleep on the keys.",
  "Rehearsal fell apart. Give it a minute and ask again.",
];

const MAX_STYLE_CHARS = 600;
const MAX_TAGS_CHARS = 500;

export type Rng = () => number;

export type BandVibeRequest = {
  /** What the room asked for, in the agent's words. */
  brief: string;
  /** Explicit mood, if the agent read one. Otherwise it is read from the brief. */
  mood?: string | undefined;
  /** Does the song have a singer? The vocal prefix goes on when it does. */
  vocals: boolean;
  /** Which lead, when it has one. Defaults to the band leader. */
  singer?: BandSinger | undefined;
};

export type BandVibe = {
  /** Short, genre-first, MiniMax-shaped. */
  style: string;
  /** Suno-shaped tag line, vocal prefix first when singing. */
  styleTags: string;
  /** Which mood row fired, for the log. */
  mood: string;
  /** The rationed keywords that went in, for the log. */
  keywords: string[];
  /** Who is on the mic, or undefined for an instrumental. */
  singer: BandSinger | undefined;
};

export function buildBandVibe(request: BandVibeRequest, rng: Rng = Math.random): BandVibe {
  const mood = readMood(request.mood, request.brief);
  const instruments = pickInstruments(rng);
  const structure = pick(BAND_STRUCTURES, rng);
  const room = pick(BAND_ROOMS, rng);
  const keywords = pickKeywords(rng);
  const singer = request.vocals ? (request.singer ?? "bexton") : undefined;

  const style = clip(
    [
      BAND_STYLE_GENRE,
      `${capitalize(instruments.join(", "))}.`,
      mood?.style ?? structure,
      mood ? structure : undefined,
      room,
      keywords.length ? `${capitalize(keywords.join("; "))}.` : undefined,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" "),
    MAX_STYLE_CHARS,
  );

  const styleTags = clip(
    [
      singer ? BAND_VOCAL_PREFIXES[singer] : "instrumental, no vocals",
      "vintage lounge jazz, big band vaudeville, rat-pack swagger",
      instruments.join(", "),
      mood?.tags,
      "burlesque tempo, stop-time breaks, brassy finale, warm analog room",
      ...keywords,
    ]
      .filter((part): part is string => Boolean(part))
      .join("; "),
    MAX_TAGS_CHARS,
  );

  return { style, styleTags, mood: mood?.id ?? "house", keywords, singer };
}

export type BandAnnouncementRequest = {
  title: string;
  bandName?: string | undefined;
  /** Other billings the band goes by; each gets a quarter of the primary's weight. */
  bandAliases?: readonly string[] | undefined;
  requestedBy?: string | undefined;
  dedicatedTo?: string | undefined;
  /** Who is singing; Trixie gets her own billing. */
  singer?: BandSinger | undefined;
};

/** The line over the mic before the count-in. */
export function buildBandAnnouncement(
  request: BandAnnouncementRequest,
  rng: Rng = Math.random,
): string {
  const band = pickBandName(request, rng);
  const requester = request.requestedBy?.trim();
  const dedicatee = request.dedicatedTo?.trim();
  const templates = request.singer === "trixie" ? TRIXIE_ANNOUNCEMENT_TEMPLATES : ANNOUNCEMENT_TEMPLATES;
  const candidates = templates.filter((template) => {
    if (template.text.includes("{requester}") && !requester) {
      return false;
    }
    if (template.text.includes("{dedicatee}") && !dedicatee) {
      return false;
    }
    return true;
  });
  const chosen = pickWeighted(candidates, rng);
  return chosen.text
    .replaceAll("{band}", band)
    .replaceAll("{title}", quoteTitle(request.title))
    .replaceAll("{requester}", requester ?? "")
    .replaceAll("{dedicatee}", dedicatee ?? "");
}

/** What the leader says when the generator let the room down. */
export function buildBandFailureLine(rng: Rng = Math.random): string {
  return pick(FAILURE_TEMPLATES, rng);
}

/** A song title from a brief, for when the agent forgot to name it. */
export function titleFromBrief(brief: string): string {
  const words = brief
    .replace(/[^\p{Letter}\p{Number}\s']+/gu, " ")
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 5);
  if (words.length === 0) {
    return "Untitled Number";
  }
  return words.map(capitalize).join(" ");
}

// --- internals ---------------------------------------------------------------

/** Primary name at weight 4, every alias at weight 1. */
function pickBandName(request: BandAnnouncementRequest, rng: Rng): string {
  const primary = request.bandName?.trim() || DEFAULT_BAND_NAME;
  const aliases = (request.bandAliases ?? DEFAULT_BAND_ALIASES)
    .map((alias) => alias.trim())
    .filter((alias) => alias && alias !== primary);
  return pickWeighted(
    [{ weight: 4, name: primary }, ...aliases.map((name) => ({ weight: 1, name }))],
    rng,
  ).name;
}

function readMood(explicit: string | undefined, brief: string) {
  const wanted = explicit?.trim().toLowerCase();
  if (wanted) {
    const byId = BAND_MOODS.find((mood) => mood.id === wanted);
    if (byId) {
      return byId;
    }
    const byMatch = BAND_MOODS.find((mood) => mood.match.test(wanted));
    if (byMatch) {
      return byMatch;
    }
  }
  return BAND_MOODS.find((mood) => mood.match.test(brief));
}

/** The core four always play; the rest of the band shows up in a random order and number. */
function pickInstruments(rng: Rng): string[] {
  const core = ["upright bass", "brushed drums", "muted trumpet", "baritone sax"];
  const rest = shuffle(
    BAND_INSTRUMENTS.filter((instrument) => !core.includes(instrument)),
    rng,
  );
  const extra = 2 + Math.floor(rng() * (rest.length - 1)); // 2..rest.length
  return [...core, ...rest.slice(0, extra)];
}

/** 0 keywords 45% of the time, 1 keyword 40%, 2 keywords 15%. Never more. */
function pickKeywords(rng: Rng): string[] {
  const roll = rng();
  const count = roll < 0.45 ? 0 : roll < 0.85 ? 1 : 2;
  return shuffle([...BAND_KEYWORDS], rng).slice(0, count);
}

function pick<T>(items: readonly T[], rng: Rng): T {
  const index = Math.min(items.length - 1, Math.floor(rng() * items.length));
  return items[index] as T;
}

function pickWeighted<T extends { weight: number }>(items: readonly T[], rng: Rng): T {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = rng() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll < 0) {
      return item;
    }
  }
  return items[items.length - 1] as T;
}

function shuffle<T>(items: T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const cut = text.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  return (stop > max / 2 ? cut.slice(0, stop + 1) : cut).trim();
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function quoteTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed ? `"${trimmed}"` : "this one";
}
