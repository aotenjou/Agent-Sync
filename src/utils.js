import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

export function writeJson(path, value) {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeFileAtomic(path, content, options = undefined) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = join(dirname(path), `.${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
  writeFileSync(tempPath, content, options);
  renameSync(tempPath, path);
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function safeRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function unique(values) {
  return [...new Set(values)];
}

export function normalizePath(path) {
  return resolve(path).replaceAll("\\", "/");
}

export function toSlash(path) {
  return path.replaceAll("\\", "/");
}

export function shrinkHome(path) {
  const home = normalizePath(homedir());
  const normalized = normalizePath(path);
  if (normalized.startsWith(`${home}/`)) {
    return `~/${relative(home, normalized).replaceAll(sep, "/")}`;
  }
  return normalized;
}

export function expandHome(path) {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

export function walk(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files;
}
