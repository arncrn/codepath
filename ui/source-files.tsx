import { useEffect, useRef, useState } from "react";
import type { SourceOverview } from "../types.mjs";
import { listSourceFiles } from "./api";

export function SourceFiles({
  initial,
  chooseSource,
  fail,
}: {
  initial: SourceOverview;
  chooseSource: (file: string) => void;
  fail: (error: unknown) => void;
}) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState(initial.files);
  const [cursor, setCursor] = useState<string>();
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  async function load(
    q: string,
    next: string | undefined,
    append: boolean,
    version: number
  ) {
    setBusy(true);
    try {
      let page;
      do {
        page = await listSourceFiles(q, next);
        next = page.nextCursor;
      } while (!page.files.length && next && version === request.current);
      if (version !== request.current) return;
      setFiles((previous) =>
        append ? [...previous, ...page.files] : page.files
      );
      setCursor(page.nextCursor);
    } catch (error) {
      if (version === request.current) fail(error);
    } finally {
      if (version === request.current) setBusy(false);
    }
  }
  useEffect(() => {
    const version = ++request.current;
    setFiles(query ? [] : initial.files);
    setCursor(undefined);
    const timer = setTimeout(
      () => void load(query, undefined, false, version),
      150
    );
    return () => {
      clearTimeout(timer);
      request.current++;
    };
  }, [query]);
  return (
    <>
      <input
        aria-label="Find source files"
        placeholder="Find source files…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div id="files">
        {files.map(({ file }) => (
          <button
            key={file}
            data-file={file}
            title={file}
            onClick={() => chooseSource(file)}
          >
            <span className="file-dot" />
            {file}
          </button>
        ))}
        {busy && <small role="status">Finding files…</small>}
        {!busy && cursor && (
          <button
            onClick={() => void load(query, cursor, true, ++request.current)}
          >
            More files
          </button>
        )}
        {!busy && !cursor && !files.length && (
          <small>No matching source files.</small>
        )}
      </div>
    </>
  );
}
