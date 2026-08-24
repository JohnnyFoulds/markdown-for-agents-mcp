import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { Socks5Server } from './socks5Server.js';

// Pick an unused port for each test suite
let portCounter = 19100;
function nextPort() { return portCounter++; }

async function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port }, () => resolve(sock));
    sock.once('error', reject);
  });
}

async function write(sock: net.Socket, data: Buffer): Promise<Buffer> {
  return new Promise((resolve) => {
    sock.once('data', resolve);
    sock.write(data);
  });
}

const servers: Socks5Server[] = [];
afterEach(async () => {
  for (const s of servers) { await s.close(); }
  servers.length = 0;
});

async function startServer(opts: ConstructorParameters<typeof Socks5Server>[0] = {}): Promise<Socks5Server> {
  const s = new Socks5Server({ port: nextPort(), host: '127.0.0.1', ...opts });
  await s.listen();
  servers.push(s);
  return s;
}

describe('SOCKS5 greeting / method negotiation', () => {
  it('selects NO_AUTH when client offers it', async () => {
    const srv = await startServer({ auth: 'none' });
    const sock = await connect((srv as unknown as { opts: { port: number } }).opts.port);
    const resp = await write(sock, Buffer.from([0x05, 0x01, 0x00])); // VER, NMETHODS=1, NO_AUTH
    expect(resp[0]).toBe(0x05);  // VER
    expect(resp[1]).toBe(0x00);  // NO_AUTH selected
    sock.destroy();
  });

  it('rejects when client only offers GSSAPI (not supported)', async () => {
    const srv = await startServer({ auth: 'userpass' });
    const sock = await connect((srv as unknown as { opts: { port: number } }).opts.port);
    const resp = await write(sock, Buffer.from([0x05, 0x01, 0x01])); // GSSAPI only
    expect(resp[1]).toBe(0xff); // NO_ACCEPTABLE_METHODS
    sock.destroy();
  });

  it('selects USERPASS when server requires it and client offers it', async () => {
    const srv = await startServer({ auth: 'userpass', user: 'alice', pass: 'secret' });
    const port = (srv as unknown as { opts: { port: number } }).opts.port;
    const sock = await connect(port);
    const resp = await write(sock, Buffer.from([0x05, 0x02, 0x00, 0x02])); // NO_AUTH + USERPASS
    expect(resp[1]).toBe(0x02); // USERPASS selected
    sock.destroy();
  });
});

describe('RFC 1929 userpass authentication', () => {
  async function greetAndAuth(port: number, user: string, pass: string): Promise<number> {
    const sock = await connect(port);
    await write(sock, Buffer.from([0x05, 0x02, 0x00, 0x02]));
    const uBuf = Buffer.from(user);
    const pBuf = Buffer.from(pass);
    const msg = Buffer.alloc(3 + uBuf.length + pBuf.length);
    msg[0] = 0x01; msg[1] = uBuf.length; uBuf.copy(msg, 2);
    msg[2 + uBuf.length] = pBuf.length; pBuf.copy(msg, 3 + uBuf.length);
    const resp = await write(sock, msg);
    const status = resp[1] ?? 0xff;
    sock.destroy();
    return status;
  }

  it('accepts correct credentials (status 0x00)', async () => {
    const srv = await startServer({ auth: 'userpass', user: 'alice', pass: 'secret' });
    const port = (srv as unknown as { opts: { port: number } }).opts.port;
    expect(await greetAndAuth(port, 'alice', 'secret')).toBe(0x00);
  });

  it('rejects wrong credentials (non-zero status)', async () => {
    const srv = await startServer({ auth: 'userpass', user: 'alice', pass: 'secret' });
    const port = (srv as unknown as { opts: { port: number } }).opts.port;
    expect(await greetAndAuth(port, 'alice', 'wrong')).not.toBe(0x00);
  });
});

describe('CONNECT — policy enforcement', () => {
  async function sendConnect(port: number, targetHost: string, targetPort: number): Promise<number> {
    const sock = await connect(port);
    // Greeting (no auth)
    await write(sock, Buffer.from([0x05, 0x01, 0x00]));
    // CONNECT request
    const domain = Buffer.from(targetHost);
    const req = Buffer.alloc(7 + domain.length);
    req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03;
    req[4] = domain.length; domain.copy(req, 5);
    req.writeUInt16BE(targetPort, 5 + domain.length);
    const resp = await write(sock, req);
    const rep = resp[1] ?? 0xff;
    sock.destroy();
    return rep;
  }

  it('denies CONNECT to blocked port 22', async () => {
    const srv = await startServer();
    const port = (srv as unknown as { opts: { port: number } }).opts.port;
    const rep = await sendConnect(port, 'example.com', 22);
    expect(rep).toBe(0x02); // NOT_ALLOWED
  });

  it('denies CONNECT to loopback (SSRF)', async () => {
    const srv = await startServer();
    const port = (srv as unknown as { opts: { port: number } }).opts.port;
    const rep = await sendConnect(port, '127.0.0.1', 80);
    expect(rep).toBe(0x02); // NOT_ALLOWED
  });

  it('denies CONNECT to 169.254.169.254 (metadata SSRF)', async () => {
    const srv = await startServer();
    const port = (srv as unknown as { opts: { port: number } }).opts.port;
    const rep = await sendConnect(port, '169.254.169.254', 80);
    expect(rep).toBe(0x02); // NOT_ALLOWED
  });
});
