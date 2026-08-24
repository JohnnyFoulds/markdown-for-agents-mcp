/**
 * SOCKS5 tunnel relay — RFC 1928 + RFC 1929 userpass auth.
 *
 * Mode: `tunnel` only. The server sees only CONNECT host:port (like a MITM-less
 * HTTP CONNECT proxy). Content is never read. Intercept mode would require a CA
 * and is out of scope here; the config validates SOCKS5_LISTEN_MODE.
 *
 * Why this exists: Chromium has no SOCKS5 credential support
 * (microsoft/playwright#10567, P3, open since 2021). When SOCKS5_UPSTREAM_URL
 * requires authentication, Tier 3 cannot reach it directly. Pointing Chromium at
 * socks5://127.0.0.1:1080 (this listener, no auth) and having this listener add
 * credentials upstream is the standard workaround.
 *
 * SSRF note: with a upstream proxy, DNS resolution happens at the proxy so
 * policy.checkPolicy() can only do hostname-lexical blocking. Real SSRF
 * prevention is the network's job (egress firewall / VPC policy).
 */

import net from 'node:net';
import { Logger } from '../utils/logger.js';
import { checkPolicy } from './policy.js';
import { ssrfViolationsTotal } from '../obs/metrics.js';

// ── SOCKS5 constants ─────────────────────────────────────────────────────────
const SOCKS_VERSION = 0x05;
const AUTH_NONE = 0x00;
const AUTH_USERPASS = 0x02;
const AUTH_NO_ACCEPTABLE = 0xff;
const USERPASS_VERSION = 0x01;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const REP_SUCCESS = 0x00;
const REP_GENERAL_FAILURE = 0x01;
const REP_CONN_REFUSED = 0x05;
const REP_HOST_UNREACHABLE = 0x04;
const REP_COMMAND_NOT_SUPPORTED = 0x07;
const REP_ADDRESS_TYPE_NOT_SUPPORTED = 0x08;
const REP_NOT_ALLOWED = 0x02;

function sendReply(socket: net.Socket, rep: number, host = '0.0.0.0', port = 0): void {
  const hostBuf = Buffer.from(host, 'utf8');
  const reply = Buffer.alloc(10);
  reply[0] = SOCKS_VERSION;
  reply[1] = rep;
  reply[2] = 0x00; // reserved
  reply[3] = ATYP_IPV4;
  reply.fill(0, 4, 8); // BND.ADDR (0.0.0.0)
  reply.writeUInt16BE(port, 8);
  socket.write(reply);
  if (rep !== REP_SUCCESS) socket.destroy();
  void hostBuf;
}

export interface Socks5ServerOptions {
  host?: string;
  port?: number;
  auth?: 'none' | 'userpass';
  user?: string;
  pass?: string;
  /** When set, authenticated connections are forwarded through this upstream SOCKS5 URL. */
  upstreamUrl?: string;
  upstreamUser?: string;
  upstreamPass?: string;
}

export class Socks5Server {
  private server: net.Server;
  private readonly opts: Required<Omit<Socks5ServerOptions, 'upstreamUrl' | 'upstreamUser' | 'upstreamPass'>>
    & Pick<Socks5ServerOptions, 'upstreamUrl' | 'upstreamUser' | 'upstreamPass'>;

