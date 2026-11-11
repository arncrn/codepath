# Codepath learning explanations

Codepath connects source code with explanations that help a reader understand its purpose and behavior.

## Language

**Walkthrough**:
An explanation of a selected behavior through relevant source locations and function calls.

**Current-state walkthrough**:
A walkthrough explaining the behavior of the code currently being examined, rather than a preserved historical source version.

**PR-review walkthrough**:
A walkthrough explaining how proposed changes alter behavior relative to the pull request's target/base behavior.

**Main integration**:
Bringing changes from main into the working branch. This is distinct from a pull request landing on main.

**Archived walkthrough**:
An inactive walkthrough retained for later use, not a historical code snapshot. Its explanations may need revision as the code evolves.

**Stale explanation**:
An explanation whose relationship to the current source needs review because that source or its meaning has changed. Being archived and being stale are separate properties.

**Function context**:
The innermost lexical function containing a card's selected nonwhitespace current source, shown by name inside its code pane, not its authored purpose or a runtime call stack. A range spanning nested callbacks belongs to their common outer function. Current names and stale explanations are independent. Sibling functions without a common owner, top-level code and unavailable/unsupported source are explicit states.

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
