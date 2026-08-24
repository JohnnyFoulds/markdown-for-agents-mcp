import type { RenderTier } from './types.js';

export interface HeuristicInput {
  html: string;
  status: number;
  headers: Record<string, string>;
}

export interface HeuristicResult {
  escalate: boolean;
  targetTier: RenderTier;
  score: number;
  reasons: string[];
}

// Weights are exported so they are reviewable and test-overridable.
export const WEIGHTS = {
  nearEmptyBody: 0.35,
  lowTextRatio: 0.25,
  spaPayload: 0.20,
  emptyRootMount: 0.25,
  scriptHeavy: 0.10,
  noscriptWarning: 0.20,
  richContent: -0.50,
} as const;

export const ESCALATE_THRESHOLD = 0.45;
export const RENDER_MIN_TEXT_CHARS = 400;

const BOT_CHALLENGE_HEADERS = ['cf-mitigated', 'x-datadome-request', 'x-incapsula-error'];
const BOT_CHALLENGE_CONTENT = ['__cf_chl', 'Just a moment...', '_Incapsula_', 'datadome', 'DDoS protection'];

const SPA_MARKERS = [
  '__NEXT_DATA__', 'window.__NUXT__', '__remixContext',
  '__INITIAL_STATE__', 'ng-version', 'window.REDUX_STATE',
];

const BOT_STATUSES = new Set([403, 429, 503]);

function visibleText(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countScriptTags(html: string): number {
  return (html.match(/<script[^>]+src=/gi) ?? []).length;
}

function hasEmptyRootMount(html: string): boolean {
  // Matches <div id="root"></div>, <div id="app"></div>, etc. with no element children
  return /<(div|main)[^>]+id=["'](root|app|__next)['""][^>]*>\s*<\/(div|main)>/i.test(html) ||
    /<[^>]+data-reactroot[^>]*>\s*<\/[^>]+>/i.test(html);
}

export function needsEscalation(
  html: string,
  status: number,
  headers: Record<string, string>,
): HeuristicResult {
  const reasons: string[] = [];

  // Content-type guard: never escalate non-HTML
  const ct = (headers['content-type'] ?? '').toLowerCase();
  if (ct && !ct.includes('text/html')) {
    return { escalate: false, targetTier: 'http', score: 0, reasons: ['non-html content-type'] };
  }

  // Hard jump to playwright for bot challenges (Lightpanda has no stealth)
  const isBotChallenge =
    BOT_STATUSES.has(status) ||
    BOT_CHALLENGE_HEADERS.some(h => headers[h] !== undefined) ||
    BOT_CHALLENGE_CONTENT.some(marker => html.includes(marker));

  if (isBotChallenge) {
    return { escalate: true, targetTier: 'playwright', score: 1.0, reasons: ['bot-challenge'] };
  }

  let score = 0;
  const text = visibleText(html);

  if (text.length < RENDER_MIN_TEXT_CHARS) {
    score += WEIGHTS.nearEmptyBody;
    reasons.push('near-empty-body');
  }

  if (html.length > 0 && text.length / html.length < 0.05) {
    score += WEIGHTS.lowTextRatio;
    reasons.push('low-text-ratio');
  }

  if (SPA_MARKERS.some(m => html.includes(m))) {
    score += WEIGHTS.spaPayload;
    reasons.push('spa-payload');
  }

  if (hasEmptyRootMount(html)) {
    score += WEIGHTS.emptyRootMount;
    reasons.push('empty-root-mount');
  }

  const scriptCount = countScriptTags(html);
  if (scriptCount >= 8 && text.length < 1500) {
    score += WEIGHTS.scriptHeavy;
    reasons.push('script-heavy');
  }

  if (/enable JavaScript|requires JavaScript/i.test(html)) {
    score += WEIGHTS.noscriptWarning;
    reasons.push('noscript-warning');
  }

  // Negative: rich content signals (static article — no escalation needed)
  const paragraphMatches = html.match(/<p[^>]*>[\s\S]*?<\/p>/gi) ?? [];
  const paragraphTextLen = paragraphMatches
    .map(p => p.replace(/<[^>]+>/g, '').length)
    .reduce((a, b) => a + b, 0);
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const articleLen = articleMatch ? articleMatch[1]!.replace(/<[^>]+>/g, '').length : 0;

  if ((paragraphMatches.length >= 3 && paragraphTextLen > 1500) || articleLen > 1000) {
    score += WEIGHTS.richContent;
    reasons.push('rich-static-content');
  }

  const escalate = score >= ESCALATE_THRESHOLD;
  return { escalate, targetTier: escalate ? 'lightpanda' : 'http', score, reasons };
}
