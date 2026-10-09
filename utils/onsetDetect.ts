/**
 * onsetDetect.ts — 离线字幕对齐用的「有声起点」分析
 *
 * 思路（全部本地完成，不联网、不依赖 Worker）：
 *
 *   1. 把媒体文件解码成 8 kHz 单声道音频。
 *      8 kHz 的奈奎斯特频率是 4 kHz，而人声/语音的能量几乎全部集中在
 *      200–3500 Hz，所以 8 kHz 足够判断「哪里开始有声」，
 *      同时把内存占用降到原始 48 kHz 立体声的 1/12。
 *      —— 一个 36 分钟的 mp3，8 kHz 下只有约 17M 个采样点，
 *      解码 + 分析通常 1–3 秒完成。
 *
 *   2. 用 OfflineAudioContext 做一次 200–3500 Hz 的带通滤波。
 *      滤掉低频轰隆（空调、桌面震动）和高频嘶声，剩下的就是语音主体。
 *
 *   3. 算短时 RMS 能量包络（10 ms 一帧），再做一次 3 帧滑动平均去抖动。
 *
 *   4. 包络的「正向一阶差分」就是经典的 onset strength（起音强度）曲线，
 *      它的局部极大值正好对应音节/词的起音位置 —— 也就是字幕应该对齐的地方。
 *
 * 字幕对齐时，用户点选某一行 → 在这一行时间的 ±window 秒内找最强峰 →
 * 把字幕时间吸附过去，得到 offset，再整体平移时间轴。
 */

export interface EnergyEnvelope {
    /** 短时 RMS 能量包络，已归一化到 0..1 */
    env: Float32Array;
    /** 起音强度曲线（正向一阶差分），已归一化到 0..1 */
    onset: Float32Array;
    /** 每帧代表多少秒 */
    hopSec: number;
    /** 分析覆盖的时长（秒） */
    duration: number;
    /** 实际解码采样率 */
    sampleRate: number;
}

export interface PeakHit {
    /** 吸附目标时间（秒） */
    time: number;
    /** 该峰的起音强度 0..1 */
    strength: number;
    /** 相对传入中心时间的位移（秒），正值表示往后 */
    delta: number;
}

/** 解码采样率：4 kHz 奈奎斯特，足够覆盖语音带宽 */
const ANALYSIS_RATE = 8000;
/** 包络帧长：10 ms，足以分辨音节 */
const HOP_SEC = 0.01;
/** 带通下限，滤掉低频轰隆 */
const BAND_LOW = 200;
/** 带通上限，滤掉高频嘶声 */
const BAND_HIGH = 3500;
/** 峰搜索的默认窗口半径（秒） */
export const DEFAULT_SNAP_WINDOW = 2.0;

const getOfflineCtor = (): any => {
    const w = window as any;
    const Ctor = w.OfflineAudioContext || w.webkitOfflineAudioContext;
    if (!Ctor) throw new Error('当前浏览器不支持 OfflineAudioContext，无法进行音频分析');
    return Ctor;
};

/**
 * 以低采样率解码媒体文件。
 *
 * 注意：`decodeAudioData` 会把音频重采样到它所属 AudioContext 的 sampleRate，
 * 所以我们故意建一个 8 kHz 的 OfflineAudioContext 来「顺手降采样」，
 * 避免先把 48 kHz 的整段音频读进内存。
 */
async function decodeAtLowRate(blob: Blob): Promise<AudioBuffer> {
    const raw = await blob.arrayBuffer();
    const Ctor = getOfflineCtor();
    const ctx = new Ctor(1, 1, ANALYSIS_RATE);
    // decodeAudioData 会 detach 传入的 ArrayBuffer，所以这里不需要额外拷贝
    return await ctx.decodeAudioData(raw);
}

/** 用 OfflineAudioContext 做 200–3500 Hz 带通，输出单声道 */
async function bandLimit(buffer: AudioBuffer): Promise<AudioBuffer> {
    const Ctor = getOfflineCtor();
    const ctx = new Ctor(1, buffer.length, buffer.sampleRate);

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = BAND_LOW;
    hp.Q.value = 0.707;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = BAND_HIGH;
    lp.Q.value = 0.707;

    src.connect(hp);
    hp.connect(lp);
    lp.connect(ctx.destination);
    src.start(0);

    return await ctx.startRendering();
}

/** 短时 RMS 包络 */
function computeEnvelope(buffer: AudioBuffer, hopSec: number): { env: Float32Array; hopSec: number } {
    const rate = buffer.sampleRate;
    const hop = Math.max(1, Math.round(hopSec * rate));
    const len = buffer.length;
    const frames = Math.max(1, Math.floor(len / hop));

    // 多声道下混（带通后的 OfflineAudioContext 是单声道，这里只是兜底）
    const chCount = buffer.numberOfChannels;
    const channels: Float32Array[] = [];
    for (let c = 0; c < chCount; c++) channels.push(buffer.getChannelData(c));
    const inv = 1 / chCount;

    const env = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
        const start = f * hop;
        const end = Math.min(start + hop, len);
        let sum = 0;
        for (let i = start; i < end; i++) {
            let v = 0;
            for (let c = 0; c < chCount; c++) v += channels[c][i];
            v *= inv;
            sum += v * v;
        }
        env[f] = Math.sqrt(sum / Math.max(1, end - start));
    }
    return { env, hopSec: hop / rate };
}

/** 3 帧滑动平均，抹掉单帧抖动 */
function smooth(input: Float32Array, radius = 1): Float32Array {
    if (radius <= 0) return input;
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
        let sum = 0;
        let n = 0;
        for (let k = -radius; k <= radius; k++) {
            const j = i + k;
            if (j < 0 || j >= input.length) continue;
            sum += input[j];
            n++;
        }
        out[i] = n > 0 ? sum / n : 0;
    }
    return out;
}

