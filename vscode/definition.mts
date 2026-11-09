import crypto from "node:crypto";

import type {
  Walkthrough,
  ReferenceContext,
  SourceFileInfo,
  DefinitionLocation,
  DefinitionCandidate,
  ToolClient,
  Position,
  StepInput,
} from "../types.mjs";
function checkedStep(walk: Walkthrough, context: ReferenceContext) {
  const step = walk.steps.find((s) => s.id === context.stepId);
  if (!step?.code || step.error)
    throw Error(step?.error || "Source is no longer available.");
  if (
    typeof context.fileHash !== "string" ||
    context.fileHash !== step.code.fileHash
  )
    throw Error(
      "Source changed since this card was rendered. Refresh Codepath before following this symbol."
    );
  return { ...step, code: step.code };
}
function candidateSource(
  entry: SourceFileInfo,
  target: DefinitionLocation & { name: string }
) {
  if (
    !entry ||
    !Number.isInteger(target.startLine) ||
    !Number.isInteger(target.endLine) ||
    target.startLine < 1 ||
    target.endLine < target.startLine ||
    target.endLine > entry.lineCount
  )
    return null;
  const symbol = entry.symbols
    .filter(
      (s) => s.startLine <= target.startLine && s.endLine >= target.startLine
    )
    .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];
  if (symbol) {
    const unique =
      entry.symbols.filter((s) => s.name === symbol.name).length === 1;
    return {
      title: symbol.name,
      source: {
        file: target.file,
        ...(unique
          ? { symbol: symbol.name }
          : { startLine: symbol.startLine, endLine: symbol.endLine }),
      },
    };
  }
  return {
    title: target.name,
    source: {
      file: target.file,
      startLine: target.startLine,
      endLine: target.endLine,
    },
  };
}

// One operation owns validation, definition preference, ambiguity, insertion and
// focus. The editor supplies language definitions; all writes use the service.
interface FollowOptions {
  findDefinitions?: (
    position: Position
  ) => Promise<{ locations: DefinitionLocation[]; external: boolean }>;
  choose?: (
    candidates: DefinitionCandidate[],
    name: string
  ) => Promise<DefinitionCandidate | null | undefined>;
}
export async function followReference(
  service: ToolClient,
  context: ReferenceContext,
  {
    findDefinitions = async () => ({ locations: [], external: false }),
    choose = async () => null,
  }: FollowOptions = {}
) {
  const walk = await service.call("get_walkthrough", {
    id: context.walkthroughId,
  });
  const step = checkedStep(walk, context);
  const reference = await service.call("resolve_reference", {
    file: step.code.file,
    line: context.line,
    column: context.column,
    identifyOnly: true,
  });
  if (reference.fileHash !== context.fileHash)
    throw Error("Source changed. Refresh Codepath and try again.");
  const native = await findDefinitions({
    file: step.code.file,
    line: context.line,
    column: context.column,
  });
  const byLanguage = native.locations.length > 0 || native.external;
  const raw: (DefinitionLocation & { reason?: string })[] = [
    ...native.locations,
  ];
  if (!byLanguage) {
    let cursor: string | undefined;
    const deadline = performance.now() + 5000;
    do {
      const page = await service.call("resolve_reference", {
        file: step.code.file,
        line: context.line,
        column: context.column,
        ...(cursor ? { cursor } : {}),
      });
      if (page.fileHash !== context.fileHash)
        throw Error("Source changed. Refresh Codepath and try again.");
      raw.push(...page.candidates);
      cursor = page.nextCursor;
      if (cursor && performance.now() > deadline)
        throw Error(
          "Definition search is incomplete. Use a language provider or choose a source file explicitly."
        );
    } while (cursor);
  }
  const candidates: DefinitionCandidate[] = [];
  for (const target of raw) {
    let entry: SourceFileInfo;
    try {
      entry = await service.call("inspect_source", { file: target.file });
    } catch (error) {
      if (
        error instanceof Error &&
        /not indexed|not a project source|exceeds 1 MiB|ENOENT|EACCES|relative source filename/i.test(
          error.message
        )
      )
        continue;
      throw error;
    }
    const resolved = candidateSource(entry, {
      ...target,
      name: target.name ?? reference.name,
    });
    if (!resolved) continue;
    const candidate: DefinitionCandidate = {
      ...resolved,
      title: resolved.title.slice(0, 200),
      evidence: byLanguage ? "source" : "inferred",
      explanation: byLanguage
        ? "VS Code Go to Definition resolved " +
          reference.name +
          " from " +
          step.code.file +
          ":" +
          context.line +
          ". This links a source reference, not proof of invocation or execution."
        : (target.reason ?? ""),
    };
    if (
      !candidates.some(
        (c) => JSON.stringify(c.source) === JSON.stringify(candidate.source)
      )
    )
      candidates.push(candidate);
  }
  if (!candidates.length)
    return {
      message:
        "No " +
        (native.external ? "in-project " : "indexed ") +
        "definition for " +
        reference.name +
        ". It may be external or unsupported. You can follow a project callback identifier instead.",
    };
  const target =
    candidates.length === 1
      ? candidates[0]
      : await choose(candidates, reference.name);
  if (!target) return { cancelled: true };
  if (!candidates.includes(target))
    throw Error("Choose one of the returned definitions.");
  // A note/agent edit while the definition provider was working must survive.
  const current = await service.call("get_walkthrough", { id: walk.id });
  checkedStep(current, context);
  const id = crypto.randomUUID(),
    steps: StepInput[] = [...current.steps];
  steps.splice(steps.findIndex((s) => s.id === context.stepId) + 1, 0, {
    id,
    ...target,
    // Definition provenance is useful in the chooser, but it does not explain
    // the highlighted function. Leave that description for an actual reading.
    explanation: "",
  });
  await service.call("save_walkthrough", {
    id: current.id,
    title: current.title,
    description: current.description,
    steps,
    expectedRevision: current.revision,
  });
  await service.call("focus_step", { walkthroughId: current.id, stepId: id });
  return { walkthroughId: current.id, stepId: id };
}
