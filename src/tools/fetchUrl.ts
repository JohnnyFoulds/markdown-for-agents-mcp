import { getConfig } from "../config.js";
import { fetcher } from "../fetcher.js";
import { extract } from "../extract/pipeline.js";
import { FetchUrlResult } from "./types.js";

export interface FetchUrlOptions {
  url: string;
  timeout?: number;
  headers?: Record<string, string>;
}

export async function fetchUrl(options: FetchUrlOptions): Promise<FetchUrlResult> {
  const { url, timeout } = options;
  let headers = options.headers;
  try {
    if (!getConfig().FETCH_ALLOW_REQUEST_HEADERS) headers = undefined;
  } catch { /* config not initialised — allow by default */ }
  const pageResult = await fetcher.fetch(url, timeout, undefined, headers);
  const { markdown, contentSize } = extract(pageResult.html, { url, title: pageResult.title });
  return {
    url,
    title: pageResult.title,
    markdown,
    fetchedAt: new Date().toISOString(),
    contentSize,
  };
}
