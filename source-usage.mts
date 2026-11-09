import fs from "node:fs";
import path from "node:path";
import { read, resolve } from "./indexer.mjs";
import { errorMessage } from "./types.mjs";
import type {
  SourceIdentity,
  SourceIndex,
  SourceRef,
  SourceUsage,
  SourceUsageBatch,
  SourceUsageLocation,
  StepSourceUsages,
  UnresolvedSourceUsage,
} from "./types.mjs";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const validTitle = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 200;

function sourceRef(value: unknown): SourceRef {
  if (
    !record(value) ||
    typeof value.file !== "string" ||
    !value.file ||
    (value.symbol !== undefined &&
      (typeof value.symbol !== "string" || !value.symbol)) ||
    (value.excerpt !== undefined && typeof value.excerpt !== "string") ||
    (value.startLine !== undefined &&
      (typeof value.startLine !== "number" ||
        !Number.isInteger(value.startLine) ||
        value.startLine < 1)) ||
    (value.endLine !== undefined &&
      (typeof value.endLine !== "number" ||
        !Number.isInteger(value.endLine) ||
        value.endLine < 1))
  )
    throw Error("Invalid saved source reference.");
  return {
    file: value.file,
    ...(typeof value.symbol === "string" ? { symbol: value.symbol } : {}),
    ...(typeof value.excerpt === "string" ? { excerpt: value.excerpt } : {}),
    ...(typeof value.startLine === "number"
      ? { startLine: value.startLine }
      : {}),
    ...(typeof value.endLine === "number" ? { endLine: value.endLine } : {}),
  };
}

function resolveIdentity(
  root: string,
  index: SourceIndex,
  input: unknown
): SourceIdentity {
  const ref = sourceRef(input);
  // read enforces the existing relative-path, extension, size and realpath
  // containment rules before an alias is canonicalized.
  const text = read(root, ref.file);
  const file = path
    .relative(root, fs.realpathSync(path.join(root, ref.file)))
    .split(path.sep)
    .join("/");
  if (!ref.symbol && ref.excerpt) {
    const offset = text.indexOf(ref.excerpt);
    if (offset < 0)
      throw Error("Saved source excerpt is missing. Review its reference.");
    if (text.indexOf(ref.excerpt, offset + 1) >= 0)
      throw Error(
        "Saved source excerpt is ambiguous. Choose an exact reference."
      );
  }
  const code = resolve(root, index, { ...ref, file });
  return { file, startLine: code.startLine, endLine: code.endLine };
}

const identityKey = (identity: SourceIdentity) =>
  JSON.stringify([identity.file, identity.startLine, identity.endLine]);

export function buildSourceUsageIndex(
  root: string,
  index: SourceIndex,
  savedPaths: unknown
) {
  root = fs.realpathSync(root);
  if (!Array.isArray(savedPaths)) throw Error("Invalid saved source usages.");
  const byWalkthrough = new Map<
    string,
    (SourceUsage | UnresolvedSourceUsage)[]
  >();
  const byIdentity = new Map<string, SourceUsage[]>();
  const byFile = new Map<string, SourceUsage[]>();
  const unresolved: UnresolvedSourceUsage[] = [];
  for (const savedPath of savedPaths) {
    if (
      !record(savedPath) ||
      !validId(savedPath.id) ||
      !validTitle(savedPath.title) ||
      !Array.isArray(savedPath.steps) ||
      byWalkthrough.has(savedPath.id)
    )
      throw Error("Invalid saved source usage path.");
    const locations: (SourceUsage | UnresolvedSourceUsage)[] = [];
    byWalkthrough.set(savedPath.id, locations);
    const stepIds = new Set<string>();
    for (const [position, step] of savedPath.steps.entries()) {
      if (
        !record(step) ||
        !validId(step.id) ||
        !validTitle(step.title) ||
        stepIds.has(step.id)
      )
        throw Error("Invalid saved source usage step.");
      stepIds.add(step.id);
      const location: SourceUsageLocation = {
        walkthroughId: savedPath.id,
        walkthroughTitle: savedPath.title,
        stepId: step.id,
        stepTitle: step.title,
        position,
      };
      try {
        const identity = resolveIdentity(root, index, step.source);
        const usage: SourceUsage = { ...location, identity };
        locations.push(usage);
        const key = identityKey(identity);
        const exact = byIdentity.get(key) ?? [];
        exact.push(usage);
        byIdentity.set(key, exact);
        const fileUsages = byFile.get(identity.file) ?? [];
        fileUsages.push(usage);
        byFile.set(identity.file, fileUsages);
      } catch (error) {
        const usage = { ...location, error: errorMessage(error) };
        locations.push(usage);
        unresolved.push(usage);
      }
    }
  }
  return {
    forWalkthrough(walkthroughId: unknown): SourceUsageBatch {
      if (!validId(walkthroughId)) throw Error("Invalid walkthrough ID.");
      const locations = byWalkthrough.get(walkthroughId);
      if (!locations) throw Error("Walkthrough not found.");
      const steps: StepSourceUsages[] = locations.map((location) => {
        if (!("identity" in location))
          return {
            stepId: location.stepId,
            status: "unresolved",
            error: location.error,
          };
        const identity = location.identity;
        const key = identityKey(identity);
        return {
          stepId: location.stepId,
          status: "resolved",
          identity,
          exact: byIdentity.get(key) ?? [],
          overlapping: (byFile.get(identity.file) ?? []).filter(
            (usage) =>
              identityKey(usage.identity) !== key &&
              usage.identity.startLine <= identity.endLine &&
              usage.identity.endLine >= identity.startLine
          ),
        };
      });
      return { walkthroughId, steps, unresolved };
    },
  };
}
