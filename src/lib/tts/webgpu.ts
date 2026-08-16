/**
 * The gate at the front door of script-to-video.
 *
 * Kokoro runs entirely in the user's browser, and only WebGPU makes that a
 * minutes job instead of an hours one. There is deliberately NO WASM
 * fallback: 40 minutes of silent grinding is precisely the failure mode this
 * codebase spent a week removing everywhere else. A browser without WebGPU is
 * refused before a script is accepted — politely, and with what to do instead
 * of what failed.
 *
 * WHAT THIS GATE CAN AND CANNOT CATCH. Both machines surveyed on 2026-08-16
 * (a 2014 desktop at 3.38 compute-seconds per audio-second, a 2012 laptop at
 * ~10) pass every capability check here and fail on SPEED — which is owned by
 * the measured, per-machine estimate inside generation, not by this probe.
 * This gate catches ABSENCE (no adapter) and NON-CONFORMANCE (an adapter
 * reporting less than the WebGPU spec's guaranteed minimums — only broken or
 * software-emulated stacks do that). It does not attempt a performance
 * verdict; adapters do not report speed.
 */

export const WEBGPU_REFUSAL =
  "Script-to-video needs a browser with WebGPU — Chrome or Edge on a desktop computer. " +
  "On this browser you can still make a video from a narration you record yourself, using Upload narration.";

/**
 * The WebGPU spec default for maxStorageBufferBindingSize: 128 MiB. Every
 * conformant adapter guarantees AT LEAST this, so refusing below it can only
 * ever reject broken or software-emulated adapters — a free safety net that
 * cannot refuse working hardware. (A model-size-derived maxBufferSize
 * threshold was considered and rejected: weights upload per-initializer, so
 * the file size does not bound any single GPU buffer, and device-survey data
 * puts such a threshold inside a band that would refuse ~2% of real,
 * working machines.)
 */
export const MIN_STORAGE_BUFFER_BINDING_BYTES = 134_217_728;

/** What the probe learned about the machine — fed to the fleet survey. */
export type AdapterSurvey = {
  maxBufferSize: number;
  maxStorageBufferBindingSize: number;
  /** vendor / architecture / device / description, where the browser exposes them. */
  info: Record<string, string>;
};

export type WebGpuVerdict = { ok: true; survey: AdapterSurvey } | { ok: false; message: string };

type GpuAdapterLike = {
  limits?: { maxBufferSize?: number; maxStorageBufferBindingSize?: number };
  info?: Record<string, unknown>;
  requestAdapterInfo?: () => Promise<Record<string, unknown>>;
};

/**
 * Probes for a usable WebGPU adapter. `navigator.gpu` existing is not enough:
 * a browser can expose the API and still return no adapter (software-only
 * machines, disabled flags), and requestAdapter is the probe that actually
 * answers "can this machine run the model".
 */
export async function checkWebGpu(gpuOverride?: {
  requestAdapter(): Promise<GpuAdapterLike | null>;
}): Promise<WebGpuVerdict> {
  const gpu =
    gpuOverride ??
    (navigator as { gpu?: { requestAdapter(): Promise<GpuAdapterLike | null> } }).gpu;
  if (!gpu) return { ok: false, message: WEBGPU_REFUSAL };
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { ok: false, message: WEBGPU_REFUSAL };

    const maxBufferSize = Number(adapter.limits?.maxBufferSize ?? 0);
    const maxStorageBufferBindingSize = Number(adapter.limits?.maxStorageBufferBindingSize ?? 0);
    if (maxStorageBufferBindingSize < MIN_STORAGE_BUFFER_BINDING_BYTES) {
      // Below the spec's guaranteed minimum: not real, working WebGPU.
      return { ok: false, message: WEBGPU_REFUSAL };
    }

    const rawInfo =
      (adapter.info as Record<string, unknown> | undefined) ??
      (await adapter.requestAdapterInfo?.().catch(() => undefined)) ??
      {};
    const info: Record<string, string> = {};
    for (const key of ["vendor", "architecture", "device", "description"]) {
      const value = rawInfo[key];
      if (typeof value === "string" && value) info[key] = value;
    }

    return { ok: true, survey: { maxBufferSize, maxStorageBufferBindingSize, info } };
  } catch {
    return { ok: false, message: WEBGPU_REFUSAL };
  }
}
