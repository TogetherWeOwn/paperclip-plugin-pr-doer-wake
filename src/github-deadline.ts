/** Inert deadline arithmetic; this does not enforce or cancel any operation. */
export type GithubDeadline = Readonly<{ deadline: number; observedAt: number }>;

function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("invalid deadline timestamp");
  return value;
}

/** All inputs are absolute non-negative safe integer milliseconds on the same clock. */
export function githubDeadline(tickDeadline: number, operationDeadline: number, now: number): GithubDeadline {
  return { deadline: Math.min(timestamp(tickDeadline), timestamp(operationDeadline)), observedAt: timestamp(now) };
}

/** Carry the returned value forward across stages; an earlier clock reading never replenishes it. */
export function advanceGithubDeadline(previous: GithubDeadline, now: number): { budget: GithubDeadline; remainingMs: number; expired: boolean } {
  const deadline = timestamp(previous.deadline);
  const observedAt = Math.max(timestamp(previous.observedAt), timestamp(now));
  const remainingMs = Math.max(0, deadline - observedAt);
  return { budget: { deadline, observedAt }, remainingMs, expired: remainingMs === 0 };
}
