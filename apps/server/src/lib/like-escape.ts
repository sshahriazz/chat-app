/**
 * Escape LIKE/ILIKE wildcard metacharacters in user-supplied search
 * input.
 *
 * Even with parameterized queries (Prisma `$queryRaw` tagged templates
 * and Prisma `contains`), the VALUE is bound safely against SQL
 * injection — but `%` and `_` inside it are still interpreted as LIKE
 * wildcards. A query of `%` matches every row (full-table ILIKE scan);
 * `_` matches any single char. Escaping them keeps user input literal.
 *
 * Uses backslash, which is Postgres's default LIKE escape character
 * (no explicit `ESCAPE` clause needed for either the raw queries or
 * Prisma's generated ILIKE).
 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, "\\$&");
}
