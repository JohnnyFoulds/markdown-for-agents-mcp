import { fetcher } from "../fetcher.js";
import { extract } from "../extract/pipeline.js";
import { FetchUrlResult } from "./types.js";

export interface FetchUrlOptions {
  url: string;
  timeout?: number;
}

export async function fetchUrl(options: FetchUrlOptions): Promise<FetchUrlResult> {
  const { url, timeout } = options;
  const pageResult = await fetcher.fetch(url, timeout);
  const { markdown, contentSize } = extract(pageResult.html, { url, title: pageResult.title });
  return {
    url,
    title: pageResult.title,
    markdown,
    fetchedAt: new Date().toISOString(),
    contentSize,
  };
}
