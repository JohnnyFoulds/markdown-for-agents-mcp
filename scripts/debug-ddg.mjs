import http from 'http';
import https from 'https';
import { gunzip } from 'zlib';

async function fetchHtml(url, timeout) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      },
    };

    const chunks = [];

    const req = client.request(options, (res) => {
      console.log('Response status:', res.statusCode);
      console.log('Content-Encoding:', res.headers['content-encoding']);
      console.log('Server:', res.headers.server);

      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        console.log('Redirect to:', res.headers.location);
        fetchHtml(res.headers.location, timeout).then(resolve).catch(reject);
        return;
      }

      res.on('data', (chunk) => {
        chunks.push(chunk);
      });

      res.on('end', async () => {
        let data = Buffer.concat(chunks);

        if (res.headers['content-encoding'] === 'gzip') {
          try {
            data = await gunzip(data);
          } catch (e) {
            console.error('Decompression error:', e.message);
          }
        }

        resolve(data.toString('utf8'));
      });
    });

    req.on('error', reject);
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error(`Request timeout after ${timeout}ms`));
    });

    req.end();
  });
}

const html = await fetchHtml('https://html.duckduckgo.com/html/?q=rag', 10000);
console.log('\n=== HTML Preview ===');
//console.log(html);
console.log(html.substring(0, 3000));
