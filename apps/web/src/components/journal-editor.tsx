"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { JournalDoc } from "@/lib/types";
import { cx } from "./ui";

const isHttp = (url: string) => /^https?:\/\//i.test(url);

/** 心得編輯器：只開文字類功能（沒有圖片、程式碼區塊、底線），與後端 schema 一致。 */
export function useJournalEditor(initial: JournalDoc | null) {
  return useEditor({
    immediatelyRender: false,
    // 工具列要反映游標所在的格式
    shouldRerenderOnTransaction: true,
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        underline: false,
        heading: { levels: [2, 3] },
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: "https",
          isAllowedUri: (url) => isHttp(url),
        },
      }),
    ],
    content: initial ?? "",
    editorProps: {
      attributes: {
        class:
          "journal-editor min-h-40 rounded-b-lg border border-line-strong px-3 py-2 text-[15px] leading-relaxed outline-none focus:border-brand",
        "aria-label": "心得內容",
        role: "textbox",
        "aria-multiline": "true",
      },
    },
  });
}

type Editor = NonNullable<ReturnType<typeof useJournalEditor>>;

function Tool({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cx(
        "h-8 min-w-8 rounded-md px-2 text-sm",
        active ? "bg-brand-soft font-bold text-brand" : "text-ink-soft hover:bg-canvas",
      )}
    >
      {children}
    </button>
  );
}

export function JournalEditor({ editor }: { editor: Editor | null }) {
  if (!editor) return <div className="min-h-48 rounded-lg border border-line-strong" />;
  const state = {
    bold: editor.isActive("bold"),
    italic: editor.isActive("italic"),
    h2: editor.isActive("heading", { level: 2 }),
    h3: editor.isActive("heading", { level: 3 }),
    bullet: editor.isActive("bulletList"),
    ordered: editor.isActive("orderedList"),
    quote: editor.isActive("blockquote"),
    link: editor.isActive("link"),
  };
  const chain = () => editor.chain().focus();
  return (
    <div>
      <div
        role="toolbar"
        aria-label="格式"
        className="flex flex-wrap gap-0.5 rounded-t-lg border border-b-0 border-line-strong bg-white p-1"
      >
        <Tool label="粗體" active={state.bold} onClick={() => chain().toggleBold().run()}>
          <b>B</b>
        </Tool>
        <Tool label="斜體" active={state.italic} onClick={() => chain().toggleItalic().run()}>
          <i>I</i>
        </Tool>
        <Tool
          label="大標題"
          active={state.h2}
          onClick={() => chain().toggleHeading({ level: 2 }).run()}
        >
          H2
        </Tool>
        <Tool
          label="小標題"
          active={state.h3}
          onClick={() => chain().toggleHeading({ level: 3 }).run()}
        >
          H3
        </Tool>
        <Tool
          label="項目清單"
          active={state.bullet}
          onClick={() => chain().toggleBulletList().run()}
        >
          •
        </Tool>
        <Tool
          label="編號清單"
          active={state.ordered}
          onClick={() => chain().toggleOrderedList().run()}
        >
          1.
        </Tool>
        <Tool label="引言" active={state.quote} onClick={() => chain().toggleBlockquote().run()}>
          ❝
        </Tool>
        <Tool
          label={state.link ? "移除連結" : "加入連結"}
          active={state.link}
          onClick={() => {
            if (state.link) return chain().unsetLink().run();
            const url = window.prompt("連結網址（https://…）");
            if (!url) return;
            if (!isHttp(url)) return window.alert("只能使用 http 或 https 開頭的網址");
            chain().extendMarkRange("link").setLink({ href: url }).run();
          }}
        >
          🔗
        </Tool>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}

/** 把編輯器內容轉成後端接受的格式（移除 Tiptap 的多餘屬性由後端處理）。 */
export const editorDoc = (editor: Editor) => editor.getJSON() as unknown as JournalDoc;
