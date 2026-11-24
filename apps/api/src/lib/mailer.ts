/** 寄信介面。正式環境用 Resend；沒有金鑰時只記錄在 log。 */
export interface Mailer {
  sendInvitation(params: {
    to: string;
    url: string;
    tripTitle: string;
    inviterName: string;
  }): Promise<void>;
}

export const consoleMailer: Mailer = {
  async sendInvitation() {
    console.info("[mailer] invitation delivery skipped: provider not configured");
  },
};

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string,
  );

/** 邀請信內容（純函式，方便測試）。 */
export function invitationEmail(p: { url: string; tripTitle: string; inviterName: string }) {
  const who = p.inviterName || "你的旅伴";
  const subject = `${who} 邀請你一起規劃「${p.tripTitle}」`;
  const text = `${who} 邀請你加入 Travelog 上的行程「${p.tripTitle}」。\n\n打開連結加入：${p.url}\n\n如果你不認識對方，可以忽略這封信。`;
  const html = `<div style="font-family:system-ui,-apple-system,'PingFang TC','Noto Sans TC',sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1b2430">
<p style="font-size:16px">${escapeHtml(who)} 邀請你加入 Travelog 上的行程</p>
<p style="font-size:22px;font-weight:700;margin:8px 0 24px">${escapeHtml(p.tripTitle)}</p>
<a href="${escapeHtml(p.url)}" style="display:inline-block;background:#1f5fae;color:#fff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:10px">加入行程</a>
<p style="font-size:13px;color:#6b7686;margin-top:24px">如果你不認識對方，可以忽略這封信。</p>
</div>`;
  return { subject, text, html };
}

export function resendMailer(opts: { apiKey: string; from: string; fetch?: typeof fetch }): Mailer {
  const doFetch = opts.fetch ?? fetch;
  return {
    async sendInvitation(p) {
      const { subject, text, html } = invitationEmail(p);
      const res = await doFetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: opts.from, to: [p.to], subject, text, html }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok)
        throw new Error(`Resend 回應 ${res.status}`);
    },
  };
}

export function createMailer(mail: { resendApiKey: string | undefined; from: string }): Mailer {
  return mail.resendApiKey
    ? resendMailer({ apiKey: mail.resendApiKey, from: mail.from })
    : consoleMailer;
}
