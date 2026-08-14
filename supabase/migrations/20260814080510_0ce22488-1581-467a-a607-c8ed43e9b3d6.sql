revoke all on function public.record_generation_event() from public;
revoke all on function public.record_generation_event() from anon;
revoke all on function public.record_generation_event() from authenticated;
grant execute on function public.record_generation_event() to service_role;