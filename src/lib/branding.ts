/**
 * The product's names — both of them, until the operator unifies them.
 *
 * Round C decision, not to be re-litigated here: the landing page says
 * "Auto Video Creator" and the app shell says "Scene Smith", exactly as
 * they did before this file existed. Every occurrence on both surfaces
 * reads from these constants so the eventual rename is one edit per line
 * below; THIS round changes no displayed name, and branding.test.ts pins
 * every composed string byte-for-byte to prove it.
 */

/** The public/marketing surface: landing page, auth page, head metas. */
export const LANDING_PRODUCT_NAME = "Auto Video Creator";

/** The signed-in app surface: shell header, settings, dashboard copy. */
export const APP_PRODUCT_NAME = "Scene Smith";
