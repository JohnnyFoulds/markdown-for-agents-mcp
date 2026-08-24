const CHROME_VERSIONS = ['132.0.0.0', '133.0.0.0', '134.0.0.0', '135.0.0.0'];
const OS_STRING = 'Macintosh; Intel Mac OS X 10_15_7';

export function generateBrowserUA(): string {
  const v = CHROME_VERSIONS[Math.floor(Math.random() * CHROME_VERSIONS.length)]!;
  return `Mozilla/5.0 (${OS_STRING}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`;
}

export const BROWSER_HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  DNT: '1',
  Connection: 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Cache-Control': 'no-cache',
};

export const CRAWLER_UA = 'Mozilla/5.0 (compatible; markdown-for-agents-mcp/1.0)';
