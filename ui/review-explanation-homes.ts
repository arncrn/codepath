import type { ComparisonWalkthroughStep, GitChangedFile } from "../types.mjs";

// Display grouping only. A path or group match NEVER authorizes source marks,
// editing, variable occurrences, relocation, or an explanation's currentness.
export function explanationHomes(
  steps: readonly ComparisonWalkthroughStep[],
  files: readonly GitChangedFile[]
) {
  const ids = new Map(files.map((file) => [file.id, file]));
  const paths = new Map<string, GitChangedFile[]>();
  const key = (file: GitChangedFile) =>
    JSON.stringify([file.file, file.oldFile ?? null]);
  for (const file of files)
    paths.set(key(file), [...(paths.get(key(file)) ?? []), file]);
  const byFile = new Map<string, ComparisonWalkthroughStep[]>(),
    unmatched: ComparisonWalkthroughStep[] = [];
  for (const step of steps) {
    const candidates = paths.get(key(step.file)) ?? [],
      sameGroup = candidates.filter((file) => file.group === step.file.group);
    const home =
      ids.get(step.fileId) ??
      (sameGroup.length === 1
        ? sameGroup[0]
        : candidates.length === 1
          ? candidates[0]
          : undefined);
    if (home) byFile.set(home.id, [...(byFile.get(home.id) ?? []), step]);
    else unmatched.push(step);
  }
  return { byFile, unmatched };
}
