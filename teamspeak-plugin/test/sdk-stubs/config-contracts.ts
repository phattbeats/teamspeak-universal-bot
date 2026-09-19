/**
 * Standalone-test stand-in for `openclaw/plugin-sdk/config-contracts`.
 *
 * The plugin only forwards the host config to SDK calls; it never reads a
 * field. An opaque record is therefore a faithful stand-in for the type, and
 * keeps this stub from drifting as the real config grows.
 */
export type OpenClawConfig = Record<string, unknown>;
