/**
 * Definite pre-dispatch errors only: the host throws them before heartbeat.wakeup runs
 * (requestWakeup throws budgets.reconcileScope's block reason verbatim before dispatch), so
 * the effect provably never happened and a retry is safe. Every other exception may have
 * dispatched; it must stay recorded as unconfirmed rather than be retried.
 * Host sources: plugin-host-services requestWakeup, budgets.reconcileScope (server 2026.1023.0).
 */
export function retryableBeforeQueue(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /^(Company|Agent|Project) cannot start work while completed runs await accounting\.$/.test(error.message)
    || /^(Company|Agent|Project) cannot start work because recorded usage has no reliable price\.$/.test(error.message)
    || /^Project cannot start work because its budget hard-stop is still exceeded\.$/.test(error.message)
    || /^(Company|Agent) is paused because its budget hard-stop was reached\.$/.test(error.message)
    || /^(Company|Project) is paused and cannot start new work\.$/.test(error.message)
    || error.message === "Budget pause requires a policy or an explicit operator resume."
    || error.message === "New work must wait while a native run recovers its unfinished accounting."
    || error.message === "worker RPC host is not running"
    || ((error as { code?: unknown }).code === -32000 && error.message === "Plugin is held for idle sleep");
}