/** 正向一阶差分 = 起音强度 */
function computeOnset(env: Float32Array): Float32Array {
    const onset = new Float32Array(env.length);
    for (let i = 1; i < env.length; i++) {
        const d = env[i] - env[i - 1];
        onset[i] = d > 0 ? d : 0;
    }
    return onset;
}

/** 按最大值归一化到 0..1（用于显示与阈值判断；argmax 不受影响） */
function normalize(input: Float32Array): Float32Array {
    let max = 0;
    for (let i = 0; i < input.length; i++) {
        if (input[i] > max) max = input[i];
    }
    if (max <= 0) return input;
    const out = new Float32Array(input.length);
    const inv = 1 / max;
    for (let i = 0; i < input.length; i++) out[i] = input[i] * inv;
    return out;
}

/**
 * 构建能量包络。整个流程是 CPU 密集但纯本地的，
 * 一个 36 分钟的音频大约需要 1–3 秒。
 */
export async function buildEnergyEnvelope(blob: Blob): Promise<EnergyEnvelope> {
    const decoded = await decodeAtLowRate(blob);
    const filtered = await bandLimit(decoded);

    const { env: rawEnv, hopSec } = computeEnvelope(filtered, HOP_SEC);
    const smoothed = smooth(rawEnv, 1);
    const onsetRaw = computeOnset(smoothed);

    return {
        env: normalize(smoothed),
        onset: normalize(onsetRaw),
        hopSec,
        duration: filtered.duration,
        sampleRate: filtered.sampleRate,
    };
}

/**
 * 在 [centerSec - windowSec, centerSec + windowSec] 内找出**最强**的起音峰。
 *
 * 「最强」= onset strength 的局部极大值里取值最大的那个。
 * 用局部极大值（而不是区间最大值）可以避免吸附到某个长音的中间平台。
 * 找到峰值帧后再做一次抛物线插值，把精度细化到亚帧级（~1 ms）。
 */
export function findStrongestPeak(
    envelope: EnergyEnvelope,
    centerSec: number,
    windowSec: number = DEFAULT_SNAP_WINDOW,
): PeakHit | null {
    const { onset, hopSec } = envelope;
    if (onset.length < 3) return null;

    const centerFrame = centerSec / hopSec;
    const halfFrames = Math.max(1, Math.round(windowSec / hopSec));

    const from = Math.max(1, Math.floor(centerFrame - halfFrames));
    const to = Math.min(onset.length - 2, Math.ceil(centerFrame + halfFrames));
    if (to <= from) return null;

    let bestFrame = -1;
    let bestVal = -1;

    // 优先找局部极大值
    for (let i = from; i <= to; i++) {
        const v = onset[i];
        if (v <= bestVal) continue;
        if (v < onset[i - 1] || v < onset[i + 1]) continue; // 必须是局部极大值
        bestVal = v;
        bestFrame = i;
    }

    // 兜底：整段过于平滑（例如持续噪声）时没有明显局部极大值，退回区间最大值
    if (bestFrame < 0) {
        for (let i = from; i <= to; i++) {
            if (onset[i] > bestVal) {
                bestVal = onset[i];
                bestFrame = i;
            }
        }
    }
    if (bestFrame < 0) return null;

    // 抛物线插值，细化到亚帧精度
    const y0 = onset[bestFrame - 1];
    const y1 = onset[bestFrame];
    const y2 = onset[bestFrame + 1];
    const denom = y0 - 2 * y1 + y2;
    let frac = 0;
    if (denom !== 0) {
        frac = (0.5 * (y0 - y2)) / denom;
        if (frac > 0.5) frac = 0.5;
        if (frac < -0.5) frac = -0.5;
    }

    const time = (bestFrame + frac) * hopSec;
    return { time, strength: bestVal, delta: time - centerSec };
}

/** 取窗口内前 N 个候选峰，供 UI 展示「备选吸附点」 */
export function findPeaks(
    envelope: EnergyEnvelope,
    centerSec: number,
    windowSec: number = DEFAULT_SNAP_WINDOW,
    limit = 3,
): PeakHit[] {
    const { onset, hopSec } = envelope;
    if (onset.length < 3) return [];

    const centerFrame = centerSec / hopSec;
    const halfFrames = Math.max(1, Math.round(windowSec / hopSec));
    const from = Math.max(1, Math.floor(centerFrame - halfFrames));
    const to = Math.min(onset.length - 2, Math.ceil(centerFrame + halfFrames));

    const hits: PeakHit[] = [];
    for (let i = from; i <= to; i++) {
        if (onset[i] < onset[i - 1] || onset[i] < onset[i + 1]) continue;
        const time = i * hopSec;
        hits.push({ time, strength: onset[i], delta: time - centerSec });
    }

    hits.sort((a, b) => b.strength - a.strength);
    return hits.slice(0, limit);
}

/**
 * 判断某个峰是否「足够响」——用于拒绝在静音段乱吸附。
 * 以整段音频的能量分布为基准，而不是写死绝对值。
 */
export function isPeakMeaningful(envelope: EnergyEnvelope, hit: PeakHit | null): boolean {
    if (!hit) return false;
    // 起音强度至少要有全局最大值的 2%，否则基本是噪声
    if (hit.strength < 0.02) return false;
    // 并且吸附点附近的能量不能是绝对静音
    const frame = Math.round(hit.time / envelope.hopSec);
    const env = envelope.env;
    const from = Math.max(0, frame - 3);
    const to = Math.min(env.length - 1, frame + 3);
    let local = 0;
    for (let i = from; i <= to; i++) local = Math.max(local, env[i]);
    return local >= 0.03;
}
