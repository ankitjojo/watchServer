import { BlockList, isIP } from 'node:net';

/** One request attempt (FR-E2 stores every attempt). */
export interface ProbeAttempt {
  attempt: number;
  statusCode?: number;
  responseTimeMs: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface ProbeResult {
  /** True only if some attempt ended with exactly HTTP 200. */
  isUp: boolean;
  attempts: ProbeAttempt[];
}

/** What one HTTP GET returned. The body is never read. */
export interface ProbeResponse {
  status: number;
  location: string | null;
}

export interface ProbeDeps {
  /**
   * One GET without following redirects. The production implementation vets the addresses the
   * socket connects to with `isBlockedAddress` (review M3: no second, unchecked DNS resolution).
   */
  request(url: URL, options: { signal: AbortSignal }): Promise<ProbeResponse>;
  /** Resolves every address of a host. Checked before each hop (security 2.9). */
  lookup(host: string): Promise<string[]>;
  sleep(ms: number): Promise<void>;
  /** Monotonic milliseconds, for response times. */
  nowMs(): number;
}

export interface ProbeOptions {
  retryCount: number;
  retryDelayMs: number;
  timeoutMs: number;
  maxRedirects: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const SAFE_MESSAGES: Record<string, string> = {
  TIMEOUT: 'The request timed out',
  DNS_ERROR: 'The host name could not be resolved',
  CONNECTION_REFUSED: 'The connection was refused',
  CONNECTION_RESET: 'The connection was reset',
  TLS_ERROR: 'The TLS handshake or certificate failed',
  NETWORK_ERROR: 'A network error occurred',
  BLOCKED_ADDRESS: 'The address is blocked (cloud metadata or link-local)',
  TOO_MANY_REDIRECTS: 'Too many redirects',
  INVALID_REDIRECT: 'The redirect target is not allowed',
};

// Link-local (incl. the AWS/GCP/Azure metadata IP), Alibaba metadata, AWS IPv6 metadata, IPv6 link-local.
// BlockList matches every spelling, including IPv4-mapped IPv6 such as ::ffff:a9fe:a9fe (review M3).
const BLOCKED = new BlockList();
BLOCKED.addSubnet('169.254.0.0', 16, 'ipv4');
BLOCKED.addAddress('100.100.100.200', 'ipv4');
BLOCKED.addAddress('fd00:ec2::254', 'ipv6');
BLOCKED.addSubnet('fe80::', 10, 'ipv6');

/** Cloud metadata and link-local addresses are never probed, also not through redirects (SSRF). */
export function isBlockedAddress(address: string): boolean {
  // Brackets from a URL host and an IPv6 zone id (fe80::1%eth0) are not part of the address.
  const ip = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = isIP(ip);
  if (family === 0) return false;
  return BLOCKED.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/** Error code a vetting resolver uses when a connection would reach a blocked address. */
export const BLOCKED_ADDRESS_CODE = 'EBLOCKEDADDRESS';

interface ProbeFailure {
  errorCode: string;
}

function textProperty(value: unknown, key: string): string {
  if (typeof value !== 'object' || value === null || !(key in value)) return '';
  const property = (value as Record<string, unknown>)[key];
  return typeof property === 'string' ? property : '';
}

// Duck-typed on purpose: errors thrown by fetch can come from another realm, so `instanceof Error` is unreliable.
function classifyError(err: unknown): string {
  const name = textProperty(err, 'name');
  if (name === 'TimeoutError' || name === 'AbortError') return 'TIMEOUT';
  const cause = typeof err === 'object' && err !== null && 'cause' in err ? err.cause : undefined;
  const code = textProperty(cause, 'code') || textProperty(err, 'code');
  if (code === BLOCKED_ADDRESS_CODE) return 'BLOCKED_ADDRESS';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS_ERROR';
  if (code === 'ECONNREFUSED') return 'CONNECTION_REFUSED';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'CONNECTION_RESET';
  if (/CERT|TLS|SSL|SIGNATURE|SELF_SIGNED/i.test(code)) return 'TLS_ERROR';
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT') return 'TIMEOUT';
  return 'NETWORK_ERROR';
}

/**
 * One attempt: GET with manual redirects, so ENDPOINT_MAX_REDIRECTS is honoured (TD-12).
 * One timeout covers the whole attempt including redirects. The body is never read.
 */
export async function probeOnce(
  startUrl: string,
  options: Pick<ProbeOptions, 'timeoutMs' | 'maxRedirects'>,
  deps: ProbeDeps,
): Promise<Omit<ProbeAttempt, 'attempt'>> {
  const startedAt = deps.nowMs();
  const finish = (extra: { statusCode: number } | ProbeFailure): Omit<ProbeAttempt, 'attempt'> => {
    const responseTimeMs = Math.round(deps.nowMs() - startedAt);
    if ('statusCode' in extra) return { statusCode: extra.statusCode, responseTimeMs };
    return {
      responseTimeMs,
      errorCode: extra.errorCode,
      errorMessage:
        SAFE_MESSAGES[extra.errorCode] ?? SAFE_MESSAGES['NETWORK_ERROR'] ?? 'A network error occurred',
    };
  };

  const signal = AbortSignal.timeout(options.timeoutMs);
  let current: URL;
  try {
    current = new URL(startUrl);
  } catch {
    return finish({ errorCode: 'INVALID_REDIRECT' });
  }

  try {
    for (let hop = 0; ; hop++) {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        return finish({ errorCode: 'INVALID_REDIRECT' });
      }
      if (current.username !== '' || current.password !== '')
        return finish({ errorCode: 'INVALID_REDIRECT' });

      const addresses = await deps.lookup(current.hostname.replace(/^\[|\]$/g, ''));
      if (addresses.some(isBlockedAddress)) return finish({ errorCode: 'BLOCKED_ADDRESS' });

      // The request releases the socket without reading the body: payloads are never surfaced (security 2.9).
      const response = await deps.request(current, { signal });
      const { location } = response;
      if (!REDIRECT_STATUSES.has(response.status) || location === null) {
        return finish({ statusCode: response.status });
      }
      if (hop >= options.maxRedirects) return finish({ errorCode: 'TOO_MANY_REDIRECTS' });
      try {
        current = new URL(location, current);
      } catch {
        return finish({ errorCode: 'INVALID_REDIRECT' });
      }
    }
  } catch (err) {
    return finish({ errorCode: classifyError(err) });
  }
}

/** FR-E2: DOWN only if every attempt fails; stops at the first 200; retryCount + 1 attempts at most. */
export async function probe(url: string, options: ProbeOptions, deps: ProbeDeps): Promise<ProbeResult> {
  const attempts: ProbeAttempt[] = [];
  for (let attempt = 1; attempt <= options.retryCount + 1; attempt++) {
    if (attempt > 1) await deps.sleep(options.retryDelayMs);
    const result = await probeOnce(url, options, deps);
    attempts.push({ attempt, ...result });
    if (result.statusCode === 200) return { isUp: true, attempts };
  }
  return { isUp: false, attempts };
}
