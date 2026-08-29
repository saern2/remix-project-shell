/**
 * Worded failures (Item 3). Every message here is read by the person whose
 * key and credit were on the line — the platform's describeUserFacingError
 * passes application-authored text through verbatim, so these ARE the UI.
 *
 * The provider-error path needs no wording of its own: Anymotion attaches
 * err.explained at the throw site (agent-loop.js:1115-1138) — "402 Payment
 * Required — the account behind this key is out of credit at <endpoint>…",
 * "401 Unauthorized — your API key was rejected…" — and those pass through
 * with a one-line frame naming whose account it is.
 */

export const WALL_CLOCK_MARKER = 'wall-clock';
export const TURN_CAP_MARKER = 'turn-cap';

export class MotionJobFailure extends Error {}

export function describeStopReason(stopReason, abortReason, input) {
  if (stopReason === 'turn-limit' || abortReason === TURN_CAP_MARKER) {
    return (
      `The explainer did not converge within ${input.maxTurns} agent turns, so it was stopped ` +
      'rather than left to keep spending your API credit. A tighter, more specific brief ' +
      'usually finishes in far fewer turns — please simplify it and try again.'
    );
  }
  if (abortReason === WALL_CLOCK_MARKER) {
    const minutes = Math.round(input.wallClockSeconds / 60);
    return (
      `The explainer was still running after ${minutes} minutes, so it was stopped rather than ` +
      'left open-ended. This usually means the AI provider was very slow — please try again, ' +
      'or switch to a different model.'
    );
  }
  return (
    'The explainer generation stopped before finishing. Nothing was saved — please try again. ' +
    `(internal: stopReason=${stopReason})`
  );
}

/**
 * Frames a provider/engine error for the user. Anymotion's err.explained is
 * already worded; everything else gets a plain sentence with the detail in
 * parentheses. 402 gets the AgentRouter-specific framing the operator
 * ordered: both test runs hit it, and a user seeing an unexplained 402
 * assumes the product is broken.
 */
export function describeEngineError(err) {
  const status = err?.status || err?.statusCode;
  const explained = err?.explained;
  if (status === 402) {
    return (
      'Your AI provider account is out of credit, or the model you chose is temporarily ' +
      'unavailable on it (AgentRouter releases Claude models in daily batches). ' +
      'Try again later, or switch to GLM or DeepSeek — both are verified working. ' +
      (explained ? `(provider: ${explained})` : '')
    ).trim();
  }
  if (status === 401 || status === 403) {
    return (
      'Your API key was rejected by the provider. Check that it was pasted completely and is ' +
      'still active, then save it again. ' +
      (explained ? `(provider: ${explained})` : '')
    ).trim();
  }
  if (explained) return String(explained);
  const message = String(err?.message ?? 'unknown error');
  if (/could not find|failed to launch|executable|chrome|chromium/i.test(message)) {
    return (
      'The rendering browser could not start on the server. This is a platform problem, not ' +
      `your brief or your key. Please try again; if it repeats, contact the operator. (internal: ${message.slice(0, 160)})`
    );
  }
  return `The explainer could not be generated. Nothing was saved — please try again. (internal: ${message.slice(0, 200)})`;
}
