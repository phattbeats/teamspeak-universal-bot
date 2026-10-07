# STT as a connector

#3790, the implementation of [TOOL-CATALOG.md](TOOL-CATALOG.md) §4.7.

## What was wrong

`sttProvider` looked like a switch and was a label. The name lived in
`channels.teamspeak.voice.streaming.transcription.provider`, `config.ts`
checked it against a hardcoded `LOCAL_TRANSCRIPTION_PROVIDERS = ["whisper-local"]`,
and then `stt-tts-lane.ts` ignored it and built `LocalWhisperTranscriber` as the
primary and `MiniMaxAsrTranscriber` as the secondary regardless. Changing either
one meant editing two source files. Two more symptoms of the same missing
contract: `transcribe` returned a bare `string`, so timing and confidence had
nowhere to live, and the lane had to *feature-detect* `transcribeDetailed`
because only the router carried it.

## The contract

`teamspeak-plugin/src/voice/stt-provider.ts`:

```ts
transcribe(request: SttRequest): Promise<SttResult>

SttRequest  = { pcm48kMono, label, clientId?, durationMs?, lang?, prompt?, prefer? }
SttResult   = { text, provider, ms, confidence?, escalated? }
SttProvider = { id, kind: "local" | "hosted", transcribe, isBackedOff?, backoffRemainingMs? }
```

Everything in the path implements it: `LocalWhisperTranscriber`,
`MiniMaxAsrTranscriber`, the `RoutingTranscriber` that puts one in front of the
other, and the `ConcurrencyLimitedTranscriber` that wraps the lot. Nothing
feature-detects anything.

`ms` is the provider's own wall clock, so a composite reports its total and the
concurrency limiter passes the inner number through untouched — the queue wait it
imposes is already reported separately as `queueWaitMs`. Both land in the turn
log as `sttMsProvider=` next to the existing `sttMs=`.

`confidence` is usually absent, and that is not an oversight. whisper.cpp only
scores under `response_format=verbose_json`, measured at **+1.8s on every turn**
(table in `whisper-local.ts`), and MiniMax `asr-1.0` returns no score at all.
`transcription.confidence: true` buys it back at that price; the escalation
router still does not use it for the same reason it never did.

## The registry

`teamspeak-plugin/src/voice/stt-registry.ts` maps names to factories.
Case-insensitive, with aliases:

| name | kind | aliases |
| --- | --- | --- |
| `whisper-local` | local | `whisper`, `whisper-cpp` |
| `minimax-asr` | hosted | `minimax` |

`whisper-local` is the default primary and talks to the shared whisper pool
container (#3598/3607). `minimax-asr` is the default secondary.

Adding a provider is three things, none of them in the lane:

1. a module exporting an `SttProviderFactory`,
2. one `register` call in `stt-registry.ts`,
3. that factory's own defaults and its own refusal inside `create` — which is
   where the whisper URL default and the MiniMax missing-key refusal now live,
   instead of in `config.ts`.

Swapping a provider is a config edit and nothing else.

## Config, per persona

Each bot reads its own `openclaw.json`, so the block below is per persona.
Both slots take the same shape.

```jsonc
"channels": { "teamspeak": { "accounts": { "default": { "voice": {
  "mode": "stt-tts",
  "streaming": {
    "transcription": {
      "provider": "whisper-local",   // registry name; default whisper-local
      "url": "http://whisper:8080/inference",
      "language": "en",              // or "auto"
      "prompt": "Sexton, Bexton, Trixie",  // decoder priming; unset by default
      "confidence": false,           // true costs ~1.8s/turn on whisper
      "timeoutMs": 15000,
      "allowHosted": false           // required to put a hosted provider here
    },
    "secondaryTranscription": {      // omit the block entirely to disable
      "provider": "minimax-asr",
      "apiKey": "...",               // or MINIMAX_API_KEY in the environment
      "longSegmentMs": 8000,
      "emptyEscalationMinMs": 1500
    }
  }
}}}}}
```

A hosted provider also takes `baseUrl` / `apiKey`, and anything a provider
invents beyond these fields goes under `options` and reaches it untouched.

### Where each refusal comes from

| condition | who says no | effect |
| --- | --- | --- |
| unknown provider name | registry | lane refuses to start, message lists the registered names |
| `kind: "hosted"` in the primary slot without `allowHosted` | registry | lane refuses to start |
| provider's own missing pieces (e.g. no MiniMax key) | that provider's factory | primary: lane refuses. secondary: warn and stay on the primary alone |
| `secondaryTranscription` block absent | `config.ts` | secondary off, silently — an ambient `MINIMAX_API_KEY` must never switch it on |

The asymmetry is deliberate: transcription *is* the lane, so an unbuildable
primary is not a degraded lane, it is no lane. An unbuildable secondary only
costs an upgrade, so it costs a log line.

## The hot-mic promise after the widening

`LOCAL_TRANSCRIPTION_PROVIDERS` was the $0 / audio-stays-home promise expressed
as code. Deleting it for an open registry would have deleted the promise, so the
promise moved instead: every factory declares `kind`, and a `hosted` provider is
refused in the primary slot unless the account states `allowHosted: true`. The
default behaviour is unchanged — local only, or the lane does not start — and the
override is one named config key rather than a source edit.

## Compatibility

An existing `openclaw.json` needs no changes and behaves identically: the default
provider, language, timeout, escalation thresholds and wire format are all what
they were, and both new knobs (`prompt`, `confidence`) default to off.
