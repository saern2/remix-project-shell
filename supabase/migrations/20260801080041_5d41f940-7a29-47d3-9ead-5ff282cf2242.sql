REVOKE ALL ON FUNCTION public.has_platform_account_access() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_platform_account_access() FROM anon;
REVOKE ALL ON FUNCTION public.has_platform_account_access() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.has_platform_account_access() TO service_role;