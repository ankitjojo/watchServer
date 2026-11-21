/**
 * TD-39, pure: may this check open an incident (and send ENDPOINT_DOWN)? A single failed check is often
 * the monitor's own network blip, so an incident opens only after `downAfterChecks` failed checks in a row.
 * Once an incident is open, every check goes to the alert policy as before (FR-A3).
 */
export function shouldProcessAlert(input: {
  isDown: boolean;
  consecutiveFailures: number;
  downAfterChecks: number;
  hasOpenIncident: boolean;
}): boolean {
  if (!input.isDown || input.hasOpenIncident) return true;
  return input.consecutiveFailures >= input.downAfterChecks;
}
