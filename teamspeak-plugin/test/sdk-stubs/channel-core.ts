/**
 * Standalone-test stand-in for `openclaw/plugin-sdk/channel-core`.
 *
 * Inert, types only. The real `PluginRuntime` is the host's trusted runtime
 * handle and is far wider than this; the stub declares just the three seams
 * `src/tools/persona-tools.ts` reaches for (config read, config mutate,
 * agent workspace resolution) so the file typechecks standalone. Tests never
 * see a real one — `test/persona-tools.test.ts` swaps `src/runtime.ts` for a
 * fake via `vi.mock`, so nothing here runs.
 */
export type OpenClawConfig = Record<string, unknown>;

export type PluginRuntime = {
  config: {
    current(): OpenClawConfig;
    mutateConfigFile(params: {
      base?: "runtime" | "file";
      afterWrite?: { mode: "auto" | "none" | "restart" | "hot" };
      mutate: (draft: OpenClawConfig) => void;
    }): Promise<unknown>;
  };
  agent: {
    resolveAgentWorkspaceDir(cfg: OpenClawConfig, agentId: string): string;
  };
};
