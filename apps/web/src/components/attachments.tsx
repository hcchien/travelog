"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import type { Attachment } from "@/lib/types";
import { File, Trash } from "./icons";
import { useToast } from "./toast";
import { Button } from "./ui";

const ACCEPT = "application/pdf,image/png,image/jpeg,image/webp";
const MAX = 10 * 1024 * 1024;

const size = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;

/** 開啟附件：先拿短效下載網址。 */
export async function openAttachment(tripId: string, a: Pick<Attachment, "id">) {
  // 先開視窗再填網址，避免被瀏覽器當成彈出視窗擋掉
  const win = window.open("", "_blank");
  try {
    const { url } = await api<{ url: string }>(
      "GET",
      `/v1/trips/${tripId}/attachments/${a.id}/download`,
    );
    if (win) win.location.href = url;
    else window.location.href = url;
  } catch (e) {
    win?.close();
    throw e;
  }
}

/** 行程點的訂位憑證、票券（PDF 或截圖）。 */
export function Attachments({
  tripId,
  itemId,
  canEdit,
  myUserId,
  isOwner,
}: {
  tripId: string;
  itemId: string;
  canEdit: boolean;
  myUserId: string | undefined;
  isOwner: boolean;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const key = ["attachments", tripId, itemId];
  const list = useQuery({
    queryKey: key,
    queryFn: async () =>
      (
        await api<{ attachments: Attachment[] }>(
          "GET",
          `/v1/trips/${tripId}/attachments?itemId=${itemId}`,
        )
      ).attachments,
  });

  async function upload(file: File) {
    if (file.size > MAX) return toast("檔案不能超過 10 MB", "error");
    if (!ACCEPT.split(",").includes(file.type))
      return toast("只接受 PDF、PNG、JPEG、WebP", "error");
    setBusy(true);
    try {
      const start = await api<{
        attachment: Attachment;
        upload: { url: string; headers: Record<string, string> };
      }>("POST", `/v1/trips/${tripId}/attachments/uploads`, {
        body: { filename: file.name, mime: file.type, sizeBytes: file.size, itemId },
      });
      const res = await fetch(start.upload.url, {
        method: "PUT",
        headers: start.upload.headers,
        body: file,
      });
      if (!res.ok) throw new Error("上傳失敗，請再試一次");
      await api("POST", `/v1/trips/${tripId}/attachments/${start.attachment.id}/complete`);
      toast(`已上傳「${file.name}」`);
      void qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function remove(a: Attachment) {
    if (!window.confirm(`刪除「${a.filename}」？`)) return;
    try {
      await api("DELETE", `/v1/trips/${tripId}/attachments/${a.id}`);
      void qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  }

  return (
    <section className="flex flex-col gap-2" aria-label="附件">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink-soft">憑證與票券</h3>
        {canEdit && (
          <>
            <input
              ref={input}
              type="file"
              accept={ACCEPT}
              aria-label="選擇要上傳的檔案"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
              }}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              {busy ? "上傳中…" : "上傳檔案"}
            </Button>
          </>
        )}
      </div>
      {list.data?.length === 0 && (
        <p className="text-sm text-muted">
          沒有附件。可上傳訂位確認信 PDF 或票券截圖（10 MB 以內）。
        </p>
      )}
      {list.data?.map((a) => (
        <div key={a.id} className="flex items-center gap-2 rounded-lg bg-canvas px-3 py-2 text-sm">
          <File className="size-4 flex-none text-muted" />
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left font-semibold text-brand"
            onClick={() => openAttachment(tripId, a).catch((e) => toast(errorMessage(e), "error"))}
          >
            {a.filename}
          </button>
          <span className="flex-none text-xs text-muted">{size(a.sizeBytes)}</span>
          {canEdit && (a.uploadedBy === myUserId || isOwner) && (
            <button
              type="button"
              aria-label={`刪除 ${a.filename}`}
              onClick={() => remove(a)}
              className="text-muted"
            >
              <Trash className="size-4" />
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
