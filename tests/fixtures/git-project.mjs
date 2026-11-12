import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startProjectService } from "../../dist/service.mjs";

export const gitEnvironment = {
  PATH: process.env.PATH,
  HOME: os.tmpdir(),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@invalid",
};
export async function gitProject(t, options = {}) {
  // A fresh fixture root can hash to a slot held by an unrelated live owner.
  // Reroll only this disposable directory; never steal/stop that owner or ask
  // the product to use an alternate reservation port for the same root.
  for (let attempt = 0; ; attempt++) {
    try {
      return await createGitProject(t, options);
    } catch (error) {
      if (
        attempt >= 3 ||
        error.message !==
          "Project ownership reservation is busy; retry startup."
      )
        throw error;
    }
  }
}
async function createGitProject(
  t,
  { unborn = false, subfolder = "", objectFormat = "sha1" } = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-git-"));
  const gitInput = (input, ...args) =>
    execFileSync(
      "/usr/bin/git",
      ["-c", "core.hooksPath=/dev/null", "-C", root, ...args],
      { env: gitEnvironment, input, stdio: "pipe", encoding: "utf8" }
    );
  const git = (...args) =>
    execFileSync(
      "/usr/bin/git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-C",
        root,
        ...args,
      ],
      { env: gitEnvironment, encoding: "utf8", stdio: "pipe" }
    );
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  git(
    "init",
    "--quiet",
    "--initial-branch=main",
    "--object-format=" + objectFormat
  );
  write(".gitignore", ".codepaths/\nignored.txt\n");
  write("part.ts", "const amount = 1;\nunchanged\n");
  if (!unborn) {
    git("add", "--", ".gitignore", "part.ts");
    git("commit", "--quiet", "-m", "fixture base");
    git("branch", "equal");
  }
  if (subfolder) fs.mkdirSync(path.join(root, subfolder), { recursive: true });
  let service;
  try {
    service = await startProjectService(path.join(root, subfolder), {
      assetsRoot: path.resolve("dist"),
    });
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  t.after(async () => {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    git,
    gitInput,
    write,
    get service() {
      return service;
    },
    async reopen() {
      await service.close();
      service = await startProjectService(path.join(root, subfolder), {
        assetsRoot: path.resolve("dist"),
      });
    },
  };
}
export async function allChanges(service, query = { mode: "changes" }) {
  let page = await service.call("list_git_changes", { query });
  const files = [...page.files];
  while (!page.complete) {
    page = await service.call("list_git_changes", {
      query,
      cursor: page.nextCursor,
    });
    files.push(...page.files);
  }
  return { ...page, files };
}
