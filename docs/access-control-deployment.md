# Access Control Deployment

Deploy this feature in this order. The application code expects the new schema and must not go live first.

1. Configure `APP_URL` with the production origin used by Supabase invitation and administrator password-recovery redirects. Add `${APP_URL}/auth` to Supabase Authentication > URL Configuration > Redirect URLs.
2. Configure `ACCESS_SECRET_PEPPER` with a stable, secret value of at least 32 characters. Never expose it through a `VITE_` variable.
3. Apply `20260801000001_approval_waitlist_access_secrets.sql` to a disposable database and run the activation tests.
4. Apply only migration `20260801000001` to production and confirm all four access tables and two private RPCs exist.
5. Deploy the application.
6. Sign in as the primary administrator. The access screen offers a one-time bootstrap only when that account has never had a secret.
7. Save the displayed primary-admin secret, acknowledge it, and confirm the dashboard and Admin > Access page load.
8. Apply `20260801000002_enforce_verified_platform_rls.sql` and confirm project, audio, and render-output access still works for that trusted administrator.

The fifth distinct browser activation succeeds and marks the secret exhausted. Existing trusted browsers remain valid; a sixth new browser is denied. Revoking the secret blocks every associated trusted browser on its next protected server request.
