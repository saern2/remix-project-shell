export type PollStatus = { status?: string } | null | undefined;

export function isMissingPollResult(result: PollStatus): boolean {
  return result?.status === "not_found";
}

export function pollIntervalWhileActive(
  subject: PollStatus,
  activeStatuses: ReadonlySet<string>,
  intervalMs: number,
): number | false {
  return subject?.status && activeStatuses.has(subject.status) ? intervalMs : false;
}
