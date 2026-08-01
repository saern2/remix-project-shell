REVOKE ALL ON FUNCTION public.enforce_two_project_limit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_two_project_limit() TO service_role;