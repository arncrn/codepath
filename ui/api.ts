import type {
  DefinitionLocation,
  Overview,
  ReferenceContext,
  ToolArgs,
  ToolName,
  ToolResults,
} from "../types.mjs";
import { config, inVSCode, request } from "./transport";

// Protocol strings stay here. UI actions use named operations, regardless of
// whether the transport uses browser HTTP or VS Code host messages.
function invokeWorkspaceTool<Name extends ToolName>(
  toolName: Name,
  toolArguments: ToolArgs[Name]
): Promise<ToolResults[Name]> {
  return request<ToolResults[Name]>("/api/call", {
    name: toolName,
    arguments: toolArguments,
  });
}
export function getProjectOverview(walkthroughId?: string): Promise<Overview> {
  return walkthroughId
    ? invokeWorkspaceTool("project_overview", { walkthroughId })
    : request<Overview>("/api/state");
}
export function listComparisonWalkthroughs() {
  return invokeWorkspaceTool("list_comparison_walkthroughs", {});
}
export function getComparisonWalkthrough(id: string) {
  return invokeWorkspaceTool("get_comparison_walkthrough", { id });
}
export function createComparisonWalkthrough(
  input: ToolArgs["create_comparison_walkthrough"]
) {
  return invokeWorkspaceTool("create_comparison_walkthrough", input);
}
export function saveWalkthroughComparisonNote(
  input: ToolArgs["save_walkthrough_comparison_note"]
) {
  return invokeWorkspaceTool("save_walkthrough_comparison_note", input);
}
export function deleteWalkthroughComparisonNote(
  input: ToolArgs["delete_walkthrough_comparison_note"]
) {
  return invokeWorkspaceTool("delete_walkthrough_comparison_note", input);
}
export function checkGitComparison(listId: string) {
  return invokeWorkspaceTool("check_git_comparison", { listId });
}
export function listGitBranches() {
  return invokeWorkspaceTool("list_git_branches", {});
}
export function listGitChanges(input: ToolArgs["list_git_changes"]) {
  return invokeWorkspaceTool("list_git_changes", input);
}
export function listGitExplanations(input: ToolArgs["list_git_explanations"]) {
  return invokeWorkspaceTool("list_git_explanations", input);
}
export function getGitViewed(listId: string) {
  return invokeWorkspaceTool("get_git_viewed", { listId });
}
export function setGitViewed(input: ToolArgs["set_git_viewed"]) {
  return invokeWorkspaceTool("set_git_viewed", input);
}
export function clearGitViewed(input: ToolArgs["clear_git_viewed"]) {
  return invokeWorkspaceTool("clear_git_viewed", input);
}
export function getGitFile(input: ToolArgs["get_git_file"]) {
  return invokeWorkspaceTool("get_git_file", input);
}
export function saveComparisonNote(input: ToolArgs["save_comparison_note"]) {
  return invokeWorkspaceTool("save_comparison_note", input);
}
export function deleteComparisonNote(
  input: ToolArgs["delete_comparison_note"]
) {
  return invokeWorkspaceTool("delete_comparison_note", input);
}
export function getWalkthrough(walkthroughId: string) {
  return invokeWorkspaceTool("get_walkthrough", { id: walkthroughId });
}
export function saveWalkthrough(walkthrough: ToolArgs["save_walkthrough"]) {
  return invokeWorkspaceTool("save_walkthrough", walkthrough);
}
export function deleteWalkthrough(
  confirmedDeletion: ToolArgs["delete_walkthrough"]
) {
  return invokeWorkspaceTool("delete_walkthrough", confirmedDeletion);
}
export function readSource(sourceFile: string) {
  return invokeSourceTool("read_source", { file: sourceFile });
}
let sourceCapability: Promise<void> | null = null;
async function invokeSourceTool<
  N extends
    | "read_source"
    | "inspect_source"
    | "list_source_files"
    | "find_symbols"
    | "search_source",
>(name: N, args: ToolArgs[N]) {
  sourceCapability ??= getProjectOverview()
    .then((overview) => {
      if (
        overview.root !== config.root ||
        overview.capabilities?.onDemandSource !== true
      )
        throw Error(
          "Reload VS Code, then reopen Codepath to use on-demand source indexing. Your draft is kept."
        );
    })
    .catch((error: unknown) => {
      sourceCapability = null;
      throw error;
    });
  await sourceCapability;
  return invokeWorkspaceTool(name, args);
}
export function inspectSource(sourceFile: string) {
  return invokeSourceTool("inspect_source", { file: sourceFile });
}
export function listSourceFiles(query = "", cursor?: string) {
  return invokeSourceTool("list_source_files", {
    query,
    ...(cursor ? { cursor } : {}),
  });
}
export function findSourceSymbols(query = "", cursor?: string) {
  return invokeSourceTool("find_symbols", {
    query,
    ...(cursor ? { cursor } : {}),
  });
}
export function searchSource(searchText: string, cursor?: string) {
  return invokeSourceTool("search_source", {
    query: searchText,
    ...(cursor ? { cursor } : {}),
  });
}
export function getRun(runId: string) {
  return invokeWorkspaceTool("get_run", { id: runId });
}
export function listRuns(walkthroughId: string) {
  return invokeWorkspaceTool("list_runs", { walkthroughId });
}
export function deleteNote(note: ToolArgs["delete_note"]) {
  return invokeWorkspaceTool("delete_note", note);
}
export function addNote(note: ToolArgs["add_note"]) {
  return invokeWorkspaceTool("add_note", note);
}
async function checkNotePresentation(review: ToolArgs["add_reviewed_note"]) {
  if (
    (review.variableName !== undefined || review.archived !== undefined) &&
    (await getProjectOverview()).capabilities?.notePresentation !== true
  )
    throw Error(
      "Reload VS Code, then reopen Codepath to save variable explanations or archived notes. Your draft is kept."
    );
}
export async function addReviewedNote(review: ToolArgs["add_reviewed_note"]) {
  await checkNotePresentation(review);
  return invokeWorkspaceTool("add_reviewed_note", review);
}
export async function reviewNote(review: ToolArgs["review_note"]) {
  await checkNotePresentation(review);
  return invokeWorkspaceTool("review_note", review);
}
export function reviewExplanation(review: ToolArgs["review_explanation"]) {
  return invokeWorkspaceTool("review_explanation", review);
}
export function repairStepSource(repair: ToolArgs["repair_step_source"]) {
  return invokeWorkspaceTool("repair_step_source", repair);
}
// Imports reported values; it does not execute application code.
export function recordRun(run: ToolArgs["record_run"]) {
  return invokeWorkspaceTool("record_run", run);
}
export async function followDefinition(reference: ReferenceContext) {
  if (!inVSCode) throw Error("Following a definition requires VS Code.");
  return request("follow-reference", reference);
}
export async function openSourceInEditor(
  sourceStep: Pick<ReferenceContext, "walkthroughId" | "stepId">
) {
  if (!inVSCode) throw Error("Opening source in an editor requires VS Code.");
  return request<DefinitionLocation>("open-source", sourceStep);
}
