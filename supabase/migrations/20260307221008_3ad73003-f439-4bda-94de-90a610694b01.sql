
CREATE TABLE public.ai_cache (
  key TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Allow public read access (no auth needed for dashboard)
ALTER TABLE public.ai_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read access" ON public.ai_cache
  FOR SELECT TO anon, authenticated USING (true);

-- Allow service role to write (edge function uses service role)
CREATE POLICY "Allow service role write" ON public.ai_cache
  FOR ALL TO service_role USING (true) WITH CHECK (true);
