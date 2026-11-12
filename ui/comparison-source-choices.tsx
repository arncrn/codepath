import { useEffect, useRef, useState } from "react";
import type { GitQuery, ToolResults } from "../types.mjs";
import { errorMessage } from "../types.mjs";
import { listGitBranches, listGitChanges } from "./api";

// Prospective authoring choices only. They cannot rewrite a stored walkthrough.
export function ComparisonSourceChoices({ active }: { active: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<GitQuery>({ mode: "changes" });
  const [branches, setBranches] = useState<ToolResults["list_git_branches"]>({
    branches: [],
  });
  const [status, setStatus] = useState("");
  const epoch = useRef(0);
  useEffect(() => {
    const token = ++epoch.current;
    if (!open || !active) return;
    setStatus("Reading available source pairs…");
    void (async () => {
      const refs = await listGitBranches();
      if (epoch.current !== token) return;
      setBranches(refs);
      let page = await listGitChanges({ query }),
        count = page.files.length;
      while (!page.complete && epoch.current === token) {
        page = await listGitChanges({ query, cursor: page.nextCursor });
        count += page.files.length;
      }
      if (epoch.current === token)
        setStatus(
          count
            ? `${count} source pairs available for a new authored walkthrough.`
            : "No differences. No walkthrough steps generated."
        );
    })().catch((error) => {
      if (epoch.current === token) setStatus(errorMessage(error));
    });
    return () => {
      epoch.current++;
    };
  }, [active, open, query]);
  function choose(value: GitQuery) {
    epoch.current++;
    setQuery(value);
  }
  return (
    <details
      className="comparison-source-choices"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Git sources</summary>
      <p>
        For a new walkthrough; these choices do not change authored versions.
      </p>
      <button
        aria-pressed={query.mode === "changes"}
        onClick={() => choose({ mode: "changes" })}
      >
        Changes
      </button>
      <button
        aria-pressed={query.mode === "compare"}
        onClick={() =>
          choose({ mode: "compare", base: "HEAD", target: "WORKING_TREE" })
        }
      >
        Compare
      </button>
      {query.mode === "compare" && (
        <div className="source-choices">
          <label>
            Base branch{" "}
            <select
              aria-label="Base branch"
              value={query.base}
              onChange={(e) => choose({ ...query, base: e.target.value })}
            >
              <option value="HEAD">HEAD (committed)</option>
              {branches.branches.map((branch) => (
                <option key={branch.ref} value={branch.ref}>
                  {branch.name} · {branch.oid.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Target{" "}
            <select
              aria-label="Target"
              value={query.target}
              onChange={(e) => choose({ ...query, target: e.target.value })}
            >
              <option value="WORKING_TREE">Working tree (saved)</option>
              <option value="HEAD">HEAD (committed)</option>
              {branches.branches.map((branch) => (
                <option key={branch.ref} value={branch.ref}>
                  {branch.name} · {branch.oid.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <p role="status">{status}</p>
      <p>
        Ask your connected agent to author explicit paired purposes, Notes and
        Variables.
      </p>
    </details>
  );
}
