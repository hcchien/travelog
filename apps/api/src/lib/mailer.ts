/** 寄信介面。正式環境之後接 worker（Cloud Tasks）＋寄信服務；目前只記錄。 */
export interface Mailer {
  sendInvitation(params: {
    to: string;
    url: string;
    tripTitle: string;
    inviterName: string;
  }): Promise<void>;
}

export const consoleMailer: Mailer = {
  async sendInvitation({ to, tripTitle }) {
    console.info(`[mailer] 邀請信（尚未接寄信服務）→ ${to}：${tripTitle}`);
  },
};
