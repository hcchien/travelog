/** 工具執行環境：以使用者身分呼叫 Travelog API。 */
export interface ToolContext {
  call<T = unknown>(
    method: string,
    path: string,
    opts?: { body?: unknown; ifMatch?: number },
  ): Promise<T>;
  now(): Date;
}

/** API 回傳錯誤時丟出；MCP 層會轉成給 AI 看的錯誤訊息。 */
export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Record<string, unknown>,
  ) {
    super(String(problem.title ?? `API 錯誤 ${status}`));
  }
}

/** 轉成讓 AI 能向使用者解釋、且不會一直重試的訊息。 */
export function explainError(err: unknown): string {
  if (err instanceof ApiCallError) {
    switch (err.status) {
      case 423:
        return "這個行程點已確定（已訂位／已購票），日期、時間、地點與順序都不能修改，也不能移動或刪除。請告訴使用者：需要改期或取消時，請他在 Travelog 中先「解除確定」。不要重試。";
      case 412:
        return "這個行程點剛被其他人修改。請重新讀取行程後再決定是否修改。";
      case 403:
        return `沒有權限：${err.message}。可能是使用者在這趟行程是檢視者，或授權時沒有給寫入權限。不要重試。`;
      case 404:
        return `找不到：${err.message}。請確認 ID 是否正確（可先用 list_trips 或 get_day_plan 查詢）。`;
      case 409:
        return `無法完成：${err.message}`;
      case 422: {
        const errors = err.problem.errors as { path: string; message: string }[] | undefined;
        return `輸入有誤：${errors?.map((e) => `${e.path} ${e.message}`).join("；") ?? err.message}`;
      }
      case 503:
        return `服務暫時無法使用：${err.message}`;
    }
    return `Travelog 回傳錯誤（${err.status}）：${err.message}`;
  }
  if (err instanceof ToolInputError) return err.message;
  return "Travelog 發生未預期的錯誤，請稍後再試。";
}

export class ToolInputError extends Error {}
