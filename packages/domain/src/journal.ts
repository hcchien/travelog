/**
 * 心得內容：Tiptap/ProseMirror JSON 的受限子集（只有文字，沒有圖片或 HTML）。
 * 結構驗證在 @travelog/schema；這裡是純函式。
 */

export type JournalMark =
  | { type: "bold" | "italic" | "strike" | "code" }
  | { type: "link"; attrs: { href: string } };

export interface JournalText {
  type: "text";
  text: string;
  marks?: JournalMark[];
}
export type JournalInline = JournalText | { type: "hardBreak" };
export type JournalBlock =
  | { type: "paragraph"; content?: JournalInline[] }
  | { type: "heading"; attrs: { level: 2 | 3 }; content?: JournalInline[] }
  | { type: "bulletList" | "orderedList"; content: { type: "listItem"; content: JournalBlock[] }[] }
  | { type: "blockquote"; content: JournalBlock[] }
  | { type: "horizontalRule" };
export interface JournalDoc {
  type: "doc";
  content: JournalBlock[];
}

export const emptyDoc = (): JournalDoc => ({ type: "doc", content: [] });

/** 純文字轉成心得文件：每一行一個段落。 */
export function textToDoc(text: string): JournalDoc {
  return {
    type: "doc",
    content: text
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .map((line) =>
        line
          ? { type: "paragraph" as const, content: [{ type: "text" as const, text: line }] }
          : { type: "paragraph" as const },
      ),
  };
}

function inlineText(content: JournalInline[] | undefined): string {
  return (content ?? []).map((n) => (n.type === "text" ? n.text : "\n")).join("");
}

function blockLines(block: JournalBlock, prefix = ""): string[] {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return [prefix + inlineText(block.content)];
    case "bulletList":
    case "orderedList":
      return block.content.flatMap((li, i) =>
        li.content.flatMap((b, j) =>
          blockLines(
            b,
            j === 0
              ? `${prefix}${block.type === "orderedList" ? `${i + 1}. ` : "• "}`
              : `${prefix}  `,
          ),
        ),
      );
    case "blockquote":
      return block.content.flatMap((b) => blockLines(b, `${prefix}> `));
    case "horizontalRule":
      return [`${prefix}---`];
  }
}

/** 文件轉純文字（搜尋、MCP、預覽用）。 */
export function docToText(doc: JournalDoc): string {
  return doc.content
    .flatMap((b) => blockLines(b))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 在文件最後接上另一份文件。 */
export function appendDoc(a: JournalDoc, b: JournalDoc): JournalDoc {
  return { type: "doc", content: [...a.content, ...b.content] };
}

const SLUG_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";

/** 公開分享網址用的短代碼（不含易混淆字元）。bytes 由呼叫端提供亂數。 */
export function slugFromBytes(bytes: Uint8Array, length = 10): string {
  if (bytes.length < length) throw new Error("亂數不足");
  let s = "";
  for (let i = 0; i < length; i++) s += SLUG_ALPHABET[(bytes[i] as number) % SLUG_ALPHABET.length];
  return s;
}