  constructor(opts: Socks5ServerOptions = {}) {
    this.opts = {
      host: opts.host ?? '127.0.0.1',
      port: opts.port ?? 1080,
      auth: opts.auth ?? 'none',
      user: opts.user ?? '',
      pass: opts.pass ?? '',
      upstreamUrl: opts.upstreamUrl,
      upstreamUser: opts.upstreamUser,
      upstreamPass: opts.upstreamPass,
    };
    this.server = net.createServer(sock => this.handleClient(sock));
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.opts.port, this.opts.host, () => {
        Logger.info(`[socks5] Listener on ${this.opts.host}:${this.opts.port} (auth=${this.opts.auth})`);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise(resolve => this.server.close(() => resolve()));
  }

  private handleClient(client: net.Socket): void {
    client.once('error', () => client.destroy());
    client.once('data', (buf: Buffer) => this.handleGreeting(client, buf));
  }

  // ── Phase 1: greeting / method negotiation ───────────────────────────────
  private handleGreeting(client: net.Socket, buf: Buffer): void {
    buf = Buffer.from(buf);
    if (buf[0] !== SOCKS_VERSION || buf.length < 3) {
      client.destroy();
      return;
    }
    const nMethods = buf[1]!;
    const methods = new Set(buf.subarray(2, 2 + nMethods));

    if (this.opts.auth === 'userpass') {
      if (!methods.has(AUTH_USERPASS)) {
        client.write(Buffer.from([SOCKS_VERSION, AUTH_NO_ACCEPTABLE]));
        client.destroy();
        return;
      }
      client.write(Buffer.from([SOCKS_VERSION, AUTH_USERPASS]));
      client.once('data', (authBuf: Buffer) => this.handleUserpass(client, authBuf));
    } else {
      // No auth required — accept AUTH_NONE or AUTH_USERPASS (client's choice)
      client.write(Buffer.from([SOCKS_VERSION, AUTH_NONE]));
      client.once('data', (reqBuf: Buffer) => this.handleRequest(client, reqBuf));
    }
  }

  // ── Phase 2: RFC 1929 userpass authentication ─────────────────────────────
  private handleUserpass(client: net.Socket, buf: Buffer): void {
    buf = Buffer.from(buf);
    if (buf[0] !== USERPASS_VERSION || buf.length < 3) {
      client.write(Buffer.from([USERPASS_VERSION, 0x01])); // failure
      client.destroy();
      return;
    }
    const uLen = buf[1]!;
    const user = buf.subarray(2, 2 + uLen).toString();
    const pLen = buf[2 + uLen]!;
    const pass = buf.subarray(3 + uLen, 3 + uLen + pLen).toString();

    const ok = user === this.opts.user && pass === this.opts.pass;
    client.write(Buffer.from([USERPASS_VERSION, ok ? 0x00 : 0x01]));
    if (!ok) {
      client.destroy();
      return;
    }
    client.once('data', (reqBuf: Buffer) => this.handleRequest(client, reqBuf));
  }

  // ── Phase 3: CONNECT request ──────────────────────────────────────────────
  private handleRequest(client: net.Socket, buf: Buffer): void {
    buf = Buffer.from(buf);
    if (buf[0] !== SOCKS_VERSION || buf.length < 7) {
      sendReply(client, REP_GENERAL_FAILURE);
      return;
    }

    const cmd = buf[1]!;
    if (cmd !== CMD_CONNECT) {
      sendReply(client, REP_COMMAND_NOT_SUPPORTED);
      return;
    }

    const atyp = buf[3]!;
    let host: string;
    let portOffset: number;

    if (atyp === ATYP_IPV4) {
      host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
      portOffset = 8;
    } else if (atyp === ATYP_DOMAIN) {
      const len = buf[4]!;
      host = buf.subarray(5, 5 + len).toString();
      portOffset = 5 + len;
    } else if (atyp === ATYP_IPV6) {
      // 16-byte IPv6
      const parts: string[] = [];
      for (let i = 0; i < 8; i++) {
        parts.push(buf.readUInt16BE(4 + i * 2).toString(16));
      }
      host = parts.join(':');
      portOffset = 20;
    } else {
      sendReply(client, REP_ADDRESS_TYPE_NOT_SUPPORTED);
      return;
    }

    const port = buf.readUInt16BE(portOffset);

    // Policy check
    const { verdict, reason } = checkPolicy(host, port);
    if (verdict === 'deny') {
      Logger.warn(`[socks5] CONNECT ${host}:${port} denied — ${reason}`);
      ssrfViolationsTotal.labels({ stage: 'socks5_connect' }).inc();
      sendReply(client, REP_NOT_ALLOWED);
      return;
    }

    this.connectToTarget(client, host, port);
  }

  // ── Phase 4: establish upstream tunnel ───────────────────────────────────
  private connectToTarget(client: net.Socket, host: string, port: number): void {
    // With upstream SOCKS5: forward through it (Tier 3 credential workaround)
    if (this.opts.upstreamUrl) {
      this.connectViaUpstream(client, host, port);
      return;
    }

    // Direct tunnel
    const target = net.createConnection({ host, port }, () => {
      sendReply(client, REP_SUCCESS);
      target.pipe(client);
      client.pipe(target);
    });
    target.once('error', err => {
      const rep = (err as NodeJS.ErrnoException).code === 'ECONNREFUSED'
        ? REP_CONN_REFUSED
        : REP_HOST_UNREACHABLE;
      sendReply(client, rep);
    });
    client.once('close', () => target.destroy());
    target.once('close', () => client.destroy());
  }

  // ── Upstream SOCKS5 chaining ──────────────────────────────────────────────
  private connectViaUpstream(client: net.Socket, targetHost: string, targetPort: number): void {
    const url = new URL(this.opts.upstreamUrl!);
    const upHost = url.hostname;
    const upPort = parseInt(url.port || '1080', 10);
    const upUser = this.opts.upstreamUser ?? url.username ?? '';
    const upPass = this.opts.upstreamPass ?? url.password ?? '';

    const upstream = net.createConnection({ host: upHost, port: upPort }, () => {
      // Send greeting — offer AUTH_NONE and AUTH_USERPASS
      upstream.write(Buffer.from([SOCKS_VERSION, 0x02, AUTH_NONE, AUTH_USERPASS]));

      upstream.once('data', (greet: Buffer) => {
        const method = greet[1]!;

        const afterAuth = () => {
          // Build CONNECT request for the real target
          const domainBuf = Buffer.from(targetHost, 'utf8');
          const req = Buffer.alloc(7 + domainBuf.length);
          req[0] = SOCKS_VERSION;
          req[1] = CMD_CONNECT;
          req[2] = 0x00;
          req[3] = ATYP_DOMAIN;
          req[4] = domainBuf.length;
          domainBuf.copy(req, 5);
          req.writeUInt16BE(targetPort, 5 + domainBuf.length);
          upstream.write(req);

          upstream.once('data', (reply: Buffer) => {
            if (reply[1] !== REP_SUCCESS) {
              sendReply(client, reply[1] ?? REP_GENERAL_FAILURE);
              upstream.destroy();
              return;
            }
            sendReply(client, REP_SUCCESS);
            upstream.pipe(client);
            client.pipe(upstream);
          });
        };

        if (method === AUTH_USERPASS) {
          // RFC 1929 sub-negotiation with upstream credentials
          const uBuf = Buffer.from(upUser, 'utf8');
          const pBuf = Buffer.from(upPass, 'utf8');
          const authMsg = Buffer.alloc(3 + uBuf.length + pBuf.length);
          authMsg[0] = USERPASS_VERSION;
          authMsg[1] = uBuf.length;
          uBuf.copy(authMsg, 2);
          authMsg[2 + uBuf.length] = pBuf.length;
          pBuf.copy(authMsg, 3 + uBuf.length);
          upstream.write(authMsg);
          upstream.once('data', (authReply: Buffer) => {
            if (authReply[1] !== 0x00) {
              sendReply(client, REP_GENERAL_FAILURE);
              upstream.destroy();
              return;
            }
            afterAuth();
          });
        } else {
          afterAuth();
        }
      });
    });

    upstream.once('error', () => sendReply(client, REP_HOST_UNREACHABLE));
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
  }
}
