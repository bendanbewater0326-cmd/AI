/**
 * 生成内置音效库的 10 个纯音频 mp4（AAC）→ `src/ui/audio/sfx/*.m4a`。
 *
 * 方案 C（docs/audio-panel-plan.md §2，用户已拍板）：
 * 构建期用 ffmpeg 程序化合成（正弦/噪声 + 包络/扫频），产物提交进 git，
 * 运行时经 esbuild base64 内联 → 走现有导入管线成为真资产（media 层零改动）。
 *
 * 全部单声道 48kHz、AAC 64kbps；每个音效首尾 2–4ms 去咔哒淡变
 * （audioEngine 接缝消咔的同一条经验：1 个样本的台阶听感就是"嗒"）。
 * 真实采样音效（掌声/爆炸等）程序合成不了，明确不做（见方案 §8 待拍板 2）。
 *
 * 运行：`node scripts/gen-sfx.cjs`（产物已提交，只有改清单/参数时才需要重跑）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'src', 'ui', 'audio', 'sfx');

/** ffmpeg 位置：环境变量优先，其次本机 winget 安装（gen-baseline.cjs 同款），最后 PATH。 */
const FFMPEG_CANDIDATES = [
  process.env.FFMPEG,
  'C:/Users/Administrator/AppData/Local/Microsoft/Winget/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.2-full_build/bin/ffmpeg.exe',
  'ffmpeg',
].filter(Boolean);
const FFMPEG = FFMPEG_CANDIDATES.find((p) => p === 'ffmpeg' || existsSync(p));
if (FFMPEG === undefined) {
  console.error('✗ 找不到 ffmpeg（设 FFMPEG 环境变量指向 ffmpeg.exe）');
  process.exit(1);
}
const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');

/** 首尾去咔哒：2–4ms 淡变，占空比 <1% 不影响音色。 */
function declick(durationSec) {
  const fadeIn = 0.003;
  const fadeOut = 0.004;
  return (
    `,afade=t=in:st=0:d=${fadeIn}` +
    `,afade=t=out:st=${(durationSec - fadeOut).toFixed(4)}:d=${fadeOut}` +
    ',aformat=sample_rates=48000:channel_layouts=mono'
  );
}

/**
 * 音效清单。`file` 是仓库里的 ASCII 文件名（素材栏显示名在 sfxLibrary.ts 里配）。
 * 每条 chain 都是"恰好一个未命名输出"（ffmpeg 会自动接到输出文件），时长必须与
 * 滤镜实际产出一致（跑完用 ffprobe 复核 ±0.05s）。
 */
const SOUNDS = [
  {
    file: 'ding.m4a',
    duration: 0.6,
    // 叮：880Hz 主体 + 一点 1760Hz 泛音，整体衰减
    inputs: [
      'sine=frequency=880:sample_rate=48000:duration=0.6',
      'sine=frequency=1760:sample_rate=48000:duration=0.6',
    ],
    chain: '[0:a][1:a]amix=inputs=2:normalize=0,volume=0.8,afade=t=out:st=0.06:d=0.54',
  },
  {
    file: 'dong.m4a',
    duration: 0.7,
    // 咚：低频短衰减
    inputs: ['sine=frequency=160:sample_rate=48000:duration=0.7'],
    chain: '[0:a]volume=0.95,afade=t=out:st=0.04:d=0.66',
  },
  {
    file: 'beep.m4a',
    duration: 0.15,
    // 滴·短：短促提示
    inputs: ['sine=frequency=1200:sample_rate=48000:duration=0.15'],
    chain: '[0:a]volume=0.65',
  },
  {
    file: 'double-beep.m4a',
    duration: 0.8,
    // 双响提示：两连音（低→高），接缝各自去咔哒，尾部留静音
    inputs: [
      'sine=frequency=880:sample_rate=48000:duration=0.32',
      'sine=frequency=1318:sample_rate=48000:duration=0.32',
    ],
    chain:
      '[0:a]volume=0.65,afade=t=out:st=0.31:d=0.01[f0];' +
      '[1:a]volume=0.65,afade=t=in:st=0:d=0.005[f1];' +
      '[f0][f1]concat=n=2:v=0:a=1,apad=pad_dur=0.16',
  },
  {
    file: 'whoosh.m4a',
    duration: 1.2,
    // 嗖：噪声从低频带滑到高频带（两段带通交叉淡化近似扫频）+ 梭形包络
    inputs: [
      'anoisesrc=d=0.7:color=white:sample_rate=48000:amplitude=0.8',
      'anoisesrc=d=0.7:color=white:sample_rate=48000:amplitude=0.8',
    ],
    chain:
      '[0:a]bandpass=f=250:w=250[b1];' +
      '[1:a]bandpass=f=3000:w=2000[b2];' +
      '[b1][b2]acrossfade=d=0.2,lowpass=f=6000,volume=0.85,' +
      'afade=t=in:st=0:d=0.25,afade=t=out:st=0.65:d=0.55',
  },
  {
    file: 'riser.m4a',
    duration: 1.0,
    // 上扬：300→1200Hz 正弦上滑（相位 = 300t + 450t²，导数即瞬时频率）
    inputs: ['aevalsrc=sin(2*PI*(300*t+450*t*t)):s=48000:d=1.0:c=mono'],
    chain: '[0:a]volume=0.7,afade=t=out:st=0.8:d=0.2',
  },
  {
    file: 'fall.m4a',
    duration: 1.0,
    // 下落：1200→300Hz 正弦下滑（相位 = 1200t − 450t²）
    inputs: ['aevalsrc=sin(2*PI*(1200*t-450*t*t)):s=48000:d=1.0:c=mono'],
    chain: '[0:a]volume=0.7,afade=t=out:st=0.7:d=0.3',
  },
  {
    file: 'click.m4a',
    duration: 0.4,
    // 咔哒：白噪脉冲 + 快指数衰减（−18/s）
    inputs: ['aevalsrc=(2*random(0)-1)*exp(-18*t):s=48000:d=0.4:c=mono'],
    chain: '[0:a]lowpass=f=8000,volume=0.9',
  },
  {
    file: 'noise-soft.m4a',
    duration: 2.5,
    // 白噪·柔：窄带低电平（环境垫底）
    inputs: ['anoisesrc=d=2.5:color=white:sample_rate=48000:amplitude=0.5'],
    chain: '[0:a]highpass=f=80,lowpass=f=1200,volume=0.35',
  },
  {
    file: 'noise-strong.m4a',
    duration: 2.5,
    // 白噪·强：中电平全带（对白垫底/链路测试）
    inputs: ['anoisesrc=d=2.5:color=white:sample_rate=48000:amplitude=0.6'],
    chain: '[0:a]highpass=f=60,volume=0.45',
  },
];

