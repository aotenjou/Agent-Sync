export function parseArgs(rawArgs) {
  const args = [];
  const options = {};
  let command = rawArgs[0];

  if (command?.startsWith("-")) {
    command = undefined;
  }

  for (let i = command ? 1 : 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--oneline") {
      options.oneline = true;
    } else if (arg === "-n" || arg === "--max-count") {
      options.maxCount = rawArgs[++i];
    } else if (arg.startsWith("--max-count=")) {
      options.maxCount = arg.slice("--max-count=".length);
    } else if (/^-\d+$/.test(arg)) {
      options.maxCount = arg.slice(1);
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--latest") {
      options.latest = true;
    } else if (arg === "--current") {
      options.current = true;
    } else if (arg === "--no-adapt") {
      options.noAdapt = true;
    } else if (arg === "--no-register") {
      options.noRegister = true;
    } else if (arg.startsWith("--m=")) {
      options.message = arg.slice("--m=".length);
    } else if (arg === "--m" || arg === "-m" || arg === "--message") {
      options.message = rawArgs[++i];
    } else if (arg.startsWith("--message=")) {
      options.message = arg.slice("--message=".length);
    } else if (arg.startsWith("--index=")) {
      options.index = arg.slice("--index=".length);
    } else if (arg === "--index") {
      options.index = rawArgs[++i];
    } else if (arg.startsWith("--i=")) {
      options.index = arg.slice("--i=".length);
    } else if (arg === "--i") {
      options.index = rawArgs[++i];
    } else if (arg.startsWith("--branch=")) {
      options.branch = arg.slice("--branch=".length);
    } else if (arg === "--branch") {
      options.branch = rawArgs[++i];
    } else if (arg.startsWith("--commit=")) {
      options.commit = arg.slice("--commit=".length);
    } else if (arg === "--commit") {
      options.commit = rawArgs[++i];
    } else if (arg.startsWith("--remote=")) {
      options.remote = arg.slice("--remote=".length);
    } else if (arg === "--remote") {
      options.remote = rawArgs[++i];
    } else if (arg.startsWith("--store=")) {
      options.store = arg.slice("--store=".length);
    } else if (arg === "--store") {
      options.store = rawArgs[++i];
    } else {
      args.push(arg);
    }
  }

  return { command, args, options };
}

export function parseSelector(options, { requireSelector }) {
  const selectors = [
    options.latest ? { type: "latest" } : null,
    options.current ? { type: "current" } : null,
    options.branch !== undefined ? { type: "branch", value: options.branch } : null,
    options.commit !== undefined ? { type: "commit", value: options.commit } : null
  ].filter(Boolean);

  if (selectors.length > 1) {
    throw new Error("choose only one of --latest, --current, --branch, or --commit");
  }
  if (!selectors.length) {
    if (requireSelector) {
      throw new Error("log requires one of --latest, --current, --branch, or --commit");
    }
    return null;
  }

  const selector = selectors[0];
  if ((selector.type === "branch" || selector.type === "commit") && !selector.value) {
    throw new Error(`--${selector.type} requires a value`);
  }
  return selector;
}

export function formatSelector(selector) {
  if (selector.type === "latest") {
    return "latest";
  }
  if (selector.type === "current") {
    return "current";
  }
  return `${selector.type} ${selector.value}`;
}
