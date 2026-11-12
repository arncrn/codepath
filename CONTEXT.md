# Codepath learning explanations

Codepath connects source code with explanations that help a reader understand its purpose and behavior.

## Language

**Walkthrough**:
An explanation of a selected behavior through relevant source locations and function calls.

**Current-state walkthrough**:
A walkthrough explaining the behavior of the code currently being examined, rather than a preserved historical source version.

**PR-review walkthrough**:
A walkthrough explaining how proposed changes alter behavior relative to the pull request's target/base behavior.

**Git comparison**:
Differences between selected committed branches, or between a committed branch and the current saved working tree, without changing the checked-out branch.

**Changes**:
The source-control view separating staged, unstaged and untracked files. A partially staged file belongs to both staged and unstaged groups with different differences.

**Staged changes**:
Differences from HEAD to the index. Before the first commit, the before side is empty.

**Unstaged changes**:
Differences from the index to saved working files.

**Untracked file**:
A nonignored working file absent from the index, compared against an empty before side.

**Working tree target**:
The current saved files, including staged, unstaged and untracked work, rather than any branch's committed tip or unsaved editor buffers.

**Viewed**:
Manual reading progress for one exact selected Git source pair, not approval, correctness or explanation review. A file with staged and unstaged differences has separate pairs; every selected pair must be Viewed before that file is fully Viewed. Returning to the exact earlier paired versions/choices can recover their earlier progress.

**Coverage**:
The declared inventory scope and its completeness/unknowns. Complete allowed-path enumeration does not include ignored/nonproject paths and does not establish the changes inside restricted paths that were never inspected.

**Comparison note**:
A human annotation belonging to one side of one exact source comparison. It does not automatically follow changed source or become an ordinary walkthrough note.

**Main integration**:
Bringing changes from main into the working branch. This is distinct from a pull request landing on main.

**Archived walkthrough**:
An inactive walkthrough retained for later use, not a historical code snapshot. Its explanations may need revision as the code evolves.

**Stale explanation**:
An explanation whose relationship to the current source needs review because that source or its meaning has changed. Being archived and being stale are separate properties.

**Function context**:
The innermost lexical function containing a card's selected nonwhitespace current source, shown by name inside its code pane, not its authored purpose or a runtime call stack. A range spanning nested callbacks belongs to their common outer function. Current names and stale explanations are independent. Comparison cards instead project each selected range against its own immutable raw historical side, never the live file's scopes. Sibling functions without a common owner, top-level code and unavailable/unsupported source are explicit states.

**Card explanation**:
A concise explanation of the overall purpose of the code shown in a card.

**Block note**:
A source-linked explanation of a particular block of code, including its behavior, decisions or function calls.

**Variable explanation**:
A source-linked explanation of what one specific variable represents and why the code uses it. It is distinct from the variable's type information and from a glossary covering every variable in a function.

**Plain note**:
A deliberate free-text note without source highlighting or an explicit Variables classification. It is distinct from a source-linked block note or variable explanation.

**Authoring readiness**:
A generated walkthrough has current card purposes and source-linked Notes and Variables for applicable parts, with explicit reasons for inapplicable categories. This is distinct from judging explanatory quality, completeness of relevant behavior or observed execution.

**Archived note**:
An explanation retained for reference and history but excluded from active reading. It can be restored without losing its identity or earlier versions.
