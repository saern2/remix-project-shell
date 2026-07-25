// Unit tests for .env.example completeness
// Validates: Requirements 5.6

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envExamplePath = resolve(__dirname, '../.env.example');

describe('.env.example completeness', () => {
  let content;

  // Read once for all assertions
  content = readFileSync(envExamplePath, 'utf8');

  it('contains MAX_DURATION_SECONDS key', () => {
    expect(content).toMatch(/^\s*MAX_DURATION_SECONDS\s*=/m);
  });

  it('contains CHUNK_SIZE key', () => {
    expect(content).toMatch(/^\s*CHUNK_SIZE\s*=/m);
  });

  it('contains CHUNK_TIMEOUT_SECONDS key', () => {
    expect(content).toMatch(/^\s*CHUNK_TIMEOUT_SECONDS\s*=/m);
  });

  it('contains WORKER_CONCURRENCY_CHUNKS key', () => {
    expect(content).toMatch(/^\s*WORKER_CONCURRENCY_CHUNKS\s*=/m);
  });
});
