// Shared persisted and wire contracts. JSON still crosses runtime validation in
// the workspace and restricted host bridge; these types do not replace it.
export interface SourceRef {
  file: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  excerpt?: string;
}
export interface CallSite {
  name: string;
  line: number;
}
export interface SourceSymbol {
  file: string;
  name: string;
  startLine: number;
  endLine: number;
  calls: CallSite[];
  approximate?: boolean;
  reason?: string;
  evidence?: Evidence;
  fileHash?: string;
}
export interface FunctionScopes {
  reliable: boolean;
  functions: {
    name: string;
    start: number;
    end: number;
    startLine: number;
    startColumn: number;
  }[];
}
export type FunctionContext =
  | { status: "function"; name: string; startLine: number; startColumn: number }
  | { status: "multiple" | "no-function" }
  | { status: "unknown"; reason: string };
export interface SourceFileInfo {
  file: string;
  lineCount: number;
  hash: string;
  symbols: SourceSymbol[];
  calls?: CallSite[];
  functionScopes?: FunctionScopes;
}
// In-process source interface; never serialized as the project overview.
export interface SourceIndex {
  files: SourceFileInfo[];
  warnings: string[];
  version: string;
  loadFile?: (file: string, currentText?: string) => SourceFileInfo;
  querySymbols?: (
    names: string[],
    cursor?: string,
    directory?: string,
    exclude?: { file: string; startLine: number }
  ) => SourceSymbolsPage;
}
export interface SourceFilesPage {
  files: { file: string }[];
  complete: boolean;
  nextCursor?: string;
  warnings: string[];
}
export interface SourceSymbolsPage {
  symbols: SourceSymbol[];
  matchedNames?: string[];
  complete: boolean;
  nextCursor?: string;
  warnings: string[];
}
export interface SourceOverview {
  files: { file: string }[];
  fileCount: number;
  discoveryComplete: boolean;
  warnings: string[];
  version: string;
}
export interface ResolvedSource {
  file: string;
  symbol?: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  hash: string;
  fileHash: string;
  lines: string[];
  functionContext: FunctionContext;
}
export type Evidence = "source" | "inferred";
export interface Values {
  input?: unknown;
  output?: unknown;
}
export interface SourceAttachment {
  file: string;
  fileHash: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  text: string;
  sourceExcerpt?: string;
  sourceStartLine?: number;
}
export interface ExplanationRevision {
  body: string;
  author: string;
  at: string;
  hash: string;
  attachments?: SourceAttachment[];
}
export interface SourceReview {
  walkthroughId: string;
  stepId: string;
  expectedRevision: number;
  sourceHash: string;
  fileHash: string;
  body: string;
  author: string;
  attachments: SourceAttachment[];
}
export interface NoteRevision extends ExplanationRevision {
  variableName?: string;
  archived?: boolean;
}
export interface NoteReview extends SourceReview {
  variableName?: string | null;
  archived?: boolean;
}
export interface Note {
  id: string;
  body: string;
  author: string;
  at: string;
  hash: string;
  stale?: boolean;
  history?: NoteRevision[];
  attachments?: SourceAttachment[];
  reviewRequired?: boolean;
  variableName?: string;
  archived?: boolean;
}
export type CallbackRole =
  "registration" | "definition" | "activation-call-site";
export function parseCallbackRole(value: unknown): CallbackRole | undefined {
  if (
    value === undefined ||
    value === "registration" ||
    value === "definition" ||
    value === "activation-call-site"
  )
    return value;
  throw Error(
    "Invalid callback role. Choose registration, definition or activation-call-site."
  );
}
export interface StepInput {
  id: string;
  title: string;
  source: SourceRef;
  explanation?: string;
  evidence?: Evidence;
  sample?: Values;
  callbackRole?: CallbackRole | null;
}
export interface SavedStep extends Omit<StepInput, "callbackRole"> {
  callbackRole?: CallbackRole;
  explanation: string;
  evidence: Evidence;
  snapshotHash: string;
  notes: Note[];
  explanationAttachments?: SourceAttachment[];
  explanationAuthor?: string;
  explanationAt?: string;
  explanationHistory?: ExplanationRevision[];
  explanationReviewRequired?: boolean;
}
export interface Step extends SavedStep {
  code?: ResolvedSource;
  stale: boolean;
  error?: string;
}
export interface SavedWalkthrough {
  id: string;
  title: string;
  description: string;
  steps: SavedStep[];
  revision: number;
}
export interface Walkthrough extends Omit<SavedWalkthrough, "steps"> {
  steps: Step[];
}
export interface RunEvent extends Values {
  stepId: string;
  sourceHash?: string;
  at?: string;
}
export interface Run {
  id: string;
  walkthroughId: string;
  label: string;
  mode: "recorded" | "example";
  origin: string;
  at: string;
  events: RunEvent[];
}
export interface Focus {
  walkthroughId: string;
  stepId: string;
  nonce: string;
}
export interface WorkspaceState {
  format: number;
  revision: number;
  paths: SavedWalkthrough[];
  runs: Run[];
  focus: Focus | null;
}
export interface Overview {
  root: string;
  project: string;
  revision: number;
  capabilities?: {
    notePresentation: true;
    onDemandSource?: true;
    authoringValidation?: true;
  };
  index: SourceOverview;
  focus: Focus | null;
  paths: (Omit<SavedWalkthrough, "steps"> & { count: number })[];
  runs: RunSummary[];
}
export type RunSummary = Omit<Run, "events"> & { count: number };
export interface Position {
  file: string;
  line: number;
  column: number;
}
export interface ReferenceContext {
  walkthroughId: string;
  stepId: string;
  fileHash: string;
  line: number;
  column: number;
}
export interface DefinitionLocation {
  file: string;
  startLine: number;
  endLine: number;
  name?: string;
  reason?: string;
}
export interface DefinitionCandidate {
  title: string;
  source: SourceRef;
  evidence: Evidence;
  explanation: string;
}
export interface ReferenceResult {
  name: string;
  fileHash: string;
  candidates: SourceSymbol[];
  limitation: string;
  complete?: boolean;
  nextCursor?: string;
}
export interface SourceIdentity {
  file: string;
  startLine: number;
  endLine: number;
}
export interface SourceUsageLocation {
  walkthroughId: string;
  walkthroughTitle: string;
  stepId: string;
  stepTitle: string;
  position: number;
}
export interface SourceUsage extends SourceUsageLocation {
  identity: SourceIdentity;
}
export interface UnresolvedSourceUsage extends SourceUsageLocation {
  error: string;
}
export type StepSourceUsages =
  | {
      stepId: string;
      status: "resolved";
      identity: SourceIdentity;
      exact: SourceUsage[];
      overlapping: SourceUsage[];
    }
  | { stepId: string; status: "unresolved"; error: string };
