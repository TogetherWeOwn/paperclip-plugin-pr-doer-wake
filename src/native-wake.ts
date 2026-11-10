/** These stock-host guards run before enqueue; all other exceptions may be post-dispatch. */
export function retryableBeforeQueue(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /^(Company|Agent|Project) cannot start work while completed runs await accounting\.$/.test(error.message)
    || error.message === "New work must wait while a native run recovers its unfinished accounting."
    || error.message === "worker RPC host is not running"
    || ((error as { code?: unknown }).code === -32000 && error.message === "Plugin is held for idle sleep");
}
