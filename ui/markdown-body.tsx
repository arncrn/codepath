import { Fragment } from "react";
import { Lexer } from "marked";
import type { MarkedToken, Token } from "marked";

// Only built-in lexer tokens are admitted: no HTML renderer, plugins, dynamic
// tags/attributes or HTML insertion. React escapes every source-controlled string.
function renderTokens(tokens: Token[]) {
  return tokens.map((token, index) => (
    <Fragment key={index}>{renderToken(token)}</Fragment>
  ));
}

function safeLink(href: string): string | undefined {
  try {
    // No base URL: relative/host routes, command URLs and local files must not
    // gain navigation privileges. Also refuse credential-bearing links.
    if (!/^https?:\/\//i.test(href)) return;
    const url = new URL(href);
    if (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
    )
      return url.href;
  } catch {
    // Invalid URLs are just labels, never a host message or an executable URL.
  }
}

function renderToken(input: Token) {
  // A private, unextended Lexer never produces extension (Generic) tokens.
  const token = input as MarkedToken;
  switch (token.type) {
    case "space":
    case "def":
      return null;
    case "paragraph":
      return <p>{renderTokens(token.tokens)}</p>;
    case "heading": {
      const content = renderTokens(token.tokens);
      // Fixed JSX tags only: lexer depth never becomes a source-controlled tag.
      switch (token.depth) {
        case 1:
          return <h1>{content}</h1>;
        case 2:
          return <h2>{content}</h2>;
        case 3:
          return <h3>{content}</h3>;
        case 4:
          return <h4>{content}</h4>;
        case 5:
          return <h5>{content}</h5>;
        case 6:
          return <h6>{content}</h6>;
        default:
          return token.raw;
      }
    }
    case "del":
      return <del>{renderTokens(token.tokens)}</del>;
    case "text":
      return token.tokens ? renderTokens(token.tokens) : token.text;
    case "strong":
      return <strong>{renderTokens(token.tokens)}</strong>;
    case "em":
      return <em>{renderTokens(token.tokens)}</em>;
    case "codespan":
      return <code>{token.text}</code>;
    case "code":
      return (
        <pre>
          <code>{token.text}</code>
        </pre>
      );
    case "list": {
      const items = token.items.map((item, index) => (
        <li key={index}>{renderTokens(item.tokens)}</li>
      ));
      return token.ordered ? (
        <ol start={token.start || 1}>{items}</ol>
      ) : (
        <ul>{items}</ul>
      );
    }
    case "link": {
      const href = safeLink(token.href);
      const label = renderTokens(token.tokens);
      return href ? (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {label}
        </a>
      ) : (
        label
      );
    }
    case "image":
      // Alt text only; not even data: images may create an image element.
      return token.text;
    case "br":
      return <br />;
    case "escape":
      return token.text;
    default:
      // Unsupported syntax, including raw HTML, remains inert visible text.
      return token.raw;
  }
}

/** Reading only: never normalizes stored text or supplies textarea contents. */
export function MarkdownBody({ body }: { body: string }) {
  let content;
  try {
    // GFM recognizes both ~single~ and ~~double~~ strikethrough. All lexer
    // output still passes the same passive React-element/URL allowlist.
    content = renderTokens(new Lexer({ gfm: true }).lex(body));
  } catch {
    // Malformed/pathologically nested input must not take down the reader.
    content = <p>{body}</p>;
  }
  return <div className="markdown-body">{content}</div>;
}
