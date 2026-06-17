import net from "node:net";
import { env } from "../env";
import { logger } from "../infra/logger";

/**
 * Minimal ClamAV INSTREAM client.
 *
 * Why hand-rolled instead of the `clamscan` npm package: the INSTREAM
 * protocol is tiny (≈30 lines) and adding a dep with its own transitive
 * surface just to send bytes over TCP isn't worth it. The protocol:
 *
 *   1. Send the ASCII command `zINSTREAM\0` (the `z` prefix tells clamd
 *      to terminate the command on NUL, not newline).
 *   2. For each chunk: send a 4-byte big-endian length, then the chunk.
 *   3. Send a 4-byte big-endian zero to signal end-of-stream.
 *   4. Read the response. `stream: OK\0` = clean; `stream: <NAME> FOUND\0`
 *      = infected; anything else = unknown / error.
 *
 * The scan is opt-in via `CLAMAV_HOST` / `CLAMAV_PORT`. When unset,
 * `scanBytes` returns `{ clean: true, skipped: true }` so callers can
 * treat "not configured" as a no-op rather than a failure.
 */

export interface ScanResult {
  clean: boolean;
  /** Set when ClamAV is not configured; callers may treat it as a pass. */
  skipped?: boolean;
  /** Signature name when `clean === false` and ClamAV reported a hit. */
  virus?: string;
  /** Reason when an error caused the scan to abort (timeout, connect, etc.). */
  error?: string;
}

export function isClamAvConfigured(): boolean {
  return Boolean(env.CLAMAV_HOST && env.CLAMAV_PORT);
}

const CONNECT_TIMEOUT_MS = 5_000;
// clamd default max stream size is 25 MiB; our attachment cap is 10 MB,
// so a single chunk is fine. We still chunk at 64 KiB for memory.
const CHUNK_SIZE = 64 * 1024;

/**
 * Scan a Buffer of bytes against the configured ClamAV daemon. Resolves
 * with `clean: true` / `clean: false` / `error: <reason>`. Never throws —
 * the caller decides whether a scan error blocks or allows the upload.
 */
export function scanBytes(buf: Buffer): Promise<ScanResult> {
  if (!isClamAvConfigured()) {
    return Promise.resolve({ clean: true, skipped: true });
  }
  const host = env.CLAMAV_HOST as string;
  const port = env.CLAMAV_PORT as number;

  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    let settled = false;
    const responseChunks: Buffer[] = [];

    const finish = (r: ScanResult) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(r);
    };

    sock.setTimeout(CONNECT_TIMEOUT_MS);
    sock.on("timeout", () => finish({ clean: true, error: "timeout" }));
    sock.on("error", (err) =>
      finish({ clean: true, error: `connect: ${err.message}` }),
    );

    sock.on("connect", () => {
      // Command: zINSTREAM + NUL
      sock.write("zINSTREAM\0");
      // Stream the buffer in CHUNK_SIZE pieces with a 4-byte BE length
      // prefix each.
      for (let offset = 0; offset < buf.length; offset += CHUNK_SIZE) {
        const slice = buf.subarray(offset, offset + CHUNK_SIZE);
        const lenHdr = Buffer.alloc(4);
        lenHdr.writeUInt32BE(slice.length, 0);
        sock.write(lenHdr);
        sock.write(slice);
      }
      // End-of-stream marker: 4 BE zero bytes.
      const eos = Buffer.alloc(4);
      eos.writeUInt32BE(0, 0);
      sock.write(eos);
    });

    sock.on("data", (chunk) => responseChunks.push(chunk));

    sock.on("end", () => {
      const resp = Buffer.concat(responseChunks).toString("ascii").trim();
      // Expected forms:
      //   "stream: OK"
      //   "stream: Win.Test.EICAR_HDB-1 FOUND"
      //   "stream: <name> ERROR" (parse failure, oversize, etc.)
      if (resp.endsWith("OK")) {
        finish({ clean: true });
        return;
      }
      const found = resp.match(/:\s+(.+?)\s+FOUND$/);
      if (found) {
        finish({ clean: false, virus: found[1] });
        return;
      }
      finish({ clean: true, error: `unexpected response: ${resp.slice(0, 80)}` });
    });
  });
}

/**
 * Logged wrapper: scan + log the outcome. Returns the ScanResult so the
 * caller can act on it. Skipped scans (not configured) log nothing.
 */
export async function scanBytesLogged(
  buf: Buffer,
  context: Record<string, unknown>,
): Promise<ScanResult> {
  const result = await scanBytes(buf);
  if (result.skipped) return result;
  if (!result.clean && result.virus) {
    logger.error({ ...context, virus: result.virus }, "[clamav] infected");
  } else if (result.error) {
    logger.warn({ ...context, error: result.error }, "[clamav] scan error");
  }
  return result;
}
