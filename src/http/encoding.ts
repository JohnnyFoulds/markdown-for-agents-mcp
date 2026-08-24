const BOM_MAP: Array<[Buffer, string]> = [
  [Buffer.from([0xef, 0xbb, 0xbf]), 'utf-8'],
  [Buffer.from([0xff, 0xfe]), 'utf-16le'],
  [Buffer.from([0xfe, 0xff]), 'utf-16be'],
];

function fromBom(buf: Buffer): string | null {
  for (const [bom, enc] of BOM_MAP) {
    if (buf.length >= bom.length && buf.subarray(0, bom.length).equals(bom)) return enc;
  }
  return null;
}

function fromContentType(contentType: string): string | null {
  const m = contentType.match(/charset\s*=\s*["']?([^\s;"']+)/i);
  return m ? m[1]!.toLowerCase() : null;
}

function fromMetaCharset(buf: Buffer): string | null {
  const head = buf.subarray(0, 2048).toString('latin1');
  const m = head.match(/<meta[^>]+charset\s*=\s*["']?([^\s;"'>]+)/i) ||
            head.match(/<meta[^>]+content-type[^>]+charset\s*=\s*["']?([^\s;"'>]+)/i);
  return m ? m[1]!.toLowerCase() : null;
}

export function detectCharset(
  contentTypeHeader: string | undefined,
  body: Buffer,
  fallback = 'utf-8',
): string {
  return (
    fromBom(body) ??
    fromContentType(contentTypeHeader ?? '') ??
    fromMetaCharset(body) ??
    fallback
  );
}

export function decodeBody(body: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}
