'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { buildFilterGraph } = require('../../src/ffmpegBuilder');

describe('filter graph duration contract', () => {
  test('pads short source streams and trims every clip to its requested timeline duration', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'filtergraph-duration-'));
    try {
      const { scriptPath } = buildFilterGraph({
        clips: [
          { start: 0, end: 2.8 },
          { start: 0, end: 3.45 },
        ],
        width: 1280,
        height: 720,
        fps: 30,
        transition: 'hard-cut',
        transitionDuration: 0.5,
        tempDir,
      });
      const graph = await fs.readFile(scriptPath, 'utf8');

      expect(graph).toContain('tpad=stop_mode=clone:stop_duration=2.8,trim=duration=2.8');
      expect(graph).toContain('tpad=stop_mode=clone:stop_duration=3.45,trim=duration=3.45');
      expect(graph).toContain('concat=n=2:v=1:a=0');
      expect(graph).not.toContain('xfade=');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
