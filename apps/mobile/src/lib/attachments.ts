import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { Attachment } from "./types";

/** 附件清單（只在線上時讀取；下載網址每次重新申請）。 */
export const useAttachments = (tripId: string) =>
  useQuery({
    queryKey: ["attachments", tripId],
    queryFn: async () =>
      (await api<{ attachments: Attachment[] }>("GET", `/v1/trips/${tripId}/attachments`))
        .attachments,
    retry: false,
  });
