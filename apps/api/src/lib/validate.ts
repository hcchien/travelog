import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { ZodType } from "zod";
import { ApiError } from "./problem.js";

/** zod 驗證失敗時回 422 Problem Details，並列出欄位錯誤。 */
export const validate = <T extends ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) =>
  zValidator(target, schema, (result) => {
    if (!result.success) {
      throw new ApiError(422, "/problems/validation", "輸入資料有誤", {
        errors: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
  });
