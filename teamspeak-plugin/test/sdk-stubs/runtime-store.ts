/**
 * Standalone-test stand-in for `openclaw/plugin-sdk/runtime-store`.
 *
 * Minimal, behaviorally faithful: a one-slot holder that throws the caller's
 * message on `getRuntime()` before anything was set, which is all
 * `src/runtime.ts` asks of the real store. Tests never exercise it —
 * `test/persona-tools.test.ts` replaces `src/runtime.ts` wholesale via
 * `vi.mock` — it exists so that file typechecks standalone.
 */
export function createPluginRuntimeStore<T>(params: { pluginId: string; errorMessage: string }): {
  setRuntime: (next: T) => void;
  tryGetRuntime: () => T | null;
  getRuntime: () => T;
} {
  let runtime: T | null = null;
  return {
    setRuntime: (next: T) => {
      runtime = next;
    },
    tryGetRuntime: () => runtime,
    getRuntime: () => {
      if (runtime === null) {
        throw new Error(params.errorMessage);
      }
      return runtime;
    },
  };
}
