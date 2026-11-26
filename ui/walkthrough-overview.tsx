import { useRef, useState } from "react";
import type { Walkthrough } from "../types.mjs";
import { errorMessage, walkthroughOverviewLimit } from "../types.mjs";
import { saveWalkthroughOverview } from "./api";
import { MarkdownBody } from "./markdown-body";

const template = `## Big picture

What behavior does this walkthrough explain, and what is its result?

## Mental model

- Name the important concepts and how they fit together.
- Describe the main sequence and any important decisions.

## Worked example

Use one concrete input or scenario and explain its result. Label hypothetical values as examples, not observed execution.

## Keep in mind

Explain assumptions, edge cases, and what this walkthrough does not cover.
`;
interface OverviewDraft {
  instance: symbol;
  version: number;
  body: string;
  base: string;
  revision: number;
  busy: boolean;
  error: string;
}

export function WalkthroughPages({
  page,
  change,
}: {
  page: "overview" | "cards";
  change: (page: "overview" | "cards") => void;
}) {
  return (
    <div
      className="walkthrough-pages"
      role="navigation"
      aria-label="Walkthrough pages"
    >
      <button
        id="overview-page"
        aria-pressed={page === "overview"}
        aria-controls="walkthrough-overview"
        onClick={() => change("overview")}
      >
        Overview
      </button>
      <button
        id="cards-page"
        aria-pressed={page === "cards"}
        aria-controls="walkthrough-cards"
        onClick={() => change("cards")}
      >
        Code cards
      </button>
    </div>
  );
}

