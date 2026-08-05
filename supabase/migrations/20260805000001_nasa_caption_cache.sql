-- Round 6 waste removal: stop re-probing NASA captions on every asset cache hit.
--
-- resolveNasaAssets fetched the captions endpoint for every ranked item BEFORE
-- consulting nasa_asset_cache, because the cache had nowhere to store the answer.
-- That is one HTTPS round trip per ranked item per search — 150-400ms each,
-- spent inside the matching_footage time budget, on a fact that never changes for
-- a given asset. Caching it lets the probe move inside the miss branch.
--
-- Nullable on purpose: NULL means "not probed yet", which is distinct from
-- false ("probed, no captions"). Rows cached before this migration therefore
-- re-probe exactly once and then settle.

alter table public.nasa_asset_cache
  add column if not exists has_captions boolean;

comment on column public.nasa_asset_cache.has_captions is
  'Whether images-api.nasa.gov/captions has a .vtt/.srt track for this asset. NULL means not yet probed — the caption probe runs once for such rows and stores the result. Cached because the probe is an HTTPS round trip that runs inside the matching time budget.';
