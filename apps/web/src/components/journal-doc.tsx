import type { ReactNode } from "react";
import type { JournalDoc, JournalNode } from "@/lib/types";

/**
 * 把受限的心得 JSON 轉成 React 元素。不使用 dangerouslySetInnerHTML，
 * 未知節點直接忽略，連結只允許 http(s)（ARCHITECTURE §11）。
 */
function inline(nodes: JournalNode[] | undefined, key: string): ReactNode[] {
  return (nodes ?? []).map((n, i) => {
    const k = `${key}.${i}`;
    if (n.type === "hardBreak") return <br key={k} />;
    if (n.type !== "text" || !n.text) return null;
    let el: ReactNode = n.text;
    for (const m of n.marks ?? []) {
      if (m.type === "bold") el = <strong>{el}</strong>;
      else if (m.type === "italic") el = <em>{el}</em>;
      else if (m.type === "strike") el = <s>{el}</s>;
      else if (m.type === "code")
        el = <code className="rounded bg-canvas px-1 text-[0.9em]">{el}</code>;
      else if (m.type === "link" && /^https?:\/\//i.test(m.attrs.href)) {
        el = (
          <a
            href={m.attrs.href}
            target="_blank"
            rel="nofollow noopener noreferrer"
            className="text-brand underline"
          >
            {el}
          </a>
        );
      }
    }
    return <span key={k}>{el}</span>;
  });
}

function block(n: JournalNode, key: string): ReactNode {
  switch (n.type) {
    case "paragraph":
      return n.content?.length ? (
        <p key={key}>{inline(n.content, key)}</p>
      ) : (
        <p key={key} className="h-3" aria-hidden="true" />
      );
    case "heading":
      return n.attrs?.level === 3 ? (
        <h4 key={key} className="text-base font-bold">
          {inline(n.content, key)}
        </h4>
      ) : (
        <h3 key={key} className="text-lg font-bold">
          {inline(n.content, key)}
        </h3>
      );
    case "bulletList":
    case "orderedList": {
      const items = (n.content ?? []).map((li, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 文件節點沒有 id，內容是靜態的
        <li key={`${key}.${i}`}>
          {(li.content ?? []).map((b, j) => block(b, `${key}.${i}.${j}`))}
        </li>
      ));
      return n.type === "bulletList" ? (
        <ul key={key} className="list-disc pl-6">
          {items}
        </ul>
      ) : (
        <ol key={key} className="list-decimal pl-6">
          {items}
        </ol>
      );
    }
    case "blockquote":
      return (
        <blockquote key={key} className="border-l-4 border-line-strong pl-3 text-ink-soft">
          {(n.content ?? []).map((b, i) => block(b, `${key}.${i}`))}
        </blockquote>
      );
    case "horizontalRule":
      return <hr key={key} className="border-line" />;
    default:
      return null;
  }
}

export function JournalBody({ doc, className }: { doc: JournalDoc; className?: string }) {
  return (
    <div className={`flex flex-col gap-2 text-[15px] leading-relaxed ${className ?? ""}`}>
      {doc.content.map((b, i) => block(b, String(i)))}
    </div>
  );
}