export function WalkthroughOverview({
  walkthrough,
  hidden,
  selectStep,
  readCards,
  refresh,
}: {
  walkthrough: Walkthrough | null;
  hidden: boolean;
  selectStep: (id: string) => void;
  readCards: () => void;
  refresh: () => Promise<void>;
}) {
  // Drafts stay in this mounted reader, never in reading-context or workspace
  // data. Polls and navigation cannot replace them; old saves cannot clear a
  // newer edit or a discarded-and-recreated editor with the same walkthrough ID.
  const drafts = useRef(new Map<string, OverviewDraft>());
  const [, render] = useState(0);
  const latest = useRef({ walkthrough, refresh });
  latest.current = { walkthrough, refresh };
  function put(id: string, draft?: OverviewDraft) {
    if (draft) drafts.current.set(id, draft);
    else drafts.current.delete(id);
    render((n) => n + 1);
  }
  function begin(body?: string) {
    if (!walkthrough || drafts.current.has(walkthrough.id)) return;
    put(walkthrough.id, {
      instance: Symbol("overview draft"),
      version: 0,
      body: body ?? walkthrough.overview ?? "",
      base: walkthrough.overview ?? "",
      revision: walkthrough.revision,
      busy: false,
      error: "",
    });
  }
  async function save() {
    const target = latest.current.walkthrough;
    if (!target) return;
    const submitted = drafts.current.get(target.id);
    if (!submitted || submitted.busy) return;
    if (
      (target.overview ?? "") !== submitted.base ||
      target.revision < submitted.revision
    ) {
      put(target.id, {
        ...submitted,
        error:
          "The saved overview changed elsewhere. Your draft is kept. Copy it or discard the draft to load the saved version.",
      });
      return;
    }
    put(target.id, { ...submitted, busy: true, error: "" });
    let saved: Walkthrough | undefined;
    try {
      saved = await saveWalkthroughOverview({
        walkthroughId: target.id,
        expectedRevision: target.revision,
        overview: submitted.body,
      });
      // Fetch current state rather than installing the response: the user may
      // have switched/deleted/recreated a walkthrough while this request waited.
      await latest.current.refresh();
      const current = drafts.current.get(target.id);
      if (current?.instance !== submitted.instance) return;
      if (current.version === submitted.version) put(target.id);
      else
        put(target.id, {
          ...current,
          base: saved.overview ?? "",
          revision: saved.revision,
          busy: false,
          error: "",
        });
    } catch (error) {
      const current = drafts.current.get(target.id);
      if (current?.instance !== submitted.instance) return;
      put(target.id, {
        ...current,
        busy: false,
        ...(saved
          ? { base: saved.overview ?? "", revision: saved.revision }
          : {}),
        error: saved
          ? "Overview saved, but refresh failed. Your draft is kept. " +
            errorMessage(error)
          : errorMessage(error),
      });
    }
  }
  if (!walkthrough) return null;
  const draft = drafts.current.get(walkthrough.id);
  return (
    <section
      id="walkthrough-overview"
      hidden={hidden}
      aria-labelledby="overview-heading"
    >
      <header className="overview-heading">
        <div>
          <h2 id="overview-heading">The big picture</h2>
          <p>A quick mental model before you follow the code.</p>
        </div>
        <div className="overview-actions">
          {!draft && (
            <button className="secondary" onClick={() => begin()}>
              {walkthrough.overview?.trim()
                ? "Edit overview"
                : "Write overview"}
            </button>
          )}
          <button
            className="primary"
            onClick={readCards}
            disabled={!walkthrough.steps.length}
          >
            Read code cards →
          </button>
        </div>
      </header>
      {walkthrough.steps.some((step) => step.stale) && (
        <p className="overview-warning">
          Some source cards have changed or are unavailable. Check this overview
          against the current code; reading it does not review explanations.
        </p>
      )}
      <div className="overview-layout">
        <div className="overview-document">
          {draft ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <label htmlFor="overview-text">
                Walkthrough overview Markdown
              </label>
              <p className="overview-help">
                Explain the big picture, key concepts, a concrete example, and
                important caveats. Markdown headings, lists and code blocks are
                supported.
              </p>
              <textarea
                id="overview-text"
                maxLength={walkthroughOverviewLimit}
                value={draft.body}
                onChange={(event) =>
                  put(walkthrough.id, {
                    ...draft,
                    body: event.target.value,
                    version: draft.version + 1,
                    error: "",
                  })
                }
              />
              <div className="overview-actions">
                <button className="primary" disabled={draft.busy}>
                  {draft.busy ? "Saving overview…" : "Save overview"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => put(walkthrough.id)}
                >
                  Discard draft
                </button>
                <small>
                  {draft.body.length.toLocaleString()} /{" "}
                  {walkthroughOverviewLimit.toLocaleString()}
                </small>
              </div>
              {draft.error && (
                <p role="alert" className="overview-warning">
                  {draft.error}
                </p>
              )}
              <details className="overview-preview">
                <summary>Preview Markdown</summary>
                <MarkdownBody body={draft.body} />
              </details>
            </form>
          ) : walkthrough.overview?.trim() ? (
            <MarkdownBody body={walkthrough.overview} />
          ) : (
            <div className="overview-empty">
              <h3>No overview yet</h3>
              {walkthrough.description && <p>{walkthrough.description}</p>}
              <p>
                Add the overall explanation, important concepts and examples
                here. Card titles alone are not an explanation of the whole
                behavior.
              </p>
              <button className="secondary" onClick={() => begin(template)}>
                Use cheat-sheet template
              </button>
              <p>
                Or ask your agent:{" "}
                <code>
                  /codepath Add an overview with a mental model and worked
                  example to this walkthrough.
                </code>
              </p>
            </div>
          )}
        </div>
        <div className="overview-map">
          <h3>Explore the code</h3>
          <p>
            Jump to a card. This is reading order, not an inferred call graph.
          </p>
          <ol>
            {walkthrough.steps.map((step, index) => (
              <li key={step.id}>
                <button
                  data-overview-step={step.id}
                  onClick={() => selectStep(step.id)}
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{step.title}</strong>
                  <small>
                    {step.code?.functionContext.status === "function"
                      ? step.code.functionContext.name
                      : step.source.file}
                  </small>
                </button>
              </li>
            ))}
          </ol>
          {!walkthrough.steps.length && (
            <p>Add source cards to build the reading path.</p>
          )}
        </div>
      </div>
    </section>
  );
}
