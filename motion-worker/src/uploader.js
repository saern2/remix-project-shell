/**
 * The finished MP4 leaves the box by streamed PUT to a signed URL created
 * app-side — the same Round-12 discipline as the render and tts workers:
 * https.request + createReadStream, Content-Length from stat, constant
 * memory. The Cloudflare app layer never carries a video byte.
 */

import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';

export function uploadFile(filePath, signedUrl, { contentType = 'video/mp4' } = {}) {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(filePath).size;
    const url = new URL(signedUrl);
    const transport = url.protocol === 'http:' ? http : https;
    const request = transport.request(
      url,
      {
        method: 'PUT',
        headers: { 'Content-Type': contentType, 'Content-Length': size },
        timeout: 600_000,
      },
      (response) => {
        const chunks = [];
        response.on('data', (c) => chunks.length < 8 && chunks.push(c));
        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(size);
          } else {
            reject(
              new Error(
                `The finished explainer could not be saved to storage (HTTP ${response.statusCode}). ` +
                  `Please try again. (internal: ${Buffer.concat(chunks).toString('utf8').slice(0, 200)})`,
              ),
            );
          }
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error('upload timed out')));
    request.on('error', (err) =>
      reject(
        new Error(
          `The finished explainer could not be saved to storage. Please try again. (internal: ${err.message})`,
        ),
      ),
    );
    fs.createReadStream(filePath).pipe(request);
  });
}
