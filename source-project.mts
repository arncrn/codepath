import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  hash,
  read,
  parseFile,
  sourceExtensions,
  ignoredDirectories,
} from "./source-parser.mjs";
import type {
  SourceFileInfo,
  SourceIndex,
  SourceOverview,
  SourceFilesPage,
  SourceSymbolsPage,
  ToolResults,
} from "./types.mjs";
import { errorMessage } from "./types.mjs";

type Tick = { file?: string; stamp?: string; warning?: string };
type Session = {
  key: string;
  iterator: Generator<unknown>;
  at: number;
  matched: Set<string>;
};
const stamp = (s: fs.BigIntStats) =>
  [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");

// One root owns discovery, eligibility and an evictable parsed-source cache.
// A cache miss or an unfinished discovery scan never makes a known path ineligible.
export function createSourceProject(
  root: string,
  { cacheBytes = 16 * 1024 * 1024, cacheFiles = 128 } = {}
) {
  root = fs.realpathSync(root);
  let revision = 0,
    ignoreStamp = "",
    ignores: string[] = [],
    complete = false;
  let scan: Generator<Tick> | undefined;
  let reconcile: Iterator<string> | undefined;
  let previewFiles: string[] = [];
  let seen = new Set<string>();
  const known = new Map<string, string>();
  const contentHashes = new Map<string, string>();
  const directories = new Map<string, { stamp: string; names: Set<string> }>();
  const warnings = new Set<string>();
  const cache = new Map<
    string,
    { info: SourceFileInfo; stamp: string; bytes: number }
  >();
  let bytes = 0;
  const sessions = new Map<string, Session>();
  let watched: string[] = [];
  const warn = (s: string) => {
    if (warnings.size < 100) warnings.add(s);
  };
  function evict(file: string) {
    const entry = cache.get(file);
    if (entry) {
      bytes -= entry.bytes;
      cache.delete(file);
    }
  }
  function exclusions() {
    const file = path.join(root, ".codepaths-ignore");
    let next = "missing";
    try {
      const stat = fs.lstatSync(file, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536n)
        throw Error(
          ".codepaths-ignore must be a regular local file below 64 KiB."
        );
      next = stamp(stat);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (next === ignoreStamp) return;
    const nextIgnores =
      next === "missing"
        ? []
        : fs
            .readFileSync(file, "utf8")
            .split("\n")
            .map((s) => s.trim().replace(/\/$/, ""))
            .filter((s) => s && !s.startsWith("#"));
    ignores = nextIgnores;
    ignoreStamp = next;
    known.clear();
    contentHashes.clear();
    directories.clear();
    cache.clear();
    bytes = 0;
    sessions.clear();
    warnings.clear();
    scan = undefined;
    reconcile = undefined;
    previewFiles = [];
    seen = new Set();
    complete = false;
    revision++;
  }
  const excluded = (file: string) =>
    ignores.some((p) => file === p || file.startsWith(p + "/"));
  function eligible(file: string) {
    exclusions();
    if (
      typeof file !== "string" ||
      !file ||
      path.isAbsolute(file) ||
      file.includes("\\") ||
      file
        .split("/")
        .some(
          (p) =>
            !p || p === ".." || p.startsWith(".") || ignoredDirectories.has(p)
        ) ||
      !sourceExtensions.has(path.extname(file)) ||
      file.endsWith(".d.ts") ||
      excluded(file)
    )
      throw Error("File is not indexed or is excluded: " + file);
    let absolute = root;
    for (const part of file.split("/")) {
      const target = path.join(absolute, part);
      if (fs.lstatSync(target).isSymbolicLink())
        throw Error("Symbolic-link source is not indexed: " + file);
      // Case aliases on case-insensitive filesystems must not bypass exclusions.
      const directoryStamp = stamp(fs.statSync(absolute, { bigint: true }));
      let directory = directories.get(absolute);
      if (!directory || directory.stamp !== directoryStamp) {
        directory = {
          stamp: directoryStamp,
          names: new Set(fs.readdirSync(absolute)),
        };
      }
      directories.delete(absolute);
      while (directories.size >= 256)
        directories.delete(directories.keys().next().value!);
      directories.set(absolute, directory);
      if (!directory.names.has(part))
        throw Error(
          "File is not indexed: use its discovered filename spelling: " + file
        );
      absolute = target;
    }
    if (!fs.realpathSync(absolute).startsWith(root + path.sep))
      throw Error("Not a project source file: " + file);
    const stat = fs.statSync(absolute, { bigint: true });
    if (!stat.isFile()) throw Error("Not a project source file: " + file);
    if (stat.size > 1048576n) throw Error("File exceeds 1 MiB.");
    return stamp(stat);
  }
  function record(file: string, value: string) {
    if (
      (previewFiles.length < 100 || file < previewFiles.at(-1)!) &&
      !previewFiles.includes(file)
    )
      previewFiles = [...previewFiles, file].sort().slice(0, 100);
    if (known.get(file) !== value) {
      known.set(file, value);
      revision++;
    }
  }
  function forget(file: string) {
    if (known.delete(file)) {
      previewFiles = previewFiles.filter((candidate) => candidate !== file);
      revision++;
    }
    contentHashes.delete(file);
    evict(file);
  }
  function* walk(dir = root): Generator<Tick> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      yield { warning: path.relative(root, dir) + ": " + errorMessage(e) };
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const file = path.relative(root, absolute).split(path.sep).join("/");
      if (
        entry.name.startsWith(".") ||
        ignoredDirectories.has(entry.name) ||
        entry.isSymbolicLink() ||
        excluded(file)
      ) {
        yield {};
        continue;
      }
      if (entry.isDirectory()) {
        yield {};
        yield* walk(absolute);
      } else if (
        sourceExtensions.has(path.extname(file)) &&
        !file.endsWith(".d.ts")
      ) {
        try {
          const value = eligible(file);
          yield { file, stamp: value };
        } catch (e) {
          yield { warning: file + ": " + errorMessage(e) };
        }
      } else yield {};
    }
  }
  function advance() {
    exclusions();
    if (!scan && !reconcile) {
      scan = walk();
      seen = new Set();
    }
    const deadline = performance.now() + 6;
    for (let n = 0; n < 200 && performance.now() < deadline; n++) {
      if (reconcile) {
        const next = reconcile.next();
        if (next.done) {
          reconcile = undefined;
          complete = true;
          return;
        }
        if (!seen.has(next.value)) forget(next.value);
        continue;
      }
      const next = scan!.next();
      if (next.done) {
        scan = undefined;
        reconcile = known.keys();
        continue;
      }
      if (next.value.warning) warn(next.value.warning);
      if (next.value.file) {
        seen.add(next.value.file);
        record(next.value.file, next.value.stamp!);
      }
    }
  }
  function inspect(file: string, currentText?: string): SourceFileInfo {
    const value = eligible(file);
    record(file, value);
    const cached = cache.get(file);
    if (cached && cached.stamp === value && currentText === undefined) {
      cache.delete(file);
      cache.set(file, cached);
      return cached.info;
    }
    const text = currentText ?? read(root, file),
      fileHash = hash(text);
    // Content hashes, not stat metadata alone, certify a supplied fresh read.
    if (cached?.info.hash === fileHash) {
      cached.stamp = value;
      cache.delete(file);
      cache.set(file, cached);
      return cached.info;
    }
    const parsed = parseFile(file, text);
    const info: SourceFileInfo = {
      file,
      hash: fileHash,
      lineCount: text.split("\n").length,
      symbols: parsed.symbols.map((s) => ({ ...s, fileHash })),
      calls: parsed.calls,
      functionScopes: parsed.functionScopes,
    };
    evict(file);
    const weight =
      Buffer.byteLength(JSON.stringify(info)) + Buffer.byteLength(text);
    while (
      cache.size &&
      (bytes + weight > cacheBytes || cache.size >= cacheFiles)
    )
      evict(cache.keys().next().value!);
    if (weight <= cacheBytes && cacheFiles > 0) {
      cache.set(file, { info, stamp: value, bytes: weight });
      bytes += weight;
    }
    if (contentHashes.get(file) !== fileHash) {
      contentHashes.set(file, fileHash);
      revision++;
    }
    return info;
  }
  function currentText(file: string) {
    record(file, eligible(file));
    return read(root, file);
  }
  function refresh() {
    exclusions();
    // The visible walkthrough's paths remain observable even after cache eviction.
    for (const file of watched) {
      try {
        record(file, eligible(file));
      } catch {
        forget(file);
      }
    }
    advance();
  }
  function snapshot(readingScope = false): SourceOverview {
    return {
      files: previewFiles.map((file) => ({ file })),
      fileCount: known.size,
      discoveryComplete: complete,
      warnings: [...warnings],
      // Discovery progress and unrelated cache activity must not repeatedly
      // rehydrate/tokenize every card in the reader's unchanged walkthrough.
      version: readingScope
        ? hash(
            JSON.stringify([
              ignoreStamp,
              ...watched.map((file) => [
                file,
                known.get(file),
                contentHashes.get(file),
              ]),
            ])
          )
        : String(revision),
    };
  }
  function page<T>(
    key: string,
    cursor: string | undefined,
    make: (matched: Set<string>) => Generator<T | undefined>
  ) {
    exclusions();
    const now = Date.now();
    for (const [id, session] of sessions)
      if (now - session.at > 300000) sessions.delete(id);
    let session: Session;
    if (cursor !== undefined) {
      const found = sessions.get(cursor);
      if (!found || found.key !== key)
        throw Error("Source search expired or changed. Restart the search.");
      sessions.delete(cursor);
      session = found;
    } else {
      const matched = new Set<string>();
      session = { key, iterator: make(matched), at: now, matched };
    }
    const results: T[] = [];
    const deadline = performance.now() + 12;
    let done = false;
    for (
      let n = 0;
      n < 200 && results.length < 100 && performance.now() < deadline;
      n++
    ) {
      const next = session.iterator.next();
      if (next.done) {
        done = true;
        break;
      }
      if (next.value !== undefined) results.push(next.value as T);
    }
    let nextCursor: string | undefined;
    if (!done) {
      while (sessions.size >= 16)
        sessions.delete(sessions.keys().next().value!);
      nextCursor = crypto.randomUUID();
      session.at = now;
      sessions.set(nextCursor, session);
    }
    return {
      results,
      matchedNames: [...session.matched],
      complete: done,
      ...(nextCursor ? { nextCursor } : {}),
      warnings: [...warnings],
    };
  }
  function query(value = "") {
    if (typeof value !== "string" || value.length > 500)
      throw Error("Source query is too long.");
    return value.trim().toLowerCase();
  }
  function filesPage(input = "", cursor?: string): SourceFilesPage {
    const q = query(input);
    const p = page("files:" + q, cursor, function* () {
      for (const tick of walk()) {
        if (tick.warning) warn(tick.warning);
        if (tick.file) record(tick.file, tick.stamp!);
        yield tick.file && tick.file.toLowerCase().includes(q)
          ? { file: tick.file }
          : undefined;
      }
    });
    return {
      files: p.results,
      complete: p.complete,
      nextCursor: p.nextCursor,
      warnings: p.warnings,
    };
  }
  function symbolsPage(
    input = "",
    cursor?: string,
    names?: string[],
    directory?: string,
    exclude?: { file: string; startLine: number }
  ): SourceSymbolsPage {
    const q = query(input);
    const p = page(
      JSON.stringify(["symbols", q, names, directory, exclude]),
      cursor,
      function* (matched) {
        for (const tick of walk()) {
          if (tick.warning) warn(tick.warning);
          if (!tick.file) {
            yield undefined;
            continue;
          }
          const file = tick.file;
          if (
            directory !== undefined &&
            (!file.endsWith(".go") || path.posix.dirname(file) !== directory)
          ) {
            yield undefined;
            continue;
          }
          try {
            const text = currentText(file);
            const filenameMatch = !names && file.toLowerCase().includes(q);
            const needles = names?.map((name) => name.split(".").at(-1)!) ?? [
              q,
            ];
            if (
              !filenameMatch &&
              !needles.some((name) =>
                text.toLowerCase().includes(name.toLowerCase())
              )
            ) {
              yield undefined;
              continue;
            }
            const info = inspect(file, text);
            for (const symbol of info.symbols) {
              const match = names
                ? names.some(
                    (name) =>
                      symbol.name === name || symbol.name.endsWith("." + name)
                  )
                : filenameMatch || symbol.name.toLowerCase().includes(q);
              if (
                match &&
                !(
                  exclude?.file === symbol.file &&
                  exclude.startLine === symbol.startLine
                )
              ) {
                if (names)
                  for (const name of names)
                    if (
                      symbol.name === name ||
                      symbol.name.endsWith("." + name)
                    )
                      matched.add(name);
                yield symbol;
              }
            }
          } catch (e) {
            warn(file + ": " + errorMessage(e));
          }
          yield undefined;
        }
      }
    );
    return {
      symbols: p.results,
      matchedNames: p.matchedNames,
      complete: p.complete,
      nextCursor: p.nextCursor,
      warnings: p.warnings,
    };
  }
  function search(
    input: string,
    cursor?: string
  ): ToolResults["search_source"] {
    const q = query(input);
    if (!q) throw Error("Text is missing or too long.");
    const p = page("text:" + q, cursor, function* () {
      for (const tick of walk()) {
        if (tick.warning) warn(tick.warning);
        if (!tick.file) {
          yield undefined;
          continue;
        }
        try {
          const text = currentText(tick.file),
            lines = text.split("\n"),
            fileHash = hash(text);
          for (let line = 0; line < lines.length; line++) {
            if (lines[line].toLowerCase().includes(q))
              yield {
                file: tick.file,
                line: line + 1,
                text: lines[line],
                fileHash,
                lineCount: lines.length,
              };
            else if (line % 64 === 0) yield undefined;
          }
        } catch (e) {
          warn(tick.file + ": " + errorMessage(e));
        }
        yield undefined;
      }
    });
    return {
      hits: p.results,
      limit: 100,
      complete: p.complete,
      nextCursor: p.nextCursor,
      warnings: p.warnings,
    };
  }
  const index: SourceIndex = {
    get files() {
      return [...known.keys()].map((file) => ({
        file,
        get hash() {
          return inspect(file).hash;
        },
        get lineCount() {
          return inspect(file).lineCount;
        },
        get symbols() {
          return inspect(file).symbols;
        },
      }));
    },
    get version() {
      return String(revision);
    },
    get warnings() {
      return [...warnings];
    },
    loadFile: inspect,
    querySymbols: (names, cursor, directory, exclude) =>
      symbolsPage("", cursor, names, directory, exclude),
  };
  refresh();
  return {
    index,
    refresh,
    snapshot,
    inspect,
    currentText,
    filesPage,
    symbolsPage,
    search,
    watch(files: string[]) {
      watched = [...new Set(files)];
    },
    // Explicit compatibility helper, not used by overview or ordinary requests.
    discoverAll() {
      do {
        advance();
      } while (!complete);
    },
  };
}
