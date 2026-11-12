import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  gitProject,
  allChanges,
  gitEnvironment,
} from "./fixtures/git-project.mjs";

test("Safe effective global ignores honor fake HOME/XDG, repo override, spaced paths and linked ignore data without executable config", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cp-ignore-home-"));
  const old = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, "xdg space");
  const f = await gitProject(t);
  const marker = path.join(home, "executed");
  const ignore = path.join(home, "global ignore data");
  const link = path.join(home, "ignore link");
  fs.writeFileSync(ignore, "global-only.log\n");
  fs.symlinkSync(ignore, link);
  fs.writeFileSync(
    path.join(home, ".gitconfig"),
    `[core]\n excludesFile = "${link}"\n fsmonitor = "touch ${marker}"\n[credential]\n helper = "!touch ${marker}"\n`
  );
  for (const name of ["global-only.log", "repo-only.log", "visible 世界.ts"])
    f.write(name, "fixture\n");
  const oracle = () => {
    const env = {
      ...gitEnvironment,
      HOME: home,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    };
    delete env.GIT_CONFIG_GLOBAL;
    return execFileSync(
      "/usr/bin/git",
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        f.root,
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      { env, encoding: "utf8" }
    )
      .split("\0")
      .filter(Boolean)
      .sort();
  };
  const compare = async () => {
    const index = path.join(f.root, ".git/index");
    const bytes = fs.readFileSync(index),
      stat = fs.statSync(index, { bigint: true });
    assert.deepEqual(
      (await allChanges(f.service)).files.map((x) => x.file).sort(),
      oracle()
    );
    assert.deepEqual(fs.readFileSync(index), bytes);
    assert.equal(fs.statSync(index, { bigint: true }).mtimeNs, stat.mtimeNs);
    assert.equal(fs.existsSync(marker), false);
  };
  await compare();
  const repoIgnore = path.join(home, "repo ignore data");
  fs.writeFileSync(repoIgnore, "repo-only.log\n");
  f.git("config", "core.excludesFile", repoIgnore);
  await compare();
  f.git("config", "--unset", "core.excludesFile");
  fs.unlinkSync(path.join(home, ".gitconfig"));
  fs.mkdirSync(path.join(process.env.XDG_CONFIG_HOME, "git"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(process.env.XDG_CONFIG_HOME, "git/ignore"),
    "global-only.log\n"
  );
  await compare();
  delete process.env.XDG_CONFIG_HOME;
  fs.mkdirSync(path.join(home, ".config/git"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config/git/ignore"), "repo-only.log\n");
  await compare();
});
