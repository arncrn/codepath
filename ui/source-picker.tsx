import { useEffect, useRef, useState } from "react";
import type { Overview, SourceRef, SourceSymbol } from "../types.mjs";
import {
  readSource,
  inspectSource,
  listSourceFiles,
  findSourceSymbols,
  searchSource,
} from "./api";

type Choice = SourceSymbol & { symbol?: boolean };
export function Picker({
  overview,
  file,
  requireReview = false,
  add,
  fail,
}: {
  overview: Overview;
  file?: string;
  requireReview?: boolean;
  add: (source: SourceRef, title: string, fileHash?: string) => Promise<void>;
  fail: (error: unknown) => void;
}) {
  const [choices, setChoices] = useState<Choice[]>([]);
  const [files, setFiles] = useState(overview.index.files);
  const [cursor, setCursor] = useState<string>();
  const [fileCursor, setFileCursor] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"symbols" | "text">("symbols");
  const [reviewedPreview, setReviewedPreview] = useState<{
    file: string;
    fileHash: string;
    choice?: Choice;
    unique: boolean;
  } | null>(null);
  const [query, setQuery] = useState("");
  const [rangeFile, setRangeFile] = useState(file ?? "");
  const [start, setStart] = useState(1),
    [end, setEnd] = useState(12);
  const [preview, setPreview] = useState(
    "A path can start anywhere: a component, a test, a button’s JSX, or a backend handler."
  );
  const readVersion = useRef(0),
    searchVersion = useRef(0);
  const searchIntent = useRef({ query, mode });
  searchIntent.current = { query, mode };
  async function readFile(filename: string, choice?: Choice) {
    const version = ++readVersion.current;
    setRangeFile(filename);
    setReviewedPreview(null);
    setPreview(filename ? "Loading source…" : "Choose a file to preview.");
    if (!filename) return;
    try {
      const [source, details] = await Promise.all([
        readSource(filename),
        inspectSource(filename),
      ]);
      if (version !== readVersion.current) return;
      setPreview(source.text);
      if (
        (choice?.fileHash && choice.fileHash !== source.fileHash) ||
        details.hash !== source.fileHash
      ) {
        setStart(1);
        setEnd(Math.min(12, source.endLine));
        fail(
          "Source changed. Preview current source and choose its range again."
        );
        return;
      }
      setStart(choice?.startLine ?? 1);
      setEnd(choice?.endLine ?? Math.min(12, source.endLine));
      setReviewedPreview({
        file: filename,
        fileHash: source.fileHash,
        choice,
        unique:
          !!choice?.symbol &&
          details.symbols.filter((s) => s.name === choice.name).length === 1,
      });
      if (
        !searchIntent.current.query.trim() &&
        searchIntent.current.mode === "symbols"
      ) {
        setChoices(details.symbols.map((s) => ({ ...s, symbol: true })));
        setCursor(undefined);
      }
    } catch (error) {
      if (version === readVersion.current) fail(error);
    }
  }
  async function load(
    kind: "symbols" | "text",
    q: string,
    next: string | undefined,
    append: boolean,
    version: number
  ) {
    if (kind === "symbols" && !q.trim()) return;
    setBusy(true);
    setCursor(undefined);
    try {
      let found: Choice[] = [];
      do {
        if (kind === "text") {
          const result = await searchSource(q, next);
          found = result.hits.map((hit) => ({
            file: hit.file,
            fileHash: hit.fileHash,
            name: hit.text.trim().slice(0, 90) || "Line " + hit.line,
            startLine: Math.max(1, hit.line - 2),
            endLine: Math.min(hit.lineCount ?? hit.line + 4, hit.line + 4),
            calls: [],
          }));
          next = result.nextCursor;
        } else {
          const result = await findSourceSymbols(q, next);
          found = result.symbols.map((symbol) => ({ ...symbol, symbol: true }));
          next = result.nextCursor;
        }
      } while (!found.length && next && version === searchVersion.current);
      if (version !== searchVersion.current) return;
      setChoices((old) => (append ? [...old, ...found] : found));
      setCursor(next);
    } catch (error) {
      if (version === searchVersion.current) fail(error);
    } finally {
      if (version === searchVersion.current) setBusy(false);
    }
  }
  async function loadFiles(
    q: string,
    next: string | undefined,
    append: boolean,
    version: number
  ) {
    setFileCursor(undefined);
    try {
      let page;
      do {
        page = await listSourceFiles(q, next);
        next = page.nextCursor;
      } while (!page.files.length && next && version === searchVersion.current);
      if (version !== searchVersion.current) return;
      setFiles((old) => (append ? [...old, ...page.files] : page.files));
      setFileCursor(page.nextCursor);
    } catch (error) {
      if (version === searchVersion.current) fail(error);
    }
  }
  useEffect(() => {
    if (file) void readFile(file);
    return () => {
      readVersion.current++;
    };
  }, [file]);
  useEffect(() => {
    const version = ++searchVersion.current;
    setChoices([]);
    setCursor(undefined);
    setFileCursor(undefined);
    const timer = setTimeout(() => {
      void load(mode, query, undefined, false, version);
      void loadFiles(query, undefined, false, version);
    }, 150);
    return () => {
      clearTimeout(timer);
      searchVersion.current++;
    };
  }, [query, mode]);
  async function choose(choice: Choice) {
    if (requireReview) {
      void readFile(choice.file, choice);
      return;
    }
    const version = searchVersion.current;
    try {
      const info = await inspectSource(choice.file);
      if (version !== searchVersion.current) return;
      if (choice.fileHash && choice.fileHash !== info.hash) {
        fail("Source changed. Search or preview current source again.");
        return;
      }
      const unique =
        choice.symbol &&
        info.symbols.filter((s) => s.name === choice.name).length === 1;
      await add(
        {
          file: choice.file,
          ...(unique
            ? { symbol: choice.name }
            : { startLine: choice.startLine, endLine: choice.endLine }),
        },
        choice.name
      );
    } catch (error) {
      if (version === searchVersion.current) fail(error);
    }
  }
  const rangeFiles = [
    ...new Set([
      ...files.map((f) => f.file),
      ...(rangeFile ? [rangeFile] : []),
    ]),
  ];
  return (
    <>
      <div className="picker-search">
        <input
          id="symbol-query"
          placeholder="Symbol, filename or text…"
          data-autofocus
          value={query}
          onChange={(event) => {
            setMode("symbols");
            setQuery(event.target.value);
          }}
        />
        <button
          id="text-search"
          disabled={!query.trim()}
          onClick={() => {
            if (mode === "text") {
              const version = ++searchVersion.current;
              void load("text", query, undefined, false, version);
              void loadFiles(query, undefined, false, version);
            } else setMode("text");
          }}
        >
          Search text
        </button>
      </div>
      <div className="picker-columns">
        <div id="symbol-results">
          {choices.map((choice, i) => (
            <button
              key={choice.file + ":" + choice.startLine + ":" + i}
              data-choice={i}
              className="choice"
              onClick={() => void choose(choice)}
            >
              <strong>
                {choice.name} <span>＋</span>
              </strong>
              <small>
                {choice.file}:{choice.startLine}–{choice.endLine}
                {choice.approximate ? " · approximate Go range" : ""}
              </small>
              {choice.reason && <p>{choice.reason}</p>}
            </button>
          ))}
          {busy && <p role="status">Finding source…</p>}
          {!busy && cursor && (
            <button
              onClick={() =>
                void load(mode, query, cursor, true, searchVersion.current)
              }
            >
              More results
            </button>
          )}
          {!busy && !cursor && !choices.length && (
            <p className="empty">
              No symbols match. Try literal text search or choose a file range.
            </p>
          )}
        </div>
        <div className="range">
          <label>
            Or choose a file and lines
            <select
              id="range-file"
              value={rangeFile}
              onChange={(event) => void readFile(event.target.value)}
            >
              <option value="">Select a file…</option>
              {rangeFiles.map((filename) => (
                <option key={filename} value={filename}>
                  {filename}
                </option>
              ))}
            </select>
          </label>
          {fileCursor && (
            <button
              onClick={() =>
                void loadFiles(query, fileCursor, true, searchVersion.current)
              }
            >
              More files
            </button>
          )}
          <div className="range-inputs">
            <label>
              From
              <input
                id="range-start"
                type="number"
                min="1"
                value={start}
                onChange={(event) => setStart(Number(event.target.value))}
              />
            </label>
            <label>
              To
              <input
                id="range-end"
                type="number"
                min="1"
                value={end}
                onChange={(event) => setEnd(Number(event.target.value))}
              />
            </label>
            {requireReview && (
              <button
                disabled={!rangeFile}
                onClick={() => void readFile(rangeFile)}
              >
                Preview current source
              </button>
            )}
            <button
              id="range-add"
              className="primary"
              disabled={requireReview && reviewedPreview?.file !== rangeFile}
              onClick={() => {
                if (requireReview && reviewedPreview?.file !== rangeFile)
                  return;
                const fileHash = reviewedPreview?.fileHash,
                  choice = reviewedPreview?.choice;
                const keepSymbol =
                  requireReview &&
                  reviewedPreview?.unique &&
                  choice &&
                  choice.startLine === start &&
                  choice.endLine === end;
                if (requireReview) setReviewedPreview(null);
                void add(
                  keepSymbol
                    ? { file: rangeFile, symbol: choice.name }
                    : { file: rangeFile, startLine: start, endLine: end },
                  rangeFile.split("/").at(-1) + " · selected range",
                  fileHash
                );
              }}
            >
              {requireReview ? "Confirm reviewed range" : "Add"}
            </button>
          </div>
          <pre id="range-preview">{preview}</pre>
        </div>
      </div>
    </>
  );
}
