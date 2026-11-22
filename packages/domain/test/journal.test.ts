import { describe, expect, it } from "vitest";
import { appendDoc, docToText, type JournalDoc, slugFromBytes, textToDoc } from "../src/journal.js";

describe("心得文件", () => {
  it("純文字轉文件再轉回來", () => {
    const doc = textToDoc("早上去清水寺\n\n楓葉正紅");
    expect(doc.content).toHaveLength(3);
    expect(doc.content[1]).toEqual({ type: "paragraph" });
    expect(docToText(doc)).toBe("早上去清水寺\n\n楓葉正紅");
  });

  it("清單、標題、引言都轉成可讀的純文字", () => {
    const doc: JournalDoc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Day 1" }] },
        {
          type: "orderedList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "伏見稻荷" }] }],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [
                    { type: "text", text: "清水寺", marks: [{ type: "bold" }] },
                    { type: "hardBreak" },
                    { type: "text", text: "人很多" },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "blockquote",
          content: [{ type: "paragraph", content: [{ type: "text", text: "值得再來" }] }],
        },
      ],
    };
    expect(docToText(doc)).toBe("Day 1\n1. 伏見稻荷\n2. 清水寺\n人很多\n> 值得再來");
  });

  it("接上另一份文件", () => {
    expect(docToText(appendDoc(textToDoc("a"), textToDoc("b")))).toBe("a\nb");
  });

  it("分享代碼只用不易混淆的字元", () => {
    const slug = slugFromBytes(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 255]));
    expect(slug).toHaveLength(10);
    expect(slug).toMatch(/^[2-9a-km-np-z]+$/);
    expect(() => slugFromBytes(new Uint8Array(3))).toThrow();
  });
});
