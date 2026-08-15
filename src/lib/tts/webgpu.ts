/**
 * The gate at the front door of script-to-video.
 *
 * Kokoro runs entirely in the user's browser, and only WebGPU makes that a
 * 4-5 minute job instead of a 40-minute one. There is deliberately NO WASM
 * fallback: 40 minutes of silent grinding is precisely the failure mode this
 * codebase spent a week removing everywhere else. A browser without WebGPU is
 * refused before a script is accepted — politely, and with what to do instead
 * of what failed.
 */

export const WEBGPU_REFUSAL =
  "Script-to-video needs a browser with WebGPU — Chrome or Edge on a desktop computer. " +
  "On this browser you can still make a video from a narration you record yourself, using Upload narration.";

export type WebGpuVerdict = { ok: true } | { ok: false; message: string };

/**
 * Probes for a usable WebGPU adapter. `navigator.gpu` existing is not enough:
 * a browser can expose the API and still return no adapter (software-only
 * machines, disabled flags), and requestAdapter is the probe that actually
 * answers "can this machine run the model".
 */
export async function checkWebGpu(): Promise<WebGpuVerdict> {
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown | null> } }).gpu;
  if (!gpu) return { ok: false, message: WEBGPU_REFUSAL };
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { ok: false, message: WEBGPU_REFUSAL };
    return { ok: true };
  } catch {
    return { ok: false, message: WEBGPU_REFUSAL };
  }
}
