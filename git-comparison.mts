import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";
import { hash } from "./indexer.mjs";
import {
  workingRules,
  normalizeWorking,
  autoText,
} from "./git-working-rules.mjs";
import type {
  WorkingSettings,
  WorkingAttributes,
} from "./git-working-rules.mjs";
import type {
  GitQuery,
  GitChangedFile,
  GitSourceSide,
  GitFileView,
  GitChangesPage,
  GitGroup,
  GitCoverage,
} from "./types.mjs";

const MAX_OUTPUT = 32 * 1024 * 1024;
const MAX_TEXT = 128 * 1024;
const MAX_HASH = 8 * 1024 * 1024;
const digest = (value: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
function need(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
const changed = () =>
  Error(
    "Files or branches changed. Refresh the comparison; your drafts are kept."
  );
type Entry = {
  oid: string;
  mode: string;
  conflict?: boolean;
  conflicts?: string[];
  oid256?: string;
};
const blobIdentity = (data: Buffer, mode: string): Entry => {
  const header = "blob " + data.length + "\0";
  return {
    mode,
    oid: crypto.createHash("sha1").update(header).update(data).digest("hex"),
    oid256: crypto
      .createHash("sha256")
      .update(header)
      .update(data)
      .digest("hex"),
  };
};
type Entries = Map<string, Entry>;
type Inputs = {
  top: string;
  prefix: string;
  query: GitQuery;
  base?: string;
  target?: string;
  index: Entries;
  before: Entries;
  after: Entries;
  others: string[];
  restricted: {
    before: Entries;
    after: Entries;
    index: Entries;
    others: string[];
  };
  stamp: string;
  settings: WorkingSettings;
  dataFiles: { excludes: string; attributes: string };
};
type Pair = {
  group: GitGroup;
  file: string;
  oldFile?: string;
  before?: Entry;
  after?: Entry;
  disk: boolean;
  beforeLabel: string;
  afterLabel: string;
};
const provenanceFor = (pair: Pair, input: Inputs) =>
  pair.group === "compare"
    ? [input.base, input.target]
    : pair.group === "staged"
      ? [input.base]
      : [];
type Listed = {
  pair: Pair;
  view: GitChangedFile;
  binding: string;
  identity?: string;
  disabledReason?: string;
  failure?: string;
};
type Session = {
  at: number;
  inputs: Inputs;
  pairs: Pair[];
  listed: Map<string, Listed>;
  diskStamps: Map<string, string>;
  offset: number;
};

// Metadata commands never ask Git to clean working files. In particular we
// do not use diff/status/hash-object on repo paths: clean filters are executable.
// Only admitted blob OIDs go to cat-file. Text diff runs in an owned private temp
// directory, outside the repository, with no attributes/config supplied by it.
export function createGitComparison(projectRoot: string) {
  const root = fs.realpathSync(projectRoot);
  let closed = false;
  const deadline = new AsyncLocalStorage<number>();
  const deadlineTime = () => deadline.getStore() ?? Infinity;
  const bounded = <T,>(operation: () => Promise<T>) =>
    deadline.run(Date.now() + 10000, operation);
  const children = new Set<ChildProcess>();
  const jobs = new Set<Promise<unknown>>();
  const sessions = new Map<string, Session>();
  async function run(
    cwd: string,
    args: string[],
    allowFailure = false,
    limit = MAX_OUTPUT,
    settingsOnly = false
  ): Promise<Buffer> {
    need(!closed, "Git comparison is closed.");
    need(children.size < 8, "Git is busy. Retry shortly.");
    const remaining = (deadline.getStore() ?? Date.now() + 10000) - Date.now();
    need(remaining > 0, "Git query timed out. Refresh the comparison.");
    const child = spawn(
      "/usr/bin/git",
      [
        "--no-pager",
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "diff.external=",
        "-c",
        "submodule.recurse=false",
        "-c",
        "core.quotePath=false",
        "-c",
        "protocol.allow=never",
        ...args,
      ],
      {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: "/usr/bin:/bin",
          HOME: settingsOnly ? (process.env.HOME ?? os.homedir()) : os.tmpdir(),
          ...(settingsOnly && process.env.XDG_CONFIG_HOME
            ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
            : {}),
          LC_ALL: "C",
          ...(settingsOnly
            ? {}
            : { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null" }),
          ...(settingsOnly ? {} : { GIT_CONFIG_GLOBAL: "/dev/null" }),
          GIT_ATTR_NOSYSTEM:
            args.includes("check-attr") || args.includes("--format=%(eolattr)")
              ? "0"
              : "1",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_TERMINAL_PROMPT: "0",
          GIT_LITERAL_PATHSPECS: "1",
          GIT_PAGER: "cat",
          GIT_PROTOCOL_FROM_USER: "0",
          GIT_NO_LAZY_FETCH: "1",
        },
      }
    );
    children.add(child);
    const job = new Promise<Buffer>((resolve, reject) => {
      const output: Buffer[] = [];
      let size = 0,
        failure: Error | undefined;
      const stop = (error: Error) => {
        failure ??= error;
        child.kill("SIGKILL");
      };
      const timeout = setTimeout(
        () =>
          stop(
            Error("Git query timed out. Retry or use a smaller project scope.")
          ),
        Math.min(5000, remaining)
      );
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit)
          stop(
            Error(
              "Git result exceeds the request budget; no partial result was used."
            )
          );
        else output.push(chunk);
      });
      // Drain but do not return repo/config-controlled stderr (which may contain
      // private paths or contents). Bound both channels, including failures.
      child.stderr.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) stop(Error("Git result exceeds the request budget."));
      });
      child.on("error", (error) => {
        failure = error;
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        children.delete(child);
        if (closed) reject(Error("Git comparison is closed."));
        else if (failure) reject(failure);
        else if (
          code !== 0 &&
          !(
            allowFailure &&
            (args[0] === "diff" || args[0] === "config"
              ? code === 1
              : code === 128)
          )
        )
          reject(
            Error(
              "Git query unavailable. Check that this folder is a readable local repository."
            )
          );
        else resolve(Buffer.concat(output));
      });
    });
    jobs.add(job);
    try {
      return await job;
    } finally {
      jobs.delete(job);
    }
  }
  function decode(bytes: Buffer) {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes
    );
  }
  function safe(file: string) {
    return (
      !!file &&
      !path.isAbsolute(file) &&
      !file
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            /^(?:\.git|\.codepaths|\.ssh|\.aws|\.npmrc|\.netrc|\.env(?:\..*)?)$/i.test(
              part
            )
        )
    );
  }
  async function location() {
    let top: string;
    try {
      top = fs.realpathSync(
        decode(await run(root, ["rev-parse", "--show-toplevel"])).replace(
          /\n$/,
          ""
        )
      );
    } catch {
      throw Error("This folder is not an available Git working repository.");
    }
    const relative = path.relative(top, root);
    need(
      relative === "" ||
        (!relative.startsWith(".." + path.sep) &&
          relative !== ".." &&
          !path.isAbsolute(relative)),
      "Git working root does not contain this project."
    );
    return {
      top,
      prefix: relative ? relative.split(path.sep).join("/") + "/" : "",
    };
  }
  async function branches() {
    const { top } = await location();
    const raw = decode(
      await run(top, [
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00",
        "refs/heads/",
      ])
    );
    const branches = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [ref, oid] = line.split("\0");
        need(
          ref.startsWith("refs/heads/") && oidPattern.test(oid),
          "Invalid local branch metadata."
        );
        return { ref, name: ref.slice(11), oid };
      });
    const head = decode(
      await run(
        top,
        ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"],
        true
      )
    ).trim();
    return { branches, ...(oidPattern.test(head) ? { head } : {}) };
  }
  async function checkpoint() {
    await new Promise<void>((resolve) => setImmediate(resolve));
    need(!closed, "Git comparison is closed.");
    need(
      Date.now() < (deadline.getStore() ?? Infinity),
      "Git query timed out. Refresh the comparison."
    );
  }
  async function parseEntries(
    raw: Buffer,
    prefix: string,
    index: boolean,
    restricted: Entries
  ): Promise<Entries> {
    const result: Entries = new Map();
    let work = 0;
    for (const record of decode(raw).split("\0")) {
      if (!(work++ % 1024)) await checkpoint();
      if (!record) continue;
      const tab = record.indexOf("\t");
      need(tab >= 0, "Invalid Git file metadata.");
      const [mode, typeOrOid, oidOrStage] = record.slice(0, tab).split(" ");
      const oid = index ? typeOrOid : oidOrStage;
      const repositoryFile = record.slice(tab + 1);
      if (!repositoryFile.startsWith(prefix)) continue;
      const file = repositoryFile.slice(prefix.length);
      const destination =
        safe(file) && safe(repositoryFile) ? result : restricted;
      need(
        oidPattern.test(oid) && /^\d{6}$/.test(mode),
        "Invalid Git object metadata."
      );
      destination.set(file, {
        oid,
        mode,
        ...(index && oidOrStage !== "0"
          ? {
              conflict: true,
              conflicts: [
                ...(destination.get(file)?.conflicts ?? []),
                `${oidOrStage} ${mode} ${oid}`,
              ],
            }
          : {}),
      });
    }
    return result;
  }
  async function workingSettings(top: string): Promise<WorkingSettings> {
    // Only these non-executable keys leave config. No credentials or commands
    // are returned or copied into the normal Git query environment.
    const raw = decode(
      await run(
        top,
        [
          "config",
          "--includes",
          "--null",
          "--get-regexp",
          "^core\\.(autocrlf|filemode)$",
        ],
        true,
        65536,
        true
      )
    );
    const values = new Map(
      raw
        .split("\0")
        .filter(Boolean)
        .map((record) => {
          const newline = record.indexOf("\n");
          return [record.slice(0, newline), record.slice(newline + 1)] as const;
        })
    );
    function bool(value: string | undefined, fallback: boolean) {
      if (value === undefined) return fallback;
      if (/^(?:true|yes|on|)$/i.test(value)) return true;
      if (/^(?:false|no|off)$/i.test(value)) return false;
      if (/^[+-]?\d+$/.test(value)) return Number(value) !== 0;
      throw Error("Unsupported Git built-in configuration value.");
    }
    const autocrlf = values.get("core.autocrlf");
    return {
      autocrlf: /^input$/i.test(autocrlf ?? "") || bool(autocrlf, false),
      filemode: bool(values.get("core.filemode"), true),
    };
  }
  async function globalDataFiles(top: string) {
    const raw = decode(
      await run(
        top,
        [
          "config",
          "--includes",
          "--null",
          "--path",
          "--get-regexp",
          "^core\\.(excludesfile|attributesfile)$",
        ],
        true,
        65536,
        true
      )
    );
    const values = new Map(
      raw
        .split("\0")
        .filter(Boolean)
        .map((record) => {
          const newline = record.indexOf("\n");
          return [record.slice(0, newline), record.slice(newline + 1)] as const;
        })
    );
    const xdg =
      process.env.XDG_CONFIG_HOME ||
      path.join(process.env.HOME ?? os.homedir(), ".config");
    return {
      excludes: values.get("core.excludesfile") ?? path.join(xdg, "git/ignore"),
      attributes:
        values.get("core.attributesfile") ?? path.join(xdg, "git/attributes"),
    };
  }
  async function attributes(
    input: Inputs,
    file: string
  ): Promise<WorkingAttributes> {
    const fields = decode(
      await run(
        input.top,
        [
          "-c",
          "core.attributesFile=" + input.dataFiles.attributes,
          "check-attr",
          "--all",
          "-z",
          "--",
          input.prefix + file,
        ],
        false,
        65536
      )
    ).split("\0");
    need(
      fields.length % 3 === 1 && fields.at(-1) === "",
      "Invalid Git attribute metadata."
    );
    const result: WorkingAttributes = {};
    for (let i = 0; i < fields.length - 1; i += 3) {
      need(
        fields[i] === input.prefix + file,
        "Invalid Git attribute path metadata."
      );
      if (
        [
          "text",
          "eol",
          "crlf",
          "ident",
          "filter",
          "working-tree-encoding",
        ].includes(fields[i + 1])
      )
        result[fields[i + 1]] = fields[i + 2];
    }
    if (
      !workingRules(input.settings, result).unsupported &&
      [result.text, result.crlf].some((value) =>
        ["set", "unset"].includes(value ?? "")
      )
    ) {
      // Unlike --eol, this format requests ONLY the canonical attribute action:
      // no working-file statistics or index-blob reads. Native Git resolves
      // boolean vs literal text/crlf and macro precedence, without conversion.
      const canonical = decode(
        await run(
          input.top,
          [
            "-c",
            "core.attributesFile=" + input.dataFiles.attributes,
            "ls-files",
            "--cached",
            "--format=%(eolattr)",
            "-z",
            "--",
            input.prefix + file,
          ],
          false,
          65536
        )
      ).split("\0");
      if (canonical.length === 1 && canonical[0] === "")
        result.textAction = "unknown"; // no indexed path to ask Git about
      else {
        need(
          // A conflicted path has up to three stages, each with the same
          // effective path attributes. --format cannot use --deduplicate.
          canonical.length >= 2 &&
            canonical.length <= 4 &&
            canonical.at(-1) === "" &&
            canonical.slice(0, -1).every((value) => value === canonical[0]),
          "Invalid Git text attribute metadata."
        );
        const actions = new Map<string, WorkingAttributes["textAction"]>([
          ["", "default"],
          ["-text", "none"],
          ["text", "text"],
          ["text eol=lf", "text"],
          ["text eol=crlf", "text"],
          ["text=auto", "auto"],
          ["text=auto eol=lf", "auto"],
          ["text=auto eol=crlf", "auto"],
        ]);
        need(
          actions.has(canonical[0]),
          "Unsupported Git text attribute metadata."
        );
        result.textAction = actions.get(canonical[0]);
      }
    }
    return result;
  }
  async function indexCRLF(input: Inputs, file: string) {
    const entry = input.index.get(file);
    if (!entry || !["100644", "100755"].includes(entry.mode)) return false;
    const size = Number(
      decode(await run(input.top, ["cat-file", "-s", entry.oid])).trim()
    );
    need(
      Number.isSafeInteger(size) && size <= MAX_HASH,
      "Git normalization unavailable: index blob exceeds 8 MiB inspection budget."
    );
    const data = await run(
      input.top,
      ["cat-file", "blob", entry.oid],
      false,
      MAX_HASH
    );
    return data.includes(Buffer.from("\r\n")) && autoText(data);
  }
  async function inputs(value: GitQuery): Promise<Inputs> {
    need(
      value && (value.mode === "changes" || value.mode === "compare"),
      "Choose Changes or Compare."
    );
    const query = structuredClone(value);
    const { top, prefix } = await location();
    const refs = await branches();
    const resolveRef = (ref: string) => {
      need(typeof ref === "string", "Choose a local branch or HEAD.");
      const oid =
        ref === "HEAD"
          ? refs.head
          : refs.branches.find((branch) => branch.ref === ref)?.oid;
      need(oid, "Choose an available local branch or HEAD, then refresh.");
      return oid;
    };
    // Restricted names/OIDs are metadata only: never passed to inspection,
    // stat, attributes or blob reads. Public coverage exposes aggregates only.
    const restricted = {
      before: new Map<string, Entry>(),
      after: new Map<string, Entry>(),
      index: new Map<string, Entry>(),
      others: [] as string[],
    };
    const tree = async (oid: string | undefined, excluded: Entries) =>
      oid
        ? parseEntries(
            await run(top, [
              "ls-tree",
              "-r",
              "-z",
              "--full-tree",
              oid,
              "--",
              ...(prefix ? [prefix] : []),
            ]),
            prefix,
            false,
            excluded
          )
        : new Map<string, Entry>();
    let base: string | undefined, target: string | undefined;
    if (query.mode === "compare") {
      base = resolveRef(query.base);
      if (query.target !== "WORKING_TREE") target = resolveRef(query.target);
    } else base = refs.head;
    const disk = query.mode === "changes" || query.target === "WORKING_TREE";
    const index = disk
      ? await parseEntries(
          await run(top, [
            "ls-files",
            "--stage",
            "--full-name",
            "-z",
            "--",
            ...(prefix ? [prefix] : []),
          ]),
          prefix,
          true,
          restricted.index
        )
      : new Map<string, Entry>();
    const before = await tree(base, restricted.before);
    const after = disk ? index : await tree(target, restricted.after);
    if (disk) restricted.after = restricted.index;
    const settings = disk
      ? await workingSettings(top)
      : { autocrlf: false, filemode: true };
    const dataFiles = disk
      ? await globalDataFiles(top)
      : { excludes: "/dev/null", attributes: "/dev/null" };
    const others = disk
      ? decode(
          await run(top, [
            "-c",
            "core.excludesFile=" + dataFiles.excludes,
            "ls-files",
            "--others",
            "--exclude-standard",
            "--full-name",
            "-z",
            "--",
            ...(prefix ? [prefix] : []),
          ])
        )
          .split("\0")
          .filter((file) => {
            if (!file || !file.startsWith(prefix)) return false;
            if (safe(file) && safe(file.slice(prefix.length))) return true;
            restricted.others.push(file.slice(prefix.length));
            return false;
          })
          .map((file) => file.slice(prefix.length))
      : [];
    // Ref movement and any index mutation invalidate admission. Working files
    // are checked independently by exact bytes/mode at the selected-file seam.
    const stamp = digest({
      top,
      prefix,
      query,
      base,
      target,
      index: [...index],
      others,
      restricted: {
        before: [...restricted.before],
        after: [...restricted.after],
        index: [...restricted.index],
        others: restricted.others,
      },
      settings,
      dataFiles,
    });
    return {
      top,
      prefix,
      query,
      base,
      target,
      index,
      before,
      after,
      others,
      restricted,
      stamp,
      settings,
      dataFiles,
    };
  }
  async function pairs(input: Inputs): Promise<Pair[]> {
    const result: Pair[] = [];
    const add = async (
      group: GitGroup,
      left: Entries,
      right: Entries,
      disk: boolean,
      beforeLabel: string,
      afterLabel: string,
      names = new Set([...left.keys(), ...right.keys()])
    ) => {
      await checkpoint();
      let work = 0;
      for (const file of [...names].sort()) {
        if (!(work++ % 1024)) await checkpoint();
        const before = left.get(file),
          after = right.get(file);
        if (!disk && JSON.stringify(before) === JSON.stringify(after)) continue;
        result.push({
          group,
          file,
          before,
          after,
          disk,
          beforeLabel,
          afterLabel,
        });
      }
    };
    if (input.query.mode === "changes") {
      await add(
        "staged",
        input.before,
        input.index,
        false,
        input.base ? "HEAD" : "Empty (unborn HEAD)",
        "Index"
      );
      await add(
        "unstaged",
        input.index,
        input.index,
        true,
        "Index",
        "Working tree (saved)"
      );
      await add(
        "untracked",
        new Map(),
        new Map(),
        true,
        "Empty",
        "Working tree (saved)",
        new Set(input.others)
      );
    } else {
      const label = (ref: string, oid: string) =>
        (ref === "HEAD" ? "HEAD" : ref.slice(11)) + " · " + oid.slice(0, 8);
      const working = input.query.target === "WORKING_TREE";
      await add(
        "compare",
        input.before,
        input.after,
        working,
        label(input.query.base, input.base!),
        working
          ? "Working tree (saved)"
          : label(input.query.target, input.target!),
        new Set([
          ...input.before.keys(),
          ...input.after.keys(),
          ...input.others,
        ])
      );
    }
    // Exact-content renames across committed/index sides; edited moves remain
    // honest delete/add entries rather than a guessed similarity match.
    const additions = new Map<string, { items: Pair[]; offset: number }>();
    const key = (pair: Pair, entry: Entry) =>
      `${pair.group}:${entry.oid}:${entry.mode}`;
    let work = 0;
    for (const pair of result) {
      if (!(work++ % 1024)) await checkpoint();
      if (pair.disk || pair.before || !pair.after) continue;
      const identity = key(pair, pair.after);
      let queue = additions.get(identity);
      if (!queue) additions.set(identity, (queue = { items: [], offset: 0 }));
      queue.items.push(pair);
    }
    const remaining: Pair[] = [];
    for (const old of result) {
      if (!(work++ % 1024)) await checkpoint();
      if (!old.disk && old.before && !old.after) {
        const queue = additions.get(key(old, old.before));
        const added = queue?.items[queue.offset];
        if (added && queue) {
          queue.offset++;
          added.before = old.before;
          added.oldFile = old.file;
          continue;
        }
      }
      remaining.push(old);
    }
    return remaining;
  }
  function diskStamp(file: string): string {
    let absolute = root;
    const result: string[] = [];
    try {
      for (const part of file.split("/")) {
        absolute = path.join(absolute, part);
        const stat = fs.lstatSync(absolute, { bigint: true });
        result.push(
          [
            stat.dev,
            stat.ino,
            stat.mode,
            ...(stat.isDirectory()
              ? []
              : [stat.size, stat.mtimeNs, stat.ctimeNs]),
          ].join(":")
        );
        if (stat.isSymbolicLink()) break;
      }
    } catch (error) {
      result.push((error as NodeJS.ErrnoException).code ?? "unavailable");
    }
    return result.join("/");
  }
  function diskFile(
    file: string,
    sample?: (data: Buffer, mode: string) => void
  ): {
    entry?: Entry;
    content?: string;
    unavailable?: string;
  } {
    need(safe(file), "Private or invalid project file.");
    let absolute = root;
    const parts = file.split("/");
    const initialStamp = diskStamp(file);
    let inspected: fs.BigIntStats | undefined;
    try {
      for (const [index, part] of parts.entries()) {
        absolute = path.join(absolute, part);
        const stat = fs.lstatSync(absolute, { bigint: true });
        inspected = stat;
        if (stat.isSymbolicLink()) {
          if (index !== parts.length - 1)
            return {
              entry: { oid: "unavailable-link-parent", mode: "000000" },
              unavailable:
                "Source path passes through a symbolic link; not followed.",
            };
          const data = fs.readlinkSync(absolute, { encoding: "buffer" });
          if (diskStamp(file) !== initialStamp) throw changed();
          const entry = blobIdentity(data, "120000");
          try {
            return { entry, content: decode(data) };
          } catch {
            return {
              entry,
              unavailable:
                "Invalid UTF-8 symbolic-link data: text diff unavailable.",
            };
          }
        }
        if (index !== parts.length - 1)
          need(stat.isDirectory(), "Source parent is not a directory.");
      }
      need(
        fs.realpathSync(path.dirname(absolute)).startsWith(root + path.sep) ||
          fs.realpathSync(path.dirname(absolute)) === root,
        "Source is outside project."
      );
      const fd = fs.openSync(
        absolute,
        fs.constants.O_RDONLY |
          fs.constants.O_NOFOLLOW |
          fs.constants.O_NONBLOCK
      );
      try {
        const stat = fs.fstatSync(fd, { bigint: true });
        // O_NOFOLLOW protects the final element. Descriptor identity plus
        // before/after parent stamps also refuse swapped directory/link paths.
        if (
          stat.dev !== inspected?.dev ||
          stat.ino !== inspected.ino ||
          diskStamp(file) !== initialStamp
        )
          throw changed();
        const mode = stat.isFile()
          ? stat.mode & 0o111n
            ? "100755"
            : "100644"
          : "000000";
        if (!stat.isFile() || stat.size > BigInt(MAX_HASH))
          return {
            entry: {
              oid: digest([
                String(stat.ino),
                String(stat.size),
                String(stat.mtimeNs),
                String(stat.ctimeNs),
              ]),
              mode,
            },
            unavailable:
              "Not inspected: nonregular file or file exceeds 8 MiB hashing budget.",
          };
        const data = Buffer.alloc(Number(stat.size));
        let offset = 0;
        while (offset < data.length) {
          const read = fs.readSync(
            fd,
            data,
            offset,
            data.length - offset,
            null
          );
          if (!read) throw changed();
          offset += read;
        }
        const after = fs.fstatSync(fd, { bigint: true });
        if (
          stat.size !== after.size ||
          stat.mtimeNs !== after.mtimeNs ||
          stat.ctimeNs !== after.ctimeNs ||
          diskStamp(file) !== initialStamp
        )
          throw changed();
        const entry = blobIdentity(data, mode);
        sample?.(data, mode);
        const unavailable =
          data.length > MAX_TEXT
            ? "Text preview unavailable: file exceeds 128 KiB."
            : data.includes(0)
              ? "Binary content: text diff unavailable."
              : undefined;
        if (unavailable) return { entry, unavailable };
        try {
          return { entry, content: decode(data) };
        } catch {
          return {
            entry,
            unavailable: "Invalid UTF-8: text diff unavailable.",
          };
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      if (
        ["ENOENT", "ENOTDIR"].includes(
          (error as NodeJS.ErrnoException).code ?? ""
        )
      )
        return { content: "" };
      throw error;
    }
  }
  async function blob(entry: Entry | undefined) {
    if (!entry) return { content: "" };
    if (entry.conflict || !["100644", "100755", "120000"].includes(entry.mode))
      return {
        unavailable: "Unmerged entry or submodule: text diff unavailable.",
      };
    const { top } = await location();
    const size = Number(
      decode(await run(top, ["cat-file", "-s", entry.oid])).trim()
    );
    if (!Number.isSafeInteger(size) || size > MAX_TEXT)
      return { unavailable: "Text preview unavailable: blob exceeds 128 KiB." };
    const data = await run(
      top,
      ["cat-file", "blob", entry.oid],
      false,
      MAX_TEXT + 1
    );
    if (data.includes(0))
      return { unavailable: "Binary content: text diff unavailable." };
    try {
      return { content: decode(data) };
    } catch {
      return { unavailable: "Invalid UTF-8: text diff unavailable." };
    }
  }
  async function inspect(pair: Pair, input: Inputs) {
    const attr = pair.disk ? await attributes(input, pair.file) : undefined;
    const rules = attr ? workingRules(input.settings, attr) : undefined;
    const hasIndexCRLF =
      rules?.eol === "auto" ? await indexCRLF(input, pair.file) : false;
    let normalized: Entry | undefined, patchAfter: string | undefined;
    const right = pair.disk
      ? diskFile(pair.file, (data, mode) => {
          if (rules?.unsupported) return;
          const converted = normalizeWorking(data, rules!, hasIndexCRLF);
          const indexMode = input.index.get(pair.file)?.mode;
          normalized = blobIdentity(
            converted,
            !input.settings.filemode
              ? ["100644", "100755"].includes(indexMode ?? "")
                ? indexMode!
                : "100644"
              : mode
          );
          if (converted.length <= MAX_TEXT && !converted.includes(0)) {
            try {
              patchAfter = decode(converted);
            } catch {
              /* no text preview */
            }
          }
        })
      : { ...(await blob(pair.after)), entry: pair.after };
    const compared = normalized ?? right.entry;
    const unsupported =
      right.entry && ["100644", "100755"].includes(right.entry.mode)
        ? rules?.unsupported
        : undefined;
    // Display/admission always retain raw bytes. Only change eligibility and
    // hunks use safe built-in normalization; index/committed modes stay literal.
    const same =
      !unsupported &&
      pair.disk &&
      (pair.before
        ? !pair.before.conflict &&
          pair.before.mode === compared?.mode &&
          (pair.before.oid === compared?.oid ||
            pair.before.oid === compared?.oid256)
        : !right.entry);
    const left = same ? {} : await blob(pair.before);
    const binding = digest({
      provenance: provenanceFor(pair, input),
      attr,
      settings: pair.disk ? input.settings : undefined,
      // The index enumerates candidates for a working-tree target, but is not
      // that target's source. Staging unchanged saved bytes must not rebind notes.
      pair: pair.disk ? { ...pair, after: undefined } : pair,
      left,
      right,
    });
    const status =
      unsupported || right.unavailable?.startsWith("Not inspected")
        ? "unavailable"
        : pair.oldFile
          ? "renamed"
          : !pair.before
            ? "added"
            : !right.entry
              ? "deleted"
              : "modified";
    return {
      left,
      right,
      same,
      binding,
      status,
      attr,
      patchAfter,
      unsupported,
      mode:
        pair.disk && right.entry?.mode === "000000"
          ? "unknown"
          : (normalized?.mode ?? right.entry?.mode),
      // Preview limits and certainty are independent. Only literal hashed
      // working bytes (or confirmed absence) can participate in progress.
      ...(pair.disk && right.entry && !right.entry.oid256
        ? {
            identity: undefined,
            disabledReason:
              "Exact source identity unavailable: working source was not inspected within the 8 MiB regular-file/link budget.",
          }
        : {
            disabledReason: undefined,
            identity: digest({
              version: 1,
              root,
              query:
                input.query.mode === "changes"
                  ? { mode: "changes" }
                  : {
                      mode: "compare",
                      base: input.query.base,
                      target: input.query.target,
                    },
              group: pair.group,
              file: pair.file,
              oldFile: pair.oldFile,
              before: pair.before,
              after: right.entry,
              attr,
              settings: pair.disk ? input.settings : undefined,
            }),
          }),
    } as const;
  }
  function session(id: string) {
    const value = sessions.get(id);
    need(
      value && Date.now() - value.at < 300000,
      "Comparison expired. Refresh; drafts are kept."
    );
    need(!closed, "Git comparison is closed.");
    return value;
  }
  async function list(
    query: GitQuery,
    cursor?: string
  ): Promise<GitChangesPage> {
    let id: string, s: Session;
    if (cursor) {
      const [key, offset] = cursor.split(":");
      id = key;
      s = session(key);
      need(
        JSON.stringify(query) === JSON.stringify(s.inputs.query) &&
          Number(offset) === s.offset,
        "Invalid comparison continuation. Refresh."
      );
      if ((await inputs(query)).stamp !== s.inputs.stamp) throw changed();
    } else {
      const initial = await inputs(query);
      id = crypto.randomUUID();
      s = {
        inputs: initial,
        pairs: await pairs(initial),
        at: Date.now(),
        listed: new Map(),
        diskStamps: new Map(),
        offset: 0,
      };
      while (sessions.size >= 8) sessions.delete(sessions.keys().next().value!);
      sessions.set(id, s);
    }
    const files: GitChangedFile[] = [];
    const deadline = Date.now() + 500;
    for (
      let work = 0;
      s.offset < s.pairs.length && work < 100 && Date.now() < deadline;
      work++
    ) {
      const pair = s.pairs[s.offset++];
      const beforeStamp = pair.disk ? diskStamp(pair.file) : "";
      let observed: Awaited<ReturnType<typeof inspect>>;
      try {
        observed = await inspect(pair, s.inputs);
      } catch (error) {
        // A candidate-local source failure is an UNKNOWN row, not an omitted
        // file. Global cancellation/time/metadata failures still fail closed.
        const message =
          error instanceof Error
            ? error.message
            : "Source inspection unavailable.";
        if (
          !/^Git normalization unavailable:|^Git query unavailable\.|^Invalid Git .*attribute|^Unsupported Git .*attribute|^Unsupported Git text attribute|^Source |^(?:EACCES|EPERM|EIO|ELOOP):/.test(
            message
          )
        )
          throw error;
        if (pair.disk && diskStamp(pair.file) !== beforeStamp) throw changed();
        if (pair.disk) s.diskStamps.set(pair.file, beforeStamp);
        const view: GitChangedFile = {
          id: digest([pair.group, pair.file, pair.oldFile]),
          file: pair.file,
          group: pair.group,
          status: "unavailable",
          ...(pair.oldFile ? { oldFile: pair.oldFile } : {}),
        };
        s.listed.set(view.id, {
          pair,
          view,
          binding: "",
          failure: message,
          disabledReason: "Exact source identity unavailable: " + message,
        });
        files.push(view);
        continue;
      }
      if (pair.disk) {
        if (diskStamp(pair.file) !== beforeStamp) throw changed();
        s.diskStamps.set(pair.file, beforeStamp);
      }
      if (observed.same) continue;
      const view: GitChangedFile = {
        id: digest([pair.group, pair.file, pair.oldFile]),
        file: pair.file,
        group: pair.group,
        status: observed.status,
        ...(pair.oldFile ? { oldFile: pair.oldFile } : {}),
      };
      s.listed.set(view.id, {
        pair,
        view,
        binding: observed.binding,
        identity: observed.identity,
        disabledReason: observed.disabledReason,
      });
      files.push(view);
    }
    if ((await inputs(query)).stamp !== s.inputs.stamp) throw changed();
    const complete = s.offset === s.pairs.length;
    if (complete) {
      // Eligibility includes skipped unchanged files. An edit on an earlier
      // page must not disappear behind a later 'complete' acknowledgement.
      const until = Math.min(Date.now() + 250, deadlineTime());
      for (const [file, stamp] of s.diskStamps) {
        need(
          Date.now() < until,
          "Inventory final verification exceeds the request budget; coverage is incomplete. Refresh."
        );
        if (diskStamp(file) !== stamp) throw changed();
      }
    }
    const restricted = s.inputs.restricted;
    const names = new Set([
      ...restricted.before.keys(),
      ...restricted.after.keys(),
      ...restricted.index.keys(),
      ...restricted.others,
    ]);
    const right =
      s.inputs.query.mode === "changes" ? restricted.index : restricted.after;
    let knownChangedPaths = 0;
    // A working-tree comparison's index is not its target source. Only the
    // actually selected committed/index pairs have known restricted changes.
    if (
      s.inputs.query.mode === "changes" ||
      s.inputs.query.target !== "WORKING_TREE"
    )
      for (const name of names)
        if (
          JSON.stringify(restricted.before.get(name)) !==
          JSON.stringify(right.get(name))
        )
          knownChangedPaths++;
    const coverage: GitCoverage = {
      scope: "project nonignored allowed paths",
      allowed: {
        scanned: s.offset,
        candidates: s.pairs.length,
        listedPairs: s.listed.size,
        complete,
      },
      restricted: {
        candidatePaths: names.size,
        knownChangedPaths,
        workingChanges:
          names.size &&
          (s.inputs.query.mode === "changes" ||
            s.inputs.query.target === "WORKING_TREE")
            ? "unknown"
            : "not-selected",
      },
    };
    return {
      listId: id,
      files,
      complete,
      coverage,
      ...(!complete ? { nextCursor: id + ":" + s.offset } : {}),
    };
  }
  async function file(
    listId: string,
    fileId: string,
    samples?: Map<string, { raw: string; attr: string }>
  ): Promise<Omit<GitFileView, "annotations">> {
    const s = session(listId),
      selected = s.listed.get(fileId);
    need(selected, "File is not in this comparison. Refresh.");
    if ((await inputs(s.inputs.query)).stamp !== s.inputs.stamp)
      throw changed();
    if (selected.failure) {
      const pair = selected.pair;
      return {
        listId,
        file: selected.view,
        binding: "",
        scope: digest([s.inputs.query, pair.group, pair.oldFile, pair.file]),
        before: {
          label: pair.beforeLabel,
          file: pair.oldFile ?? pair.file,
          mode: pair.before?.mode ?? "000000",
          unavailable: selected.failure,
        },
        after: {
          label: pair.afterLabel,
          file: pair.file,
          mode: pair.disk ? "unknown" : (pair.after?.mode ?? "000000"),
          unavailable: selected.failure,
        },
        patch: "",
        unavailable: selected.failure,
      };
    }
    const observed = await inspect(selected.pair, s.inputs);
    if (observed.binding !== selected.binding) throw changed();
    const side = (
      label: string,
      file: string,
      mode: string,
      data: { content?: string; unavailable?: string }
    ): GitSourceSide => {
      const content = data.content,
        lines = content?.split("\n");
      return {
        label,
        file,
        mode,
        ...data,
        ...(content !== undefined && lines
          ? {
              code: {
                file,
                lines,
                startLine: 1,
                endLine: lines.length,
                excerpt: content,
                hash: hash(content),
                fileHash: hash(content),
              },
            }
          : {}),
      };
    };
    const pair = selected.pair;
    const before = side(
      pair.beforeLabel,
      pair.oldFile ?? pair.file,
      pair.before?.mode ?? "000000",
      observed.left
    );
    const after = side(
      pair.afterLabel,
      pair.file,
      observed.mode ?? "000000",
      observed.right
    );
    let patch = "";
    const unavailable =
      observed.unsupported ?? before.unavailable ?? after.unavailable;
    if (!unavailable) {
      const temporaryRoot = fs.realpathSync(os.tmpdir());
      const relativeTemporary = path.relative(s.inputs.top, temporaryRoot);
      need(
        relativeTemporary === ".." ||
          relativeTemporary.startsWith(".." + path.sep) ||
          path.isAbsolute(relativeTemporary),
        "A private temporary directory outside the repository is required for text diff."
      );
      const temporary = fs.mkdtempSync(
        path.join(temporaryRoot, `codepath-diff-${process.pid}-`)
      );
      try {
        fs.writeFileSync(path.join(temporary, "before"), before.content ?? "", {
          flag: "wx",
          mode: 0o600,
        });
        fs.writeFileSync(
          path.join(temporary, "after"),
          observed.patchAfter ?? after.content ?? "",
          {
            flag: "wx",
            mode: 0o600,
          }
        );
        patch = decode(
          await run(
            temporary,
            [
              "diff",
              "--no-index",
              "--no-ext-diff",
              "--no-textconv",
              "--no-color",
              "--text",
              "--unified=3",
              "--",
              "before",
              "after",
            ],
            true,
            1024 * 1024
          )
        );
      } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    }
    // No read sampled before an await can authorize a later write. Recheck
    // refs/index and literal working bytes AFTER diff subprocess drainage.
    if (
      pair.disk &&
      digest(await attributes(s.inputs, pair.file)) !== digest(observed.attr)
    )
      throw changed();
    if ((await inputs(s.inputs.query)).stamp !== s.inputs.stamp)
      throw changed();
    if (pair.disk && digest(diskFile(pair.file)) !== digest(observed.right))
      throw changed();
    if (pair.disk)
      samples?.set(pair.file, {
        raw: digest(observed.right),
        attr: digest(observed.attr),
      });
    return {
      listId,
      file: selected.view,
      before,
      after,
      binding: selected.binding,
      scope: digest([s.inputs.query, pair.group, pair.oldFile, pair.file]),
      patch,
      patchMatchesRaw: {
        before: true,
        after:
          observed.patchAfter === undefined ||
          observed.patchAfter === after.content,
      },
      ...(unavailable ? { unavailable } : {}),
    };
  }
  // One shared request deadline, deduplicated sources, and one final admission
  // after ALL diff/attribute subprocesses. Never authorize an early working file
  // with a sample taken before a later file's await.
  async function admit(
    listId: string,
    selections: { fileId: string; binding: string }[]
  ) {
    const s = session(listId);
    const samples = new Map<string, { raw: string; attr: string }>();
    const views: Omit<GitFileView, "annotations">[] = [];
    const seen = new Map<string, string>();
    let bytes = 0;
    for (const selection of selections) {
      need(
        !seen.has(selection.fileId) ||
          seen.get(selection.fileId) === selection.binding,
        "Conflicting source bindings."
      );
      if (seen.has(selection.fileId)) continue;
      seen.set(selection.fileId, selection.binding);
      const view = await file(listId, selection.fileId, samples);
      need(
        view.binding === selection.binding && !view.unavailable,
        "Authored source changed or unavailable."
      );
      bytes += Buffer.byteLength(JSON.stringify(view));
      need(bytes <= 2 * 1024 * 1024, "Admitted sources exceed 2 MiB.");
      views.push(view);
    }
    for (const [file, sample] of samples)
      if (digest(await attributes(s.inputs, file)) !== sample.attr)
        throw changed();
    if ((await inputs(s.inputs.query)).stamp !== s.inputs.stamp)
      throw changed();
    // These literal checks are synchronous and follow the final await.
    for (const [file, sample] of samples)
      if (digest(diskFile(file)) !== sample.raw) throw changed();
    need(
      !closed && Date.now() < (deadline.getStore() ?? 0),
      "Git admission timed out or closed."
    );
    const query: GitQuery =
      s.inputs.query.mode === "changes"
        ? { mode: "changes" }
        : {
            mode: "compare",
            base: s.inputs.query.base,
            target: s.inputs.query.target,
          };
    return { query, views };
  }
  async function admitViewed(
    query: GitQuery,
    fileId: string,
    identity: string
  ) {
    const input = await inputs(query);
    const pair = (await pairs(input)).find(
      (pair) => digest([pair.group, pair.file, pair.oldFile]) === fileId
    );
    need(
      pair,
      "Viewed source identity changed or is no longer in this comparison."
    );
    const observed = await inspect(pair, input);
    need(
      !observed.same && observed.identity && observed.identity === identity,
      observed.disabledReason ??
        "Exact Viewed source identity changed. Refresh progress."
    );
    if (
      pair.disk &&
      digest(await attributes(input, pair.file)) !== digest(observed.attr)
    )
      throw changed();
    if ((await inputs(query)).stamp !== input.stamp) throw changed();
    // LAST source check follows ALL awaits. The caller immediately fences
    // ownership and synchronously CAS-commits against CURRENT workspace state.
    if (pair.disk && digest(diskFile(pair.file)) !== digest(observed.right))
      throw changed();
    need(
      !closed && Date.now() < deadlineTime(),
      "Viewed source admission timed out or closed."
    );
    return observed.identity;
  }
  return {
    viewedPairs(listId: string) {
      return [...session(listId).listed.values()].map(
        ({ view, identity, disabledReason }) => ({
          fileId: view.id,
          identity,
          disabledReason,
        })
      );
    },
    admitViewed: (query: GitQuery, fileId: string, identity: string) =>
      bounded(() => admitViewed(query, fileId, identity)),
    admit: (
      listId: string,
      selections: { fileId: string; binding: string }[]
    ) => bounded(() => admit(listId, selections)),
    fresh: (query: GitQuery, fileId: string, binding: string) =>
      bounded(async () => {
        let page = await list(query);
        while (!page.files.some((file) => file.id === fileId)) {
          need(
            !page.complete,
            "Authored source changed; exact paired binding is no longer available. Draft kept."
          );
          page = await list(query, page.nextCursor);
        }
        return admit(page.listId, [{ fileId, binding }]);
      }),
    branches: () => bounded(branches),
    list: (query: GitQuery, cursor?: string) =>
      bounded(() => list(query, cursor)),
    file: (listId: string, fileId: string) =>
      bounded(() => file(listId, fileId)),
    check: (listId: string) =>
      bounded(async () => {
        const s = session(listId);
        if ((await inputs(s.inputs.query)).stamp !== s.inputs.stamp)
          return { current: false };
        const deadline = Date.now() + 250;
        for (const [file, stamp] of s.diskStamps) {
          if (Date.now() > deadline)
            throw Error(
              "Could not verify all files within the request budget. Refresh the comparison."
            );
          if (diskStamp(file) !== stamp) return { current: false };
        }
        return { current: true };
      }),
    async close() {
      closed = true;
      for (const child of children) child.kill("SIGKILL");
      while (jobs.size) await Promise.allSettled([...jobs]);
      sessions.clear();
    },
  };
}
