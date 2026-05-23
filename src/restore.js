import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentRoot } from "./agents.js";
import { queryBindings } from "./bindings.js";
import { parseSelector, formatSelector } from "./args.js";
import { findProjectBundle } from "./store.js";
import { adaptCodexSessionContent, getCodexContentProjectMatch } from "./codex-session.js";
import { expandHome, readJson } from "./utils.js";

export function restoreCommand(gitRoot, args, options, config) {
  const bundleId = args[0];
  const selector = parseSelector(options, { requireSelector: false });
  const selectorIndex = parseRestoreIndex(args, options, Boolean(selector));
  const restoreModes = [Boolean(bundleId && !selector), Boolean(options.all), Boolean(selector)].filter(Boolean).length;
  if (restoreModes !== 1) {
    throw new Error("restore requires exactly one of a bundle id, --all, --current, --branch, or --commit");
  }

  if (selector) {
    const allMatches = queryBindings(config, selector, gitRoot);
    const matches = selectRestoreMatches(allMatches, selectorIndex, selector);
    if (!matches.length) {
      throw new Error(`no bindings found for ${formatSelector(selector)}`);
    }
    restoreMatches(config, matches, options);
    return;
  }

  const bundle = findProjectBundle(config);
  if (!bundle) {
    throw new Error("no manifest found in sidecar store. Run pull first.");
  }

  const manifest = readJson(bundle.manifestPath);
  const matches = options.all ? manifest.matches : manifest.matches.filter((item) => item.bundleId === bundleId);
  if (!matches.length) {
    throw new Error(`no bundle found for "${bundleId}"`);
  }

  restoreMatches(config, matches, options);
}

function parseRestoreIndex(args, options, hasSelector) {
  const value = options.index ?? (hasSelector ? args[0] : null);
  if (value === null || value === undefined) {
    return null;
  }
  if (!/^\d+$/.test(String(value))) {
    throw new Error("restore index must be a positive number");
  }
  const index = Number(value);
  if (index < 1) {
    throw new Error("restore index must be a positive number");
  }
  return index;
}

function selectRestoreMatches(matches, index, selector) {
  if (!index) {
    return matches;
  }
  if (index > matches.length) {
    throw new Error(`restore index ${index} is out of range for ${formatSelector(selector)} (${matches.length} binding(s))`);
  }
  return matches[index - 1] ? [matches[index - 1]] : [];
}

function restoreMatches(config, matches, options = {}) {
  for (const match of matches) {
    const source = join(config.storePath, match.storeRelativePath);
    const projectMatch = getRestoreProjectMatch(config, match, source);
    if (!projectMatch.matched) {
      console.log(`skipped ${match.agent}: ${source} (${projectMatch.reason})`);
      continue;
    }
    const target = getRestoreTarget(match);
    mkdirSync(dirname(target), { recursive: true });
    const result = restoreSessionFile(config, match, source, target, options);
    const suffix = result.adapted
      ? ` (adapted ${result.fromPlatform} -> ${result.toPlatform}, shell ${result.shell})`
      : "";
    console.log(`restored ${match.agent}: ${target}${suffix}`);
  }
}

function getRestoreTarget(match) {
  if (match.agentRelativePath) {
    return join(getAgentRoot(match.agent), match.agentRelativePath);
  }
  return expandHome(match.originalPath);
}

function restoreSessionFile(config, match, source, target, options) {
  if (options.noAdapt || !shouldAdaptSessionFile(match, source)) {
    copyFileSync(source, target);
    return { adapted: false };
  }

  const content = readFileSync(source, "utf8");
  const result = adaptCodexSessionContent(content, config);
  if (!result.adapted) {
    copyFileSync(source, target);
    return { adapted: false };
  }

  writeFileSync(target, result.content);
  return result;
}

function shouldAdaptSessionFile(match, source) {
  return match.agent === "codex" && (source.endsWith(".jsonl") || source.endsWith(".json"));
}

function getRestoreProjectMatch(config, match, source) {
  if (match.agent !== "codex") {
    return { matched: true };
  }
  try {
    const content = readFileSync(source, "utf8");
    return getCodexContentProjectMatch(content, config);
  } catch (error) {
    return { matched: false, reason: `unreadable session (${error.message})` };
  }
}
