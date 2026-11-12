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
// Immutable Git/legacy snapshots retain raw code only. Lexical context is a
// derived read projection, never a stored rebind or part of the source seal.
export interface SourceCode {
  file: string;
  symbol?: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  hash: string;
  fileHash: string;
  lines: string[];
}
export interface ResolvedSource extends SourceCode {
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
export interface ReviewSideInput {
  file: string;
  content: string;
  provenance: string;
  startLine: number;
  endLine: number;
  purpose: string;
  notes: { body: string; startLine: number; endLine: number }[];
  variables: {
    name: string;
    body: string;
    occurrences: { line: number; startColumn: number }[];
  }[];
  notApplicable?: { notes?: string; variables?: string };
}
export interface ReviewCardInput {
  id: string;
  title: string;
  beforeBehavior: string;
  afterBehavior: string;
  reason: string;
  before: ReviewSideInput;
  after: ReviewSideInput;
}
export interface ChangeReviewInput {
  id?: string;
  title: string;
  cards: ReviewCardInput[];
}
export interface ReviewSnapshot {
  file: string;
  content: string;
  provenance: string;
  fingerprint: string;
  code: SourceCode;
  purpose: string;
  notes: Note[];
  notApplicable?: { notes?: string; variables?: string };
}
export interface ChangeReview {
  id: string;
  title: string;
  capturedAt: string;
  fingerprint: string;
  cards: (Omit<ReviewCardInput, "before" | "after"> & {
    before: ReviewSnapshot;
    after: ReviewSnapshot;
  })[];
}
export interface ChangeReviewView extends ChangeReview {
  live: {
    cardId: string;
    file: string;
    status: "matches-after" | "changed" | "unavailable";
    fingerprint?: string;
    error?: string;
  }[];
}
export type ChangeReviewSummary = Pick<
  ChangeReview,
  "id" | "title" | "capturedAt" | "fingerprint"
>;
export type GitQuery =
  { mode: "changes" } | { mode: "compare"; base: string; target: string };
export type GitGroup = "staged" | "unstaged" | "untracked" | "compare";
export interface GitChangedFile {
  id: string;
  file: string;
  oldFile?: string;
  group: GitGroup;
  status: "added" | "deleted" | "modified" | "renamed" | "unavailable";
}
export interface GitCoverage {
  scope: "project nonignored allowed paths";
  allowed: {
    scanned: number;
    candidates: number;
    listedPairs: number;
    complete: boolean;
  };
  restricted: {
    candidatePaths: number;
    knownChangedPaths: number;
    workingChanges: "unknown" | "not-selected";
  };
}
export interface GitChangesPage {
  listId: string;
  files: GitChangedFile[];
  complete: boolean;
  coverage: GitCoverage;
  nextCursor?: string;
}
export interface GitSourceSide {
  label: string;
  file: string;
  mode: string;
  content?: string;
  code?: SourceCode;
  unavailable?: string;
}
export interface ComparisonNote extends Note {
  binding: string;
  side: "before" | "after";
  history?: (NoteRevision & { binding: string; side: "before" | "after" })[];
}
export interface ComparisonNotes {
  scope: string;
  revision: number;
  notes: ComparisonNote[];
}
export interface GitFileView {
  listId: string;
  file: GitChangedFile;
  binding: string;
  scope: string;
  before: GitSourceSide;
  after: GitSourceSide;
  patch: string;
  patchMatchesRaw?: { before: boolean; after: boolean };
  unavailable?: string;
  annotations: ComparisonNotes;
}
export interface ComparisonNoteInput {
  listId: string;
  fileId: string;
  binding: string;
  side: "before" | "after";
  expectedRevision: number;
  noteId?: string;
  body: string;
  author: string;
  attachments: SourceAttachment[];
  variableName?: string;
}
export interface AuthoredComparisonSide extends Omit<
  ReviewSideInput,
  "file" | "content" | "provenance"
> {
  title: string;
}
export interface ComparisonWalkthroughInput {
  title: string;
  listId: string;
  steps: {
    id: string;
    title: string;
    fileId: string;
    binding: string;
    before: AuthoredComparisonSide;
    after: AuthoredComparisonSide;
  }[];
}
export type AdmittedGitFile = Omit<GitFileView, "annotations">;
export interface SavedComparisonStep {
  id: string;
  title: string;
  fileId: string;
  binding: string;
  before: Pick<
    AuthoredComparisonSide,
    "title" | "purpose" | "startLine" | "endLine" | "notApplicable"
  >;
  after: SavedComparisonStep["before"];
  annotations: ComparisonNotes;
}
export interface SavedComparisonWalkthrough {
  // Versioned accidental-corruption seal, authored once; never stamped on read.
  sourceSeal: string;
  id: string;
  title: string;
  query: GitQuery;
  sources: Record<string, AdmittedGitFile>;
  steps: SavedComparisonStep[];
}
export interface ComparisonWalkthroughStep extends Omit<
  SavedComparisonStep,
  "before" | "after"
> {
  before: GitSourceSide &
    SavedComparisonStep["before"] & { code: ResolvedSource };
  after: GitSourceSide &
    SavedComparisonStep["after"] & { code: ResolvedSource };
  file: GitChangedFile;
  patch: string;
  patchMatchesRaw?: { before: boolean; after: boolean };
}
export interface ComparisonWalkthrough extends Omit<
  SavedComparisonWalkthrough,
  "sources" | "steps" | "sourceSeal"
> {
  steps: ComparisonWalkthroughStep[];
}
export type ComparisonWalkthroughSummary = Pick<
  ComparisonWalkthrough,
  "id" | "title"
> & { count: number };
export interface WalkthroughComparisonNoteInput extends Omit<
  ComparisonNoteInput,
  "listId" | "fileId"
> {
  walkthroughId: string;
  stepId: string;
}
export interface DeleteWalkthroughComparisonNoteInput {
  walkthroughId: string;
  stepId: string;
  scope: string;
  noteId: string;
  expectedRevision: number;
}
export interface GitViewedRecord {
  readonly identity: string;
  readonly revision: number;
  readonly viewed: boolean;
}
export type GitViewedPair = { readonly fileId: string } & (
  | GitViewedRecord
  | {
      readonly disabledReason: string;
      readonly identity?: never;
      readonly revision?: never;
      readonly viewed: false;
    }
);
export interface GitViewedInput {
  query: GitQuery;
  fileId: string;
  identity: string;
  expectedRevision: number;
}
export interface WorkspaceState {
  format: number;
  revision: number;
  paths: SavedWalkthrough[];
  runs: Run[];
  focus: Focus | null;
  changeReviews?: ChangeReview[];
  comparisonNotes?: ComparisonNotes[];
  comparisonWalkthroughs?: SavedComparisonWalkthrough[];
  gitViewed?: GitViewedRecord[];
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
  list_git_explanations: { query: GitQuery; fileId: string; binding: string };
  get_git_viewed: { listId: string };
  set_git_viewed: GitViewedInput;
  clear_git_viewed: { identity: string; expectedRevision: number };
  save_walkthrough_comparison_note: WalkthroughComparisonNoteInput;
  delete_walkthrough_comparison_note: DeleteWalkthroughComparisonNoteInput;
  create_comparison_walkthrough: ComparisonWalkthroughInput;
  list_comparison_walkthroughs: Record<string, never>;
  get_comparison_walkthrough: { id: string };
  check_git_comparison: { listId: string };
  list_git_branches: Record<string, never>;
  list_git_changes: { query: GitQuery; cursor?: string };
  get_git_file: { listId: string; fileId: string };
  save_comparison_note: ComparisonNoteInput;
  delete_comparison_note: {
    scope: string;
    noteId: string;
    expectedRevision: number;
  };
  create_change_review: ChangeReviewInput;
  get_change_review: { id: string };
  list_change_reviews: Record<string, never>;
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
  delete_note: {
    walkthroughId: string;
    stepId: string;
    noteId: string;
    expectedRevision: number;
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
  list_git_explanations: {
    walkthroughId: string;
    title: string;
    stepId: string;
    stepTitle: string;
  }[];
  get_git_viewed: { readonly pairs: readonly GitViewedPair[] };
  set_git_viewed: GitViewedRecord;
  clear_git_viewed: GitViewedRecord;
  save_walkthrough_comparison_note: ComparisonNotes;
  delete_walkthrough_comparison_note: ComparisonNotes;
  create_comparison_walkthrough: ComparisonWalkthrough;
  list_comparison_walkthroughs: ComparisonWalkthroughSummary[];
  get_comparison_walkthrough: ComparisonWalkthrough;
  check_git_comparison: { current: boolean };
  list_git_branches: {
    branches: { ref: string; name: string; oid: string }[];
    head?: string;
  };
  list_git_changes: GitChangesPage;
  get_git_file: GitFileView & {
    functionContexts: { before: FunctionContext; after: FunctionContext };
  };
  save_comparison_note: ComparisonNotes;
  delete_comparison_note: ComparisonNotes;
  create_change_review: ChangeReviewView;
  get_change_review: ChangeReviewView;
  list_change_reviews: ChangeReviewSummary[];
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
  delete_note: Note;
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
