-- Enable pg_trgm for trigram-based similarity + fuzzy search.
-- The `%` operator in `/api/search` and `/api/conversations/:id/search`
-- depends on this. Without the extension, the server returns 500 with
-- "operator does not exist: text % unknown".
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram index on the flattened text column, matching the comment
-- in schema.prisma ("GIN trgm index lives on this column"). Used by
-- the similarity ranking in the search query.
CREATE INDEX IF NOT EXISTS messages_plain_content_trgm_idx
  ON messages USING gin (plain_content gin_trgm_ops);
