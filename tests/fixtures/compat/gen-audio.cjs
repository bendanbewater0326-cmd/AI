/**
 * 生成纯音频导入测试素材（WAV / MP3）→ `tests/fixtures/`。
 *
 * 与 gen-baseline.cjs 同理：素材不进 git（.gitignore），首次 clone 后跑一次本脚本。
 * 运行：`node tests/fixtures/compat/gen-audio.cjs`
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FFMPEG_CANDIDATES = [
  process.env.FFMPEG,
  'C:/Users/Administrator/AppData/Local/Microsoft/Winget/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.2-full_build/bin/ffmpeg.exe',
  'ffmpeg',
].filter(Boolean);
const FFMPEG = FFMPEG_CANDIDATES.find((p) => p === 'ffmpeg' || fs.existsSync(p));
if (FFMPEG === undefined) {
  console.error('✗ 找不到 ffmpeg（设 FFMPEG 环境变量指向 ffmpeg.exe）');
  process.exit(1);
}

const DIR = path.resolve(__dirname);
const OUT_WAV = path.join(DIR, 'sample-440-2s.wav');
const OUT_MP3 = path.join(DIR, 'sample-440-2s.mp3');

// 2 秒 440Hz 正弦，立体声 44.1k；WAV 16bit PCM，MP3 96kbps
execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2',
  '-filter_complex', '[0:a]volume=0.6,aformat=channel_layouts=stereo[out]', '-map', '[out]',
  '-c:a', 'pcm_s16le', OUT_WAV], { stdio: 'ignore' });
execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2',
  '-filter_complex', '[0:a]volume=0.6,aformat=channel_layouts=stereo[out]', '-map', '[out]',
  '-c:a', 'libmp3lame', '-b:a', '96k', OUT_MP3], { stdio: 'ignore' });

console.log('✓ 测试素材已生成：');
console.log('  sample-440-2s.wav');
console.log('  sample-440-2s.mp3');
