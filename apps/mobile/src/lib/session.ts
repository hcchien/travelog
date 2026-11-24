let epoch = 0;
let userId: string | null = null;
export const sessionScope = () => ({ epoch, userId });
export const sameSession = (scope: { epoch: number }) => scope.epoch === epoch;
export const invalidateSession = () => { epoch++; userId = null; };
export const bindSessionUser = (id: string) => { if (id !== userId) { epoch++; userId = id; } };
export class SessionChangedError extends Error {
  constructor() { super("登入狀態已改變"); }
}
export function assertSession(scope: { epoch: number }) {
  if (!sameSession(scope)) throw new SessionChangedError();
}
