import { z } from "zod";

export const memberRole = z.enum(["editor", "viewer"]);

export const createInvitationInput = z.object({
  role: memberRole,
  /** 指定 email 時只有該帳號能接受，且只能用一次；省略時為可分享的連結。 */
  email: z.email().max(254).optional(),
  /** 有效天數；null 表示不限期。 */
  expiresInDays: z.number().int().min(1).max(30).nullable().default(7),
});

export const updateMemberInput = z.object({ role: memberRole });

export const transferOwnershipInput = z.object({ userId: z.uuid() });