export interface SourceUsageBatch {
  walkthroughId: string;
  steps: StepSourceUsages[];
  unresolved: UnresolvedSourceUsage[];
}
export interface AuthoringIssue {
  code:
    | "empty-walkthrough"
    | "source-unavailable"
    | "missing-purpose"
    | "stale-card"
    | "stale-note"
    | "missing-note-body"
    | "unbound-note"
    | "invalid-attachment"
    | "duplicate-purpose"
    | "missing-block-notes"
    | "missing-variables";
  stepId?: string;
  noteId?: string;
  message: string;
}
export interface AuthoringNotApplicable {
  stepId: string;
  sourceHash: string;
  fileHash: string;
  notes?: string;
  variables?: string;
}
export interface AuthoringReport {
  walkthroughId: string;
  revision: number;
  ready: boolean;
  issueCount: number;
  issues: AuthoringIssue[];
  steps: {
    stepId: string;
    sourceHash?: string;
    fileHash?: string;
    blockNotes: number;
    variables: { noteId: string; name: string; occurrences: number }[];
  }[];
  notApplicable: AuthoringNotApplicable[];
  limitation: string;
}
export interface ToolArgs {
  project_overview: { walkthroughId?: string };
  read_source: { file: string; startLine?: number; endLine?: number };
  inspect_source: { file: string };
  list_source_files: { query?: string; cursor?: string };
  find_symbols: { query?: string; cursor?: string };
  search_source: { query: string; cursor?: string };
  follow_calls: { source: SourceRef; cursor?: string };
  resolve_reference: Position & { cursor?: string; identifyOnly?: boolean };
  get_walkthrough: { id: string };
  validate_walkthrough: {
    walkthroughId: string;
    expectedRevision: number;
    notApplicable?: AuthoringNotApplicable[];
  };
  source_usages: { walkthroughId: string };
  save_walkthrough: {
    id?: string;
    title: string;
    description?: string;
    steps: StepInput[];
    expectedRevision?: number;
  };
  delete_walkthrough: { id: string; expectedRevision: number };
  add_note: {
    walkthroughId: string;
    stepId: string;
    body: string;
    author: string;
  };
  add_reviewed_note: NoteReview;
  review_note: NoteReview & { noteId: string };
  review_explanation: SourceReview;
  repair_step_source: {
    walkthroughId: string;
    stepId: string;
    expectedRevision: number;
    source: SourceRef;
    fileHash: string;
  };
  focus_step: { walkthroughId: string; stepId: string };
  list_runs: { walkthroughId: string };
  get_run: { id: string };
  record_run: {
    walkthroughId: string;
    label: string;
    mode: Run["mode"];
    origin: string;
    events: RunEvent[];
  };
}
export interface ToolResults {
  project_overview: Overview;
  read_source: {
    file: string;
    startLine: number;
    endLine: number;
    fileHash: string;
    text: string;
  };
  inspect_source: SourceFileInfo;
  list_source_files: SourceFilesPage;
  find_symbols: SourceSymbolsPage;
  search_source: {
    hits: {
      file: string;
      line: number;
      text: string;
      fileHash?: string;
      lineCount?: number;
    }[];
    limit: number;
    complete?: boolean;
    nextCursor?: string;
    warnings?: string[];
  };
  follow_calls: {
    candidates: SourceSymbol[];
    calls: CallSite[];
    unresolved: CallSite[];
    unresolvedComplete?: boolean;
    limitation: string;
    complete?: boolean;
    nextCursor?: string;
  };
  resolve_reference: ReferenceResult;
  get_walkthrough: Walkthrough;
  validate_walkthrough: AuthoringReport;
  source_usages: SourceUsageBatch;
  save_walkthrough: Walkthrough;
  delete_walkthrough: { id: string; deleted: boolean };
  add_note: Note;
  add_reviewed_note: Note;
  review_note: Note;
  review_explanation: Walkthrough;
  repair_step_source: Walkthrough;
  focus_step: Focus;
  list_runs: RunSummary[];
  get_run: Run;
  record_run: Run;
}
export type ToolName = keyof ToolArgs;
export interface ToolClient {
  call<N extends ToolName>(name: N, args: ToolArgs[N]): Promise<ToolResults[N]>;
  request(route: "/api/state"): Promise<Overview>;
  request(route: string, body?: unknown): Promise<unknown>;
}
export interface ProjectService extends ToolClient {
  root: string;
  url: string;
  owned: boolean;
  close(): Promise<void>;
}
export interface AppConfig {
  host?: "vscode";
  demo: boolean;
  backend: "node" | "go";
  root: string;
  toolRoot: string;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
