/**
 * Download File Tool
 * Downloads a binary file from a URL and saves it to a local path
 */

import { downloadFile } from '../services/downloadFile.js';

export interface DownloadFileOptions {
  url: string;
  outputPath: string;
}

/**
 * MCP tool definition for download_file
 */
export const downloadFileTool = {
  name: 'download_file',
  description:
    'Download a binary file (PDF, image, ZIP, etc.) from a URL and save it to a local path. ' +
    'Returns JSON metadata including the saved path, file size, MIME type, and filename. ' +
    'SSRF protection and domain blocklist are enforced. Use fetch_url for web pages.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL of the file to download',
      },
      outputPath: {
        type: 'string',
        description: 'Absolute local path to save the file to (parent directory must exist)',
      },
    },
    required: ['url', 'outputPath'],
  },
};

/**
 * Handle a download_file tool invocation
 */
export async function downloadFileHandler(args: DownloadFileOptions): Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}> {
  try {
    const result = await downloadFile(args.url, args.outputPath);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: [{ type: 'text', text: `Error downloading file: ${errorMessage}` }],
      isError: true,
    };
  }
}
