
CREATE TABLE public.acled_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id_cnty text UNIQUE NOT NULL,
  event_date text,
  year integer,
  disorder_type text,
  event_type text,
  sub_event_type text,
  actor1 text,
  actor2 text,
  country text,
  admin1 text,
  location text,
  latitude double precision,
  longitude double precision,
  fatalities integer DEFAULT 0,
  notes text,
  source text,
  population_best double precision,
  timestamp bigint
);

ALTER TABLE public.acled_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read access" ON public.acled_events
  FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "Allow service role write" ON public.acled_events
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE INDEX idx_acled_country ON public.acled_events(country);
CREATE INDEX idx_acled_event_date ON public.acled_events(event_date);
CREATE INDEX idx_acled_event_type ON public.acled_events(event_type);