function runFFmpeg(args, label) {
  const result = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error(`✗ ffmpeg 失败: ${label}\n${result.stderr}`);
    process.exit(1);
  }
}

function probeJson(file, args) {
  const result = spawnSync(FFPROBE, ['-v', 'error', ...args, file], { encoding: 'utf8' });
  return result.stdout.trim();
}

mkdirSync(OUT_DIR, { recursive: true });

console.log(`ffmpeg: ${FFMPEG}`);
let totalBytes = 0;
for (const sound of SOUNDS) {
  const outFile = path.join(OUT_DIR, sound.file);
  const args = [];
  for (const input of sound.inputs) {
    args.push('-f', 'lavfi', '-i', input);
  }
  args.push(
    '-filter_complex',
    `${sound.chain}${declick(sound.duration)}`,
    '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart',
    outFile,
  );
  runFFmpeg(args, sound.file);

  const actual = Number.parseFloat(
    probeJson(outFile, ['-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1']),
  );
  if (!Number.isFinite(actual) || Math.abs(actual - sound.duration) > 0.05) {
    console.error(`✗ ${sound.file} 时长 ${actual}s ≠ 预期 ${sound.duration}s`);
    process.exit(1);
  }
  const size = statSync(outFile).size;
  totalBytes += size;
  console.log(`  ${sound.file.padEnd(18)} ${sound.duration.toFixed(2)}s  ${(size / 1024).toFixed(1)} KB`);
}

// 规格复核（每个文件都查：同一套滤镜尾 + 编码参数，但查全更省心）
for (const sound of SOUNDS) {
  const info = probeJson(path.join(OUT_DIR, sound.file), [
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,channels,sample_rate',
    '-of', 'default=nw=1',
  ]);
  if (!info.includes('codec_name=aac') || !info.includes('channels=1') || !info.includes('sample_rate=48000')) {
    console.error(`✗ ${sound.file} 规格不符（应为 aac / 单声道 / 48kHz）: ${info}`);
    process.exit(1);
  }
}

const files = readdirSync(OUT_DIR).filter((name) => name.endsWith('.m4a'));
if (files.length !== SOUNDS.length) {
  console.error(`✗ 目录里有 ${files.length} 个 m4a，清单要求 ${SOUNDS.length} 个（清掉多余产物再跑）`);
  process.exit(1);
}

console.log(`\n✓ ${SOUNDS.length} 个音效 → ${path.relative(ROOT, OUT_DIR)}/，合计 ${(totalBytes / 1024).toFixed(1)} KB`);
console.log('  下一步：人工试听验收（E2E 测不了听感），然后 base64 内联进构建。');
