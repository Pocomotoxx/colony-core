import { defaultRulesetsDir, loadRulesets, loadRulesetsSync, type LoadResult } from './loader.js';

/**
 * The rule sets the running process uses: loaded and verified once, on first use (a hook is a short-lived process, so
 * this costs one load per call, about 25 ms). A set that fails its checks is in `failed`, not silently left out.
 */
let dirOverride: string | undefined;
let cache: Promise<LoadResult> | undefined;
let syncCache: LoadResult | undefined;

export function activeRulesets(): Promise<LoadResult> {
  cache ??= loadRulesets(dirOverride ?? defaultRulesetsDir());
  return cache;
}

/** The same, for code that cannot wait (redaction is synchronous). */
export function activeRulesetsSync(): LoadResult {
  syncCache ??= loadRulesetsSync(dirOverride ?? defaultRulesetsDir());
  return syncCache;
}

/** For tests: use another folder of rule sets (or the default again with undefined), and load afresh. */
export function useRulesetsDir(dir: string | undefined): void {
  dirOverride = dir;
  cache = undefined;
  syncCache = undefined;
}
