// Pure, bounded built-in check-in conversions. No Git invocation or executable
// configuration crosses this boundary. See Git v2.39.5 convert.c (gather_stats,
// crlf_to_git, convert_attrs) and gitattributes(5).
export type WorkingSettings = { autocrlf: boolean; filemode: boolean };
// Missing means truly unspecified (--all omits it), never a serialized token.
export type WorkingAttributes = Partial<Record<string, string>> & {
  // Git's canonical builtin action, when serialized text/crlf types collide.
  textAction?: "none" | "text" | "auto" | "default" | "unknown";
};
export function workingRules(
  settings: WorkingSettings,
  attr: WorkingAttributes
) {
  // check-attr cannot distinguish boolean states from literal driver names
  // "set" / "unset". Refuse every present filter, including those booleans.
  if (attr.filter !== undefined)
    return {
      unsupported: "Unknown Git normalization: custom filter is not executed.",
    } as const;
  if (
    attr["working-tree-encoding"] !== undefined &&
    !/^utf-?8$/i.test(attr["working-tree-encoding"])
  )
    return {
      unsupported:
        "Unsupported Git working-tree-encoding; source identity is unknown.",
    } as const;
  // No safe Git metadata query distinguishes bare ident from literal ident=set.
  // Refuse both instead of contracting a real edit under a non-boolean value.
  if (attr.ident === "set")
    return {
      unsupported:
        "Unknown Git normalization: ambiguous ident attribute is not converted.",
    } as const;
  if (attr.textAction === "unknown")
    return {
      unsupported:
        "Unknown Git normalization: ambiguous text attributes on an unindexed path.",
    } as const;
  const action = (value: string | undefined) =>
    value === "unset"
      ? "none"
      : value === "set" || value === "input"
        ? "text"
        : value === "auto"
          ? "auto"
          : undefined;
  let eol =
    attr.textAction === "default"
      ? undefined
      : (attr.textAction ?? action(attr.text) ?? action(attr.crlf));
  if (eol !== "none" && ["lf", "crlf"].includes(attr.eol ?? ""))
    eol = eol === "auto" ? "auto" : "text";
  eol ??= settings.autocrlf ? "auto" : "none";
  return { eol } as const;
}
export type WorkingRules = ReturnType<typeof workingRules>;
export function autoText(data: Buffer) {
  let printable = 0,
    nonprintable = 0;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === 13) {
      if (data[i + 1] !== 10) return false;
      i++;
    } else if (c === 10) continue;
    else if (c === 0) return false;
    else if (c === 127 || (c < 32 && ![8, 9, 27, 12].includes(c)))
      nonprintable++;
    else printable++;
  }
  if (data.at(-1) === 26) nonprintable--;
  return Math.floor(printable / 128) >= nonprintable;
}
export function normalizeWorking(
  data: Buffer,
  rules: WorkingRules,
  indexCRLF: boolean
) {
  if (rules.unsupported) return data;
  // latin1 is a byte bijection: binary/invalid UTF-8 bytes are never replaced.
  let value = data.toString("latin1");
  if (
    rules.eol === "text" ||
    (rules.eol === "auto" && !indexCRLF && autoText(data))
  )
    value = value.replace(/\r\n/g, "\n");
  return Buffer.from(value, "latin1");
}
