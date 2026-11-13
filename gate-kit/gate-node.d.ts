// Types for gate-node.mjs (Gate kit Node adapter). gate-node.d.mts is a
// byte-for-byte copy for ".mjs" imports; keep both identical.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Gate, GateEnv, GateExecutionContext } from './gate.mjs';

/**
 * true: trust CF-Connecting-IP; string[]: trust it only from these socket
 * peers ("unix" = a Unix-domain socket), which must overwrite the header with
 * the visitor's address; false: socket address only.
 */
export type TrustCloudflare = boolean | readonly string[];

/** The 503 text when the client address is loopback, private or missing outside local development. */
export declare const MSG_PRIVATE_CLIENT: string;

export interface NodeRequestOptions {
  trustCloudflare?: TrustCloudflare | undefined;
  protocol?: 'https' | 'http' | undefined;
}

export declare function clientIpOf(req: IncomingMessage, options?: NodeRequestOptions): string;
export declare function toWebRequest(
  req: IncomingMessage,
  options?: NodeRequestOptions & { body?: Uint8Array | string | null | undefined },
): Request;
export declare function writeWebResponse(res: ServerResponse, response: Response, method?: string): Promise<void>;
export declare function privatizeNodeResponse<T extends ServerResponse>(res: T): T;

export interface NodeGateOptions<E extends GateEnv = GateEnv> extends NodeRequestOptions {
  /** Where the keys live. Default: process.env. */
  env?: E | undefined;
  /**
   * Developer machine only, never production: accept Cloudflare's test keys
   * and a loopback client address for a request from a loopback socket with
   * Host `localhost` / `*.localhost` (not an IP literal) and no proxy headers.
   * Ignored when NODE_ENV=production. Default false.
   */
  localDev?: boolean | undefined;
  ctx?: GateExecutionContext | undefined;
}

/**
 * (req, res, next?) => true when the gate answered, false when it passed
 * (next() was called). Always settles, also when the client disconnects.
 * A request let through only by the exempt hook gets `req.gateExemption`
 * (the exemption's name): answer it from the machine-client handler alone.
 */
export declare function createNodeGate<E extends GateEnv = GateEnv>(
  gate: Gate<E>,
  options?: NodeGateOptions<E>,
): (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void) => Promise<boolean>;
