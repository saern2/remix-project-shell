# Access Control Deployment

Deploy this feature in this order. The application code expects the new schema and must not go live first.

1. Configure `APP_URL` with the production origin used by Supabase invitation and administrator password-recovery redirects. Add `${APP_URL}/auth` to Supabase Authentication > URL Configuration > Redirect URLs.
2. Configure `ACCESS_SECRET_PEPPER` with a stable, secret value of at least 32 characters. Never expose it through a `VITE_` variable.
3. Apply `20260801000001_approval_waitlist_access_secrets.sql` to a disposable database and run the activation tests.
4. Apply only migration `20260801000001` to production and confirm all four access tables and two private RPCs exist.
5. Deploy the application.
6. Apply `20260801120000_admin_bypass_and_activation_fix.sql`. Approved administrators use credentials only; regular users still require an issued access secret.
7. Apply `20260801130000_stable_browser_activation_recovery.sql`. This adds the administrator-only recovery RPC used by the Users page.
8. Sign in as an approved administrator and confirm the dashboard, Admin, and Users pages load without a secret prompt.
9. For any secret exhausted by the earlier retry bug, open Users > Requests and secrets and select Reset activations. The secret remains the same, but every browser must verify it again.
10. Apply `20260801000002_enforce_verified_platform_rls.sql` only if it has not already been applied, then confirm project, audio, and render-output access still works for the administrator and a trusted regular user.

One browser profile consumes one activation even when a request is retried or another tab is opened. The fifth distinct browser activation succeeds and marks the secret exhausted. Existing trusted browsers remain valid; a sixth new browser is denied. Revoking the secret blocks every associated trusted browser on its next protected server request.
