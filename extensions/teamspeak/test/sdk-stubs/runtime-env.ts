/**
 * Standalone-test stand-in for `openclaw/plugin-sdk/runtime-env`.
 *
 * Inert: `defaultRuntime` is the host's process-exit/IO facade, which the
 * stt-tts agent turn only forwards to `runCommandFromIngress` and never reads.
 * Tests assert on what was forwarded, not on what the host would do with it.
 */
export const defaultRuntime = {
  __stub: "runtime-env",
} as const;
