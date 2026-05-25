import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentRoot } from "./agents.js";
import { queryBindings, readAllBindings } from "./bindings.js";
import { parseSelector, formatSelector } from "./args.js";
import { findProjectBundle } from "./store.js";
import { adaptCodexSessionContent, getCodexContentProjectMatch, registerRestoredCodexSession } from "./codex-session.js";
import { expandHome, readJson, writeFileAtomic } from "./utils.js";

export function restoreCommand(gitRoot, args, options, config) {
  const bundleId = args[0];
  const selector = parseSelector(options, { requireSelector: false });
  const selectorIndex = parseRestoreIndex(args, options, Boolean(selector));
  const logIndex = parseRestoreIndex([], options, false);
  const restoreModes = [Boolean(bundleId && !selector), Boolean(options.all), Boolean(selector), Boolean(logIndex && !selector)].filter(Boolean).length;
  if (restoreModes !== 1) {
    throw new Error("restore requires exactly one of a bundle id, --all, --index, --latest, --current, --branch, or --commit");
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

  if (logIndex) {
    const matches = selectRestoreMatches(readAllBindings(config), logIndex, null);
    if (!matches.length) {
      throw new Error("no bindings found for log");
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
    const scope = selector ? formatSelector(selector) : "log";
    throw new Error(`restore index ${index} is out of range for ${scope} (${matches.length} binding(s))`);
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
    registerRestoredSession(config, match, target, result.content, options);
  }
}

function getRestoreTarget(match) {
  if (match.agentRelativePath) {
    return join(getAgentRoot(match.agent), match.agentRelativePath);
  }
  return expandHome(match.originalPath);
}

function restoreSessionFile(config, match, source, target, options) {
  const originalContent = shouldAdaptSessionFile(match, source) ? readFileSync(source, "utf8") : null;
  if (options.noAdapt || !shouldAdaptSessionFile(match, source)) {
    copyFileSync(source, target);
    return { adapted: false, content: originalContent };
  }

  const result = adaptCodexSessionContent(originalContent, config);
  if (!result.adapted) {
    copyFileSync(source, target);
    return { adapted: false, content: originalContent };
  }

  writeFileAtomic(target, result.content);
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

function registerRestoredSession(config, match, target, content, options) {
  if (options.noRegister || match.agent !== "codex" || !content) {
    return;
  }
  const result = registerRestoredCodexSession(content, target, config, match, getAgentRoot("codex"));
  if (result.registered) {
    console.log(`registered codex thread: ${result.sessionId}`);
    return;
  }
  console.log(`warn: restored file but failed to register Codex thread (${result.reason})`);
}
