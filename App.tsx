import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  Play, Pause, SkipBack, SkipForward, Volume2, VolumeX,
  Maximize, Minimize, Upload, Music, FileText, Settings, ImageIcon,
  Repeat, Repeat1, Square, Eye, EyeOff, Video, Download, Film, Type, X, ListMusic, Rewind, FastForward,
  ChevronUp, ChevronDown, Keyboard, Minus, Crosshair, Magnet, Waves, AudioWaveform, Move, Loader2
} from './components/Icons';
import { AudioMetadata, LyricLine, TabView, VisualSlide, VideoPreset, PlaylistItem, RenderConfig, RenderEngine, FFmpegCodec } from './types';
import { formatTime, parseLRC, parseSRT, parseTTML, parseVTT } from './utils/parsers';
import VisualEditor from './components/VisualEditor';
import PlaylistEditor from './components/PlaylistEditor';
import RenderSettings, { highlightEffectGroups, deriveHighlightColors, lyricDisplayGroups, textCaseOptions } from './components/RenderSettings';
import AudioVisualizer, { disconnectVisualizerAudio } from './components/AudioVisualizer';
import { getSharedAudioContext, getOrCreateMediaElementSource } from './utils/audioContext';
import ThreeBackground from './components/ThreeBackground';
import { drawCanvasFrame } from './utils/canvasRenderer';
import { isFloatingNotesVisible } from './utils/floatingNotesVisibility';
import {
    getFloatingNotesFontSizeScale,
    getFloatingNotesMediaFlexStyle,
    getFloatingNotesMediaContainerClass,
    getFloatingNotesMediaObjectPosition,
    getFloatingNotesMediaSizeScale,
    getFloatingNotesOutlineSize,
} from './utils/floatingNotesLayout';
import { resolveAutoLyricVisibility, getContentIndexAtOffset, isEmptyLyricLine } from './utils/lyricVisibility';
import { PRESET_CYCLE_LIST, PRESET_DEFINITIONS, videoPresetGroups } from './utils/presets';
import { useUI } from './contexts/UIContext';
import FloatingVideoWindow from './components/FloatingVideoWindow';
import { buildEnergyEnvelope, findStrongestPeak, isPeakMeaningful, DEFAULT_SNAP_WINDOW, EnergyEnvelope } from './utils/onsetDetect';
import { renderWithFFmpeg, renderPlaylistWithFFmpeg, isFFmpegAvailable, getFFmpegCodecs } from './utils/ffmpegRenderer';
import { renderWithWebCodecs, renderPlaylistWithWebCodecs, isWebCodecsSupported } from './utils/webCodecsRenderer';
import { extractEmbeddedLyrics } from './utils/embeddedLyrics';
import { generateRandomRenderConfig } from './utils/randomConfig';
import { translate, loadLang, saveLang, type Lang } from './locales';

/**
 * 字幕对齐的「锚点」。
 *
 * 用户在时间轴前段点一行、后段点一行，各自吸附到最近的强起音点，
 * 就得到两个 (原时间 → 吸附时间) 的对应关系：
 *   - 只有一个锚点 → 整条时间轴做常量平移；
 *   - 有两个锚点 → 在两点之间做线性插值，顺带修正「越往后越偏」的漂移。
 */
export interface SyncAnchor {
    id: string;
    lineIndex: number;
    originalTime: number;
    snappedTime: number;
    offset: number;      // snappedTime - originalTime
    strength: number;
}

function App() {
  const { toast, confirm } = useUI();
  // Refs
  const audioRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lyricsContainerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const abortRenderRef = useRef<{ aborted: boolean }>({ aborted: false });
  const exportVideoRef = useRef<() => void>(() => { });

  // 字体改为「按需加载」：默认使用仓库内置的 ChillRoundM（离线可用），
  // 只有用户主动选择某个 Google 字体时才会去请求网络。
  // 详见 utils/fonts.ts 的 ensureFontLoaded()。

  // State: Media & Data
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const [currentAudioFile, setCurrentAudioFile] = useState<File | null>(null);
  const [audioElementKey, setAudioElementKey] = useState(0);
  const [metadata, setMetadata] = useState<AudioMetadata>({
    title: 'No Audio Loaded',
    artist: 'Select a file',
    coverUrl: null,
  });
  const [lyrics, setLyrics] = useState<LyricLine[]>([]);
  const [visualSlides, setVisualSlides] = useState<VisualSlide[]>([]);
  const [lyricOffset, setLyricOffset] = useState(0);

  // State: 悬浮视频小窗
  const [videoWindowVisible, setVideoWindowVisible] = useState(true);
  const [videoAspect, setVideoAspect] = useState(0); // 0 表示纯音频文件

  // State: 字幕对齐（频谱吸附校正）
  const [syncMode, setSyncMode] = useState(false);
  const [syncEnvelope, setSyncEnvelope] = useState<EnergyEnvelope | null>(null);
  const [syncAnalyzing, setSyncAnalyzing] = useState(false);
  const [syncAnchors, setSyncAnchors] = useState<SyncAnchor[]>([]);
  const [syncOffsets, setSyncOffsets] = useState<number[] | null>(null);
  const [syncWindow, setSyncWindow] = useState(DEFAULT_SNAP_WINDOW);
  const [awaitingSecondAnchor, setAwaitingSecondAnchor] = useState(false);
  const [snapPreview, setSnapPreview] = useState<{ lineIndex: number; delta: number; strength: number } | null>(null);

  // State: Playback
  const [isPlaying, setIsPlaying] = useState(false);
  const [repeatMode, setRepeatMode] = useState<'off' | 'one' | 'all' | 'all_repeat'>('off');
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);

  // State: UI
  const [activeTab, setActiveTab] = useState<TabView>(TabView.PLAYER);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMouseIdle, setIsMouseIdle] = useState(false);
  const [bypassAutoHide, setBypassAutoHide] = useState(false);
  const [isBgVideoReady, setIsBgVideoReady] = useState(false);


  // State: Video Export
  const [isRendering, setIsRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [aspectRatio, setAspectRatio] = useState<'16:9' | '9:16' | '3:4' | '1:1' | '1:2' | '2:1' | '2:3' | '3:2' | '20:9' | '21:9' | '4:5' | '4:3'>('16:9');
  const [resolution, setResolution] = useState<'720p' | '1080p'>('1080p');
  const [preset, setPreset] = useState<VideoPreset>('default');
  const [customFontName, setCustomFontName] = useState<string | null>(null);
  const [customChannelFontName, setCustomChannelFontName] = useState<string | null>(null);
  const [customInfoFontName, setCustomInfoFontName] = useState<string | null>(null);
  // const [fontSizeScale, setFontSizeScale] = useState(1); // Migrated to renderConfig
  const [renderCodec, setRenderCodec] = useState<string>('auto');
  const [renderFps, setRenderFps] = useState<number>(30);
  const [renderQuality, setRenderQuality] = useState<'low' | 'med' | 'high'>('med');

  // FFmpeg WASM render engine options
  const [renderEngine, setRenderEngine] = useState<RenderEngine>('webcodecs');
  const [ffmpegCodec, setFfmpegCodec] = useState<FFmpegCodec>('h264');
  const [ffmpegRenderStage, setFfmpegRenderStage] = useState<string>('');

  const [showRenderSettings, setShowRenderSettings] = useState(false);
  const [showShortcutInfo, setShowShortcutInfo] = useState(false);
  const [uiScale, setUiScale] = useState(1.0);

  // 界面语言：默认中文，可切换回英文。词条见 locales/zh.ts
  const [lang, setLang] = useState<Lang>(loadLang);
  const tr = useCallback((en: string) => translate(en, lang), [lang]);
  useEffect(() => { saveLang(lang); }, [lang]);

  // State: Drag and Drop
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);
  const [renderConfig, setRenderConfig] = useState<RenderConfig>({
    backgroundSource: 'custom',
    backgroundColor: '#0a0a0a',
    backgroundGradient: 'linear-gradient(135deg, #241a08 0%, #0d0b08 42%, #000000 100%)',
    renderMode: 'current',
    textAlign: 'center',
    contentPosition: 'center',
    fontFamily: "'ChillRoundM', ui-sans-serif, system-ui, sans-serif",
    fontSizeScale: 1.0,
    fontColor: '#ffffff',
    textEffect: 'preset',
    textAnimation: 'none',
    transitionEffect: 'none',
    lyricDisplayMode: 'all',
    lyricVisibilityMode: 'default',
    fontWeight: 'bold',
    fontStyle: 'normal',
    lyricStyleTarget: 'active-only',
    textDecoration: 'none',
    showTitle: true,
    showArtist: true,
    showCover: true,
    showIntro: true,
    showLyrics: true,
    infoPosition: 'top-left',
    infoStyle: 'classic',
    infoMarginScale: 1.0,
    backgroundBlurStrength: 0,
    introMode: 'auto',
    introText: '',
    textCase: 'none',
    highlightEffect: 'karaoke',
    lyricLineHeight: 1.3,
    useRealColorMedia: false,
    channelInfoFontWeight: 'bold',
    channelInfoFontStyle: 'normal',
    infoFontWeight: 'bold',
    infoFontStyle: 'normal',
    showFloatingNotes: false,
    floatingNotesLayout: 'text-only',
    floatingNotesMedia: undefined,
    floatingNotesMediaType: 'image',
    floatingNotesText: 'Floating Notes',
    floatingNotesPosition: 'bottom-left',
    floatingNotesShape: 'rounded',
    floatingNotesFillColor: '#000000',
    floatingNotesOutlineColor: '#ffffff',
    floatingNotesOutlineSize: 1,
    floatingNotesOpacity: 0.8,
    floatingNotesMarginScale: 1.0,
    floatingNotesWidth: 300,
    floatingNotesHeight: 150,
    floatingNotesMediaSizeScale: 0.4,
    floatingNotesFontSizeScale: 1.0,
    floatingNotesFontFamily: 'ui-sans-serif, system-ui, sans-serif',
    floatingNotesFontStyle: 'normal',
    floatingNotesFontWeight: 'normal',
    floatingNotesFontColor: '#ffffff',
    floatingNotesTextAlign: 'left',
    floatingNotesVisibilityMode: 'all',
    floatingNotesFromStartDuration: 10,
    floatingNotesFromEndDuration: 10,
    floatingNotesSpecificStart: '0:00',
    floatingNotesSpecificEnd: '0:30',
    randomizeBackgroundSource: true,
    randomizeBackgroundEffects: true,
    randomizeAudioVisualizer: true,
    randomizeLyricDisplayMode: true,
    randomizeHighlightEffect: true,
    randomizeVisibleElements: true,
    randomizeIntroSettings: true,
    randomizeTypographyStyle: true,
    randomizeTextEffect: true,
    randomizeTextAnimation: true,
    randomizeTransitionEffect: true,
    randomizeVisualTransition: true,
    randomizeChannelInfo: true,
    randomizeFloatingNotes: true,
    randomizeSongInfoDesign: true,
  });

  // Ref to access latest config in event handlers without triggering re-renders
  const renderConfigRef = useRef(renderConfig);
  useEffect(() => {
    renderConfigRef.current = renderConfig;
  }, [renderConfig]);

  const progressBarRef = useRef<HTMLDivElement>(null);
  const volumeBarRef = useRef<HTMLDivElement>(null);

  const isBlurEnabled = renderConfig.backgroundBlurStrength > 0;

  const supportedCodecs = useMemo(() => {
    const candidates = [
      { label: 'VP9 (WebM)', value: 'video/webm; codecs=vp9,opus' },
      { label: 'H.264 (MP4)', value: 'video/mp4; codecs="avc1.4D401E, mp4a.40.2"' },
      { label: 'AV1 (MP4)', value: 'video/mp4; codecs="av01.0.05M.08"' },
      { label: 'AV1 (WebM)', value: 'video/webm; codecs=av1' },
      { label: 'H.264 High (MP4)', value: 'video/mp4; codecs="avc1.64001E, mp4a.40.2"' },
    ];
    return candidates.filter(c => MediaRecorder.isTypeSupported(c.value));
  }, []);

  const [playlist, setPlaylist] = useState<PlaylistItem[]>([]);
  const [currentTrackIndex, setCurrentTrackIndex] = useState<number>(-1);
  const [isPlaylistMode, setIsPlaylistMode] = useState(false);

  // Derived dimensions
  const getCanvasDimensions = () => {
    const is1080p = resolution === '1080p';

    switch (aspectRatio) {
      case '9:16':
        return is1080p ? { w: 1080, h: 1920 } : { w: 720, h: 1280 };
      case '3:4':
        return is1080p ? { w: 1080, h: 1440 } : { w: 720, h: 960 };
      case '4:3':
        return is1080p ? { w: 1440, h: 1080 } : { w: 960, h: 720 };
      case '1:1':
        return is1080p ? { w: 1080, h: 1080 } : { w: 720, h: 720 };
      case '1:2':
        return is1080p ? { w: 1080, h: 2160 } : { w: 720, h: 1440 };
      case '2:1':
        return is1080p ? { w: 2160, h: 1080 } : { w: 1440, h: 720 };
      case '2:3':
        return is1080p ? { w: 1080, h: 1620 } : { w: 720, h: 1080 };
      case '3:2':
        return is1080p ? { w: 1620, h: 1080 } : { w: 1080, h: 720 };
      case '4:5':
        return is1080p ? { w: 1080, h: 1350 } : { w: 720, h: 900 };
      case '20:9':
        return is1080p ? { w: 2400, h: 1080 } : { w: 1600, h: 720 };
      case '21:9':
        return is1080p ? { w: 2560, h: 1080 } : { w: 1720, h: 720 };
      case '16:9':
      default:
        return is1080p ? { w: 1920, h: 1080 } : { w: 1280, h: 720 };
    }
  };


  const { w: canvasWidth, h: canvasHeight } = getCanvasDimensions();

  // Visibility Toggles (Shortcuts)
  const [showInfo, setShowInfo] = useState(true);
  const [showPlayer, setShowPlayer] = useState(true);
  const [isMinimalMode, setIsMinimalMode] = useState(false);

  // Derived State
  const activeVisualSlides = useMemo(() => {
    // Transition Logic:
    const transitionType = renderConfig.visualTransitionType || 'none';
    const transitionDuration = renderConfig.visualTransitionDuration || 1.0;
    const isTransitionActive = transitionType !== 'none';

    const slides = visualSlides.filter(s => {
      if (s.type === 'audio') return false;
      const isActive = currentTime >= s.startTime && currentTime < s.endTime;
      if (isActive) return true;

      // Include tails for transitions (only for crossfade)
      if (transitionType === 'crossfade') {
        if (currentTime >= s.endTime && currentTime < s.endTime + transitionDuration) return true;
      }
      return false;
    });

    // Sort by layer (0 first, then 1) so 1 draws on top, then by startTime to handle crossfades properly
    return slides.sort((a, b) => {
      const layerDiff = (a.layer || 0) - (b.layer || 0);
      if (layerDiff !== 0) return layerDiff;
      return a.startTime - b.startTime;
    });
  }, [visualSlides, currentTime, renderConfig.visualTransitionType, renderConfig.visualTransitionDuration]);

  const activeAudioSlides = visualSlides.filter(
    s => s.type === 'audio' && currentTime >= s.startTime && currentTime < s.endTime
  );

  // Adjusted lyrics based on offset
  // 每行最终时间 = 原时间 + 全局微调(lyricOffset) + 该行对齐修正(syncOffsets[i])
  const adjustedLyrics = useMemo(() => {
    if (lyricOffset === 0 && !syncOffsets) return lyrics;
    return lyrics.map((l, i) => {
      const syncShift = syncOffsets?.[i] ?? 0;
      const total = lyricOffset + syncShift;
      if (total === 0) return l;
      return {
        ...l,
        time: l.time + total,
        endTime: l.endTime !== undefined ? l.endTime + total : undefined,
        // words 的「全局微调」由渲染层负责（那里会再加一次 lyricOffset），
        // 所以这里只补上「对齐修正」的部分，避免重复偏移。
        words: syncShift !== 0 && l.words
          ? l.words.map(w => ({ ...w, startTime: w.startTime + syncShift, endTime: w.endTime + syncShift }))
          : l.words,
      };
    });
  }, [lyrics, lyricOffset, syncOffsets]);

  // Detect unsynced lyrics (all timestamps are 0 — e.g. embedded USLT without timing)
  const isUnsyncedLyrics = useMemo(() => {
    if (adjustedLyrics.length === 0) return false;
    return adjustedLyrics.every(l => l.time === 0 && (l.endTime === undefined || l.endTime === 0));
  }, [adjustedLyrics]);

  const currentLyricIndex = isUnsyncedLyrics ? -1 : adjustedLyrics.findIndex((line, index) => {
    if (line.endTime !== undefined) {
      return currentTime >= line.time && currentTime < line.endTime;
    }
    const nextLine = adjustedLyrics[index + 1];
    return currentTime >= line.time && (!nextLine || currentTime < nextLine.time);
  });

  const isStaticLyricMode = ['static-all', 'static-compact', 'static-compact-comma', 'static-compact-clean'].includes(renderConfig.lyricDisplayMode);

  const autoLyricVisibility = useMemo(() => {
    if (
      renderConfig.lyricVisibilityMode !== 'auto' ||
      isUnsyncedLyrics ||
      adjustedLyrics.length === 0 ||
      isStaticLyricMode
    ) {
      return null;
    }
    return resolveAutoLyricVisibility(adjustedLyrics, currentTime, duration);
  }, [renderConfig.lyricVisibilityMode, isUnsyncedLyrics, adjustedLyrics, currentTime, duration, isStaticLyricMode]);

  const autoHideLyricsPreview = autoLyricVisibility?.autoHideLyrics ?? false;
  const displayLyricIndex = autoHideLyricsPreview
    ? -1
    : (autoLyricVisibility?.displayIdx ?? currentLyricIndex);
  const virtualLyricIndex = autoLyricVisibility?.virtualActiveIdx
    ?? (currentLyricIndex >= 0 ? currentLyricIndex : 0);

  const showFloatingNotesPreview = useMemo(() => {
    return isFloatingNotesVisible(currentTime, duration, renderConfig, adjustedLyrics, {
      isFirstSongInPlaylist: currentTrackIndex <= 0,
    });
  }, [currentTime, duration, renderConfig, adjustedLyrics, currentTrackIndex]);

  const floatingNotesLayout = renderConfig.floatingNotesLayout || 'text-only';
  const floatingNotesMediaSizeScale = getFloatingNotesMediaSizeScale(renderConfig);
  const floatingNotesFontSizeScale = getFloatingNotesFontSizeScale(renderConfig);
  const floatingNotesOutlineSize = getFloatingNotesOutlineSize(renderConfig);

  const isLyricLineVisible = useCallback((idx: number) => {
    if (isEmptyLyricLine(adjustedLyrics[idx])) return false;
    if (displayLyricIndex === -1) return false;

    const mode = renderConfig.lyricDisplayMode;
    const useAutoOffsets = renderConfig.lyricVisibilityMode === 'auto' && autoLyricVisibility !== null;

    if (mode === 'all') return true;
    if (mode === 'static-all') return adjustedLyrics[idx].text.trim() !== '';

    if (mode === 'active-only') {
      const target = useAutoOffsets
        ? getContentIndexAtOffset(adjustedLyrics, virtualLyricIndex, 0)
        : displayLyricIndex;
      return idx === target;
    }

    if (mode === 'next-only') {
      const cur = useAutoOffsets
        ? getContentIndexAtOffset(adjustedLyrics, virtualLyricIndex, 0)
        : displayLyricIndex;
      const next = useAutoOffsets
        ? getContentIndexAtOffset(adjustedLyrics, virtualLyricIndex, 1)
        : displayLyricIndex + 1;
      return idx === cur || (next !== -1 && idx === next);
    }

    if (mode === 'previous-next') {
      const prev = useAutoOffsets
        ? getContentIndexAtOffset(adjustedLyrics, virtualLyricIndex, -1)
        : displayLyricIndex - 1;
      const cur = useAutoOffsets
        ? getContentIndexAtOffset(adjustedLyrics, virtualLyricIndex, 0)
        : displayLyricIndex;
      const next = useAutoOffsets
        ? getContentIndexAtOffset(adjustedLyrics, virtualLyricIndex, 1)
        : displayLyricIndex + 1;
      return idx === prev || idx === cur || (next !== -1 && idx === next);
    }

    return true;
  }, [adjustedLyrics, displayLyricIndex, virtualLyricIndex, renderConfig.lyricDisplayMode, renderConfig.lyricVisibilityMode, autoLyricVisibility]);

  // --- Handlers ---

  const loadAudioFile = async (file: File, lyricFile?: File) => {
    // Cleanup old source
    if (audioSrc && audioSrc.startsWith('blob:')) {
      URL.revokeObjectURL(audioSrc);
    }

    const url = URL.createObjectURL(file);
    setAudioSrc(url);
    setCurrentAudioFile(file);

    // Initial Fallback Metadata
    const fallbackMeta = {
      title: file.name.replace(/\.[^/.]+$/, ""),
      artist: 'Unknown Artist',
      coverUrl: null,
    };
    setMetadata(fallbackMeta);

    let parsedLyrics: LyricLine[] = [];
    if (lyricFile) {
      try {
        const text = await lyricFile.text();
        const ext = lyricFile.name.split('.').pop()?.toLowerCase();
        if (ext === 'lrc') parsedLyrics = parseLRC(text);
        else if (ext === 'srt') parsedLyrics = parseSRT(text);
        else if (ext === 'ttml' || ext === 'xml') parsedLyrics = parseTTML(text);
        else if (ext === 'vtt') parsedLyrics = parseVTT(text);
      } catch (err) {
        console.error("Failed to parse lyrics in loadAudioFile:", err);
      }
    }

    const newItemId = Math.random().toString(36).substr(2, 9);
    const newItem: PlaylistItem = {
      id: newItemId,
      audioFile: file,
      lyricFile: lyricFile,
      parsedLyrics: parsedLyrics,
      metadata: fallbackMeta,
      duration: 0
    };

    // Helper: apply embedded lyrics text to state
    const applyEmbeddedLyrics = (lyricsText: string) => {
      setLyrics((curr) => {
        if (curr && curr.length > 0) return curr; // If already uploaded manually, do not override
        let parsed = parseLRC(lyricsText);
        if (parsed.length === 0 && lyricsText.trim()) {
          const lines = lyricsText.split('\n').map(l => l.trim());
          const filteredLines: string[] = [];
          for (let i = 0; i < lines.length; i++) {
            if (lines[i] === '') {
              if (filteredLines.length > 0 && filteredLines[filteredLines.length - 1] !== '') {
                filteredLines.push('');
              }
            } else {
              filteredLines.push(lines[i]);
            }
          }
          if (filteredLines.length > 0 && filteredLines[filteredLines.length - 1] === '') {
            filteredLines.pop();
          }
          parsed = filteredLines.map(l => ({ time: 0, text: l }));
        }
        
        setPlaylist(prev => prev.map(item =>
          item.id === newItemId ? { ...item, parsedLyrics: parsed, lyricFile: new File([lyricsText], 'embedded.lrc', { type: 'text/plain' }) } : item
        ));
        
        return parsed;
      });
    };

    // jsmediatags parsing — also handle files with no MIME type (e.g. .flac, .ogg)
    if (!file.type.startsWith('video/')) {
      // @ts-ignore
      import('jsmediatags/dist/jsmediatags.min.js').then((jsmediatags) => {
        jsmediatags.read(file, {
          onSuccess: (tag: any) => {
            const { title, artist, picture } = tag.tags;
            let coverUrl = null;
            if (picture) {
              const { data, format } = picture;
              let base64String = "";
              for (let i = 0; i < data.length; i++) {
                base64String += String.fromCharCode(data[i]);
              }
              coverUrl = `data:${format};base64,${window.btoa(base64String)}`;
            }

            const newMetadata = {
              title: title || fallbackMeta.title,
              artist: artist || fallbackMeta.artist,
              coverUrl: coverUrl || null
            };

            setMetadata(newMetadata);
            setPlaylist(prev => prev.map(item =>
              item.id === newItemId ? { ...item, metadata: newMetadata } : item
            ));

            const lyricsTag = tag.tags.lyrics || tag.tags.LYRICS || tag.tags.USLT || tag.tags.SYLT || tag.tags.unsyncedlyrics || tag.tags.SYNCEDLYRICS || tag.tags['©lyr'];
            let embeddedLyrics = '';
            if (lyricsTag) {
              if (typeof lyricsTag === 'string') {
                embeddedLyrics = lyricsTag;
              } else if (Array.isArray(lyricsTag)) {
                embeddedLyrics = lyricsTag.join('\n');
              } else {
                embeddedLyrics = lyricsTag.lyrics || lyricsTag.data || lyricsTag.text || '';
              }
            }
            if (embeddedLyrics) {
              applyEmbeddedLyrics(embeddedLyrics);
            } else {
              // jsmediatags succeeded but found no lyrics — try custom binary extractor
              // (e.g. FLAC: jsmediatags parses Vorbis Comments but skips the LYRICS field)
              extractEmbeddedLyrics(file).then(result => {
                if (result.lyrics) applyEmbeddedLyrics(result.lyrics);
              }).catch(e => console.warn('[EmbeddedLyrics] Fallback failed:', e));
            }
          },
          onError: (error: any) => {
            console.log('jsmediatags has no reader for this format:', error);
            // jsmediatags has no reader for OGG, OPUS, WAV, WMA, etc.
            // Use custom binary extractor for metadata + lyrics
            extractEmbeddedLyrics(file).then(result => {
              if (result.title || result.artist) {
                setMetadata(prev => {
                  const updated = {
                    ...prev,
                    title: result.title || prev.title,
                    artist: result.artist || prev.artist,
                  };
                  setPlaylist(list => list.map(item =>
                    item.id === newItemId ? { ...item, metadata: updated } : item
                  ));
                  return updated;
                });
              }
              if (result.lyrics) applyEmbeddedLyrics(result.lyrics);
            }).catch(e => console.warn('[EmbeddedLyrics] Fallback failed:', e));
          }
        });
      });
    } else if (file.type.startsWith('video/')) {
      // If video, use it as background
      setIsBgVideoReady(false);
      const newMetadata: AudioMetadata = {
        ...fallbackMeta,
        coverUrl: url,
        backgroundType: 'video'
      };
      setMetadata(newMetadata);
      setPlaylist(prev => prev.map(item =>
        item.id === newItemId ? { ...item, metadata: newMetadata } : item
      ));
    }

    // Reset play state
    setLyrics(parsedLyrics);
    setLyricOffset(0);
    setIsPlaying(false);
    setCurrentTime(0);
    
    setPlaylist(prev => {
      const appended = [...prev, newItem];
      setCurrentTrackIndex(appended.length - 1);
      return appended;
    });
    setAudioElementKey(prev => prev + 1); // Fresh start for manually loaded audio too
    if (lyricsContainerRef.current) {
      lyricsContainerRef.current.scrollTop = 0;
    }
    if (audioRef.current) {
      audioRef.current.load();
    }
  };

  const handleAudioUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      loadAudioFile(file);
    }
    // Allow re-upload
    e.target.value = '';
  };

  const handleMetadataUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      const isVideo = file.type.startsWith('video/');
      // Reset video ready state when changing background
      if (isVideo) setIsBgVideoReady(false);
      setMetadata(prev => ({ ...prev, coverUrl: url, backgroundType: isVideo ? 'video' : 'image' }));
    }
    // Allow re-upload
    e.target.value = '';
  };

  const loadLyricsFile = async (file: File) => {
    try {
      const text = await file.text();
      const ext = file.name.split('.').pop()?.toLowerCase();
      let parsedLyrics: LyricLine[] = [];

      if (ext === 'lrc') {
        parsedLyrics = parseLRC(text);
      } else if (ext === 'srt') {
        parsedLyrics = parseSRT(text);
      } else if (ext === 'ttml' || ext === 'xml') {
        parsedLyrics = parseTTML(text);
      } else if (ext === 'vtt') {
        parsedLyrics = parseVTT(text);
      }

      // Auto-enable karaoke highlight if word-level data is detected
      if (parsedLyrics.some(l => l.words && l.words.length > 0)) {
        setRenderConfig(prev => ({ ...prev, highlightEffect: 'karaoke' }));
        toast.success(`${ext?.toUpperCase()} ${tr('已载入逐字时间轴，已启用卡拉 OK 模式')}`);
      }
      setLyrics(parsedLyrics);

      setPlaylist(prev => prev.map((item, idx) => 
        idx === currentTrackIndex ? { ...item, parsedLyrics, lyricFile: file } : item
      ));
    } catch (err) {
      console.error("Failed to parse lyrics:", err);
      toast.error(tr('Failed to parse lyric file.'));
    }
  };

  const handleLyricsUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      await loadLyricsFile(file);
    }
    // Allow re-upload
    e.target.value = '';
  };

  // Sync lyrics from playlist changes (e.g. loaded/deleted in Editor)
  useEffect(() => {
    if (currentTrackIndex !== -1 && playlist[currentTrackIndex]) {
      const track = playlist[currentTrackIndex];
      // We prioritize parsedLyrics if available, otherwise clear
      // This ensures if user clears lyrics in editor, it reflects here immediately
      setLyrics(track.parsedLyrics || []);
    }
  }, [playlist, currentTrackIndex]);

  const loadFontFile = async (file: File) => {
    if (!window.FontFace || !document.fonts) {
      toast.error(tr('Custom fonts are not supported in this browser.'));
      return;
    }
    try {
      const url = URL.createObjectURL(file);

      // Use filename as a proxy for font name (no dependency needed)
      // Internal ID remains 'CustomFont' for consistent CSS usage
      const fontLabel = file.name.replace(/\.[^/.]+$/, "");
      const fontId = 'CustomFont';

      const font = new FontFace(fontId, `url(${url})`);
      await font.load();
      document.fonts.add(font);

      setCustomFontName(fontLabel);

      // Automatically activate the font in settings
      setRenderConfig(prev => ({ ...prev, fontFamily: fontId }));
      // setPreset('custom'); // Disabled to allow customized base presets

      toast.success(`${tr('Loaded font')}: ${fontLabel}`);
    } catch (err) {
      console.error("Failed to load font:", err);
      toast.error(tr('Failed to load font file.'));
    }
  };

  const handleFontUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      await loadFontFile(file);
    }
    // Allow re-upload
    e.target.value = '';
  };

  // Drag and Drop Event Handlers
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isPlaylistMode) return;
    dragCounter.current++;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isPlaylistMode) return;
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      setIsDragging(false);
      dragCounter.current = 0;
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isPlaylistMode) return;
    setIsDragging(false);
    dragCounter.current = 0;

    const files = Array.from(e.dataTransfer.files) as File[];
    if (files.length === 0) return;

    // Group files by base name (ignoring extension) for audio/video + lyrics pairing
    const fileGroups = new Map<string, { audio?: File; lyric?: File }>();
    const fontFiles: File[] = [];
    const unsupportedFiles: File[] = [];

    const audioVideoExts = ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma', 'opus', 'mp4', 'mkv', 'webm', 'avi', 'mov', 'm4v', 'ogv'];
    const lyricsExts = ['lrc', 'srt', 'vtt', 'ttml', 'xml'];
    const fontExts = ['ttf', 'otf', 'woff', 'woff2'];

    files.forEach(file => {
      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      const mime = file.type;
      const basename = file.name.replace(/\.[^/.]+$/, "");

      if (audioVideoExts.includes(ext) || mime.startsWith('audio/') || mime.startsWith('video/')) {
        if (!fileGroups.has(basename)) {
          fileGroups.set(basename, {});
        }
        fileGroups.get(basename)!.audio = file;
      } else if (lyricsExts.includes(ext)) {
        if (!fileGroups.has(basename)) {
          fileGroups.set(basename, {});
        }
        fileGroups.get(basename)!.lyric = file;
      } else if (fontExts.includes(ext)) {
        fontFiles.push(file);
      } else {
        unsupportedFiles.push(file);
      }
    });

    // Process fonts first
    if (fontFiles.length > 0) {
      for (const file of fontFiles) {
        await loadFontFile(file);
      }
    }

    // Process the grouped files
    for (const [basename, group] of fileGroups.entries()) {
      if (group.audio) {
        await loadAudioFile(group.audio, group.lyric);
      } else if (group.lyric) {
        await loadLyricsFile(group.lyric);
      }
    }

    if (unsupportedFiles.length > 0) {
      unsupportedFiles.forEach(file => {
        toast.error(`${tr('Unsupported file type')}: ${file.name}`);
      });
    }
  };

  // Reset drag and drop state when playlist mode is opened or closed
  useEffect(() => {
    setIsDragging(false);
    dragCounter.current = 0;
  }, [isPlaylistMode]);

  const handleChannelFontUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (!window.FontFace || !document.fonts) {
        toast.error(tr('Custom fonts are not supported in this browser.'));
        return;
      }
      try {
        const url = URL.createObjectURL(file);
        const fontLabel = file.name.replace(/\.[^/.]+$/, "");
        const fontId = 'ChannelFont'; // Unique ID

        const font = new FontFace(fontId, `url(${url})`);
        await font.load();
        document.fonts.add(font);

        setCustomChannelFontName(fontLabel);
        setRenderConfig(prev => ({ ...prev, channelInfoFontFamily: fontId }));
        toast.success(`${tr('Loaded Channel font')}: ${fontLabel}`);
      } catch (err) {
        console.error("Failed to load font:", err);
        toast.error(tr('Failed to load channel font file.'));
      }
    }
    e.target.value = '';
  };

  const handleInfoFontUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (!window.FontFace || !document.fonts) {
        toast.error(tr('Custom fonts are not supported in this browser.'));
        return;
      }
      try {
        const url = URL.createObjectURL(file);
        const fontLabel = file.name.replace(/\.[^/.]+$/, "");
        const fontId = 'InfoFont'; // Unique ID

        const font = new FontFace(fontId, `url(${url})`);
        await font.load();
        document.fonts.add(font);

        setCustomInfoFontName(fontLabel);
        setRenderConfig(prev => ({ ...prev, infoFontFamily: fontId }));
        toast.success(`${tr('Loaded Info font')}: ${fontLabel}`);
      } catch (err) {
        console.error("Failed to load font:", err);
        toast.error(tr('Failed to load info font file.'));
      }
    }
    e.target.value = '';
  };

  const playTrack = useCallback(async (index: number, autoPlay: boolean = true, playlistOverride?: PlaylistItem[]) => {
    const currentList = playlistOverride || playlist;
    if (index < 0 || index >= currentList.length) return;
    const track = currentList[index];

    // Cleanup old source if it's a blob URL
    if (audioSrc && audioSrc.startsWith('blob:')) {
      URL.revokeObjectURL(audioSrc);
    }

    // Stop current state to prevent animation loop issues during switch
    setIsPlaying(false);
    setCurrentTime(0);
    setAudioElementKey(prev => prev + 1); // Force audio element remount for fresh state

    // Load Audio
    const url = URL.createObjectURL(track.audioFile);
    setAudioSrc(url);
    setCurrentAudioFile(track.audioFile);

    const isVideo = track.audioFile.type.startsWith('video/') || track.metadata.backgroundType === 'video';
    if (isVideo) {
      setIsBgVideoReady(false);
    }

    // Metadata - use cover art from track if available
    setMetadata({
      title: track.metadata.title,
      artist: track.metadata.artist,
      coverUrl: isVideo ? url : (track.metadata.coverUrl || null),
      backgroundType: isVideo ? 'video' : 'image'
    });

    // Reset Lyrics
    setLyrics([]);

    // Load Lyrics
    if (track.parsedLyrics && track.parsedLyrics.length > 0) {
      setLyrics(track.parsedLyrics);
      // Removed auto-set highlightEffect to prevent resetting user preference

    } else if (track.lyricFile) {
      try {
        const text = await track.lyricFile.text();
        const ext = track.lyricFile.name.split('.').pop()?.toLowerCase();
        let parsed: LyricLine[] = [];
        if (ext === 'lrc') parsed = parseLRC(text);
        else if (ext === 'srt') parsed = parseSRT(text);
        else if (ext === 'ttml' || ext === 'xml') parsed = parseTTML(text);
        else if (ext === 'vtt') parsed = parseVTT(text);

        setLyrics(parsed);

        // Removed auto-set highlightEffect to prevent resetting user preference


      } catch (e) {
        console.error("Failed to load lyrics", e);
      }
    }

    setLyricOffset(0);
    setCurrentTrackIndex(index);
    // Reset Scroll Position
    if (lyricsContainerRef.current) {
      lyricsContainerRef.current.scrollTop = 0;
    }

    // Auto-play logic
    if (autoPlay) {
      // Small delay to allow audio element remount and src attachment
      setTimeout(() => {
        if (audioRef.current) {
          audioRef.current.play().catch(e => console.log("Autoplay failed", e));
          setIsPlaying(true);
        }
      }, 150);
    } else {
      setIsPlaying(false);
      // Ensure we don't hold onto previous playing state
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }
    }
  }, [playlist, audioSrc]);

  const playNextSong = useCallback(() => {
    if (playlist.length === 0) return;
    const nextIndex = (currentTrackIndex + 1) % playlist.length;
    playTrack(nextIndex);
  }, [playlist, currentTrackIndex, playTrack]);

  const playPreviousSong = useCallback(() => {
    if (playlist.length === 0) return;
    const prevIndex = (currentTrackIndex - 1 + playlist.length) % playlist.length;
    playTrack(prevIndex);
  }, [playlist, currentTrackIndex, playTrack]);

  const togglePlay = () => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
        setIsPlaying(false);
      } else {
        // If no audio source is loaded but we have a playlist, start the first track
        if (!audioSrc && playlist.length > 0) {
          playTrack(0);
        } else {
          audioRef.current.play().catch(console.error);
          setIsPlaying(true);
        }
      }
    }
  };

  const stopPlayback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setIsPlaying(false);
      setCurrentTime(0);
    }
  }, []);

  const toggleRepeat = () => {
    setRepeatMode(prev => {
      if (prev === 'off') return 'one';       // 1. Loop One
      if (prev === 'one') return 'all';       // 2. Play All (Stop at End)
      if (prev === 'all') return 'all_repeat';// 3. Play All (Loop Playlist)
      return 'off';                           // 4. Off
    });
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  const handleDisplayDoubleClick = (e?: React.MouseEvent | React.TouchEvent | Event) => {
    if (isRendering) return;
    if (e && (e.target as HTMLElement).closest('.no-minimal-mode-toggle')) {
      return;
    }
    const newVal = !isMinimalMode;
    setIsMinimalMode(newVal);
    if (newVal) {
      setBypassAutoHide(true);
    }
    toast.success(`${tr('Minimal Mode')}: ${tr(newVal ? 'On' : 'Off')}`, { id: 'minimal-mode' });
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
      if (isRendering) {
        setRenderProgress((audioRef.current.currentTime / duration) * 100);
      }
    }
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration);
      // 视频轨道尺寸决定悬浮小窗的宽高比；纯音频文件 videoWidth 为 0
      const vw = audioRef.current.videoWidth;
      const vh = audioRef.current.videoHeight;
      setVideoAspect(vw > 0 && vh > 0 ? vw / vh : 0);
    }
  };

  // ---------------------------------------------------------------------------
  // 字幕对齐（频谱吸附校正）
  //
  // 交互设计：
  //   1. 点开「对齐」按钮 → 后台一次性分析音频，得到起音强度曲线；
  //   2. 点选任意一行字幕 → 在该行时间的 ±窗口 内找最强起音峰，作为吸附目标；
  //   3. 只有一个锚点 → 整条时间轴常量平移；
  //      点「再加锚点」在文件后段再锚一行 → 两点之间线性插值，修正漂移；
  //   4. 「应用」把修正写回字幕，「撤销」丢弃。
  // ---------------------------------------------------------------------------

  /** 按需构建能量包络（每次换文件只分析一次） */
  const ensureSyncEnvelope = useCallback(async (): Promise<EnergyEnvelope | null> => {
    if (syncEnvelope) return syncEnvelope;
    if (!currentAudioFile) {
      toast.error('请先载入音频或视频');
      return null;
    }
    setSyncAnalyzing(true);
    try {
      const env = await buildEnergyEnvelope(currentAudioFile);
      setSyncEnvelope(env);
      return env;
    } catch (err) {
      console.error('音频分析失败', err);
      toast.error('音频分析失败：' + ((err as Error)?.message || '未知错误'));
      return null;
    } finally {
      setSyncAnalyzing(false);
    }
  }, [syncEnvelope, currentAudioFile, toast]);

  /** 由锚点推导出「每一行」的修正量 */
  const computeOffsetsFromAnchors = useCallback((anchors: SyncAnchor[]): number[] => {
    const n = lyrics.length;
    if (n === 0 || anchors.length === 0) return new Array(n).fill(0);

    const sorted = [...anchors].sort((a, b) => a.originalTime - b.originalTime);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];

    // 单锚点，或两端偏移几乎一致（<0.1s）→ 判定为纯偏移，整条时间轴常量平移
    if (sorted.length === 1 || Math.abs(last.offset - first.offset) < 0.1) {
      const avg = sorted.reduce((sum, a) => sum + a.offset, 0) / sorted.length;
      return new Array(n).fill(avg);
    }

    // 双锚点 → 线性插值：文件开头用第一个锚点，结尾用第二个，中间按位置过渡
    const span = last.originalTime - first.originalTime;
    return lyrics.map(line => {
      if (line.time <= first.originalTime) return first.offset;
      if (line.time >= last.originalTime) return last.offset;
      const ratio = span > 0 ? (line.time - first.originalTime) / span : 0;
      return first.offset + (last.offset - first.offset) * ratio;
    });
  }, [lyrics]);

  /** 点选某一行 → 吸附 */
  const handleAnchorClick = useCallback(async (lineIndex: number) => {
    const line = lyrics[lineIndex];
    if (!line) return;

    const env = await ensureSyncEnvelope();
    if (!env) return;

    const hit = findStrongestPeak(env, line.time, syncWindow);
    if (!hit || !isPeakMeaningful(env, hit)) {
      toast.error(`第 ${lineIndex + 1} 行附近（±${syncWindow.toFixed(1)}s）没有检测到明显有声段，可换一行或调小窗口`);
      return;
    }

    const anchor: SyncAnchor = {
      id: Math.random().toString(36).slice(2, 9),
      lineIndex,
      originalTime: line.time,
      snappedTime: hit.time,
      offset: hit.time - line.time,
      strength: hit.strength,
    };

    // 同一行重复点击视为覆盖；最多保留 2 个锚点
    const withoutSame = syncAnchors.filter(a => a.lineIndex !== lineIndex);
    let next: SyncAnchor[];
    if (withoutSame.length >= 2) {
      // 已有两个锚点：替换离得更远的那个
      const sorted = [...withoutSame].sort((a, b) => a.originalTime - b.originalTime);
      const distFirst = Math.abs(anchor.originalTime - sorted[0].originalTime);
      const distLast = Math.abs(anchor.originalTime - sorted[1].originalTime);
      next = distFirst < distLast ? [anchor, sorted[1]] : [sorted[0], anchor];
    } else {
      next = [...withoutSame, anchor];
    }

    setSyncAnchors(next);
    setSyncOffsets(computeOffsetsFromAnchors(next));
    setAwaitingSecondAnchor(false);
    setSnapPreview({ lineIndex, delta: anchor.offset, strength: hit.strength });

    // 播放头跳到吸附后的位置，方便立刻用耳朵核对
    if (audioRef.current) {
      audioRef.current.currentTime = hit.time;
      setCurrentTime(hit.time);
    }
    toast.success(`第 ${lineIndex + 1} 行吸附：${anchor.offset >= 0 ? '+' : ''}${anchor.offset.toFixed(2)}s`, 1500);
  }, [lyrics, ensureSyncEnvelope, syncWindow, syncAnchors, computeOffsetsFromAnchors, toast]);

  /** 打开/关闭对齐模式 */
  const handleToggleSyncMode = useCallback(() => {
    if (syncMode) {
      setSyncMode(false);
      return;
    }
    if (lyrics.length === 0) {
      toast.error('请先载入字幕文件');
      return;
    }
    setSyncMode(true);
    void ensureSyncEnvelope();
  }, [syncMode, lyrics.length, ensureSyncEnvelope, toast]);

  /** 丢弃当前锚点与预览 */
  const resetSync = useCallback(() => {
    setSyncAnchors([]);
    setSyncOffsets(null);
    setSnapPreview(null);
    setAwaitingSecondAnchor(false);
  }, []);

  /** 把修正写回字幕 */
  const applySyncOffsets = useCallback(() => {
    if (!syncOffsets) {
      toast.error('还没有锚点，先点选一行字幕');
      return;
    }
    setLyrics(prev => prev.map((l, i) => {
      const shift = syncOffsets[i] ?? 0;
      if (shift === 0) return l;
      return {
        ...l,
        time: Math.max(0, l.time + shift),
        endTime: l.endTime !== undefined ? Math.max(0, l.endTime + shift) : undefined,
        words: l.words?.map(w => ({
          ...w,
          startTime: Math.max(0, w.startTime + shift),
          endTime: Math.max(0, w.endTime + shift),
        })),
      };
    }));
    const avg = syncOffsets.reduce((a, b) => a + b, 0) / syncOffsets.length;
    setSyncAnchors([]);
    setSyncOffsets(null);
    setSnapPreview(null);
    setAwaitingSecondAnchor(false);
    toast.success(`已应用字幕对齐（平均 ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}s）`);
  }, [syncOffsets, toast]);

  // 换文件时清空分析结果与锚点（能量包络只对应当前这一条音频）
  useEffect(() => {
    setSyncEnvelope(null);
    setSyncAnchors([]);
    setSyncOffsets(null);
    setSnapPreview(null);
    setAwaitingSecondAnchor(false);
  }, [audioSrc]);

  /** 已锚定的行号，用于在字幕列表里高亮 */
  const anchorLineIndices = useMemo(
    () => new Set(syncAnchors.map(a => a.lineIndex)),
    [syncAnchors],
  );

  // 「尚未载入」的占位文案需要跟随语言切换，所以放在渲染期翻译
  const displayTitle = metadata.title === 'No Audio Loaded' ? tr('No Audio Loaded') : metadata.title;
  const displayArtist = metadata.artist === 'Select a file' ? tr('Select a file') : metadata.artist;

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    if (audioRef.current) {
      audioRef.current.currentTime = time;
      setCurrentTime(time);
    }
  };

  const seekToPosition = (clientX: number) => {
    if (!progressBarRef.current || isRendering || !duration) return;
    const rect = progressBarRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    const percentage = x / rect.width;
    const newTime = percentage * duration;

    if (audioRef.current) {
      audioRef.current.currentTime = newTime;
      setCurrentTime(newTime);
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVol = parseFloat(e.target.value);
    setVolume(newVol);
    if (audioRef.current) {
      audioRef.current.volume = newVol;
    }
    setIsMuted(newVol === 0);
  };

  const setVolumeToPosition = (clientX: number) => {
    if (!volumeBarRef.current) return;
    const rect = volumeBarRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    const newVol = x / rect.width;

    setVolume(newVol);
    if (audioRef.current) {
      audioRef.current.volume = newVol;
    }
    setIsMuted(newVol === 0);
  };

  // --- Video Export Logic ---

  const handleExportVideo = async () => {
    if (!audioRef.current || !canvasRef.current) return;

    // Determine Render Scope
    const isPlaylistRender = renderConfig.renderMode === 'playlist' && playlist.length > 0;
    console.log(`[Render] Starting Export. Mode: ${renderConfig.renderMode}, Playlist Items: ${playlist.length}, IsPlaylistRender: ${isPlaylistRender}`);

    if (isPlaylistRender) {
      toast.success(`${tr('Starting Playlist Render')} (${playlist.length})...`);
    } else {
      toast.success(tr('Starting Single Track Render...'));
    }
    const queue: {
      audioSrc: string;
      lyrics: LyricLine[];
      metadata: AudioMetadata;
      duration?: number;
      isFileSource?: boolean;
    }[] = [];

    if (isPlaylistRender) {
      // Build Queue from Playlist
      for (const item of playlist) {
        // Prepare lyrics
        let trackLyrics: LyricLine[] = [];
        if (item.parsedLyrics && item.parsedLyrics.length > 0) {
          trackLyrics = item.parsedLyrics;
        } else if (item.lyricFile) {
          try {
            const text = await item.lyricFile.text();
            const ext = item.lyricFile.name.split('.').pop()?.toLowerCase();
            if (ext === 'lrc') trackLyrics = parseLRC(text);
            else if (ext === 'srt') trackLyrics = parseSRT(text);
            else if (ext === 'ttml' || ext === 'xml') trackLyrics = parseTTML(text);
            else if (ext === 'vtt') trackLyrics = parseVTT(text);
          } catch (e) {
            console.error("Failed to parse lyrics for playlist item", e);
          }
        }

        // Prepare Audio URL
        const url = URL.createObjectURL(item.audioFile);

        queue.push({
          audioSrc: url,
          lyrics: trackLyrics,
          metadata: item.metadata,
          isFileSource: true // Mark to revoke later
        });
      }
    } else {
      // Single Track (Current)
      if (!audioSrc) return;
      queue.push({
        audioSrc: audioSrc,
        lyrics: adjustedLyrics, // Use currently adjusted lyrics (with offset)
        metadata: metadata,
        isFileSource: false
      });
    }

    if (queue.length === 0) return;

    // Confirm
    const confirmMsg = isPlaylistRender
      ? `即将导出播放列表中的全部 ${queue.length} 首，合成一个连续视频。`
      : `即将导出 ${aspectRatio} (${resolution}) 视频，会从头到尾完整播放一遍。`;

    const isConfirmed = await confirm(`${confirmMsg}${tr(' Please do not switch tabs during rendering.')}`, tr('Start Rendering?'));
    if (!isConfirmed) {
      // Cleanup generated URLs if aborted immediately
      if (isPlaylistRender) queue.forEach(q => q.isFileSource && URL.revokeObjectURL(q.audioSrc));
      return;
    }

    setShowRenderSettings(false);
    setIsRendering(true);
    setRenderProgress(0);

    // Create new abort signal for this render session
    const currentAbortSignal = { aborted: false };
    abortRenderRef.current = currentAbortSignal;

    // Stop and Reset
    stopPlayback();
    setRepeatMode('off');

    // Stop auto-hide immediately and bypass it during render
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    setIsMouseIdle(false);
    setBypassAutoHide(true);

    // Pause background video in web view to prevent interference with render
    if (bgVideoRef.current) {
      bgVideoRef.current.pause();
    }

    const audioEl = audioRef.current;

    // Capture current preset to use inside the loop based on initial state
    const currentPreset = preset;

    // 1. Preload Images & Videos (Global Resources)
    const imageMap = new Map<string, HTMLImageElement>();
    const videoMap = new Map<string, HTMLVideoElement>();
    const audioMap = new Map<string, HTMLAudioElement>();
    const loadPromises: Promise<void>[] = [];

    // Helper Loaders
    const loadImg = (id: string, url: string) => {
      return new Promise<void>((resolve) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => { imageMap.set(id, img); resolve(); };
        img.onerror = () => resolve();
        img.src = url;
      });
    };

    const loadVid = (id: string, url: string) => {
      return new Promise<void>((resolve) => {
        const vid = document.createElement('video');
        vid.crossOrigin = "anonymous";
        vid.muted = true;
        vid.playsInline = true;
        vid.preload = "auto";
        let resolved = false;
        const safeResolve = () => { if (!resolved) { resolved = true; videoMap.set(id, vid); resolve(); } };
        vid.oncanplay = () => { if (!resolved) { vid.currentTime = 0.001; } };
        vid.onseeked = () => safeResolve();
        vid.onerror = () => { console.warn("Failed to load video:", url); safeResolve(); };
        setTimeout(() => safeResolve(), 5000);
        vid.src = url;
        vid.load();
      });
    };

    const loadAudio = (id: string, url: string) => {
      return new Promise<void>((resolve) => {
        const aud = document.createElement('audio');
        aud.crossOrigin = "anonymous";
        aud.onloadedmetadata = () => { audioMap.set(id, aud); resolve(); };
        aud.onerror = () => resolve();
        aud.src = url;
      });
    };

    // Preload Visual Slides (Global)
    visualSlides.forEach(s => {
      if (s.type === 'video') loadPromises.push(loadVid(s.id, s.url));
      else if (s.type === 'audio') loadPromises.push(loadAudio(s.id, s.url));
      else loadPromises.push(loadImg(s.id, s.url));
    });

    // Load Channel Info Image
    if (renderConfig.showChannelInfo) {
      if (renderConfig.channelInfoImage) {
        loadPromises.push(loadImg('__channel_info__', renderConfig.channelInfoImage));
      }
      // Load SVG Text if applicable
      if (renderConfig.channelInfoText) {
        const txt = renderConfig.channelInfoText.trim();
        // Check if it contains SVG tag
        if (/<svg[\s\S]*?>/i.test(txt)) {
          try {
            // Measure the content to generate correct SVG dimensions
            const measureEl = document.createElement('div');
            measureEl.style.position = 'absolute';
            measureEl.style.visibility = 'hidden';
            measureEl.style.whiteSpace = 'nowrap';
            measureEl.style.fontFamily = 'sans-serif';
            measureEl.style.fontWeight = 'bold';
            measureEl.style.fontSize = '100px'; // High res for quality
            measureEl.style.display = 'inline-flex';
            measureEl.style.alignItems = 'center';
            measureEl.style.gap = '0.25em';
            measureEl.innerHTML = txt;

            // Adjust SVG children styling for measurement matching App.tsx
            const svgs = measureEl.getElementsByTagName('svg');
            for (let i = 0; i < svgs.length; i++) {
              svgs[i].style.width = 'auto';
              svgs[i].style.height = '1.5em';
            }

            document.body.appendChild(measureEl);
            const { width, height } = measureEl.getBoundingClientRect();
            document.body.removeChild(measureEl);

            // Construct SVG with foreignObject
            const svgString = `
              <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
                <foreignObject width="100%" height="100%">
                  <div xmlns="http://www.w3.org/1999/xhtml" style="font-family: sans-serif; font-weight: bold; font-size: 100px; color: white; display: inline-flex; align-items: center; gap: 0.25em; white-space: nowrap;">
                    <style>svg { width: auto; height: 1.5em; }</style>
                    ${txt}
                  </div>
                </foreignObject>
              </svg>
            `;

            // Encode
            const encoded = window.btoa(encodeURIComponent(svgString).replace(/%([0-9A-F]{2})/g,
              function toSolidBytes(_match, p1) {
                return String.fromCharCode(parseInt(p1, 16));
              }));
            const dataUrl = `data:image/svg+xml;base64,${encoded}`;
            loadPromises.push(loadImg('__channel_info_text_svg__', dataUrl));
          } catch (e) { console.warn("Failed to process SVG channel info", e); }
        }
      }
    }
    // Load Custom Background Image
    if (renderConfig.backgroundSource === 'image' && renderConfig.backgroundImage) {
      loadPromises.push(loadImg('__custom_bg__', renderConfig.backgroundImage));
    }
    // Load Custom Background Video
    if (renderConfig.backgroundSource === 'video' && renderConfig.backgroundVideo) {
      loadPromises.push(loadVid('__custom_bg_video__', renderConfig.backgroundVideo));
    }

    // Load Floating Notes Media
    if (renderConfig.showFloatingNotes && renderConfig.floatingNotesMedia) {
      if (renderConfig.floatingNotesMediaType === 'video') {
        loadPromises.push(loadVid('__floating_notes_media__', renderConfig.floatingNotesMedia));
      } else {
        loadPromises.push(loadImg('__floating_notes_media__', renderConfig.floatingNotesMedia));
      }
    }

    await Promise.all(loadPromises);

    if (currentAbortSignal.aborted) {
      setIsRendering(false);
      if (isPlaylistRender) queue.forEach(q => q.isFileSource && URL.revokeObjectURL(q.audioSrc));
      return;
    }

    // 3. Setup Audio Mixing & Recording
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(renderFps); // Use selected FPS for capture stream

    let audioStream: MediaStream | null = null;
    try {
      // @ts-ignore
      if (audioEl.captureStream) audioStream = audioEl.captureStream();
      // @ts-ignore
      else if (audioEl.mozCaptureStream) audioStream = audioEl.mozCaptureStream();
      else throw new Error("Audio capture not supported");
    } catch (e) {
      toast.error(tr('Your browser does not support audio capture for recording.'));
      setIsRendering(false);
      return;
    }

    // Disconnect visualizer audio before creating export AudioContext
    disconnectVisualizerAudio();

    const audioContext = getSharedAudioContext();
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
    const mixerDest = audioContext.createMediaStreamDestination();

    // Connect Source to Mixer
    const source = getOrCreateMediaElementSource(audioEl, audioContext);
    source.disconnect(); // Disconnect anything previous to guarantee clean slate
    source.connect(mixerDest);

    // Create analyser for visualization in export (tap the source → analyser → destination)
    let exportAnalyser: AnalyserNode | null = null;
    let exportFreqBuf: Uint8Array | null = null;
    let exportWaveBuf: Uint8Array | null = null;
    if (renderConfig.showVisualization) {
      exportAnalyser = audioContext.createAnalyser();
      exportAnalyser.fftSize = 512;
      exportAnalyser.smoothingTimeConstant = 0.8;
      source.connect(exportAnalyser);
      exportFreqBuf = new Uint8Array(exportAnalyser.frequencyBinCount);
      exportWaveBuf = new Uint8Array(exportAnalyser.frequencyBinCount);
    }

    // Connect Preloads
    videoMap.forEach((vidElement) => {
      vidElement.muted = true;
      const src = getOrCreateMediaElementSource(vidElement, audioContext);
      src.disconnect();
      src.connect(mixerDest);
    });
    const audioGainMap = new Map<string, GainNode>();
    audioMap.forEach((audElement, id) => {
      // Keep unmuted — Web Audio graph controls audibility via gain (muted attr blocks source output)
      audElement.muted = false;
      const src = getOrCreateMediaElementSource(audElement, audioContext);
      src.disconnect();
      const gain = audioContext.createGain();
      gain.gain.value = 0;
      src.connect(gain);
      gain.connect(mixerDest);
      audioGainMap.set(id, gain);
    });

    if (mixerDest.stream.getAudioTracks().length > 0) {
      stream.addTrack(mixerDest.stream.getAudioTracks()[0]);
    } else if (audioStream) {
      stream.addTrack(audioStream.getAudioTracks()[0]);
    }

    // Setup MediaRecorder
    const getPreferredMimeType = () => {
      if (renderCodec !== 'auto' && MediaRecorder.isTypeSupported(renderCodec)) return renderCodec;
      const types = [
        'video/webm; codecs=vp9,opus', 'video/webm; codecs=vp9', 'video/webm; codecs=av1',
        'video/mp4; codecs="av01.0.05M.08"', 'video/mp4; codecs="avc1.4D401E, mp4a.40.2"',
        'video/mp4; codecs="avc1.64001E, mp4a.40.2"', 'video/mp4', 'video/webm'
      ];
      for (const t of types) { if (MediaRecorder.isTypeSupported(t)) return t; }
      return 'video/webm';
    };

    const mimeType = getPreferredMimeType();
    const baseBitrate = resolution === '1080p' ? 8000000 : 4000000;
    const fpsMultiplier = renderFps > 30 ? 1.5 : 1.0;
    const qualityMultiplier = renderQuality === 'high' ? 2.0 : renderQuality === 'low' ? 0.5 : 1.0;
    const bitrate = baseBitrate * fpsMultiplier * qualityMultiplier;

    const mediaRecorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
    mediaRecorderRef.current = mediaRecorder;

    const chunks: Blob[] = [];
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      if (!currentAbortSignal.aborted) {
        const blob = new Blob(chunks, { type: mimeType });
        const downloadBlob = (blobToDownload: Blob) => {
          const url = URL.createObjectURL(blobToDownload);
          const a = document.createElement('a');
          a.href = url;
          const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
          const filename = isPlaylistRender
            ? `Playlist_${queue.length}_Songs_${aspectRatio.replace(':', '-')}.${ext}`
            : `${queue[0].metadata.title || 'video'}_${aspectRatio.replace(':', '-')}.${ext}`;

          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        };

        if (mimeType.includes('webm')) {
          downloadBlob(blob);
        } else {
          downloadBlob(blob);
        }
      } else {
        console.log("Render aborted");
      }

      // Cleanup
      audioContext.close();
      setIsRendering(false);
      setAudioElementKey(prev => prev + 1);
      if (isPlaylistRender) queue.forEach(q => q.isFileSource && URL.revokeObjectURL(q.audioSrc));
    };

    // --- RENDER ORCHESTRATION ---

    let queueIndex = 0;
    // Mutable Rendering State
    let currentRenderLyrics: LyricLine[] = [];
    let currentRenderMetadata: AudioMetadata = metadata;
    let currentRenderDuration = 0;

    // Render Loop (Frame Drawer)
    let lastRenderTime = 0;
    const renderInterval = 1000 / renderFps; // Will be 1000/60 approx 16.6ms if 60FPS selected

    const renderFrameLoop = (now: number) => {
      if (currentAbortSignal.aborted) return;

      if (mediaRecorder.state === 'recording' || mediaRecorder.state === 'paused') {
        requestAnimationFrame(renderFrameLoop);
      }

      const elapsed = now - lastRenderTime;
      if (elapsed < renderInterval) return;
      lastRenderTime = now - (elapsed % renderInterval);

      const t = audioEl.currentTime;

      // Current Song Progress for UI (Overall for Playlist)
      if (currentRenderDuration > 0) {
        const songProgress = t / currentRenderDuration;
        if (isPlaylistRender) {
          const overallProgress = ((queueIndex + songProgress) / queue.length) * 100;
          setRenderProgress(overallProgress);
        } else {
          setRenderProgress(songProgress * 100);
        }
      }

      // Sync Backgrounds/Videos
      videoMap.forEach((v, id) => {
        if (id === 'background' || id === '__custom_bg_video__' || id === '__floating_notes_media__') {
          const vidDuration = v.duration || 1;
          const targetTime = t % vidDuration;
          // Handle Loop Wrap-around and Drift
          let drift = Math.abs(v.currentTime - targetTime);
          if (targetTime < v.currentTime && (v.currentTime - targetTime) > vidDuration / 2) {
            v.currentTime = targetTime;
          } else if (drift > 0.5) { // Increased tolerance
            v.currentTime = targetTime;
          }
          if (v.paused) v.play().catch(() => { });
        } else {
          const s = visualSlides.find(sl => sl.id === id);
          if (s) {
            if (t >= s.startTime && t < s.endTime) {
              const speed = s.playbackRate || 1;
              let rel = ((t - s.startTime) * speed) + (s.mediaStartOffset || 0);

              // Auto-Loop Logic: If render time exceeds source duration, wrap it
              const sourceDuration = s.mediaDuration || v.duration;
              if (sourceDuration && sourceDuration > 0 && rel >= sourceDuration) {
                rel = rel % sourceDuration;
              }

              if (Math.abs(v.playbackRate - speed) > 0.01) v.playbackRate = speed;

              if (Math.abs(v.currentTime - rel) > 0.5) v.currentTime = rel;
              const shouldMute = s.isMuted !== false;
              if (v.muted !== shouldMute) v.muted = shouldMute;
              if (v.paused) v.play().catch(() => { });
            } else {
              if (!v.paused) v.pause();
              if (!v.muted) v.muted = true;
            }
          }
        }
      });

      // Sync Audio Slides
      audioMap.forEach((a, id) => {
        const s = visualSlides.find(sl => sl.id === id);
        const gain = audioGainMap.get(id);
        if (s && gain) {
          const layer = s.layer || 0;
          const isLayerVisible = renderConfig.layerVisibility?.audio?.[layer] !== false;

          if (isLayerVisible && t >= s.startTime && t < s.endTime && s.isMuted !== true) {
            const speed = s.playbackRate || 1;
            const rel = ((t - s.startTime) * speed) + (s.mediaStartOffset || 0);

            if (Math.abs(a.playbackRate - speed) > 0.01) a.playbackRate = speed;

            if (Math.abs(a.currentTime - rel) > 0.5) a.currentTime = rel;
            const targetVol = s.volume !== undefined ? s.volume : 1;
            if (Math.abs(gain.gain.value - targetVol) > 0.01) gain.gain.value = targetVol;
            if (a.paused) a.play().catch(() => { });
          } else {
            if (!a.paused) a.pause();
            if (gain.gain.value !== 0) gain.gain.value = 0;
          }
        }
      });

      if (ctx) {
        // Read visualization data if enabled
        if (exportAnalyser && exportFreqBuf && exportWaveBuf) {
          exportAnalyser.getByteFrequencyData(exportFreqBuf as any);
          exportAnalyser.getByteTimeDomainData(exportWaveBuf as any);
        }

        drawCanvasFrame(
          ctx,
          canvas.width,
          canvas.height,
          t,
          currentRenderLyrics,
          currentRenderMetadata,
          visualSlides,
          imageMap, // Must contain cover!
          videoMap,
          currentPreset,
          customFontName,
          renderConfig.fontSizeScale,
          renderConfig.backgroundBlurStrength > 0, // Should be isBlurEnabled
          currentRenderDuration,
          renderConfig,
          renderConfig.renderMode === 'current' || (queueIndex === queue.length - 1),
          renderConfig.renderMode === 'current' || (queueIndex === 0),
          exportFreqBuf as any,
          exportWaveBuf as any
        );
      }
    };


    const processNextTrack = async () => {
      if (currentAbortSignal.aborted) {
        mediaRecorder.stop();
        return;
      }

      if (queueIndex >= queue.length) {
        // Add a small tail of silence/freeze
        await new Promise(r => setTimeout(r, 500));
        mediaRecorder.stop();
        return;
      }

      const track = queue[queueIndex];

      // Pause recording while loading assets/buffering to avoid black frames/gaps
      if (mediaRecorder.state === 'recording') {
        mediaRecorder.pause();
      }

      // 1. Update State
      currentRenderLyrics = track.lyrics;
      currentRenderMetadata = track.metadata; // Update local ref
      currentRenderDuration = 0;

      // Update global index for UI consistency if needed
      if (isPlaylistRender) {
        setCurrentTrackIndex(queueIndex);
      }

      // Update Metadata in Background if possible to show progress in UI?
      // Setting state might be risky if unmounted, but we are in App.
      // setMetadata(track.metadata); 

      // 2. Load Cover Art into imageMap
      if (track.metadata.coverUrl) {
        if (track.metadata.backgroundType === 'video') {
          // Ensure background video is loaded in videoMap
          // Note: if queue has different videos, we might overwrite 'background' key.
          // This is fine as we process sequentially.
          await loadVid('background', track.metadata.coverUrl);
        } else {
          await loadImg('cover', track.metadata.coverUrl);
        }
      }

      // 3. Load Audio
      // We pause first to be safe
      audioEl.pause();
      audioEl.src = track.audioSrc;
      audioEl.load();

      // Wait for ready
      await new Promise<void>((resolve) => {
        const onCanPlay = () => {
          audioEl.removeEventListener('canplay', onCanPlay);
          resolve();
        };
        audioEl.addEventListener('canplay', onCanPlay);
        // Fallback if cached
        if (audioEl.readyState >= 3) onCanPlay();
      });

      currentRenderDuration = audioEl.duration;

      // 4. Play and Record
      if (mediaRecorder.state === 'inactive') {
        if (audioContext.state === 'suspended') await audioContext.resume();
        mediaRecorder.start();
        requestAnimationFrame(renderFrameLoop);
      } else if (mediaRecorder.state === 'paused') {
        mediaRecorder.resume();
      }
      await audioEl.play();

      // Wait for end
      await new Promise<void>((resolve) => {
        const onEnded = () => {
          audioEl.removeEventListener('ended', onEnded);
          resolve();
        };
        audioEl.addEventListener('ended', onEnded);
      });

      // 5. Next
      queueIndex++;
      await processNextTrack();
    };


    // Start Processing Queue
    console.log(`[Render] Queue prepared with ${queue.length} items.`);
    if (queue.length === 0) {
      toast.error(tr('Render queue is empty!'));
      setIsRendering(false);
      return;
    }

    // Explicitly start from index 0
    queueIndex = 0;
    await processNextTrack();

  };

  // --- FFmpeg WASM Video Export Logic ---
  const handleExportVideoFFmpeg = async () => {
    if (!canvasRef.current) return;

    // Determine Render Scope  
    const isPlaylistRender = renderConfig.renderMode === 'playlist' && playlist.length > 0;
    console.log(`[FFmpeg Render] Mode: ${renderConfig.renderMode}, Playlist: ${playlist.length}, IsPlaylist: ${isPlaylistRender}`);

    // Get audio file - need the actual File object for FFmpeg
    let audioFile: File | Blob | null = null;
    let lyricsToRender = adjustedLyrics;
    let metadataToRender = metadata;

    if (isPlaylistRender && playlist.length > 0) {
      // For playlist, we'll render the first track (full playlist support can be added later)
      audioFile = playlist[0].audioFile;
      lyricsToRender = playlist[0].parsedLyrics || [];
      metadataToRender = playlist[0].metadata;
    } else if (playlist.length > 0 && currentTrackIndex >= 0) {
      audioFile = playlist[currentTrackIndex].audioFile;
    } else if (currentAudioFile) {
      audioFile = currentAudioFile;
    } else if (audioSrc) {
      try {
        const res = await fetch(audioSrc);
        audioFile = await res.blob();
      } catch (e) {
        console.error("FFmpeg: Failed to fetch audio blob", e);
        toast.error(tr('Failed to load audio source for rendering.'));
        return;
      }
    } else {
      toast.error(tr('Please load an audio file first.'));
      return;
    }

    if (!audioFile) {
      toast.error(tr('No audio file available for FFmpeg export.'));
      return;
    }

    // Check FFmpeg availability
    if (!isFFmpegAvailable()) {
      toast.error(tr('FFmpeg requires SharedArrayBuffer. Please ensure proper server headers (COOP/COEP) or use MediaRecorder instead.'));
      return;
    }

    // Confirm
    const confirmMsg = `Start FFmpeg rendering at ${resolution} (${aspectRatio})? This uses frame-by-frame capture for higher quality. Rendering may take several minutes.`;
    const isConfirmed = await confirm(confirmMsg, "Start FFmpeg Rendering?");
    if (!isConfirmed) return;

    setShowRenderSettings(false);
    setIsRendering(true);
    setRenderProgress(0);
    setFfmpegRenderStage('Initializing...');

    // Create new abort signal
    const currentAbortSignal = { aborted: false };
    abortRenderRef.current = currentAbortSignal;

    // Stop playback
    stopPlayback();

    // Prepare canvas dimensions
    const canvas = canvasRef.current;
    const { w, h } = getCanvasDimensions();
    canvas.width = w;
    canvas.height = h;

    // Preload resources (images/videos used in visual slides)
    const imageMap = new Map<string, HTMLImageElement>();
    const videoMap = new Map<string, HTMLVideoElement>();

    // Load visual slides
    const loadPromises: Promise<void>[] = [];

    const loadImg = (id: string, url: string) => {
      return new Promise<void>((resolve) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => { imageMap.set(id, img); resolve(); };
        img.onerror = () => resolve();
        img.src = url;
      });
    };

    const loadVid = (id: string, url: string) => {
      return new Promise<void>((resolve) => {
        const vid = document.createElement('video');
        vid.crossOrigin = "anonymous";
        vid.muted = true;
        vid.playsInline = true;
        vid.preload = "auto";
        let resolved = false;
        const safeResolve = () => { if (!resolved) { resolved = true; videoMap.set(id, vid); resolve(); } };
        vid.oncanplay = () => { if (!resolved) { vid.currentTime = 0.001; } };
        vid.onseeked = () => safeResolve();
        vid.onerror = () => { console.warn("Failed to load video:", url); safeResolve(); };
        setTimeout(() => safeResolve(), 5000);
        vid.src = url;
        vid.load();
      });
    };

    // Preload visual slides
    visualSlides.forEach(s => {
      if (s.type === 'video') loadPromises.push(loadVid(s.id, s.url));
      else if (s.type !== 'audio') loadPromises.push(loadImg(s.id, s.url));
    });

    // Load cover art
    if (metadataToRender.coverUrl) {
      if (metadataToRender.backgroundType === 'video') {
        loadPromises.push(loadVid('background', metadataToRender.coverUrl));
      } else {
        loadPromises.push(loadImg('cover', metadataToRender.coverUrl));
      }
    }

    // Load custom background
    if (renderConfig.backgroundSource === 'image' && renderConfig.backgroundImage) {
      loadPromises.push(loadImg('__custom_bg__', renderConfig.backgroundImage));
    }
    if (renderConfig.backgroundSource === 'video' && renderConfig.backgroundVideo) {
      // Optimization: use existing video ref if available and matching
      if (bgVideoRef.current && bgVideoRef.current.currentSrc && !bgVideoRef.current.error) {
        // Use the existing element directly
        videoMap.set('__custom_bg_video__', bgVideoRef.current);
        console.log("WebCodecs: Re-using existing background video element");
      } else {
        loadPromises.push(loadVid('__custom_bg_video__', renderConfig.backgroundVideo));
      }
    }
    if (renderConfig.backgroundSource === 'video' && renderConfig.backgroundVideo) {
      // Optimization: use existing video ref if available and matching
      if (bgVideoRef.current && bgVideoRef.current.currentSrc && !bgVideoRef.current.error) {
        // Use the existing element directly
        videoMap.set('__custom_bg_video__', bgVideoRef.current);
        console.log("FFmpeg: Re-using existing background video element");
      } else {
        loadPromises.push(loadVid('__custom_bg_video__', renderConfig.backgroundVideo));
      }
    }

    // Load channel info
    if (renderConfig.showChannelInfo && renderConfig.channelInfoImage) {
      loadPromises.push(loadImg('__channel_info__', renderConfig.channelInfoImage));
    }

    // Load Floating Notes Media
    if (renderConfig.showFloatingNotes && renderConfig.floatingNotesMedia) {
      if (renderConfig.floatingNotesMediaType === 'video') {
        loadPromises.push(loadVid('__floating_notes_media__', renderConfig.floatingNotesMedia));
      } else {
        loadPromises.push(loadImg('__floating_notes_media__', renderConfig.floatingNotesMedia));
      }
    }

    await Promise.all(loadPromises);

    if (currentAbortSignal.aborted) {
      setIsRendering(false);
      return;
    }

    try {
      if (isPlaylistRender) {
        // Build tracks for playlist renderer
        const tracks = [];
        for (const item of playlist) {
          let trackLyrics: LyricLine[] = [];
          if (item.parsedLyrics && item.parsedLyrics.length > 0) {
            trackLyrics = item.parsedLyrics;
          } else if (item.lyricFile) {
            try {
              const text = await item.lyricFile.text();
              const ext = item.lyricFile.name.split('.').pop()?.toLowerCase();
              if (ext === 'lrc') trackLyrics = parseLRC(text);
              else if (ext === 'srt') trackLyrics = parseSRT(text);
              else if (ext === 'ttml' || ext === 'xml') trackLyrics = parseTTML(text);
              else if (ext === 'vtt') trackLyrics = parseVTT(text);
            } catch (e) {
              console.error("FFmpeg: Failed to parse lyrics for playlist item", e);
            }
          }
          tracks.push({
            audioFile: item.audioFile,
            lyrics: trackLyrics,
            metadata: item.metadata
          });
        }

        const result = await renderPlaylistWithFFmpeg(
          tracks,
          {
            canvas,
            visualSlides,
            imageMap,
            videoMap,
            preset,
            customFontName,
            renderConfig,
            resolution,
            aspectRatio,
            fps: renderFps,
            quality: renderQuality,
            codec: ffmpegCodec,
            onProgress: (progress, stage) => {
              // This is handled by renderPlaylistWithFFmpeg's onTrackProgress callback
            },
            onLog: (msg) => console.log(msg),
            abortSignal: currentAbortSignal,
          },
          (trackIndex, totalTracks, progress, stage) => {
            const overallProgress = ((trackIndex + (progress / 100)) / totalTracks) * 100;
            setRenderProgress(overallProgress);
            setFfmpegRenderStage(`Song ${trackIndex + 1}/${totalTracks}: ${stage}`);
          }
        );

        // Download the result
        const filename = `Playlist_${tracks.length}_Songs_${aspectRatio.replace(':', '-')}_ffmpeg.${result.format}`;
        const url = URL.createObjectURL(result.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        toast.success(`${tr('Playlist exported successfully!')} (${result.format.toUpperCase()}, ${Math.round(result.duration)}s)`);

      } else {
        const result = await renderWithFFmpeg({
          canvas,
          audioFile,
          lyrics: lyricsToRender,
          metadata: metadataToRender,
          visualSlides,
          imageMap,
          videoMap,
          preset,
          customFontName,
          renderConfig,
          resolution,
          aspectRatio,
          fps: renderFps,
          quality: renderQuality,
          codec: ffmpegCodec,
          onProgress: (progress, stage) => {
            setRenderProgress(progress);
            setFfmpegRenderStage(stage);
          },
          onLog: (msg) => console.log(msg),
          abortSignal: currentAbortSignal,
          isFirstSong: true,
          isLastSong: true
        });

        // Download the result
        const filename = `${metadataToRender.title || 'video'}_${aspectRatio.replace(':', '-')}_ffmpeg.${result.format}`;
        const url = URL.createObjectURL(result.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        toast.success(`${tr('Video exported successfully!')} (${result.format.toUpperCase()}, ${Math.round(result.duration)}s)`);
      }
    } catch (error: any) {
      if (error.message !== 'Render aborted') {
        console.error('FFmpeg render failed:', error);
        toast.error(`${tr('FFmpeg render failed')}: ${error.message}`);
      }
    } finally {
      setIsRendering(false);
      setFfmpegRenderStage('');
    }
  };

  // --- WebCodecs Video Export Logic ---
  const handleExportVideoWebCodecs = async () => {
    if (!canvasRef.current) return;

    // Determine Render Scope  
    const isPlaylistRender = renderConfig.renderMode === 'playlist' && playlist.length > 0;

    // Get audio file
    let audioFile: File | Blob | null = null;
    let lyricsToRender = adjustedLyrics;
    let metadataToRender = metadata;

    if (isPlaylistRender && playlist.length > 0) {
      audioFile = playlist[0].audioFile;
      lyricsToRender = playlist[0].parsedLyrics || [];
      metadataToRender = playlist[0].metadata;
    } else if (playlist.length > 0 && currentTrackIndex >= 0) {
      audioFile = playlist[currentTrackIndex].audioFile;
    } else if (currentAudioFile) {
      audioFile = currentAudioFile;
    } else if (audioSrc) {
      try {
        const res = await fetch(audioSrc);
        audioFile = await res.blob();
      } catch (e) {
        console.error("WebCodecs: Failed to fetch audio blob", e);
        toast.error(tr('Failed to load audio source for rendering.'));
        return;
      }
    } else {
      toast.error(tr('Please load an audio file first.'));
      return;
    }

    if (!audioFile) {
      toast.error(tr('No audio file available for export.'));
      return;
    }

    if (!isWebCodecsSupported()) {
      toast.error(tr('WebCodecs is not supported in this browser.'));
      return;
    }

    const { w, h } = getCanvasDimensions();
    const confirmMsg = `Start WebCodecs rendering at ${resolution} @ ${renderFps}fps?\nResolution: ${w}x${h}\n\nThis uses hardware acceleration and is very fast.`;
    const isConfirmed = await confirm(confirmMsg, "Start WebCodecs Rendering?");
    if (!isConfirmed) return;

    setShowRenderSettings(false);
    setIsRendering(true);
    setRenderProgress(0);
    setFfmpegRenderStage('Initializing WebCodecs...');

    const currentAbortSignal = { aborted: false };
    abortRenderRef.current = currentAbortSignal;

    stopPlayback();

    const canvas = canvasRef.current;
    canvas.width = w;
    canvas.height = h;

    // Preload resources
    const imageMap = new Map<string, HTMLImageElement>();
    const videoMap = new Map<string, HTMLVideoElement>();
    const loadPromises: Promise<void>[] = [];

    const loadImg = (id: string, url: string) => {
      return new Promise<void>((resolve) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => { imageMap.set(id, img); resolve(); };
        img.onerror = () => resolve();
        img.src = url;
      });
    };

    const loadVid = (id: string, url: string) => {
      return new Promise<void>((resolve) => {
        const vid = document.createElement('video');
        vid.crossOrigin = "anonymous";
        vid.muted = true;
        vid.playsInline = true;
        vid.preload = "auto";
        let resolved = false;
        const safeResolve = () => { if (!resolved) { resolved = true; videoMap.set(id, vid); resolve(); } };
        vid.oncanplay = () => { if (!resolved) { vid.currentTime = 0.001; } };
        vid.onseeked = () => safeResolve();
        vid.onerror = () => { console.warn("Failed to load video:", url); safeResolve(); };
        setTimeout(() => safeResolve(), 5000);
        vid.src = url;
        vid.load();
      });
    };

    visualSlides.forEach(s => {
      if (s.type === 'video') loadPromises.push(loadVid(s.id, s.url));
      else if (s.type !== 'audio') loadPromises.push(loadImg(s.id, s.url));
    });

    if (metadataToRender.coverUrl) {
      if (metadataToRender.backgroundType === 'video') {
        loadPromises.push(loadVid('background', metadataToRender.coverUrl));
      } else {
        loadPromises.push(loadImg('cover', metadataToRender.coverUrl));
      }
    }

    if (renderConfig.backgroundSource === 'image' && renderConfig.backgroundImage) {
      loadPromises.push(loadImg('__custom_bg__', renderConfig.backgroundImage));
    }

    if (renderConfig.backgroundSource === 'video' && renderConfig.backgroundVideo) {
      // Optimization: use existing video ref if available and matching
      if (bgVideoRef.current && bgVideoRef.current.currentSrc && !bgVideoRef.current.error) {
        // Use the existing element directly
        videoMap.set('__custom_bg_video__', bgVideoRef.current);
        console.log("WebCodecs: Re-using existing background video element");
      } else {
        loadPromises.push(loadVid('__custom_bg_video__', renderConfig.backgroundVideo));
      }
    }

    if (renderConfig.showChannelInfo && renderConfig.channelInfoImage) {
      loadPromises.push(loadImg('__channel_info__', renderConfig.channelInfoImage));
    }

    // Load Floating Notes Media
    if (renderConfig.showFloatingNotes && renderConfig.floatingNotesMedia) {
      if (renderConfig.floatingNotesMediaType === 'video') {
        loadPromises.push(loadVid('__floating_notes_media__', renderConfig.floatingNotesMedia));
      } else {
        loadPromises.push(loadImg('__floating_notes_media__', renderConfig.floatingNotesMedia));
      }
    }

    await Promise.all(loadPromises);

    if (currentAbortSignal.aborted) {
      setIsRendering(false);
      return;
    }

    try {
      if (isPlaylistRender) {
        // Build tracks for processing
        const tracks = [];
        for (const item of playlist) {
          let trackLyrics: LyricLine[] = [];
          if (item.parsedLyrics && item.parsedLyrics.length > 0) {
            trackLyrics = item.parsedLyrics;
          } else if (item.lyricFile) {
            try {
              const text = await item.lyricFile.text();
              const ext = item.lyricFile.name.split('.').pop()?.toLowerCase();
              if (ext === 'lrc') trackLyrics = parseLRC(text);
              else if (ext === 'srt') trackLyrics = parseSRT(text);
              else if (ext === 'ttml' || ext === 'xml') trackLyrics = parseTTML(text);
              else if (ext === 'vtt') trackLyrics = parseVTT(text);
            } catch (e) {
              console.error("WebCodecs: Failed to parse lyrics for playlist item", e);
            }
          }
          tracks.push({
            audioFile: item.audioFile,
            lyrics: trackLyrics,
            metadata: item.metadata
          });
        }

        const result = await renderPlaylistWithWebCodecs(
          tracks,
          {
            canvas,
            visualSlides,
            imageMap,
            videoMap,
            preset,
            customFontName,
            renderConfig,
            resolution,
            aspectRatio,
            fps: renderFps,
            quality: renderQuality,
            onProgress: (progress, stage) => {
              setRenderProgress(progress);
              setFfmpegRenderStage(stage);
            },
            onLog: (msg) => console.log(msg),
            abortSignal: currentAbortSignal,
          }
        );

        const filename = `Playlist_${tracks.length}_Songs_${aspectRatio.replace(':', '-')}_webcodecs.${result.format}`;
        const url = URL.createObjectURL(result.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        toast.success(`${tr('Playlist exported successfully!')} (${result.format.toUpperCase()}, ${Math.round(result.duration)}s)`);

      } else {
        const result = await renderWithWebCodecs({
          canvas,
          audioFile,
          lyrics: lyricsToRender,
          metadata: metadataToRender,
          visualSlides,
          imageMap,
          videoMap,
          preset,
          customFontName,
          renderConfig,
          resolution,
          aspectRatio,
          fps: renderFps,
          quality: renderQuality,
          onProgress: (progress, stage) => {
            setRenderProgress(progress);
            setFfmpegRenderStage(stage);
          },
          abortSignal: currentAbortSignal,
          isFirstSong: true,
          isLastSong: true
        });

        const filename = `${metadataToRender.title || 'video'}_${aspectRatio.replace(':', '-')}_webcodecs.${result.format}`;
        const url = URL.createObjectURL(result.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        toast.success(`${tr('Video exported successfully!')} (${Math.round(result.duration)}s)`);
      }
    } catch (error: any) {
      if (error.message !== 'Render aborted') {
        console.error('WebCodecs render failed:', error);
        toast.error(`${tr('Render failed')}: ${error.message}`);
      }
    } finally {
      setIsRendering(false);
      setFfmpegRenderStage('');
    }
  };

  // Dispatch to correct export handler based on render engine
  const handleExportVideoDispatch = async () => {
    if (renderEngine === 'ffmpeg') {
      await handleExportVideoFFmpeg();
    } else if (renderEngine === 'webcodecs') {
      await handleExportVideoWebCodecs();
    } else {
      await handleExportVideo();
    }
  };

  // Keep export function ref up to date for shortcuts
  useEffect(() => {
    exportVideoRef.current = handleExportVideoDispatch;
  });



  const handleAbortRender = useCallback(() => {
    if (abortRenderRef.current) {
      abortRenderRef.current.aborted = true;
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    } else {
      setIsRendering(false);
    }
    stopPlayback();
  }, [stopPlayback]);

  // Scroll active lyric into view
  const scrollToActiveLyric = useCallback(() => {
    if (renderConfig.lyricDisplayMode?.startsWith('static-')) return;
    if (lyricsContainerRef.current) {
      // Handle start of song (reset to top) for Loops/ Repeats
      // We use the Ref current time to avoid dependency loop or frequent re-renders
      const t = audioRef.current?.currentTime || 0;
      if (currentLyricIndex === -1 && t < 2) {
        lyricsContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }

      if (currentLyricIndex !== -1) {
        // Use data attribute to find the active lyric element
        const activeEl = lyricsContainerRef.current.querySelector('[data-lyric-active="true"]') as HTMLElement;
        if (activeEl) {
          const container = lyricsContainerRef.current;

          // Skip if element is hidden
          if (activeEl.offsetHeight === 0) return;

          // Use offsetTop (layout position) instead of getBoundingClientRect (visual position)
          // This avoids issues with CSS transforms like scale-105
          const elOffsetTop = activeEl.offsetTop;
          const elHeight = activeEl.offsetHeight;
          const containerHeight = container.clientHeight;

          // Target: Position based on contentPosition preference
          let positionRatio = 0.5; // Center default
          if (renderConfig.contentPosition === 'top') positionRatio = 0.25;
          if (renderConfig.contentPosition === 'bottom') positionRatio = 0.75;

          const targetScrollTop = elOffsetTop - (containerHeight * positionRatio) + (elHeight / 2);

          container.scrollTo({
            top: targetScrollTop,
            behavior: 'smooth'
          });
        }
      }
    }
  }, [currentLyricIndex, preset, renderConfig.contentPosition, renderConfig.marginTopScale, renderConfig.marginBottomScale, renderConfig.lyricDisplayMode]);

  // Trigger scroll on lyric change
  useEffect(() => {
    scrollToActiveLyric();
  }, [scrollToActiveLyric]);

  // Re-scroll after visibility changes (wait for CSS transition to complete)
  useEffect(() => {
    const timer = setTimeout(() => {
      scrollToActiveLyric();
    }, 550); // Wait for 500ms CSS transition + buffer
    return () => clearTimeout(timer);
  }, [isMouseIdle, bypassAutoHide, showInfo, showPlayer, activeTab, isPlaylistMode, scrollToActiveLyric]);

  const controlsTimeoutRef = useRef<number | null>(null);

  // ... (keep existing state)

  // Helper to reset idle timer
  // Helper to reset idle timer
  const resetIdleTimer = useCallback(() => {
    setIsMouseIdle(false);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }

    // Auto-hide after 3s of inactivity (only if not rendering)
    if (!isRendering) {
      const timeout = window.setTimeout(() => {
        // Only set idle if we aren't bypassing it
        // Note: We check the ref/state inside the timeout or rely on the component state updates
        // Since bypassAutoHide overrides the EFFECT of isMouseIdle in the render, we can just set isMouseIdle(true)
        setIsMouseIdle(true);
      }, 3000);

      controlsTimeoutRef.current = timeout;
    }
  }, [isRendering]);

  // Handle idle mouse to hide controls
  const handleMouseMove = () => {
    resetIdleTimer();
  };

  const lastTapRef = useRef(0);
  const handleTouchStart = (e: React.TouchEvent) => {
    resetIdleTimer();

    // Manual Double Tap Detection
    const now = Date.now();
    const DOUBLE_TAP_DELAY = 300;
    if (now - lastTapRef.current < DOUBLE_TAP_DELAY) {
      if ((e.target as HTMLElement).closest('.no-minimal-mode-toggle')) {
        return;
      }
      handleDisplayDoubleClick(e);
    }
    lastTapRef.current = now;
  };

  // Keyboard Shortcuts
  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check if the key shoud trigger UI wake-up
      const key = e.key.toLowerCase();
      const ignoredKeysForIdle = [' ', 's', 'v', 'n', 'b', 't', 'p', 'l', 'r', 'f', 'h', 'g', 'm', 'j', 'd', 'e', 'c', 'x', 'z', 'q', 'escape', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'meta', 'control', 'shift', 'alt', 'printscreen', 'fn', '+', '-', '=', '8', '9', '0'];

      if (!ignoredKeysForIdle.includes(key)) {
        resetIdleTimer();
      }

      // Ignore if typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      // If a modifier key is pressed (Ctrl/Meta/Alt), ignore all simple shortcuts.
      // The only shortcut that allows modifiers is 'Ctrl/Cmd + Shift + E' for export.
      if (e.ctrlKey || e.metaKey || e.altKey) {
        if (!(key === 'e' && e.shiftKey)) {
          return;
        }
      }

      if (isRendering) {
        if (key === 'escape') {
          handleAbortRender();
        }
        return; // Block other shortcuts during render
      }

      // Escape: close open panels in priority order (highest priority first)
      if (key === 'escape') {
        e.preventDefault();
        if (showShortcutInfo) {
          setShowShortcutInfo(false);
        } else if (showRenderSettings) {
          setShowRenderSettings(false);
        } else if (isPlaylistMode) {
          setIsPlaylistMode(false);
        } else if (activeTab === TabView.EDITOR) {
          setActiveTab(TabView.PLAYER);
        }
        return;
      }

      const setPresetCustom = () => setPreset('custom');

      switch (e.key.toLowerCase()) {
        case ' ':
          e.preventDefault();
          togglePlay();
          toast.success(isPlaying ? "Paused" : "Playing", { id: 'play-pause' });
          break;
        case 's':
        case 'v':
          e.preventDefault();
          stopPlayback();
          toast.success(tr('Stopped'), { id: 'stop' });
          break;
        case 'n':
          e.preventDefault();
          playNextSong();
          toast.success(tr('Next Song'), { id: 'next-song' });
          break;
        case 'o':
          e.preventDefault();
          const newVal = !isMinimalMode;
          setIsMinimalMode(newVal);
          if (newVal) {
            setBypassAutoHide(true);
          }
          toast.success(`${tr('Minimal Mode')}: ${tr(newVal ? 'On' : 'Off')}`, { id: 'minimal-mode' });
          break;
        case 'b':
          e.preventDefault();
          playPreviousSong();
          toast.success(tr('Previous Song'), { id: 'prev-song' });
          break;
        case 'r': // Loop (Repeat)
          e.preventDefault();
          toggleRepeat();
          // We calculate the next mode based on current state to show correct toast
          const nextRepMode = repeatMode === 'off' ? 'one' : repeatMode === 'one' ? 'all' : repeatMode === 'all' ? 'all_repeat' : 'off';
          const repLabels: Record<string, string> = { off: 'Repeat Off', one: 'Loop One', all: 'Play All (Stop)', all_repeat: 'Loop Playlist' };
          toast.success(`${tr('Repeat')}: ${tr(repLabels[nextRepMode])}`, { id: 'repeat' });
          break;
        case 'p': // List (Playlist)
          e.preventDefault();
          const newMode = !isPlaylistMode;
          setIsPlaylistMode(newMode);
          if (newMode) setActiveTab(TabView.PLAYER);
          break;
        case 'h':
          e.preventDefault();
          const nextBypass = !bypassAutoHide;
          setBypassAutoHide(nextBypass);
          toast.success(nextBypass ? "HUD: Always Visible" : "HUD: Auto-Hide", { id: 'hud-mode' });
          break;
        case 'k': // Keyboard Shortcuts
          e.preventDefault();
          setShowShortcutInfo(prev => !prev);
          break;
        case 'g': // Cycle Lyric Display Mode
          e.preventDefault();
          const modes = lyricDisplayGroups.flatMap(g => g.options.map(o => o.value));
          const currentMode = renderConfigRef.current.lyricDisplayMode;
          const currentIndex = modes.indexOf(currentMode);
          const nextIndex = (currentIndex + 1) % modes.length;
          const nextMode = modes[nextIndex] as any;

          setRenderConfig(prev => ({ ...prev, lyricDisplayMode: nextMode }));
          // setPresetCustom(); // Disabled to allow customized base presets
          toast.success(`${tr('Lyric Mode')}: ${nextMode.replace('-', ' ')}`, { id: 'lyric-mode' });
          break;
        case 'c': // Cycle Text Case
          e.preventDefault();
          const cases = textCaseOptions;
          const currentCase = renderConfigRef.current.textCase;
          const currentCaseIndex = cases.indexOf(currentCase);
          const nextCaseIndex = (currentCaseIndex + 1) % cases.length;
          const nextCase = cases[nextCaseIndex] as any;

          setRenderConfig(prev => ({ ...prev, textCase: nextCase }));
          // setPresetCustom(); // Disabled to allow customized base presets
          toast.success(`${tr('Text Case')}: ${nextCase}`, { id: 'text-case' });
          break;
        case 'f':
          toggleFullscreen();
          break;
        case 'i': // Toggle Info (Top)
          setShowInfo(prev => !prev);
          break;
        case 'y': // Toggle Player (Bottom)
          setShowPlayer(prev => !prev);
          break;
        case 'l': // Random Settings
          e.preventDefault();
          {
            const newRandomConfig = generateRandomRenderConfig(renderConfigRef.current);
            setRenderConfig(newRandomConfig);
            setPreset('custom');
            toast.success(tr('🎲 Random settings generated!'), { id: 'random-settings' });
          }
          break;
        case 'd': // Toggle Render Settings
          e.preventDefault();
          setShowRenderSettings(prev => !prev);
          break;
        case 't': // Toggle Timeline (Editor)
          if (isPlaylistMode) {
            setIsPlaylistMode(false);
            setActiveTab(TabView.EDITOR);
          } else {
            setActiveTab(prev => prev === TabView.PLAYER ? TabView.EDITOR : TabView.PLAYER);
          }
          break;
        case 'm': // Mute
          e.preventDefault();
          const nextMute = !isMuted;
          setIsMuted(nextMute);
          toast.success(nextMute ? "Muted" : "Unmuted", { id: 'mute' });
          break;
        case 'x': // Toggle Highlight Effect
          e.preventDefault();
          const isTurningOn = renderConfigRef.current.highlightEffect === 'none';
          setRenderConfig(prev => ({
            ...prev,
            highlightEffect: prev.highlightEffect === 'none' ? 'karaoke' : 'none'
          }));
          // setPresetCustom(); // Disabled as per user request
          toast.success(`${tr('Highlight')}: ${tr(isTurningOn ? 'On' : 'Off')}`, { id: 'highlight-toggle' });
          break;
        case 'z': // Cycle Highlight Effect
          e.preventDefault();
          const highlightEffects = highlightEffectGroups.flatMap(g => g.options.map(o => o.value));

          const currentEffect = renderConfigRef.current.highlightEffect || 'none';
          const idx = highlightEffects.indexOf(currentEffect as string);
          const safeIdx = idx === -1 ? 0 : idx;
          const nextIdxZ = (safeIdx + 1) % highlightEffects.length;
          const nextEffectZ = highlightEffects[nextIdxZ] as string;

          const derived = deriveHighlightColors(nextEffectZ);

          setRenderConfig(prev => {
            const newConfig = { ...prev, highlightEffect: nextEffectZ as any };

            // Auto-disable custom colors on effect switch
            newConfig.useCustomHighlightColors = false;

            if (derived) {
              newConfig.highlightColor = derived.color;
              newConfig.highlightBackground = derived.bg;
            }
            return newConfig;
          });
          // setPresetCustom(); // Disabled as per user request

          toast.success(`${tr('Effect')}: ${nextEffectZ.replace(/-/g, ' ')}`, { id: 'highlight-effect' });
          break;
        case 'j': // Cycle Preset
          e.preventDefault();
          const pIdx = PRESET_CYCLE_LIST.indexOf(preset);
          const nextPIdx = (pIdx + 1) % PRESET_CYCLE_LIST.length;
          const nextP = PRESET_CYCLE_LIST[nextPIdx];

          setPreset(nextP);

          // Sync Config
          // Sync Config
          const pConfig = PRESET_DEFINITIONS[nextP];
          if (pConfig) {
            // Reset to Base Style Default first, then apply Preset overrides.
            // This ensures "custom" styles (like highlight effects from previous preset) are cleared
            // unless the new preset explicitly defines them or they are global defaults.
            // We want to reset "Visual" styles but maybe verify if we should keep "Data" settings?
            // Usually switching presets resets the Look.
            // We'll use a partial reset of visual keys.

            // List of visual style keys to reset
            const visualReset: Partial<RenderConfig> = {
              fontFamily: 'ui-sans-serif, system-ui, sans-serif',
              fontSizeScale: 1.0,
              fontColor: '#ffffff',
              fontWeight: 'bold',
              fontStyle: 'normal',
              textCase: 'none',
              textAlign: 'center',
              contentPosition: 'center',
              textDecoration: 'none',
              textEffect: 'preset',
              textAnimation: 'none',
              highlightEffect: 'karaoke', // Default to karaoke if not specified? Or 'none'? Use DEFAULT_CONFIG values.
              highlightColor: '#fb923c',
              highlightBackground: '#fb923c',
              useCustomHighlightColors: false,
              lyricStyleTarget: 'active-only',
              transitionEffect: 'none',
              // Keep background source/image? Usually yes, user might have set a background.
              // Keep info display toggles? Yes.
            };

            setRenderConfig(curr => ({
              ...curr,
              ...visualReset,
              ...pConfig
            }));
          }

          // Notification
          let pLabel: string = nextP;
          for (const g of videoPresetGroups) {
            const found = g.options.find(o => o.value === nextP);
            if (found) {
              pLabel = found.label;
              break;
            }
          }
          toast.success(`${tr('Preset')}: ${pLabel}`, { id: 'preset' });
          break;
        case 'arrowleft':
          e.preventDefault();
          if (audioRef.current) {
            const newTime = Math.max(0, audioRef.current.currentTime - 5);
            audioRef.current.currentTime = newTime;
            setCurrentTime(newTime);
          }
          break;
        case 'arrowright':
          e.preventDefault();
          if (audioRef.current) {
            const newTime = Math.min(duration, audioRef.current.currentTime + 5);
            audioRef.current.currentTime = newTime;
            setCurrentTime(newTime);
          }
          break;
        case 'arrowup':
          e.preventDefault();
          if (lyricsContainerRef.current) {
            lyricsContainerRef.current.scrollBy({ top: -100, behavior: 'smooth' });
          }
          break;
        case 'arrowdown':
          e.preventDefault();
          if (lyricsContainerRef.current) {
            lyricsContainerRef.current.scrollBy({ top: 100, behavior: 'smooth' });
          }
          break;
        case '+':
        case '=': // For keyboards where + is Shift+=
          if (e.ctrlKey || e.metaKey || e.altKey) break;
          e.preventDefault();
          const currentScaleUp = renderConfigRef.current.fontSizeScale;
          const newValUp = Math.min(currentScaleUp + 0.1, 3.0);
          setRenderConfig(prev => ({ ...prev, fontSizeScale: newValUp }));
          toast.success(`${tr('Font Size')}: ${(newValUp * 100).toFixed(0)}%`, { id: 'font-size' });
          // setPresetCustom(); // Disabled to allow customized base presets
          break;
        case '-':
          if (e.ctrlKey || e.metaKey || e.altKey) break;
          e.preventDefault();
          const currentScaleDown = renderConfigRef.current.fontSizeScale;
          const newValDown = Math.max(currentScaleDown - 0.1, 0.1);
          setRenderConfig(prev => ({ ...prev, fontSizeScale: newValDown }));
          toast.success(`${tr('Font Size')}: ${(newValDown * 100).toFixed(0)}%`, { id: 'font-size' });
          // setPresetCustom(); // Disabled to allow customized base presets
          break;
        case 'e':
          if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
            e.preventDefault();
            exportVideoRef.current();
          }
          break;
        case '1':
          if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) break;
          e.preventDefault();
          document.getElementById('audio-file')?.click();
          break;
        case '2':
          if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) break;
          e.preventDefault();
          document.getElementById('lyrics-file')?.click();
          break;
        case '3':
          if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) break;
          e.preventDefault();
          document.getElementById('font-file')?.click();
          break;
        case '8': // Decrease UI Scale
          if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) break;
          e.preventDefault();
          setUiScale(prev => {
            const next = Math.max(0.5, Math.round((prev - 0.05) * 100) / 100);
            toast.success(`${tr('UI Scale')}: ${Math.round(next * 100)}%`, { id: 'ui-scale' });
            return next;
          });
          break;
        case '9': // Increase UI Scale
          if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) break;
          e.preventDefault();
          setUiScale(prev => {
            const next = Math.min(2.0, Math.round((prev + 0.05) * 100) / 100);
            toast.success(`${tr('UI Scale')}: ${Math.round(next * 100)}%`, { id: 'ui-scale' });
            return next;
          });
          break;
        case '0': // Reset UI Scale
          if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) break;
          e.preventDefault();
          setUiScale(1.0);
          toast.success(`${tr('UI Scale')}: 100%`, { id: 'ui-scale' });
          break;
        case 'q': // Toggle Lyric Visibility Mode (Default / Auto)
          e.preventDefault();
          setRenderConfig(prev => {
            const next = (prev.lyricVisibilityMode ?? 'default') === 'auto' ? 'default' : 'auto';
            toast.success(`${tr('Lyric Visibility')}: ${tr(next === 'auto' ? 'Auto' : 'Default')}`, { id: 'lyric-visibility-mode' });
            return { ...prev, lyricVisibilityMode: next };
          });
          break;

      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, repeatMode, activeTab, isRendering, resetIdleTimer, handleAbortRender, isPlaylistMode, playNextSong, playPreviousSong, toast, isMinimalMode, preset, bypassAutoHide, isMuted, showRenderSettings, showShortcutInfo]);

  // Smooth Playback Animation Loop (Throttled to ~30fps)
  useEffect(() => {
    let animationFrameId: number;
    let lastFrameTime = 0;
    const fpsInterval = 1000 / 30;

    const animate = (now: number) => {
      if (audioRef.current && !audioRef.current.paused && isPlaying) {
        animationFrameId = requestAnimationFrame(animate);

        const elapsed = now - lastFrameTime;

        if (elapsed > fpsInterval) {
          lastFrameTime = now - (elapsed % fpsInterval);
          setCurrentTime(audioRef.current.currentTime);
        }
      }
    };

    if (isPlaying && !isRendering) {
      animationFrameId = requestAnimationFrame(animate);
    }

    return () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
    };
  }, [isPlaying, isRendering]);

  // --- Render Helpers ---

  // Combine manual visibility with mouse idle state
  // BypassAutoHide overrides mouse idle.
  const isHeaderVisible = showInfo && (!isMouseIdle || bypassAutoHide) && !isRendering;
  const isFooterVisible = showPlayer && (!isMouseIdle || bypassAutoHide) && !isRendering && !isMinimalMode;

  const activeSlide = activeVisualSlides.length > 0 ? activeVisualSlides[0] : null;

  const backgroundStyle = activeSlide
    ? { backgroundImage: `url(${activeSlide.url})` }
    : metadata.coverUrl
      ? { backgroundImage: `url(${metadata.coverUrl})` }
      : undefined;

  // Video Sync Logic
  const bgVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    // 1. Active Visual Slides Sync
    activeVisualSlides.forEach(slide => {
      // Check visibility
      const layer = slide.layer || 0;
      if (renderConfig.layerVisibility?.visual?.[layer] === false) return;

      if (slide.type === 'video') {
        const vid = document.getElementById(`video-preview-${slide.id}`) as HTMLVideoElement;
        if (vid) {
          if (isRendering) {
            if (!vid.paused) vid.pause();
          } else {
            const speed = slide.playbackRate || 1;
            let relTime = ((currentTime - slide.startTime) * speed) + (slide.mediaStartOffset || 0);

            // Auto-Loop Logic
            const sourceDuration = slide.mediaDuration || vid.duration;
            if (sourceDuration && sourceDuration > 0 && relTime >= sourceDuration) {
              relTime = relTime % sourceDuration;
            }

            // Sync Playback Rate
            if (Math.abs(vid.playbackRate - speed) > 0.01) vid.playbackRate = speed;

            // Check if we need to sync timestamps (fix drift/seeks)
            if (Math.abs(vid.currentTime - relTime) > 0.2) {
              vid.currentTime = relTime;
            }

            // Sync Muted State & Volume
            const shouldMute = slide.isMuted !== false; // Default true (muted)
            if (vid.muted !== shouldMute) vid.muted = shouldMute;

            const targetVolume = slide.volume !== undefined ? slide.volume : 1;
            if (Math.abs(vid.volume - targetVolume) > 0.01) vid.volume = targetVolume;

            if (isPlaying && vid.paused) {
              vid.play().catch(() => { }); // catch interrupt errors
            } else if (!isPlaying && !vid.paused) {
              vid.pause();
            }
          }
        }
      }
    });

    // 2. Background Video (Metadata OR Custom)
    // Only play if no active slide covers it, OR if we want it to run behind.
    // Let's run it always but maybe pause if not visible?
    // For now, simple sync:
    if ((metadata.backgroundType === 'video' || renderConfig.backgroundSource === 'video') && bgVideoRef.current) {
      const vid = bgVideoRef.current;

      if (isRendering) {
        if (!vid.paused) vid.pause();
      } else {
        // Sync with modulo for Looping
        const vidDuration = vid.duration || 1;
        const targetTime = currentTime % vidDuration;

        // Sync if drifted > 0.1s (Smoother scrubbing)
        if (Math.abs(vid.currentTime - targetTime) > 0.1) {
          vid.currentTime = targetTime;
        }

        if (isPlaying && vid.paused) {
          vid.play().catch(() => { });
        } else if (!isPlaying && !vid.paused) {
          vid.pause();
        }
      }
    }


    // 3. Audio Slides Sync (Preview)
    // We iterate over ALL audio slides that SHOULD be playing (activeAudioSlides)
    activeAudioSlides.forEach(s => {
      const aud = document.getElementById(`audio-preview-${s.id}`) as HTMLAudioElement;
      if (aud) {
        const speed = s.playbackRate || 1;
        const relTime = ((currentTime - s.startTime) * speed) + (s.mediaStartOffset || 0);

        // Sync Playback Rate
        if (Math.abs(aud.playbackRate - speed) > 0.01) aud.playbackRate = speed;

        if (Math.abs(aud.currentTime - relTime) > 0.2) aud.currentTime = relTime;

        const shouldMute = s.isMuted === true;
        if (aud.muted !== shouldMute) aud.muted = shouldMute;

        const targetVol = s.volume !== undefined ? s.volume : 1;
        if (Math.abs(aud.volume - targetVol) > 0.01) aud.volume = targetVol;

        if (isPlaying && aud.paused) aud.play().catch(() => { });
        else if (!isPlaying && !aud.paused) aud.pause();
      }
    });

  }, [currentTime, isPlaying, activeVisualSlides, metadata, activeAudioSlides, renderConfig.layerVisibility]);

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onTouchStart={handleTouchStart}
      onDoubleClick={handleDisplayDoubleClick}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className={`relative bg-black overflow-hidden flex font-sans select-none ${isMouseIdle && !bypassAutoHide ? 'cursor-none' : ''}`}
      style={{
        width: `${100 / uiScale}vw`,
        height: `${100 / uiScale}dvh`,
        transform: `scale(${uiScale})`,
        transformOrigin: 'top left',
      }}
    >
      {/* Drag and Drop Overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-[100] bg-black/80 backdrop-blur-md flex items-center justify-center p-8 transition-all duration-300 pointer-events-none">
          <div className="border-2 border-dashed border-amber-500/50 bg-zinc-950/40 backdrop-blur-xl rounded-3xl p-10 max-w-2xl w-full flex flex-col items-center text-center space-y-8 animate-pulse shadow-[0_0_50px_rgba(168,85,247,0.15)] pointer-events-none">
            <div className="p-5 bg-amber-500/10 rounded-full text-amber-400 ring-4 ring-amber-500/5 animate-bounce">
              <Upload size={48} />
            </div>
            
            <div className="space-y-3">
              <h2 className="text-3xl font-extrabold text-white tracking-tight">{tr('Drop files to load')}</h2>
              <p className="text-zinc-400 max-w-md text-sm leading-relaxed">{tr('Release your files anywhere to instantly import them into the player and maker workspace.')}</p>
            </div>

            <div className="grid grid-cols-3 gap-6 w-full pt-4 border-t border-white/5">
              <div className="flex flex-col items-center space-y-2 p-4 bg-white/5 rounded-2xl border border-white/5">
                <div className="text-amber-400 bg-amber-500/10 p-3 rounded-xl">
                  <Music size={24} />
                </div>
                <span className="text-xs font-bold text-zinc-200">{tr('Audio / Video')}</span>
                <span className="text-[10px] text-zinc-500">{tr('MP3, WAV, FLAC, MP4...')}</span>
              </div>

              <div className="flex flex-col items-center space-y-2 p-4 bg-white/5 rounded-2xl border border-white/5">
                <div className="text-emerald-400 bg-emerald-500/10 p-3 rounded-xl">
                  <FileText size={24} />
                </div>
                <span className="text-xs font-bold text-zinc-200">{tr('Lyrics / Subtitles')}</span>
                <span className="text-[10px] text-zinc-500">{tr('LRC, SRT, VTT, TTML...')}</span>
              </div>

              <div className="flex flex-col items-center space-y-2 p-4 bg-white/5 rounded-2xl border border-white/5">
                <div className="text-pink-400 bg-pink-500/10 p-3 rounded-xl">
                  <Type size={24} />
                </div>
                <span className="text-xs font-bold text-zinc-200">{tr('Custom Font')}</span>
                <span className="text-[10px] text-zinc-500">{tr('TTF, OTF, WOFF, WOFF2...')}</span>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* 悬浮视频小窗：左侧边缘垂直居中。
          播放器本体就是这个 <video>，音画天然同步；纯音频文件时窗口内显示音符占位。 */}
      <FloatingVideoWindow
        aspect={videoAspect}
        title={displayTitle}
        visible={videoWindowVisible && !isRendering}
        onVisibleChange={setVideoWindowVisible}
        uiScale={uiScale}
        disabled={isRendering}
      >
        <video
          key={audioElementKey}
          ref={audioRef}
          src={audioSrc || undefined}
          loop={repeatMode === 'one'}
          muted={isMuted}
          playsInline
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onEnded={() => {
            if (isRendering) return;

            // Global Queue Handling (Active regardless of Playist UI visibility)
            const hasQueue = playlist.length > 0;

            if (repeatMode === 'one') {
              // Handled by loop attribute, but purely for backup:
              // if (!audioRef.current?.loop) audioRef.current?.play();
            } else if (repeatMode === 'all_repeat') {
              // Loop All: Always go next (loops around)
              if (hasQueue) {
                playNextSong();
              } else {
                // Single file loop equivalent
                audioRef.current?.play();
              }
            } else if (repeatMode === 'all') {
              // Play All (No Repeat): Stop at end
              if (hasQueue) {
                if (currentTrackIndex < playlist.length - 1) {
                  playNextSong();
                } else {
                  setIsPlaying(false);
                }
              } else {
                setIsPlaying(false);
              }
            } else {
              // Off: Stop
              setIsPlaying(false);
            }
          }}
          crossOrigin="anonymous"
          className="w-full h-full object-contain bg-black"
        />
      </FloatingVideoWindow>

      {/* Audio Preview Elements */}
      {activeAudioSlides.map(s => (
        <audio
          key={s.id}
          id={`audio-preview-${s.id}`}
          src={s.url}
          className="hidden"
          playsInline
        />
      ))}

      {/* Hidden Rendering Canvas */}
      <canvas
        ref={canvasRef}
        width={canvasWidth}
        height={canvasHeight}
        className="absolute top-0 left-0 hidden pointer-events-none opacity-0"
      />

      {/* --- Visual Layer --- */}
      <div className="absolute inset-0 bg-black overflow-hidden pointer-events-none">
        {/* 1. Base Background */}
        {(renderConfig.backgroundSource === 'color' || renderConfig.backgroundSource === 'threejs') && (
          <div className="absolute inset-0" style={{ backgroundColor: renderConfig.backgroundSource === 'threejs' ? (renderConfig.threejsBgColor || '#000000') : renderConfig.backgroundColor }} />
        )}
        {renderConfig.backgroundSource === 'gradient' && (
          <div className="absolute inset-0" style={{ background: renderConfig.backgroundGradient }} />
        )}
        {renderConfig.backgroundSource === 'image' && renderConfig.backgroundImage && (
          <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url(${renderConfig.backgroundImage})` }} />
        )}
        {renderConfig.backgroundSource === 'video' && renderConfig.backgroundVideo && (
          <video
            ref={bgVideoRef} // Re-use ref for sync logic
            src={renderConfig.backgroundVideo}
            className="absolute inset-0 w-full h-full object-cover"
            muted
            loop
            playsInline
          />
        )}
        {renderConfig.backgroundSource === 'smart-gradient' && (
          <div className="absolute inset-0"
            style={{
              background: (() => {
                const hex = renderConfig.backgroundColor || '#312e81';
                const r = parseInt(hex.slice(1, 3), 16);
                const g = parseInt(hex.slice(3, 5), 16);
                const b = parseInt(hex.slice(5, 7), 16);
                const color = `${r},${g},${b}`;
                const darker = `${Math.floor(r * 0.6)},${Math.floor(g * 0.6)},${Math.floor(b * 0.6)}`;
                return `linear-gradient(to bottom right, rgb(${color}), rgb(${darker}) 50%, #000000)`;
              })()
            }}
          />
        )}
        {((renderConfig.backgroundSource === 'timeline' && visualSlides.length === 0) || renderConfig.backgroundSource === 'custom') && metadata.coverUrl && (
          metadata.backgroundType === 'video' ? (
            <video
              ref={bgVideoRef}
              src={metadata.coverUrl}
              className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-300 ${isBgVideoReady ? 'opacity-60' : 'opacity-0'}`}
              muted
              loop={!isRendering}
              playsInline
              preload="auto"
              onLoadedData={() => setIsBgVideoReady(true)}
            />
          ) : (
            <div
              className={`absolute inset-0 bg-cover bg-center transition-all duration-700 ease-in-out ${renderConfig.backgroundSource === 'custom' || activeVisualSlides.length === 0 ? 'opacity-60' : 'opacity-0'}`}
              style={{ backgroundImage: `url(${metadata.coverUrl})` }}
            />
          )
        )}

        {/* Solid Color / Gradient / Smart Gradient Background */}
        {(renderConfig.backgroundSource === 'color' || renderConfig.backgroundSource === 'threejs') && (
          <div className="absolute inset-0 transition-all duration-500" style={{ backgroundColor: renderConfig.backgroundSource === 'threejs' ? (renderConfig.threejsBgColor || '#000000') : renderConfig.backgroundColor }}></div>
        )}
        {renderConfig.backgroundSource === 'gradient' && (
          <div className="absolute inset-0 transition-all duration-500" style={{ background: renderConfig.backgroundGradient }}></div>
        )}
        {renderConfig.backgroundSource === 'smart-gradient' && (
          <div className="absolute inset-0 transition-all duration-500"
            style={{
              background: (() => {
                const hex = renderConfig.backgroundColor || '#312e81';
                const r = parseInt(hex.slice(1, 3), 16);
                const g = parseInt(hex.slice(3, 5), 16);
                const b = parseInt(hex.slice(5, 7), 16);
                const color = `${r},${g},${b}`;
                // Darker: 60%
                const darker = `${Math.floor(r * 0.6)},${Math.floor(g * 0.6)},${Math.floor(b * 0.6)}`;
                return `linear-gradient(to bottom right, rgb(${color}), rgb(${darker}) 50%, #000000)`;
              })()
            }}
          ></div>
        )}

        {/* Default Gradient if nothing */}
        {!metadata.coverUrl && ((renderConfig.backgroundSource === 'timeline' && visualSlides.length === 0) || renderConfig.backgroundSource === 'custom') && (
          <div className="absolute inset-0 bg-gradient-to-br from-indigo-900 via-amber-900 to-black opacity-80"></div>
        )}

        {/* ThreeJS Background */}
        {renderConfig.backgroundSource === 'threejs' && !isRendering && (
          <ThreeBackground
            isPlaying={isPlaying}
            currentTime={currentTime}
            config={renderConfig}
          />
        )}

        {/* 2. Slide Overlay */}
        <div className={`absolute inset-0 pointer-events-none ${renderConfig.backgroundSource === 'timeline' ? 'opacity-100' : 'opacity-0'}`}>
          {renderConfig.backgroundSource === 'timeline' && activeVisualSlides.map(slide => {
            // Check visibility
            const layer = slide.layer || 0;
            if (renderConfig.layerVisibility?.visual?.[layer] === false) return null;

            // Calculate Opacity for Transitions
            const transitionType = renderConfig.visualTransitionType || 'none';
            const transitionDuration = renderConfig.visualTransitionDuration || 1.0;
            let opacity = 1.0;

            if (transitionType !== 'none') {
              // Fade In (Start)
              if (currentTime < slide.startTime + transitionDuration) {
                const prog = (currentTime - slide.startTime) / transitionDuration;
                opacity = Math.max(0, Math.min(1, prog));
              }

              // Fade Out (End/Tail)
              if (currentTime >= slide.endTime) {
                // Check if there is a subsequent clip on the same layer starting immediately (gap < 0.1s)
                // If so, we HOLD opacity at 1.0 (or current max) to let the next clip fade in ON TOP.

                // Optimize: only scan if we are in crossfade mode
                let isCovered = false;
                if (transitionType === 'crossfade') {
                  // We need to access all visualSlides to find neighbors
                  // Note: using visualSlides from closure.
                  isCovered = visualSlides.some(other =>
                    other.id !== slide.id &&
                    (other.layer || 0) === (slide.layer || 0) &&
                    // Check if other starts substantially close to this end
                    other.startTime >= slide.endTime - 0.1 &&
                    other.startTime < slide.endTime + 0.2 // Tolerance
                  );
                }

                if (isCovered) {
                  // Hold opacity to allow dissolved incoming clip
                  // But we should NOT hold if we are detected as "fading in" above? 
                  // No, "Fading In" logic clamps opacity min(1).
                  // Here we clamp max.
                  // If we are covered, we don't reduce opacity.
                } else {
                  const past = currentTime - slide.endTime;
                  const prog = 1 - (past / transitionDuration);
                  opacity = Math.min(opacity, Math.max(0, Math.min(1, prog)));
                }
              } else if (transitionType === 'fade-to-black') {
                // Fade to black logic implies dipping to black between clips.
                // We fade out at the end of the clip *before* the join,
                // and fade in at the start of the next clip (handled above).
                if (currentTime > slide.endTime - transitionDuration) {
                  const prog = (slide.endTime - currentTime) / transitionDuration;
                  opacity = Math.min(opacity, Math.max(0, Math.min(1, prog)));
                }
              }
            }

            return (
              <div key={slide.id} className="absolute inset-0 flex items-center justify-center overflow-hidden" style={{ opacity }}>
                {slide.type === 'video' ? (
                  <video
                    id={`video-preview-${slide.id}`}
                    src={slide.url}
                    className="w-full h-full object-cover"
                    muted={slide.isMuted !== false}
                    playsInline
                  />
                ) : (
                  <div
                    className="w-full h-full bg-cover bg-center"
                    style={{ backgroundImage: `url(${slide.url})` }}
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* Blur / Dim Overlay */}
        {/* Blur / Dim Overlay */}
        <div
          className="absolute inset-0 bg-black/30 transition-all duration-700"
          style={{
            backdropFilter: (renderConfig.backgroundBlurStrength > 0) ? `blur(${renderConfig.backgroundBlurStrength}px)` : (isBlurEnabled ? 'blur(12px)' : 'none'),
            backgroundColor: renderConfig.useRealColorMedia ? 'transparent' : ((renderConfig.backgroundBlurStrength > 0 || isBlurEnabled) ? 'rgba(0,0,0,0.4)' : undefined)
          }}
        ></div>

        {/* Gradient Overlay (Black Bottom-to-Top) */}
        {renderConfig.enableGradientOverlay && (
          <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/60 to-transparent pointer-events-none z-0" />
        )}

        {/* Audio Visualizer (Web View Only - NOT rendered in export) */}
        {!isRendering && (
          <AudioVisualizer
            audioElement={audioRef.current}
            config={renderConfig}
            isPlaying={isPlaying}
          />
        )}
      </div>

      {/* --- Main Content Area --- */}
      <div className="relative z-10 flex-1 min-h-0 flex flex-col transition-all duration-500 min-w-0">

        {/* Preview Zone Wrapper: constrains absolute overlays (Channel Info, Floating Notes, Song Info) to the preview area only */}
        <div className="relative flex-1 min-h-0 overflow-hidden flex flex-col">

        {/* Channel Info Overlay */}
        {renderConfig.showChannelInfo && isMinimalMode && (
          <div
            className={`absolute z-[60] flex gap-2 p-6 pointer-events-none transition-all duration-500
              ${renderConfig.channelInfoStyle === 'modern' ? 'flex-col items-center' : 'flex-row items-center'}
              ${renderConfig.channelInfoStyle === 'box' ? 'bg-black/40 backdrop-blur-md rounded-xl border border-white/10' : ''}
              ${renderConfig.channelInfoPosition === 'top-left' ? 'top-0 left-0 items-start text-left' :
                renderConfig.channelInfoPosition === 'top-right' ? 'top-0 right-0 items-end text-right' :
                  renderConfig.channelInfoPosition === 'top-center' ? 'top-0 left-1/2 items-center text-center' :
                    renderConfig.channelInfoPosition === 'left-middle' ? 'top-1/2 left-0 items-start text-left' :
                      renderConfig.channelInfoPosition === 'center-middle' ? 'top-1/2 left-1/2 items-center text-center' :
                        renderConfig.channelInfoPosition === 'right-middle' ? 'top-1/2 right-0 items-end text-right' :
                          renderConfig.channelInfoPosition === 'bottom-left' ? 'bottom-0 left-0 items-start text-left' :
                            renderConfig.channelInfoPosition === 'bottom-center' ? 'bottom-0 left-1/2 items-center text-center' :
                              'bottom-0 right-0 items-end text-right'}
            `}
            style={{
              transform: `${renderConfig.channelInfoPosition?.includes('center') ? 'translateX(-50%)' : ''} ${renderConfig.channelInfoPosition?.includes('middle') ? 'translateY(-50%)' : ''} scale(${renderConfig.channelInfoSizeScale ?? 1})`,
              transformOrigin: renderConfig.channelInfoPosition?.includes('top')
                ? (renderConfig.channelInfoPosition?.includes('center') ? 'top center' : renderConfig.channelInfoPosition?.includes('left') ? 'top left' : 'top right')
                : renderConfig.channelInfoPosition?.includes('middle')
                  ? (renderConfig.channelInfoPosition?.includes('center') ? 'center center' : renderConfig.channelInfoPosition?.includes('left') ? 'center left' : 'center right')
                  : (renderConfig.channelInfoPosition?.includes('center') ? 'bottom center' : renderConfig.channelInfoPosition?.includes('left') ? 'bottom left' : 'bottom right'),
              // Smart Margin: If center (future proof), only vertical. If corner, all sides.
              ...(renderConfig.channelInfoPosition?.includes('middle')
                ? (renderConfig.channelInfoPosition?.includes('left') ? { marginLeft: `${(renderConfig.channelInfoMarginScale ?? 1) * 1.5}rem` } : renderConfig.channelInfoPosition?.includes('right') ? { marginRight: `${(renderConfig.channelInfoMarginScale ?? 1) * 1.5}rem` } : {})
                : renderConfig.channelInfoPosition?.includes('center')
                  ? (renderConfig.channelInfoPosition?.includes('top') ? { marginTop: `${(renderConfig.channelInfoMarginScale ?? 1) * 1.5}rem` } : { marginBottom: `${(renderConfig.channelInfoMarginScale ?? 1) * 1.5}rem` })
                  : { margin: `${(renderConfig.channelInfoMarginScale ?? 1) * 1.5}rem` })
            }}
          >
            {renderConfig.channelInfoImage && renderConfig.channelInfoStyle !== 'minimal' && (
              <img
                src={renderConfig.channelInfoImage}
                alt="Channel"
                className={`w-20 h-20 object-contain drop-shadow-lg ${renderConfig.channelInfoStyle === 'circle' ? 'rounded-full' : ''}`}
              />
            )}
            {renderConfig.channelInfoText && renderConfig.channelInfoStyle !== 'logo' && (
              (() => {
                const text = renderConfig.channelInfoText.trim();
                // Relaxed detection: checks for <svg tag presence
                const isSvg = /<svg[\s\S]*?>/i.test(text);

                if (isSvg) {
                  return (
                    <div
                      className={`font-bold drop-shadow-md text-lg inline-flex items-center gap-1
                        ${(renderConfig.channelInfoStyle === 'minimal' || renderConfig.channelInfoStyle === 'box') ? '' : 'px-2 py-1 bg-black/20 rounded-lg backdrop-blur-sm'}
                        [&>svg]:w-auto [&>svg]:h-[1.5em]`}
                      style={{
                        fontFamily: renderConfig.channelInfoFontFamily,
                        color: renderConfig.channelInfoFontColor || 'white',
                        fontWeight: renderConfig.channelInfoFontWeight || 'bold',
                        fontStyle: renderConfig.channelInfoFontStyle || 'normal'
                      }}
                      dangerouslySetInnerHTML={{ __html: text }}
                    />
                  );
                }

                return (
                  <p className={`font-bold drop-shadow-md text-lg 
                    ${(renderConfig.channelInfoStyle === 'minimal' || renderConfig.channelInfoStyle === 'box') ? '' : 'px-2 py-1 bg-black/20 rounded-lg backdrop-blur-sm'}`}
                    style={{
                      fontFamily: renderConfig.channelInfoFontFamily,
                      color: renderConfig.channelInfoFontColor || 'white',
                      fontWeight: renderConfig.channelInfoFontWeight || 'bold',
                      fontStyle: renderConfig.channelInfoFontStyle || 'normal'
                    }}>
                    {renderConfig.channelInfoText}
                  </p>
                );
              })()
            )}
          </div>
        )}

        {/* Floating Notes Overlay */}
        {renderConfig.showFloatingNotes && showFloatingNotesPreview && isMinimalMode && (
          <div
            className={`absolute z-[55] flex p-4 pointer-events-none transition-all duration-500 overflow-hidden
              ${floatingNotesLayout === 'media-left-text' ? 'flex-row items-stretch gap-3' :
                floatingNotesLayout === 'media-right-text' ? 'flex-row-reverse items-stretch gap-3' :
                  floatingNotesLayout === 'media-top-text' ? 'flex-col items-stretch gap-3' :
                    floatingNotesLayout === 'media-bottom-text' ? 'flex-col-reverse items-stretch gap-3' :
                      `flex-col justify-center ${
                        renderConfig.floatingNotesTextAlign === 'center' ? 'items-center' :
                        renderConfig.floatingNotesTextAlign === 'right' ? 'items-end' : 'items-start'
                      }`}
              ${renderConfig.floatingNotesPosition === 'top-left' ? 'top-0 left-0 text-left' :
                renderConfig.floatingNotesPosition === 'top-right' ? 'top-0 right-0 text-right' :
                  renderConfig.floatingNotesPosition === 'top-center' ? 'top-0 left-1/2 text-center' :
                    renderConfig.floatingNotesPosition === 'left-middle' ? 'top-1/2 left-0 text-left' :
                      renderConfig.floatingNotesPosition === 'center-middle' ? 'top-1/2 left-1/2 text-center' :
                        renderConfig.floatingNotesPosition === 'right-middle' ? 'top-1/2 right-0 text-right' :
                          renderConfig.floatingNotesPosition === 'bottom-left' ? 'bottom-0 left-0 text-left' :
                            renderConfig.floatingNotesPosition === 'bottom-center' ? 'bottom-0 left-1/2 text-center' :
                              'bottom-0 right-0 text-right'}
            `}
            style={{
              width: `${renderConfig.floatingNotesWidth || 300}px`,
              height: `${renderConfig.floatingNotesHeight || 150}px`,
              backgroundColor: renderConfig.floatingNotesShape !== 'none' ? (renderConfig.floatingNotesFillColor || '#000000') : 'transparent',
              opacity: renderConfig.floatingNotesOpacity ?? 0.8,
              border: renderConfig.floatingNotesShape !== 'none' && floatingNotesOutlineSize > 0
                ? `${floatingNotesOutlineSize}px solid ${renderConfig.floatingNotesOutlineColor || '#ffffff'}`
                : 'none',
              borderRadius: renderConfig.floatingNotesShape === 'rounded' ? '12px' : '0px',
              transform: `${renderConfig.floatingNotesPosition?.includes('center') ? 'translateX(-50%)' : ''} ${renderConfig.floatingNotesPosition?.includes('middle') ? 'translateY(-50%)' : ''}`,
              transformOrigin: renderConfig.floatingNotesPosition?.includes('top')
                ? (renderConfig.floatingNotesPosition?.includes('center') ? 'top center' : renderConfig.floatingNotesPosition?.includes('left') ? 'top left' : 'top right')
                : renderConfig.floatingNotesPosition?.includes('middle')
                  ? (renderConfig.floatingNotesPosition?.includes('center') ? 'center center' : renderConfig.floatingNotesPosition?.includes('left') ? 'center left' : 'center right')
                  : (renderConfig.floatingNotesPosition?.includes('center') ? 'bottom center' : renderConfig.floatingNotesPosition?.includes('left') ? 'bottom left' : 'bottom right'),
              ...(renderConfig.floatingNotesPosition?.includes('middle')
                ? (renderConfig.floatingNotesPosition?.includes('left') ? { marginLeft: `${(renderConfig.floatingNotesMarginScale ?? 1) * 1.5}rem` } : renderConfig.floatingNotesPosition?.includes('right') ? { marginRight: `${(renderConfig.floatingNotesMarginScale ?? 1) * 1.5}rem` } : {})
                : renderConfig.floatingNotesPosition?.includes('center')
                  ? (renderConfig.floatingNotesPosition?.includes('top') ? { marginTop: `${(renderConfig.floatingNotesMarginScale ?? 1) * 1.5}rem` } : { marginBottom: `${(renderConfig.floatingNotesMarginScale ?? 1) * 1.5}rem` })
                  : { margin: `${(renderConfig.floatingNotesMarginScale ?? 1) * 1.5}rem` })
            }}
          >
            {/* Media rendering */}
            {floatingNotesLayout !== 'text-only' && renderConfig.floatingNotesMedia && (
              <div
                className={getFloatingNotesMediaContainerClass(floatingNotesLayout)}
                style={getFloatingNotesMediaFlexStyle(floatingNotesLayout, floatingNotesMediaSizeScale)}
              >
                {renderConfig.floatingNotesMediaType === 'video' ? (
                  <video
                    key={renderConfig.floatingNotesMedia}
                    src={renderConfig.floatingNotesMedia}
                    className="max-w-full max-h-full object-contain"
                    style={{ objectPosition: getFloatingNotesMediaObjectPosition(floatingNotesLayout) }}
                    muted
                    loop
                    autoPlay
                    playsInline
                  />
                ) : (
                  <img
                    key={renderConfig.floatingNotesMedia}
                    src={renderConfig.floatingNotesMedia}
                    alt="Notes media"
                    className="max-w-full max-h-full object-contain"
                    style={{ objectPosition: getFloatingNotesMediaObjectPosition(floatingNotesLayout) }}
                  />
                )}
              </div>
            )}
            {/* Text rendering */}
            {floatingNotesLayout !== 'media-only' && renderConfig.floatingNotesText && (
              <div
                className="flex-1 min-w-0 min-h-0 overflow-y-auto whitespace-pre-wrap"
                style={{
                  fontFamily: renderConfig.floatingNotesFontFamily,
                  color: renderConfig.floatingNotesFontColor || 'white',
                  fontWeight: renderConfig.floatingNotesFontWeight || 'normal',
                  fontStyle: renderConfig.floatingNotesFontStyle || 'normal',
                  textAlign: renderConfig.floatingNotesTextAlign || 'left',
                  fontSize: `${12 * floatingNotesFontSizeScale}px`,
                }}
              >
                {renderConfig.floatingNotesText}
              </div>
            )}
          </div>
        )}

        {/* Minimal Mode Song Info Overlay */}
        {isMinimalMode && (
          <div
            className={`absolute z-20 flex flex-col gap-2 p-6 transition-all duration-500 pointer-events-none
              ${isHeaderVisible ? 'opacity-100' : 'opacity-0'}
              ${renderConfig.infoPosition === 'top-left' ? 'top-0 left-0 items-start text-left' :
                renderConfig.infoPosition === 'top-right' ? 'top-0 right-0 items-end text-right' :
                  renderConfig.infoPosition === 'top-center' ? 'top-0 left-1/2 items-center text-center' :
                    renderConfig.infoPosition === 'left-middle' ? 'top-1/2 left-0 items-start text-left' :
                      renderConfig.infoPosition === 'center-middle' ? 'top-1/2 left-1/2 items-center text-center' :
                        renderConfig.infoPosition === 'right-middle' ? 'top-1/2 right-0 items-end text-right' :
                          renderConfig.infoPosition === 'bottom-left' ? 'bottom-0 left-0 items-start text-left' :
                            renderConfig.infoPosition === 'bottom-right' ? 'bottom-0 right-0 items-end text-right' :
                              renderConfig.infoPosition === 'bottom-center' ? 'bottom-0 left-1/2 items-center text-center' :
                                'top-0 left-0 items-start text-left'}
            `}
            style={{
              transform: `${renderConfig.infoPosition?.includes('center') ? 'translateX(-50%)' : ''} ${renderConfig.infoPosition?.includes('middle') ? 'translateY(-50%)' : ''} scale(${renderConfig.infoSizeScale ?? 1})`,
              transformOrigin: renderConfig.infoPosition?.includes('top')
                ? (renderConfig.infoPosition?.includes('center') ? 'top center' : renderConfig.infoPosition?.includes('right') ? 'top right' : 'top left')
                : renderConfig.infoPosition?.includes('middle')
                  ? (renderConfig.infoPosition?.includes('center') ? 'center center' : renderConfig.infoPosition?.includes('right') ? 'center right' : 'center left')
                  : (renderConfig.infoPosition?.includes('center') ? 'bottom center' : renderConfig.infoPosition?.includes('right') ? 'bottom right' : 'bottom left'),
              // Smart Margin for Minimal Mode:
              // For Center positions, we only want to push from the top/bottom edge, not shift horizontally (which standard margin does if not careful)
              // For Corner positions, margin on all sides acts as inset padding nicely.
              ...(renderConfig.infoPosition?.includes('middle')
                ? (renderConfig.infoPosition?.includes('left') ? { marginLeft: `${(renderConfig.infoMarginScale ?? 1) * 1.5}rem` } : renderConfig.infoPosition?.includes('right') ? { marginRight: `${(renderConfig.infoMarginScale ?? 1) * 1.5}rem` } : {})
                : renderConfig.infoPosition?.includes('center')
                  ? (renderConfig.infoPosition?.includes('top') ? { marginTop: `${(renderConfig.infoMarginScale ?? 1) * 1.5}rem` } : { marginBottom: `${(renderConfig.infoMarginScale ?? 1) * 1.5}rem` })
                  : { margin: `${(renderConfig.infoMarginScale ?? 1) * 1.5}rem` })
            }}
          >
            {/* Inner Content Wrapper to handle layout styles */}
            <div className={`
              flex items-center gap-4 pointer-events-auto
              ${renderConfig.infoPosition?.includes('center') ? 'flex-col justify-center' : ''}
              ${renderConfig.infoPosition?.includes('right') ? 'flex-row-reverse' : 'flex-row'}
              ${renderConfig.infoStyle === 'box' ? 'bg-black/40 backdrop-blur-md p-4 rounded-xl border border-white/10' : ''}
              ${(renderConfig.infoStyle === 'modern' || renderConfig.infoStyle === 'minimal') ? '' : ''}
            `}>

              {/* Cover Art */}
              <div className={`relative group shrink-0 transition-opacity duration-300 
                ${!renderConfig.showCover || renderConfig.infoStyle === 'minimal' || renderConfig.infoStyle === 'modern' ? 'hidden' : 'block'}
                ${renderConfig.infoStyle === 'circle_art' ? 'rounded-full' : 'rounded-md'}
                overflow-hidden bg-zinc-800 shadow-lg border border-white/10
                w-12 h-12 md:w-16 md:h-16
              `}>
                {metadata.coverUrl ? (
                  metadata.backgroundType === 'video' ? (
                    <video src={metadata.coverUrl} className="w-full h-full object-cover" muted loop onMouseOver={e => e.currentTarget.play()} onMouseOut={e => e.currentTarget.pause()} />
                  ) : (
                    <img src={metadata.coverUrl} alt="Cover" className="w-full h-full object-cover" />
                  )
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-zinc-500">
                    <Music size={24} />
                  </div>
                )}
                <label className="absolute inset-0 bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 cursor-pointer transition-opacity">
                  <Upload size={20} className="text-white" />
                  <input type="file" accept="image/*,video/*" className="hidden" onChange={handleMetadataUpload} />
                </label>
              </div>

              {/* Text Info */}
              <div className={`flex flex-col justify-center ${renderConfig.infoPosition?.includes('right') ? 'items-end' : renderConfig.infoPosition?.includes('center') ? 'items-center' : 'items-start'}`}>
                {/* Title */}
                <h1 className={`font-bold drop-shadow-md line-clamp-1 transition-opacity duration-300 
                  ${!renderConfig.showTitle ? 'opacity-0 h-0 w-0' : 'opacity-100'}
                  ${renderConfig.infoStyle === 'minimal' ? 'text-sm' : renderConfig.infoStyle === 'modern' || renderConfig.infoStyle === 'modern_art' ? 'text-xl' : 'text-lg'}
                `}
                  style={{
                    fontFamily: renderConfig.infoFontFamily,
                    color: renderConfig.infoFontColor || 'white',
                    fontWeight: renderConfig.infoFontWeight || 'bold',
                    fontStyle: renderConfig.infoFontStyle || 'normal'
                  }}
                >{displayTitle}</h1>

                {/* Artist */}
                <div className={`flex items-center gap-2 transition-opacity duration-300 
                  ${!renderConfig.showArtist ? 'opacity-0 h-0 w-0' : 'opacity-100'}
                `}>
                  <p className={`drop-shadow-md
                    ${renderConfig.infoStyle === 'minimal' ? 'text-[10px]' : (renderConfig.infoStyle === 'modern' || renderConfig.infoStyle === 'modern_art') ? 'text-sm font-medium' : 'text-xs'}
                  `}
                    style={{
                      fontFamily: renderConfig.infoFontFamily,
                      color: renderConfig.infoFontColor || (renderConfig.infoStyle === 'minimal' ? '#a1a1aa' : '#d4d4d8'),
                      fontWeight: renderConfig.infoFontWeight || 'bold',
                      fontStyle: renderConfig.infoFontStyle || 'normal'
                    }}
                  >{displayArtist}</p>

                </div>
              </div>
            </div>
          </div>
        )}

        {/* Top Bar (Song Info) */}
        <div className={`transition-all duration-500 ease-in-out overflow-hidden ${(isHeaderVisible && !isMinimalMode) ? 'max-h-80 md:max-h-40 opacity-100' : 'max-h-0 opacity-0'}`}>
          <div className="p-4 md:p-6 flex flex-col md:flex-row justify-between items-start gap-4 md:gap-0">
            <div className="flex gap-4">
              <div className="flex gap-4 items-center">
                <div className={`relative group w-16 h-16 rounded-md overflow-hidden bg-zinc-800 shadow-lg border border-white/10 shrink-0 transition-opacity duration-300 ${!renderConfig.showCover ? 'opacity-0 scale-75 pointer-events-none w-0 h-0 -ml-4' : 'opacity-100 scale-100'}`}>
                  {metadata.coverUrl ? (
                    metadata.backgroundType === 'video' ? (
                      <video src={metadata.coverUrl} className="w-full h-full object-cover" muted loop onMouseOver={e => e.currentTarget.play()} onMouseOut={e => e.currentTarget.pause()} />
                    ) : (
                      <img src={metadata.coverUrl} alt="Cover" className="w-full h-full object-cover" />
                    )
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-zinc-500">
                      <Music size={24} />
                    </div>
                  )}
                  <label className="absolute inset-0 bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 cursor-pointer transition-opacity">
                    <Upload size={20} className="text-white" />
                    <input type="file" accept="image/*,video/*" className="hidden" onChange={handleMetadataUpload} />
                  </label>
                </div>
                <div>
                  <h1 className={`text-xl font-bold text-white drop-shadow-md line-clamp-1 transition-opacity duration-300 ${!renderConfig.showTitle ? 'opacity-0' : 'opacity-100'}`}>{displayTitle}</h1>
                  <div className={`flex items-center gap-2 transition-opacity duration-300 ${!renderConfig.showArtist ? 'opacity-0' : 'opacity-100'}`}>
                    <p className="text-zinc-300 text-sm drop-shadow-md">{displayArtist}</p>
                  </div>
                </div>
              </div>
            </div>

            <div className={`flex gap-2 flex-wrap ${isMinimalMode ? 'hidden' : ''}`}>
              <a
                href="https://github.com/dotslashgabut/immersive-audio-player-lyric-video-maker"
                target="_blank"
                rel="noopener noreferrer"
                title="Immersive Audio Player & Lyric Video Maker | GitHub"
                className="px-3 py-2 rounded-full transition-colors bg-black/30 text-zinc-300 hover:bg-white/10 text-xs font-bold flex items-center"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="#eee" className="bi bi-github"
                  viewBox="0 0 16 16">
                  <path
                    d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8" />
                </svg>
              </a>
              <a
                href="https://dotslashgabut.github.io/lyricseditor/"
                target="_blank"
                rel="noopener noreferrer"
                title="Premium Lyrics Editor - LRC, SRT, VTT, TTML & Subtitle Sync Tool"
                className="px-3 py-2 rounded-full transition-colors bg-black/30 text-zinc-300 hover:bg-white/10 text-xs font-bold flex items-center"
              >
                LyricsEditor
              </a>
              <a
                href="https://dotslashgabut.github.io/lyricaleditorplus/"
                target="_blank"
                rel="noopener noreferrer"
                title="LyricalEditorPlus - Universal Lyrics/Subtitle Editor & Lyrics Generator"
                className="px-3 py-2 rounded-full transition-colors bg-black/30 text-zinc-300 hover:bg-white/10 text-xs font-bold flex items-center"
              >
                LyricalEditorPlus
              </a>
              <button
                onClick={() => setBypassAutoHide(!bypassAutoHide)}
                className={`p-2 rounded-full transition-colors ${bypassAutoHide ? 'bg-amber-500/60 text-black' : 'bg-black/30 text-zinc-300 hover:bg-white/10'}`}
                title={tr('Bypass Auto-hide (H)')}
              >
                {bypassAutoHide ? <Eye size={20} /> : <EyeOff size={20} />}
              </button>
              <button
                onClick={() => setLang(l => (l === 'zh' ? 'en' : 'zh'))}
                className="h-9 px-2.5 rounded-full transition-colors bg-black/30 text-zinc-300 hover:bg-white/10 text-xs font-bold flex items-center justify-center min-w-[38px]"
                title={tr('Switch Language')}
              >
                {lang === 'zh' ? '中文' : 'EN'}
              </button>
              <div className="flex items-center gap-1 bg-black/30 text-zinc-300 rounded-full px-2 py-1 text-xs font-bold border border-white/5 h-9">
                <button
                  onClick={() => setUiScale(prev => Math.max(0.5, Math.round((prev - 0.05) * 100) / 100))}
                  className="w-5 h-5 rounded-full hover:bg-white/10 hover:text-white transition-colors flex items-center justify-center font-bold text-sm"
                  title={tr('Decrease UI Scale (8)')}
                >
                  -
                </button>
                <button
                  onClick={() => setUiScale(1.0)}
                  className="px-1 font-bold text-[10px] hover:text-white select-none transition-colors text-center min-w-[28px]"
                  title={tr('Reset UI Scale to 100% (Click)')}
                >
                  {Math.round(uiScale * 100)}%
                </button>
                <button
                  onClick={() => setUiScale(prev => Math.min(2.0, Math.round((prev + 0.05) * 100) / 100))}
                  className="w-5 h-5 rounded-full hover:bg-white/10 hover:text-white transition-colors flex items-center justify-center font-bold text-sm"
                  title={tr('Increase UI Scale (9)')}
                >
                  +
                </button>
              </div>
              <button
                onClick={() => setIsMinimalMode(!isMinimalMode)}
                className={`p-2 rounded-full transition-colors ${isMinimalMode ? 'bg-amber-500 text-black' : 'bg-black/30 text-zinc-300 hover:bg-white/10'}`}
                title={tr('Minimal Mode (O)')}
              >
                {isMinimalMode ? <Maximize size={20} /> : <Minimize size={20} />}
              </button>
              <button
                onClick={() => {
                  const newMode = !isPlaylistMode;
                  setIsPlaylistMode(newMode);
                  if (newMode) setActiveTab(TabView.PLAYER);
                }}
                className={`p-2 rounded-full transition-colors ${isPlaylistMode ? 'bg-orange-600 text-white' : 'bg-black/30 text-zinc-300 hover:bg-white/10'}`}
                title={tr('Toggle Playlist (L)')}
              >
                <ListMusic size={20} />
              </button>
              <button
                onClick={() => {
                  if (isPlaylistMode) setIsPlaylistMode(false);
                  setActiveTab(activeTab === TabView.PLAYER ? TabView.EDITOR : TabView.PLAYER);
                }}
                className={`p-2 rounded-full transition-colors ${activeTab === TabView.EDITOR && !isPlaylistMode ? 'bg-amber-500 text-black' : 'bg-black/30 text-zinc-300 hover:bg-white/10'}`}
                title={tr('Toggle Timeline (T)')}
              >
                <Film size={20} />
              </button>
              <button
                onMouseDown={(e) => {
                  e.stopPropagation();
                  setShowRenderSettings(!showRenderSettings);
                }}
                className={`p-2 rounded-full transition-colors ${showRenderSettings ? 'bg-amber-500 text-black' : 'bg-black/30 text-zinc-300 hover:bg-white/10'}`}
                title={tr('Render Settings (D)')}
              >
                <Settings size={20} />
              </button>
              <button
                onMouseDown={(e) => {
                  e.stopPropagation();
                  setShowShortcutInfo(!showShortcutInfo);
                }}
                className={`p-2 rounded-full transition-colors ${showShortcutInfo ? 'bg-amber-500 text-black' : 'bg-black/30 text-zinc-300 hover:bg-white/10'}`}
                title={tr('Keyboard Shortcuts (Y)')}
              >
                <Keyboard size={20} />
              </button>
              <button
                onClick={toggleFullscreen}
                className="p-2 rounded-full bg-black/30 text-zinc-300 hover:bg-white/10 transition-colors"
                title={tr('Fullscreen (F)')}
              >
                {isFullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
              </button>
            </div>
          </div>
        </div>

        {/* Center Stage: Lyrics */}
        {/* min-h-0 必须保留：播客/视频字幕动辄几百行，若不限制 flex 项的最小高度，
            字幕区会撑破容器并把底部控制条挤出视口。 */}
        <div
          className={`flex-1 min-h-0 flex justify-center overflow-hidden relative ${renderConfig.contentPosition === 'top' ? 'items-start' : renderConfig.contentPosition === 'bottom' ? 'items-end' : 'items-center'}`}
          style={{
            paddingTop: renderConfig.contentPosition === 'top' ? `${(renderConfig.marginTopScale ?? 1.0) * 10}vh` : undefined,
            paddingBottom: renderConfig.contentPosition === 'bottom' ? `${(renderConfig.marginBottomScale ?? 1.0) * 10}vh` : undefined,
          }}
        >
          {lyrics.length > 0 ? (
            <div
              ref={lyricsContainerRef}
              className={`w-full max-w-5xl max-h-full overflow-y-auto no-scrollbar px-4 md:px-6 space-y-4 md:space-y-6 transition-all duration-500 lyrics-root ${renderConfig.textAlign === 'left' ? 'text-left' : renderConfig.textAlign === 'right' ? 'text-right' : 'text-center'
                } ${!renderConfig.showLyrics || autoHideLyricsPreview ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
              style={{
                maskImage: (isHeaderVisible || isFooterVisible) && preset !== 'subtitle'
                  ? 'linear-gradient(to bottom, transparent, black 10%, black 90%, transparent)'
                  : 'none',
                // @ts-ignore
                '--fs-scale': renderConfig.fontSizeScale || 1,
                '--l-height': renderConfig.lyricLineHeight || 1.2
              }}
            >
              <div className={`transition-all duration-500 ${renderConfig.contentPosition === 'center' ? ((activeTab === TabView.EDITOR || isPlaylistMode) ? 'h-[25vh]' : (!isHeaderVisible && !isFooterVisible) ? 'h-[50vh]' : 'h-[40vh]') : 'h-0'}`}></div>
              {['static-compact', 'static-compact-comma', 'static-compact-clean'].includes(renderConfig.lyricDisplayMode) ? (
                (() => {
                  const mode = renderConfig.lyricDisplayMode;
                  let previewText = '';

                  // Group lyrics into paragraphs based on empty lines (verse breaks)
                  const paragraphs: string[][] = [];
                  let currentPara: string[] = [];
                  for (let li = 0; li < adjustedLyrics.length; li++) {
                    const lineText = adjustedLyrics[li].text.trim();
                    if (lineText === '') {
                      if (currentPara.length > 0) {
                        paragraphs.push(currentPara);
                        currentPara = [];
                      }
                    } else {
                      currentPara.push(lineText);
                    }
                  }
                  if (currentPara.length > 0) {
                    paragraphs.push(currentPara);
                  }

                  // Casing helper
                  const casing = renderConfig?.textCase || 'none';
                  const applyCasing = (txt: string) => {
                    if (!txt) return txt;
                    if (casing === 'upper') return txt.toUpperCase();
                    if (casing === 'lower') return txt.toLowerCase();
                    if (casing === 'title') return txt.replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.substr(1).toLowerCase());
                    if (casing === 'sentence') {
                      const lower = txt.toLowerCase();
                      return lower.charAt(0).toUpperCase() + lower.slice(1);
                    }
                    if (casing === 'invert') return txt.replace(/\w\S*/g, (t) => t.charAt(0).toLowerCase() + t.slice(1).toUpperCase());
                    return txt;
                  };

                  if (mode === 'static-compact') {
                    const casedParas = paragraphs.map(p => applyCasing(p.join(' / ')));
                    previewText = casedParas.join(' // ');
                  } else if (mode === 'static-compact-comma') {
                    const casedParas = paragraphs.map(p => applyCasing(p.join(', ')) + '.');
                    previewText = casedParas.join('\n');
                  } else {
                    const casedParas = paragraphs.map(p => applyCasing(p.join(' ')) + '.');
                    previewText = casedParas.join('\n');
                  }

                  return (
                    <div 
                      className="w-full text-white opacity-90 text-center select-none whitespace-pre-wrap leading-relaxed px-4 md:px-8"
                      style={{
                        fontSize: `calc(1.35rem * var(--fs-scale))`,
                        fontFamily: (renderConfig.fontFamily === 'CustomFont') ? 'CustomFont, sans-serif' : renderConfig.fontFamily,
                        fontWeight: renderConfig.fontWeight || 'bold',
                        fontStyle: renderConfig.fontStyle || 'normal',
                        textAlign: renderConfig.textAlign || 'center',
                      }}
                    >
                      {previewText}
                    </div>
                  );
                })()
              ) : (
                adjustedLyrics.map((line, idx) => {
                  const isActive = renderConfig.lyricDisplayMode === 'static-all'
                    ? false
                    : idx === (displayLyricIndex >= 0 ? displayLyricIndex : currentLyricIndex);
                  const isEditor = activeTab === TabView.EDITOR || isPlaylistMode;
                  const isPortraitPreview = ['9:16', '3:4', '1:1', '1:2', '2:3'].includes(aspectRatio);

                  const isBigLayout = ['large', 'large_upper', 'big_center', 'metal', 'kids', 'sad', 'romantic', 'tech', 'gothic', 'testing', 'testing_up', 'one_line', 'one_line_up', 'custom'].includes(preset);

                  // --- Render Config Display Mode Filter ---
                  if (renderConfig.lyricDisplayMode !== 'all') {
                    if (displayLyricIndex === -1 && ['active-only', 'next-only', 'previous-next'].includes(renderConfig.lyricDisplayMode)) {
                      return <p key={idx} className="hidden" />;
                    }
                    if (renderConfig.lyricDisplayMode === 'static-all' && line.text.trim() === '') return <p key={idx} className="hidden" />;
                    if (!isLyricLineVisible(idx)) return <p key={idx} className="hidden" />;
                  } else {
                  // Fallback to Preset Defaults
                  // If mode is 'all', we generally want to show everything.
                  // BUT we still respect 'none' or 'just_video' as "no lyric" presets generally, 
                  // though showLyrics toggle handles visibility. 
                  if (preset === 'none' || preset === 'just_video') return <p key={idx} className="hidden" />;

                  // Previously we restricted isBigLayout to +/- 1 line. 
                  // User requested "Show All" to actually show all lines.
                  // So we removed the lines that returned 'hidden' for isBigLayout, one_line, etc.
                }

                // --- Dynamic Styling based on Preset ---
                let activeClass = '';
                let inactiveClass = '';
                // [FIX] Use specific transitions instead of transition-all to prevent font-size/height animation
                // animating dimensions causes layout shifts during scroll calculation, leading to "jumps".
                // We exclude font-size, line-height, margin, padding, width, height.
                const transEffect = renderConfig.transitionEffect;
                let containerClass = 'transition-[color,background-color,border-color,text-decoration-color,fill,stroke,opacity,box-shadow,transform,filter,backdrop-filter,text-shadow] duration-500 cursor-pointer whitespace-pre-wrap break-words ';

                // Handle Transitions
                if (isActive) {
                  // Active State
                  if (transEffect === 'slide') containerClass += 'translate-y-0 opacity-100 ';
                  else if (transEffect === 'zoom') containerClass += 'scale-100 opacity-100 ';
                  else if (transEffect === 'float') containerClass += 'translate-y-0 opacity-100 ';
                  else if (transEffect === 'blur') containerClass += 'blur-0 opacity-100 ';
                  else if (transEffect === 'fade') containerClass += 'opacity-100 ';
                  else if (transEffect === 'drop') containerClass += 'trans-drop-enter opacity-100 ';
                  else if (transEffect === 'lightspeed') containerClass += 'trans-lightspeed-enter opacity-100 ';
                  else if (transEffect === 'roll') containerClass += 'trans-roll-enter opacity-100 ';
                  else if (transEffect === 'elastic') containerClass += 'trans-elastic-enter opacity-100 ';
                  else if (transEffect === 'flip') containerClass += 'trans-flip-enter opacity-100 ';
                  else if (transEffect === 'rotate-in') containerClass += 'trans-rotate-in-enter opacity-100 ';
                  else if (transEffect === 'spiral') containerClass += 'trans-spiral-enter opacity-100 ';
                  else if (transEffect === 'shatter') containerClass += 'trans-shatter-enter opacity-100 ';
                  else containerClass += 'opacity-100 ';
                } else {
                  // Inactive State
                  if (transEffect === 'slide') containerClass += 'translate-y-4 opacity-0 ';
                  else if (transEffect === 'zoom') containerClass += 'scale-75 opacity-0 ';
                  else if (transEffect === 'float') containerClass += 'translate-y-8 opacity-0 ';
                  else if (transEffect === 'blur') containerClass += 'blur-md opacity-0 ';
                  else if (transEffect === 'fade') containerClass += 'opacity-50 ';
                  else if (transEffect === 'drop') containerClass += 'trans-drop-exit opacity-0 ';
                  else if (transEffect === 'roll') containerClass += 'trans-roll-exit opacity-0 ';
                  else containerClass += 'opacity-0 '; // Default hide for other effects when not active

                  if (transEffect === 'none') containerClass = containerClass.replace('opacity-0', 'opacity-50');
                }

                if (preset === 'large' || preset === 'large_upper') {
                  // Large: Left aligned, huge text, bold
                  // Render Logic Equiv: Portrait=90, Landscape=120. (Approx 25% diff)

                  // Let's us 6xl(3.75) vs 8xl(6)
                  const portraitActive = isEditor ? 'text-4xl' : 'text-6xl';
                  const landscapeActive = isEditor ? 'text-6xl' : 'text-8xl';
                  const activeSize = isPortraitPreview ? portraitActive : landscapeActive;

                  const inactiveSize = isPortraitPreview
                    ? (isEditor ? 'text-xl' : 'text-2xl')
                    : (isEditor ? 'text-2xl' : 'text-3xl');
                  activeClass = `${activeSize} font-black text-white ${preset === 'large_upper' ? 'uppercase' : ''} tracking-tight text-left pl-4`;
                  inactiveClass = `${inactiveSize} text-zinc-600/40 hover:text-zinc-400 text-left pl-4`;
                } else if (preset === 'big_center') {
                  const activeSize = isPortraitPreview
                    ? (isEditor ? 'text-4xl' : 'text-5xl')
                    : (isEditor ? 'text-6xl' : 'text-8xl');
                  const inactiveSize = isPortraitPreview
                    ? (isEditor ? 'text-xl' : 'text-2xl')
                    : (isEditor ? 'text-2xl' : 'text-3xl');
                  activeClass = `${activeSize} font-black text-white uppercase tracking-tight text-center`;
                  inactiveClass = `${inactiveSize} text-zinc-600/40 hover:text-zinc-400 text-center`;
                } else if (preset === 'testing_up') {
                  const activeSize = isPortraitPreview
                    ? (isEditor ? 'text-4xl' : 'text-5xl')
                    : (isEditor ? 'text-6xl' : 'text-8xl');
                  const inactiveSize = isPortraitPreview
                    ? (isEditor ? 'text-xl' : 'text-2xl')
                    : (isEditor ? 'text-2xl' : 'text-3xl');
                  activeClass = `${activeSize} text-white uppercase tracking-tight text-center`;
                  inactiveClass = `${inactiveSize} text-zinc-600/40 hover:text-zinc-400 text-center`;
                } else if (preset === 'testing') {
                  const activeSize = isPortraitPreview
                    ? (isEditor ? 'text-4xl' : 'text-5xl')
                    : (isEditor ? 'text-6xl' : 'text-8xl');
                  const inactiveSize = isPortraitPreview
                    ? (isEditor ? 'text-xl' : 'text-2xl')
                    : (isEditor ? 'text-2xl' : 'text-3xl');
                  activeClass = `${activeSize} text-white tracking-tight text-center`;
                  inactiveClass = `${inactiveSize} text-zinc-600/40 hover:text-zinc-400 text-center`;
                } else if (preset === 'one_line_up') {
                  const activeSize = isPortraitPreview
                    ? (isEditor ? 'text-4xl' : 'text-5xl')
                    : (isEditor ? 'text-6xl' : 'text-8xl');
                  const inactiveSize = isPortraitPreview
                    ? (isEditor ? 'text-xl' : 'text-2xl')
                    : (isEditor ? 'text-2xl' : 'text-3xl');
                  activeClass = `${activeSize} text-white uppercase tracking-tight text-center`;
                  inactiveClass = `${inactiveSize} text-zinc-600/40 hover:text-zinc-400 text-center`;
                } else if (preset === 'one_line') {
                  const activeSize = isPortraitPreview
                    ? (isEditor ? 'text-4xl' : 'text-5xl')
                    : (isEditor ? 'text-6xl' : 'text-8xl');
                  const inactiveSize = isPortraitPreview
                    ? (isEditor ? 'text-xl' : 'text-2xl')
                    : (isEditor ? 'text-2xl' : 'text-3xl');
                  activeClass = `${activeSize} text-white tracking-tight text-center`;
                  inactiveClass = `${inactiveSize} text-zinc-600/40 hover:text-zinc-400 text-center`;
                } else if (preset === 'metal') {
                  const activeSize = isPortraitPreview
                    ? (isEditor ? 'text-4xl' : 'text-5xl')
                    : (isEditor ? 'text-6xl' : 'text-8xl');
                  const inactiveSize = isPortraitPreview
                    ? (isEditor ? 'text-xl' : 'text-2xl')
                    : (isEditor ? 'text-2xl' : 'text-3xl');
                  activeClass = `${activeSize} text-white uppercase tracking-wide text-center drop-shadow-[0_4px_6px_rgba(255,0,0,0.5)]`;
                  inactiveClass = `${inactiveSize} text-zinc-600/60 hover:text-zinc-400 text-center`;
                } else if (preset === 'kids') {
                  const activeSize = isPortraitPreview
                    ? (isEditor ? 'text-4xl' : 'text-5xl')
                    : (isEditor ? 'text-6xl' : 'text-8xl');
                  const inactiveSize = isPortraitPreview
                    ? (isEditor ? 'text-xl' : 'text-2xl')
                    : (isEditor ? 'text-2xl' : 'text-3xl');
                  activeClass = `${activeSize} text-white tracking-wide text-center drop-shadow-[3px_3px_0px_rgba(0,0,0,0.5)]`;
                  inactiveClass = `${inactiveSize} text-zinc-600/60 hover:text-zinc-400 text-center`;
                } else if (preset === 'sad') {
                  const activeSize = isPortraitPreview
                    ? (isEditor ? 'text-4xl' : 'text-5xl') // 48px / 60px
                    : (isEditor ? 'text-6xl' : 'text-7xl'); // 60px / 72px (Render 75px)
                  const inactiveSize = isPortraitPreview
                    ? (isEditor ? 'text-lg' : 'text-xl')
                    : (isEditor ? 'text-xl' : 'text-2xl');
                  activeClass = `${activeSize} text-zinc-200 tracking-wider text-center drop-shadow-md`;
                  inactiveClass = `${inactiveSize} text-zinc-600/60 hover:text-zinc-400 text-center`;
                } else if (preset === 'romantic') {
                  const activeSize = isPortraitPreview
                    ? (isEditor ? 'text-4xl' : 'text-5xl')
                    : (isEditor ? 'text-6xl' : 'text-7xl');
                  const inactiveSize = isPortraitPreview
                    ? (isEditor ? 'text-lg' : 'text-xl')
                    : (isEditor ? 'text-xl' : 'text-2xl');
                  activeClass = `${activeSize} text-pink-100 italic tracking-wide text-center drop-shadow-[0_0_10px_rgba(236,72,153,0.5)]`;
                  inactiveClass = `${inactiveSize} text-zinc-600/60 hover:text-zinc-400 text-center italic`;
                } else if (preset === 'tech') {
                  const activeSize = isPortraitPreview
                    ? (isEditor ? 'text-4xl' : 'text-5xl')
                    : (isEditor ? 'text-6xl' : 'text-8xl');
                  const inactiveSize = isPortraitPreview
                    ? (isEditor ? 'text-xl' : 'text-2xl')
                    : (isEditor ? 'text-2xl' : 'text-3xl');
                  activeClass = `${activeSize} text-cyan-50 font-bold uppercase tracking-widest text-center drop-shadow-[0_0_10px_rgba(34,211,238,0.8)]`;
                  inactiveClass = `${inactiveSize} text-cyan-900/40 hover:text-cyan-800 text-center uppercase`;
                } else if (preset === 'gothic') {
                  const activeSize = isPortraitPreview
                    ? (isEditor ? 'text-4xl' : 'text-5xl')
                    : (isEditor ? 'text-6xl' : 'text-7xl');
                  const inactiveSize = isPortraitPreview
                    ? (isEditor ? 'text-xl' : 'text-2xl')
                    : (isEditor ? 'text-2xl' : 'text-3xl');
                  activeClass = `${activeSize} text-zinc-300 tracking-normal text-center drop-shadow-[0_4px_10px_rgba(0,0,0,0.9)]`;
                  inactiveClass = `${inactiveSize} text-zinc-700/60 hover:text-zinc-500 text-center`;
                } else if (preset === 'monospace') {
                  const activeSize = isPortraitPreview
                    ? (isEditor ? 'text-2xl' : 'text-3xl')
                    : (isEditor ? 'text-3xl' : 'text-5xl');
                  const inactiveSize = isPortraitPreview
                    ? (isEditor ? 'text-lg' : 'text-xl')
                    : (isEditor ? 'text-xl' : 'text-2xl');
                  activeClass = `${activeSize} font-mono font-bold text-white scale-105 drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]`;
                  inactiveClass = `${inactiveSize} font-mono text-zinc-500/60 hover:text-zinc-300 drop-shadow-sm`;
                } else if (preset === 'classic') {
                  // Classic: Serif, Italic
                  // Render: Portrait=55, Landscape=65
                  const activeSize = isPortraitPreview
                    ? (isEditor ? 'text-2xl' : 'text-3xl') // 30 / 36
                    : (isEditor ? 'text-3xl' : 'text-6xl'); // 36 / 60
                  const inactiveSize = isPortraitPreview
                    ? (isEditor ? 'text-lg' : 'text-xl')
                    : (isEditor ? 'text-xl' : 'text-2xl');
                  activeClass = `${activeSize} font-serif italic font-bold text-amber-100 drop-shadow-[0_4px_8px_rgba(0,0,0,0.9)]`;
                  inactiveClass = `${inactiveSize} font-serif text-zinc-500/60 hover:text-zinc-300 italic`;
                } else if (preset === 'slideshow' || preset === 'just_video') {
                  // Slideshow: Small, centered
                  const activeSize = isPortraitPreview
                    ? (isEditor ? 'text-2xl' : 'text-3xl')
                    : (isEditor ? 'text-3xl' : 'text-4xl');
                  activeClass = `${activeSize} text-white tracking-wide text-center`;
                  inactiveClass = 'hidden';
                } else if (preset === 'subtitle') {
                  // Subtitle: Small, bottom-center (adjusts based on visible panels)
                  const activeSize = isPortraitPreview
                    ? (isEditor ? 'text-2xl' : 'text-3xl')
                    : (isEditor ? 'text-3xl' : 'text-4xl');
                  activeClass = `${activeSize} text-white tracking-wide text-center whitespace-pre-wrap`;
                  inactiveClass = 'hidden';

                  // Position bumping to avoid footer overlap
                  let bottomClass = 'bottom-16'; // Minimal mode (approx 64px)
                  if (isEditor && isFooterVisible) {
                    bottomClass = 'bottom-[560px]'; // Editor + Footer
                  } else if (isEditor) {
                    bottomClass = 'bottom-[360px]'; // Editor only
                  } else if (isFooterVisible) {
                    bottomClass = 'bottom-[280px]'; // Footer only (approx 280px to clear max-h-60 footer)
                  }

                  // Clean up conflicting classes (remove absolute/transform if we want reliable fixed behavior)
                  containerClass = containerClass.replace('absolute', '').replace('transform', '');
                  containerClass += `fixed ${bottomClass} left-1/2 -translate-x-1/2 w-full px-8 z-[100] pointer-events-none `;
                } else if (preset === 'custom') {
                  const activeSize = isPortraitPreview
                    ? (isEditor ? 'text-4xl' : 'text-5xl')
                    : (isEditor ? 'text-6xl' : 'text-8xl');
                  const inactiveSize = isPortraitPreview
                    ? (isEditor ? 'text-xl' : 'text-2xl')
                    : (isEditor ? 'text-2xl' : 'text-3xl');

                  const alignClass = renderConfig.textAlign === 'center' ? 'text-center' : renderConfig.textAlign === 'right' ? 'text-right' : 'text-left';

                  activeClass = `${activeSize} tracking-tight ${alignClass}`;
                  inactiveClass = `${inactiveSize} opacity-40 hover:opacity-100 ${alignClass}`;

                  // We'll apply color and effects via inline style for 'custom'
                } else {
                  // Default
                  const activeSize = isPortraitPreview
                    ? (isEditor ? 'text-2xl' : 'text-3xl') //
                    : (isEditor ? 'text-3xl' : 'text-5xl');
                  const inactiveSize = isPortraitPreview
                    ? (isEditor ? 'text-lg' : 'text-xl')
                    : (isEditor ? 'text-xl' : 'text-2xl');
                  activeClass = `${activeSize} font-bold text-white scale-105 drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]`;
                }

                if (renderConfig.lyricDisplayMode === 'static-all') {
                  const size = isPortraitPreview
                    ? (isEditor ? 'text-base' : 'text-lg')
                    : (isEditor ? 'text-lg' : 'text-xl');
                  const alignClass = renderConfig.textAlign === 'center' ? 'text-center' : renderConfig.textAlign === 'right' ? 'text-right' : 'text-left';
                  inactiveClass = `${size} font-semibold text-white/90 drop-shadow-sm ${alignClass}`;
                }

                // Dynamic Styles for Custom Preset options
                // Dynamic Styles for Custom Preset options
                const targetStyleMode = renderConfig.lyricStyleTarget || 'active-only';
                const useCustomStyle = (targetStyleMode === 'all' || isActive); // Allow customization for all presets

                let textEffectStyles: React.CSSProperties = {
                  color: renderConfig.fontColor,
                  fontWeight: useCustomStyle ? renderConfig.fontWeight : undefined,
                  fontStyle: useCustomStyle ? renderConfig.fontStyle : undefined,
                  textDecoration: useCustomStyle ? renderConfig.textDecoration : undefined,
                  fontFamily: (renderConfig.fontFamily === 'CustomFont') ? 'CustomFont, sans-serif' : renderConfig.fontFamily
                };

                // Advanced Text Effects
                if ((preset === 'custom' || preset === 'default') && isActive && renderConfig.textEffect !== 'none') {
                  const textEf = renderConfig.textEffect;

                  if (textEf === 'glow') textEffectStyles.textShadow = `0 0 10px ${renderConfig.fontColor}, 0 0 20px ${renderConfig.fontColor}`;
                  else if (textEf === 'neon') textEffectStyles.textShadow = `0 0 5px #fff, 0 0 10px #fff, 0 0 20px ${renderConfig.fontColor}, 0 0 40px ${renderConfig.fontColor}, 0 0 80px ${renderConfig.fontColor}`;
                  else if (textEf === 'neon-multi') textEffectStyles.textShadow = `0 0 5px #fff, 0 0 10px #fff, 0 0 20px #ff00de, 0 0 35px #00ffff, 0 0 40px #ff00de, 0 0 50px #00ffff`;
                  else if (textEf === 'shadow') textEffectStyles.textShadow = '3px 3px 6px rgba(0,0,0,0.7)';
                  else if (textEf === 'outline') textEffectStyles.textShadow = '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000';
                  else if (textEf === '3d') textEffectStyles.textShadow = '1px 1px 0px #ccc, 2px 2px 0px #bbb, 3px 3px 0px #aaa, 4px 4px 0px rgba(0,0,0,0.5)';
                  else if (textEf === 'emboss') { textEffectStyles.color = '#ebebeb'; textEffectStyles.textShadow = '1px 2px 3px rgba(255,255,255,0.8), -1px -2px 3px rgba(0,0,0,0.8)'; }
                  else if (textEf === 'gold') {
                    textEffectStyles.background = 'linear-gradient(to bottom, #d4af37, #C5A028)';
                    (textEffectStyles as any).WebkitBackgroundClip = 'text';
                    textEffectStyles.color = 'transparent';
                  }
                  else if (textEf === 'chrome') {
                    textEffectStyles.background = 'linear-gradient(to bottom, #ebebeb 50%, #616161 50%, #ebebeb)';
                    (textEffectStyles as any).WebkitBackgroundClip = 'text';
                    textEffectStyles.color = 'transparent';
                  }
                  else if (textEf === 'fire') {
                    textEffectStyles.color = '#fff';
                    textEffectStyles.textShadow = '0 -5px 4px #FFC107, 2px -10px 6px #FF9800, -2px -15px 11px #FF5722, 2px -25px 18px #795548';
                  }
                  else if (textEf === 'frozen') {
                    textEffectStyles.color = '#fff';
                    textEffectStyles.textShadow = '0 0 5px rgba(255,255,255,0.8), 0 0 10px rgba(255,255,255,0.5), 0 0 20px #03A9F4, 0 0 30px #03A9F4, 0 0 40px #03A9F4';
                  }
                  else if (textEf === 'vhs') {
                    textEffectStyles.textShadow = '2px 0 0 rgba(255,0,0,0.7), -2px 0 0 rgba(0,0,255,0.7)';
                  }
                  else if (textEf === 'gradient') {
                    textEffectStyles.background = `linear-gradient(to right, ${renderConfig.fontColor}, #ffffff)`;
                    (textEffectStyles as any).WebkitBackgroundClip = 'text';
                    textEffectStyles.color = 'transparent';
                  }
                  else if (textEf === 'rainbow') {
                    textEffectStyles.background = 'linear-gradient(to left, violet, indigo, blue, green, yellow, orange, red)';
                    (textEffectStyles as any).WebkitBackgroundClip = 'text';
                    textEffectStyles.color = 'transparent';
                  }
                  else if (textEf === 'glass') {
                    textEffectStyles.backgroundColor = 'rgba(255, 255, 255, 0.1)';
                    textEffectStyles.backdropFilter = 'blur(8px)';
                    textEffectStyles.padding = '0.5rem 1rem';
                    textEffectStyles.borderRadius = '0.75rem';
                    textEffectStyles.border = '1px solid rgba(255, 255, 255, 0.2)';
                    textEffectStyles.display = 'inline-block';
                  }
                  else if (textEf === 'mirror') {
                    textEffectStyles.transform = 'scaleY(1.3) perspective(500px) rotateX(-10deg)';
                    textEffectStyles.textShadow = '0 15px 5px rgba(0,0,0,0.1), 0 -1px 3px rgba(0,0,0,0.3)';
                  }
                  else if (textEf === 'retro') {
                    textEffectStyles.fontFamily = "'Press Start 2P', cursive";
                    textEffectStyles.color = '#ff00ff';
                    textEffectStyles.textShadow = '4px 4px 0px #00ffff';
                  }
                  else if (textEf === 'cyberpunk') {
                    textEffectStyles.color = '#fcee0a';
                    textEffectStyles.textShadow = '2px 2px 0px #000, -1px -1px 0 #05d9e8';
                    textEffectStyles.fontFamily = "'Orbitron', sans-serif";
                    textEffectStyles.letterSpacing = '1px';
                  }
                  else if (textEf === 'glitch-text') {
                    textEffectStyles.animation = 'anim-glitch 0.4s infinite linear';
                    textEffectStyles.position = 'relative';
                  }
                  else if (textEf === 'hologram') {
                    textEffectStyles.color = 'rgba(0, 255, 255, 0.7)';
                    textEffectStyles.textShadow = '0 0 5px rgba(0,255,255,0.5), 0 0 10px rgba(0,255,255,0.5)';
                    textEffectStyles.backgroundImage = 'repeating-linear-gradient(0deg, transparent, transparent 2px, #00ffff 3px)';
                    (textEffectStyles as any).WebkitBackgroundClip = 'text';
                  }
                  else if (textEf === 'comic') {
                    textEffectStyles.fontFamily = "'Bangers', cursive";
                    textEffectStyles.color = '#ffcc00';
                    textEffectStyles.textShadow = '2px 2px 0px #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000';
                    textEffectStyles.letterSpacing = '1px';
                  }
                }

                // Calculate text content with casing logic
                let textContent = line.text;
                const casing = renderConfig.textCase;

                if (casing === 'upper') {
                  textContent = textContent.toUpperCase();
                } else if (casing === 'lower') {
                  textContent = textContent.toLowerCase();
                } else if (casing === 'title') {
                  textContent = textContent.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
                } else if (casing === 'sentence') {
                  textContent = textContent.charAt(0).toUpperCase() + textContent.slice(1).toLowerCase();
                } else if (casing === 'invert') {
                  textContent = textContent.replace(/\w\S*/g, (txt) => txt.charAt(0).toLowerCase() + txt.slice(1).toUpperCase());
                }

                // Fix spacing around hyphens for display (e.g. "Eh- eh" -> "Eh-eh")
                textContent = textContent.replace(/\s*([-‐‑‒–—―])\s*/g, '$1');

                // Apply Typewriter effect if active
                if (isActive && renderConfig.textAnimation === 'typewriter') {
                  textContent = textContent.substring(0, Math.max(0, Math.floor((currentTime - line.time) * 35)));
                }

                // --- Highlight Effect Logic ---
                // If we have word-level data and exact highlight effect (e.g. Karaoke)
                // We render words individually.
                let contentRender: React.ReactNode = textContent;

                if (isActive && renderConfig.highlightEffect !== 'none') {
                  const hEffect = renderConfig.highlightEffect;
                  const hasWords = line.words && line.words.length > 0;

                  if ((hEffect === 'karaoke' || hEffect?.startsWith('karaoke-')) && hasWords) {
                    // Word-level Karaoke with variants
                    contentRender = line.words!
                      .filter(w => w.text === '\n' || w.text.trim().length > 0)
                      .map((w, wIdx, arr) => {
                        if (w.text === '\n') return <br key={wIdx} />;

                        // Apply Casing to individual words
                        let wText = w.text.trim();
                        if (casing === 'upper') wText = wText.toUpperCase();
                        else if (casing === 'lower') wText = wText.toLowerCase();
                        else if (casing === 'title') wText = wText.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
                        else if (casing === 'sentence') {
                          const lower = wText.toLowerCase();
                          wText = (wIdx === 0) ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
                        }
                        else if (casing === 'invert') wText = wText.replace(/\w\S*/g, (txt) => txt.charAt(0).toLowerCase() + txt.slice(1).toUpperCase());

                        const wStart = w.startTime + lyricOffset;
                        const wEnd = w.endTime + lyricOffset;
                        const isWordActive = currentTime >= wStart && currentTime < wEnd;
                        const isWordPast = currentTime >= wEnd;

                        const hyphenEndRegex = /[-‐‑‒–—―]$/;
                        const hyphenStartRegex = /^[-‐‑‒–—―]/;

                        let shouldAddSpace = !wText.endsWith(' ');

                        // If current word ends with hyphen, no space.
                        if (hyphenEndRegex.test(wText.trim())) shouldAddSpace = false;

                        // If next word starts with hyphen, no space.
                        const nextW = arr[wIdx + 1];
                        if (nextW && hyphenStartRegex.test(nextW.text.trim())) shouldAddSpace = false;
                        if (nextW && nextW.text === '\n') shouldAddSpace = false;

                        // Last word of array check
                        if (wIdx === arr.length - 1) shouldAddSpace = false;

                        // Use inline-block but NO margin. We insert spaces manually.
                        let wordStyle: React.CSSProperties = { display: 'inline-block' }; // Base style (removed transition for performance)

                        // Apply Global Decoration
                        if (renderConfig.textDecoration && renderConfig.textDecoration !== 'none') {
                          wordStyle.textDecoration = renderConfig.textDecoration;
                        }

                        // Inactive/Future state defaults
                        if (!isWordActive && !isWordPast) {
                          if (hEffect === 'karaoke-smooth-white') {
                            wordStyle.opacity = 1;
                            wordStyle.color = '#ffffff';
                          } else {
                            wordStyle.opacity = 0.5;
                          }
                          wordStyle.transform = 'scale(1)';
                          // Inherit color from preset (parent <p>)
                        } else if (isWordPast) {
                          if (hEffect === 'karaoke-fill') {
                            const hBg = renderConfig.highlightBackground || '#fb923c';
                            wordStyle.backgroundColor = hBg;
                            wordStyle.color = '#000';
                            wordStyle.padding = '2px 6px';
                            wordStyle.borderRadius = '4px';
                            wordStyle.opacity = 1;
                          } else if (hEffect === 'karaoke-smooth' || hEffect === 'karaoke-smooth-white') {
                            wordStyle.color = renderConfig.highlightColor || '#fb923c';
                            wordStyle.opacity = 1;
                          } else {
                            // Standard Karaoke:
                            // User Request: Only highlight CURRENT word for presets (non-custom).
                            // Custom can keep behavior or follow suit.
                            // If NOT Custom, past words should be normal color (un-highlighted).

                            if (preset === 'custom') {
                              wordStyle.color = renderConfig.fontColor;
                            }

                            // wordStyle.color = ... (Remove this to inherit)
                            wordStyle.opacity = 1;
                          }
                        }

                        // Active State Per Effect

                        // Active State Per Effect
                        if (isWordActive) {
                          const hColor = renderConfig.highlightColor || '#fb923c';
                          const hBg = renderConfig.highlightBackground || '#fb923c';

                          if (hEffect === 'karaoke-smooth' || hEffect === 'karaoke-smooth-white') {
                            const duration = w.endTime - w.startTime;
                            const elapsed = currentTime - wStart;
                            const progress = Math.min(100, Math.max(0, (elapsed / duration) * 100));

                            const targetColor = hEffect === 'karaoke-smooth-white' ? '#ffffff' : (renderConfig.fontColor || '#ffffff');
                            wordStyle.backgroundImage = `linear-gradient(90deg, ${hColor} ${progress}%, ${targetColor} ${progress}%)`;
                            wordStyle.backgroundClip = 'text';
                            wordStyle.WebkitBackgroundClip = 'text';
                            wordStyle.color = 'transparent';
                            wordStyle.WebkitTextFillColor = 'transparent';
                            wordStyle.textShadow = 'none';
                          } else if (hEffect === 'karaoke' || hEffect === 'color') {
                            wordStyle.color = hColor;
                            wordStyle.textShadow = `0 0 10px ${hColor}`;
                          } else if (hEffect === 'karaoke-neon') {
                            wordStyle.color = '#fff';
                            wordStyle.textShadow = `0 0 5px #fff, 0 0 10px #fff, 0 0 20px ${hColor}, 0 0 35px ${hColor}`;
                          } else if (hEffect === 'karaoke-scale') {
                            wordStyle.color = hColor;
                            wordStyle.transform = 'scale(1.3)';
                          } else if (hEffect === 'karaoke-underline') {
                            wordStyle.color = hColor;
                            wordStyle.textDecoration = (wordStyle.textDecoration || '') + ' underline';
                            wordStyle.textDecorationColor = hColor;
                            wordStyle.textUnderlineOffset = '4px';
                          } else if (hEffect === 'karaoke-bounce') {
                            wordStyle.color = hColor;
                            wordStyle.transform = 'translateY(-10px)';
                          } else if (hEffect === 'karaoke-fill') {
                            wordStyle.backgroundColor = hBg;
                            wordStyle.color = '#000';
                            wordStyle.padding = '2px 6px';
                            wordStyle.borderRadius = '4px';
                          } else if (hEffect === 'karaoke-outline') {
                            wordStyle.color = 'transparent';
                            wordStyle.WebkitTextStroke = `2px ${hColor}`;
                          } else if (hEffect === 'karaoke-shadow') {
                            wordStyle.color = hColor;
                            wordStyle.textShadow = '3px 3px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000';
                          } else if (hEffect === 'karaoke-gradient') {
                            wordStyle.background = `linear-gradient(90deg, ${hColor}, ${hBg})`;
                            wordStyle.WebkitBackgroundClip = 'text';
                            wordStyle.WebkitTextFillColor = 'transparent';
                          } else if (hEffect === 'karaoke-wave') {
                            wordStyle.color = hColor;
                            wordStyle.animation = 'bounce 0.3s ease infinite';
                          } else if (hEffect === 'karaoke-pill') {
                            wordStyle.backgroundColor = hBg;
                            wordStyle.color = '#000';
                            wordStyle.padding = '4px 16px';
                            wordStyle.borderRadius = '9999px';
                          } else if (hEffect === 'karaoke-box') {
                            wordStyle.backgroundColor = hBg;
                            wordStyle.color = '#000';
                            wordStyle.padding = '4px 8px';
                            wordStyle.borderRadius = '0';
                          } else if (hEffect === 'karaoke-rounded') {
                            wordStyle.backgroundColor = hBg;
                            wordStyle.color = '#000';
                            wordStyle.padding = '4px 12px';
                            wordStyle.padding = '4px 12px';
                            wordStyle.borderRadius = '12px';
                          } else if (hEffect === 'karaoke-glass') {
                            // Glass Effect
                            wordStyle.backgroundColor = 'rgba(255, 255, 255, 0.1)';
                            wordStyle.color = '#fff';
                            wordStyle.padding = '4px 12px';
                            wordStyle.borderRadius = '8px';
                            wordStyle.backdropFilter = 'blur(4px)';
                            wordStyle.border = '1px solid rgba(255, 255, 255, 0.3)';
                            wordStyle.boxShadow = '0 4px 6px rgba(0, 0, 0, 0.1)';
                          } else if (hEffect === 'karaoke-neon-multi') {
                            wordStyle.color = '#fff';
                            wordStyle.textShadow = '0 0 5px #fff, 0 0 10px #fff, 0 0 20px #ff00de, 0 0 35px #00ffff, 0 0 40px #ff00de';
                          } else if (hEffect === 'karaoke-soft-glow') {
                            wordStyle.color = hColor;
                            wordStyle.textShadow = `0 0 5px ${hColor}, 0 0 15px ${hColor}, 0 0 30px ${hColor}`;
                          } else if (hEffect === 'karaoke-3d') {
                            wordStyle.textShadow = `1px 1px 0px #ccc, 2px 2px 0px #bbb, 3px 3px 0px #aaa, 4px 4px 0px rgba(0,0,0,0.5)`;
                          } else if (hEffect === 'karaoke-emboss') {
                            wordStyle.color = '#ebebeb';
                            wordStyle.textShadow = '1px 2px 3px rgba(255,255,255,0.8), -1px -2px 3px rgba(0,0,0,0.8)';
                          } else if (hEffect === 'karaoke-chrome') {
                            wordStyle.background = 'linear-gradient(to bottom, #ebebeb 50%, #616161 50%, #ebebeb)';
                            (wordStyle as any).WebkitBackgroundClip = 'text';
                            wordStyle.color = 'transparent';
                          } else if (hEffect === 'karaoke-gold') {
                            wordStyle.background = 'linear-gradient(to bottom, #d4af37, #C5A028)';
                            (wordStyle as any).WebkitBackgroundClip = 'text';
                            wordStyle.color = 'transparent';
                          } else if (hEffect === 'karaoke-fire') {
                            wordStyle.color = '#fff';
                            wordStyle.textShadow = '0 -5px 4px #FFC107, 2px -10px 6px #FF9800, -2px -15px 11px #FF5722, 2px -25px 18px #795548';
                          } else if (hEffect === 'karaoke-frozen') {
                            wordStyle.color = '#fff';
                            wordStyle.textShadow = '0 0 5px rgba(255,255,255,0.8), 0 0 10px rgba(255,255,255,0.5), 0 0 20px #03A9F4, 0 0 30px #03A9F4';
                          } else if (hEffect === 'karaoke-rainbow') {
                            wordStyle.background = 'linear-gradient(to left, violet, indigo, blue, green, yellow, orange, red)';
                            (wordStyle as any).WebkitBackgroundClip = 'text';
                            wordStyle.color = 'transparent';
                          } else if (hEffect === 'karaoke-mirror') {
                            wordStyle.transform = 'scaleY(1.3) perspective(500px) rotateX(-10deg)';
                            wordStyle.textShadow = '0 15px 5px rgba(0,0,0,0.1), 0 -1px 3px rgba(0,0,0,0.3)';
                          } else if (hEffect === 'karaoke-vhs') {
                            wordStyle.textShadow = '2px 0 0 rgba(255,0,0,0.7), -2px 0 0 rgba(0,0,255,0.7)';
                          } else if (hEffect === 'karaoke-retro') {
                            wordStyle.fontFamily = "'Press Start 2P', cursive";
                            wordStyle.color = '#ff00ff';
                            wordStyle.textShadow = '4px 4px 0px #00ffff';
                          } else if (hEffect === 'karaoke-cyberpunk') {
                            wordStyle.color = '#fcee0a';
                            wordStyle.textShadow = '2px 2px 0px #000, -1px -1px 0 #05d9e8';
                            wordStyle.fontFamily = "'Orbitron', sans-serif";
                          } else if (hEffect === 'karaoke-hologram') {
                            wordStyle.color = 'rgba(0, 255, 255, 0.7)';
                            wordStyle.textShadow = '0 0 5px rgba(0,255,255,0.5)';
                          } else if (hEffect === 'karaoke-comic') {
                            wordStyle.fontFamily = "'Bangers', cursive";
                            wordStyle.color = '#ffcc00';
                            wordStyle.textShadow = '2px 2px 0px #000, -1px -1px 0 #000';
                          } else if (hEffect === 'karaoke-glitch-text') {
                            wordStyle.animation = 'anim-glitch 0.4s infinite linear';
                          } else if (hEffect === 'karaoke-pulse') {
                            wordStyle.animation = 'anim-pulse 1s infinite ease-in-out';
                          } else if (hEffect === 'karaoke-breathe') {
                            wordStyle.animation = 'anim-breathe 2s infinite ease-in-out';
                          } else if (hEffect === 'karaoke-float') {
                            wordStyle.animation = 'anim-float 2s infinite ease-in-out';
                          } else if (hEffect === 'karaoke-sway') {
                            wordStyle.animation = 'anim-sway 2s infinite ease-in-out';
                          } else if (hEffect === 'karaoke-flicker') {
                            wordStyle.animation = 'anim-flicker 2s infinite linear';
                          } else if (hEffect === 'karaoke-shake') {
                            wordStyle.animation = 'anim-shake 0.2s infinite linear';
                          } else if (hEffect === 'karaoke-wobble') {
                            wordStyle.animation = 'anim-wobble 1s infinite ease-in-out';
                          } else if (hEffect === 'karaoke-jello') {
                            wordStyle.animation = 'anim-jello 1s infinite';
                          } else if (hEffect === 'karaoke-rubberband') {
                            wordStyle.animation = 'anim-rubberband 1s infinite';
                          } else if (hEffect === 'karaoke-heartbeat') {
                            wordStyle.animation = 'anim-heartbeat 1.3s infinite ease-in-out';
                          } else if (hEffect === 'karaoke-flash') {
                            wordStyle.animation = 'anim-flash 1s infinite';
                          } else if (hEffect === 'karaoke-tada') {
                            wordStyle.animation = 'anim-tada 1s infinite';
                          } else if (hEffect === 'karaoke-swing') {
                            wordStyle.animation = 'anim-swing 2s infinite';
                          } else if (hEffect === 'karaoke-rotate') {
                            wordStyle.animation = 'anim-rotate 4s infinite linear';
                          } else if (hEffect === 'karaoke-spin') {
                            wordStyle.animation = 'anim-rotate 1s infinite linear';
                          } else if (hEffect === 'karaoke-glitch') {
                            wordStyle.animation = 'anim-glitch 0.3s infinite linear';
                          } else if (hEffect === 'karaoke-typewriter') {
                            // Web Preview Approximation using clip-path steps
                            wordStyle.animation = 'typewriter-reveal 0.5s steps(10, end) forwards';
                            wordStyle.whiteSpace = 'nowrap';
                            wordStyle.overflow = 'hidden';
                            wordStyle.display = 'inline-block';
                            wordStyle.verticalAlign = 'bottom';
                            // Note: steps(10) is an approximation since we don't know char count here easily without more logic.
                            // Ideally this would be dynamic style based on word length.
                          }
                          else if (hEffect === 'karaoke-fade') {
                            wordStyle.animation = 'trans-fade-in 0.4s cubic-bezier(0.4, 0, 0.2, 1) forwards';
                          } else if (hEffect === 'karaoke-slide') {
                            wordStyle.animation = 'trans-slide-in 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards';
                          } else if (hEffect === 'karaoke-drop') {
                            wordStyle.animation = 'trans-drop-in 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards';
                          } else if (hEffect === 'karaoke-lightspeed') {
                            wordStyle.animation = 'trans-lightspeed-in 0.5s ease-out forwards';
                          } else if (hEffect === 'karaoke-roll') {
                            wordStyle.animation = 'trans-roll-in 0.5s ease-out forwards';
                          } else if (hEffect === 'karaoke-zoom') {
                            wordStyle.animation = 'trans-zoom-in 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) forwards';
                          } else if (hEffect === 'karaoke-elastic') {
                            wordStyle.animation = 'trans-elastic-in 0.7s ease-out forwards';
                          } else if (hEffect === 'karaoke-scale-rotate') {
                            wordStyle.animation = 'trans-scale-rotate-in 0.5s ease-out forwards';
                          } else if (hEffect === 'karaoke-flip') {
                            wordStyle.animation = 'trans-flip-in 0.5s ease-out forwards';
                          } else if (hEffect === 'karaoke-rotate-in') {
                            wordStyle.animation = 'trans-rotate-in 0.5s ease-out forwards';
                          } else if (hEffect === 'karaoke-spiral') {
                            wordStyle.animation = 'trans-spiral-in 0.6s ease-out forwards';
                          } else if (hEffect === 'karaoke-blur') {
                            wordStyle.animation = 'trans-blur-in 0.4s ease-out forwards';
                          } else if (hEffect === 'karaoke-shatter') {
                            wordStyle.animation = 'trans-shatter-in 0.5s ease-out forwards';
                          }

                          // Handle legacy color names by mapping them to use the custom color if user wants, 
                          // or keep them hardcoded. For now, let's make them respect the custom color 
                          // effectively treating the preset name as just a "style" of effect but allowing color override.
                          // However, to keep it simple, I'll update the explicit color ones to use defaults BUT
                          // since the user now has a color picker, they probably want that color to apply everywhere.
                          // I will update the "karaoke-blue", "purple" etc to just be aliases for standard colored styling
                          // but using the user's SELECTED color if they changed it, or defaults if they didn't.
                          // actually, the prompt implies "pilihlah highlight effect ini untuk mengatur highlight font"
                          // so all effects should respect the color picker.

                          else if (['karaoke-blue', 'karaoke-purple', 'karaoke-green', 'karaoke-pink', 'karaoke-cyan', 'karaoke-glow-blue', 'karaoke-glow-pink'].includes(hEffect || '')) {
                            wordStyle.color = hColor;
                            wordStyle.textShadow = `0 0 10px ${hColor}`;
                            if (hEffect?.includes('glow')) {
                              wordStyle.textShadow = `0 0 5px ${hColor}, 0 0 15px ${hColor}, 0 0 30px ${hColor}`;
                            }
                          }
                        }

                        const element = (
                          <span key={wIdx} className="inline-block" style={wordStyle}>
                            {wText}
                          </span>
                        );

                        return shouldAddSpace ? <React.Fragment key={wIdx}>{element}{' '}</React.Fragment> : element;
                      });
                  } else if (hEffect === 'karaoke' || hEffect?.startsWith('karaoke-')) {
                    // Fallback Karaoke (Line Fill)
                    const hColor = renderConfig.highlightColor || '#fb923c';
                    const hBg = renderConfig.highlightBackground || '#fb923c';

                    textEffectStyles.color = hColor;

                    if (hEffect === 'karaoke-neon') textEffectStyles.textShadow = `0 0 10px ${hColor}, 0 0 20px ${hColor}`;
                    if (hEffect === 'karaoke-scale') textEffectStyles.transform = (textEffectStyles.transform || '') + ' scale(1.1)';
                    if (hEffect === 'karaoke-underline') textEffectStyles.textDecoration = 'underline';
                    if (hEffect === 'karaoke-bounce') textEffectStyles.transform = (textEffectStyles.transform || '') + ' translateY(-5px)';
                    if (hEffect === 'karaoke-fill') { textEffectStyles.backgroundColor = hBg; textEffectStyles.color = '#000'; textEffectStyles.padding = '4px 12px'; textEffectStyles.borderRadius = '6px'; }
                    if (hEffect === 'karaoke-outline') { textEffectStyles.color = 'transparent'; (textEffectStyles as any).WebkitTextStroke = `2px ${hColor}`; }
                    if (hEffect === 'karaoke-shadow') textEffectStyles.textShadow = `3px 3px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000`;
                    if (hEffect === 'karaoke-gradient') { textEffectStyles.background = `linear-gradient(90deg, ${hColor}, ${hBg})`; (textEffectStyles as any).WebkitBackgroundClip = 'text'; (textEffectStyles as any).WebkitTextFillColor = 'transparent'; }

                    if (['karaoke-pill', 'karaoke-box', 'karaoke-rounded'].includes(hEffect!)) {
                      textEffectStyles.backgroundColor = hBg;
                      textEffectStyles.color = '#000';
                      textEffectStyles.padding = '4px 16px';
                      textEffectStyles.borderRadius = hEffect === 'karaoke-pill' ? '9999px' : hEffect === 'karaoke-rounded' ? '12px' : '0';
                    }
                    if (hEffect?.includes('glow')) {
                      textEffectStyles.textShadow = `0 0 10px ${hColor}, 0 0 20px ${hColor}`;
                    }

                  } else if (hEffect === 'scale') {
                    textEffectStyles.color = renderConfig.highlightColor || '#fb923c';
                  } else if (renderConfig.highlightEffect === 'background') {
                    textEffectStyles.backgroundColor = (renderConfig.highlightBackground || '#fb923c') + '4D'; // 30% alpha roughly
                    textEffectStyles.padding = '0 10px';
                    textEffectStyles.borderRadius = '8px';
                  }
                }

                const isAnchorLine = anchorLineIndices.has(idx);
                const isSnapPreviewLine = snapPreview?.lineIndex === idx;

                return (
                  <p
                    key={idx}
                    data-lyric-active={isActive ? "true" : "false"}
                    className={`${syncMode ? containerClass.replace('cursor-pointer', 'cursor-crosshair') : containerClass}${isActive ? activeClass : inactiveClass}${isAnchorLine ? ' ring-2 ring-amber-400/70 bg-amber-400/10 rounded-lg' : isSnapPreviewLine ? ' ring-1 ring-amber-300/40 rounded-lg' : ''}`}
                    onClick={() => {
                      // 对齐模式下，点选一行 = 把它吸附到最近的强起音点
                      if (syncMode) {
                        void handleAnchorClick(idx);
                        return;
                      }
                      if (isActive) {
                        navigator.clipboard.writeText(line.text);
                        toast.success(tr('Lyric copied to clipboard'), 1500);
                      }
                      if (audioRef.current && !isRendering) {
                        audioRef.current.currentTime = line.time;
                        setCurrentTime(line.time);
                      }
                    }}
                  >
                    <span className={`inline-block ${isActive && renderConfig.textAnimation !== 'none' && renderConfig.textAnimation !== 'typewriter' ? `text-anim-${renderConfig.textAnimation}` : ''}`}>
                      <span style={textEffectStyles} className="inline-block">
                        {contentRender}
                      </span>
                    </span>
                  </p>
                );
              })
              )}
              <div className={`transition-all duration-500 ${renderConfig.contentPosition === 'center' ? ((activeTab === TabView.EDITOR || isPlaylistMode) ? 'h-[25vh]' : (!isHeaderVisible && !isFooterVisible) ? 'h-[50vh]' : 'h-[40vh]') : 'h-0'}`}></div>
            </div>
          ) : (
            <div className="text-center text-zinc-400/50 select-none pointer-events-none">
              {!activeSlide && !audioSrc && playlist.length === 0 && preset !== 'none' && (
                <div className="flex flex-col items-center gap-4 animate-pulse">
                  <Music size={64} className="opacity-20" />
                  <p>{tr('Drag & drop files or load audio & lyrics to start')}</p>
                  <p className="text-xs opacity-50">{tr('Shortcuts: 1 (Load Audio/Video), 2 (Load Lyrics), 3 (Load Font), Space (Play), S / V (Stop)')}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Bottom Controls (Player) */}
        {/* 对齐面板展开时需要更高的上限，否则面板会被 overflow-hidden 裁掉 */}
        <div className={`no-minimal-mode-toggle transition-all duration-500 ease-in-out overflow-hidden ${isFooterVisible ? (syncMode ? 'max-h-[40rem]' : 'max-h-60') + ' opacity-100 translate-y-0' : 'max-h-0 opacity-0 translate-y-4'}`}>
          <div className="bg-gradient-to-t from-black/60 via-black/30 to-transparent p-4 pb-6 lg:p-6 lg:pb-8">
            <div className="max-w-7xl mx-auto space-y-4">
              {/* Progress Bar */}
              <div className="flex items-center gap-3 group">
                <span className="text-xs text-zinc-400 font-mono w-10 text-right">{formatTime(currentTime)}</span>
                <div
                  ref={progressBarRef}
                  className="flex-1 h-1 bg-zinc-700/50 rounded-full relative cursor-pointer group-hover:h-2 transition-all touch-none"
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    seekToPosition(e.clientX);
                  }}
                  onPointerMove={(e) => {
                    if (e.buttons === 1) {
                      seekToPosition(e.clientX);
                    }
                  }}
                >
                  <div
                    className="absolute top-0 left-0 h-full bg-amber-500 rounded-full pointer-events-none"
                    style={{ width: `${(currentTime / duration) * 100}%` }}
                  ></div>
                  <input
                    type="range"
                    name="progress"
                    id="progress-bar"
                    aria-label={tr('Seek Progress')}
                    min="0"
                    max={duration || 0}
                    value={currentTime}
                    onChange={handleSeek}
                    disabled={isRendering}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-wait pointer-events-none"
                  />
                </div>
                <span className="text-xs text-zinc-400 font-mono w-10">{formatTime(duration)}</span>

                {/* Volume Control (Top Row) */}
                <div className="flex items-center gap-2 pl-4">
                  <button onClick={() => setIsMuted(!isMuted)} className="text-zinc-400 hover:text-white">
                    {isMuted || volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
                  </button>
                  <div
                    ref={volumeBarRef}
                    className="w-16 h-1 bg-zinc-700/50 rounded-full relative overflow-hidden group/vol cursor-pointer touch-none"
                    onPointerDown={(e) => {
                      e.currentTarget.setPointerCapture(e.pointerId);
                      setVolumeToPosition(e.clientX);
                    }}
                    onPointerMove={(e) => {
                      if (e.buttons === 1) {
                        setVolumeToPosition(e.clientX);
                      }
                    }}
                  >
                    <div
                      className="absolute top-0 left-0 h-full bg-zinc-300 group-hover/vol:bg-amber-400 transition-colors pointer-events-none"
                      style={{ width: `${isMuted ? 0 : volume * 100}%` }}
                    ></div>
                    <input
                      type="range"
                      name="volume"
                      id="volume-control"
                      aria-label={tr('Volume Control')}
                      min="0"
                      max="1"
                      step="0.05"
                      value={isMuted ? 0 : volume}
                      onChange={handleVolumeChange}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer pointer-events-none"
                    />
                  </div>
                </div>
              </div>

              {/* 字幕对齐面板 */}
              {syncMode && (
                <div className="rounded-2xl border border-amber-400/25 bg-gradient-to-b from-amber-500/[0.07] to-transparent p-3 lg:p-4 space-y-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2 text-amber-300">
                      <Crosshair size={16} />
                      <span className="text-sm font-bold">字幕对齐</span>
                    </div>

                    <span className={`text-[11px] px-2 py-0.5 rounded-full ${syncAnalyzing ? 'bg-amber-500/15 text-amber-300 animate-pulse' : syncEnvelope ? 'bg-emerald-500/15 text-emerald-300' : 'bg-zinc-700/50 text-zinc-400'}`}>
                      {syncAnalyzing ? '正在分析音频…' : syncEnvelope ? '分析就绪' : '待分析'}
                    </span>

                    <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                      <span>搜索窗口</span>
                      <select
                        value={syncWindow}
                        onChange={e => setSyncWindow(parseFloat(e.target.value))}
                        className="bg-zinc-800 border border-white/10 rounded px-1.5 py-0.5 text-[11px] text-zinc-200 focus:outline-none focus:ring-1 focus:ring-amber-500"
                      >
                        <option value={0.5}>±0.5s</option>
                        <option value={1}>±1.0s</option>
                        <option value={2}>±2.0s</option>
                        <option value={3}>±3.0s</option>
                        <option value={5}>±5.0s</option>
                      </select>
                    </div>

                    <span className="text-[11px] text-zinc-400">
                      锚点 <span className="text-amber-300 font-mono">{syncAnchors.length}</span>/2
                      {syncAnchors.length === 2 && (
                        <span className="ml-1 text-zinc-500">
                          {Math.abs(syncAnchors[0].offset - syncAnchors[1].offset) < 0.1 ? '（纯平移）' : '（线性插值）'}
                        </span>
                      )}
                    </span>

                    <div className="flex-1" />

                    <button
                      onClick={() => setAwaitingSecondAnchor(true)}
                      disabled={syncAnchors.length === 0 || syncAnalyzing}
                      className="px-2.5 py-1 rounded-lg text-[11px] bg-white/5 hover:bg-white/10 text-zinc-200 border border-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      再加锚点
                    </button>
                    <button
                      onClick={applySyncOffsets}
                      disabled={!syncOffsets || syncAnchors.length === 0}
                      className="px-2.5 py-1 rounded-lg text-[11px] bg-amber-500 hover:bg-amber-400 text-black font-bold disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      应用
                    </button>
                    <button
                      onClick={resetSync}
                      disabled={syncAnchors.length === 0}
                      className="px-2.5 py-1 rounded-lg text-[11px] bg-white/5 hover:bg-white/10 text-zinc-200 border border-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      撤销
                    </button>
                    <button
                      onClick={() => setSyncMode(false)}
                      className="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
                      title="退出对齐模式"
                    >
                      <X size={14} />
                    </button>
                  </div>

                  <p className="text-[11px] text-zinc-500 leading-relaxed">
                    {awaitingSecondAnchor && syncAnchors.length === 1
                      ? '请在文件后段再点选一行字幕作为第二个锚点，用于修正「越往后越偏」的漂移。'
                      : syncAnchors.length === 0
                        ? '点选任意一行字幕，它会被吸附到该行时间附近最强的起音点，并据此整体平移时间轴。'
                        : '预览已生效（琥珀色描边为锚定行）。确认无误后点「应用」写回字幕；不满意可「撤销」。'}
                  </p>

                  {snapPreview && (
                    <div className="text-[11px] text-amber-200/90 font-mono">
                      第 {snapPreview.lineIndex + 1} 行 → 位移 {snapPreview.delta >= 0 ? '+' : ''}{snapPreview.delta.toFixed(3)}s
                      <span className="text-zinc-500 ml-2">峰强度 {(snapPreview.strength * 100).toFixed(0)}%</span>
                    </div>
                  )}
                </div>
              )}

              {/* Main Buttons */}
              <div className="flex flex-wrap lg:grid lg:grid-cols-[1fr_auto_1fr] items-center justify-center gap-4">
                <div className="flex gap-1 justify-center lg:justify-start flex-wrap order-2 lg:order-none w-auto lg:w-full">
                  <label className="p-2 rounded-lg hover:bg-white/10 text-zinc-400 hover:text-white cursor-pointer transition-colors" title="载入音频或视频 (1)">
                    <Music size={18} />
                    <input type="file" name="audio-file" id="audio-file" accept="audio/*,video/*" className="hidden" onChange={handleAudioUpload} disabled={isRendering} />
                  </label>
                  <button
                    onClick={() => setVideoWindowVisible(v => !v)}
                    className={`p-2 rounded-lg hover:bg-white/10 transition-colors ${videoWindowVisible ? 'text-amber-400' : 'text-zinc-400 hover:text-white'}`}
                    title={videoWindowVisible ? '隐藏悬浮视频小窗' : '显示悬浮视频小窗'}
                    disabled={isRendering}
                  >
                    {videoWindowVisible ? <Video size={18} /> : <EyeOff size={18} />}
                  </button>
                  <div className="flex items-center gap-1">
                    <label className={`p-2 rounded-lg hover:bg-white/10 cursor-pointer transition-colors ${lyrics.length > 0 ? 'text-amber-400' : 'text-zinc-400 hover:text-white'}`} title={tr('Load Lyrics (.lrc, .srt, .vtt, .ttml) (2)')}>
                      <FileText size={18} />
                      <input type="file" name="lyrics-file" id="lyrics-file" accept=".lrc,.srt,.ttml,.xml,.vtt" className="hidden" onChange={handleLyricsUpload} disabled={isRendering} />
                    </label>
                    {lyrics.length > 0 && (
                      <button
                        onClick={() => setLyrics([])}
                        className="p-1 rounded-full text-zinc-500 hover:text-red-400 hover:bg-white/5 transition-colors"
                        title={tr('Clear Lyrics')}
                        disabled={isRendering}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>

                  {/* Lyric Offset Controls */}
                  <div className="flex items-center gap-1 bg-zinc-800/50 rounded-lg px-2 py-1 h-9">
                    <span className="text-xs text-zinc-300 w-12 text-center font-mono select-none border-r border-white/10 pr-2 mr-1">
                      {lyricOffset > 0 ? '+' : ''}{lyricOffset.toFixed(1)}s
                    </span>
                    <div className="flex flex-col -my-1 h-full justify-center">
                      <button
                        onClick={() => setLyricOffset(prev => parseFloat((prev + 0.1).toFixed(1)))}
                        className="text-zinc-400 hover:text-white flex items-center justify-center h-3.5 w-4 hover:bg-white/10 rounded-sm transition-colors"
                        title={tr('Increase Lyric Offset (+0.1s)')}
                        disabled={isRendering}
                      >
                        <ChevronUp size={12} />
                      </button>
                      <button
                        onClick={() => setLyricOffset(prev => parseFloat((prev - 0.1).toFixed(1)))}
                        className="text-zinc-400 hover:text-white flex items-center justify-center h-3.5 w-4 hover:bg-white/10 rounded-sm transition-colors"
                        title={tr('Decrease Lyric Offset (-0.1s)')}
                        disabled={isRendering}
                      >
                        <ChevronDown size={12} />
                      </button>
                    </div>
                  </div>

                  {/* 字幕对齐（频谱吸附） */}
                  <button
                    onClick={handleToggleSyncMode}
                    className={`p-2 rounded-lg hover:bg-white/10 transition-colors ${syncMode ? 'text-amber-400 bg-amber-500/10' : 'text-zinc-400 hover:text-white'} disabled:opacity-30 disabled:cursor-not-allowed`}
                    title={syncMode ? '退出字幕对齐' : '字幕对齐：点选一行，吸附到最近的强起音点'}
                    disabled={isRendering || lyrics.length === 0 || !audioSrc}
                  >
                    {syncAnalyzing ? <Loader2 size={18} className="animate-spin" /> : <Crosshair size={18} />}
                  </button>

                  <div className="flex items-center gap-1">
                    <label className={`p-2 rounded-lg hover:bg-white/10 cursor-pointer transition-colors ${customFontName ? 'text-amber-400' : 'text-zinc-400 hover:text-white'}`} title={customFontName ? `${tr('Custom Font')}：${customFontName}` : tr('Load Custom Font (.ttf, .otf, .woff) (3)')}>
                      <Type size={18} />
                      <input type="file" name="font-file" id="font-file" accept=".ttf,.otf,.woff,.woff2" className="hidden" onChange={handleFontUpload} disabled={isRendering} />
                    </label>
                    {customFontName && (
                      <button
                        onClick={() => setCustomFontName(null)}
                        className="p-1 rounded-full text-zinc-500 hover:text-red-400 hover:bg-white/5 transition-colors"
                        title={tr('Reset Default Font')}
                        disabled={isRendering}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>

                  {/* Font Size Control */}
                  <div className="flex items-center gap-1 bg-zinc-800/50 rounded-lg px-2 py-1 h-9">
                    <span className="text-xs text-zinc-300 w-10 text-center font-mono select-none border-r border-white/10 pr-2 mr-1">
                      {Math.round(renderConfig.fontSizeScale * 100)}%
                    </span>
                    <div className="flex flex-col -my-1 h-full justify-center">
                      <button
                        onClick={() => setRenderConfig(prev => ({ ...prev, fontSizeScale: Math.min(prev.fontSizeScale + 0.1, 3.0) }))}
                        className="text-zinc-400 hover:text-white flex items-center justify-center h-3.5 w-4 hover:bg-white/10 rounded-sm transition-colors"
                        title={tr('Increase Font Size')}
                        disabled={isRendering}
                      >
                        <ChevronUp size={12} />
                      </button>
                      <button
                        onClick={() => setRenderConfig(prev => ({ ...prev, fontSizeScale: Math.max(prev.fontSizeScale - 0.1, 0.1) }))}
                        className="text-zinc-400 hover:text-white flex items-center justify-center h-3.5 w-4 hover:bg-white/10 rounded-sm transition-colors"
                        title={tr('Decrease Font Size')}
                        disabled={isRendering}
                      >
                        <ChevronDown size={12} />
                      </button>
                    </div>
                  </div>

                  {/* Preset Dropdown (Moved here) */}
                  <div className="relative group">
                    <select
                      value={preset}
                      onChange={(e) => {
                        const nextP = e.target.value as VideoPreset;
                        setPreset(nextP);

                        // Sync Config with Visual Reset (same as Shortcut 'j')
                        const pConfig = PRESET_DEFINITIONS[nextP];
                        if (pConfig) {
                          const visualReset: Partial<RenderConfig> = {
                            fontFamily: 'sans-serif',
                            fontSizeScale: 1.0,
                            fontColor: '#ffffff',
                            fontWeight: 'bold',
                            fontStyle: 'normal',
                            textCase: 'none',
                            textAlign: 'center',
                            contentPosition: 'center',
                            textDecoration: 'none',
                            textEffect: 'preset',
                            textAnimation: 'none',
                            highlightEffect: 'karaoke',
                            highlightColor: '#fb923c',
                            highlightBackground: '#fb923c',
                            useCustomHighlightColors: false,
                            lyricStyleTarget: 'active-only',
                            transitionEffect: 'none',
                          };

                          setRenderConfig(curr => ({
                            ...curr,
                            ...visualReset,
                            ...pConfig
                          }));
                        }
                      }}
                      className="appearance-none bg-zinc-800/50 border border-white/5 text-zinc-300 text-xs rounded-lg px-3 pr-8 h-9 w-24 focus:outline-none focus:border-amber-500 cursor-pointer"
                      disabled={isRendering}
                      title={tr('Select Visual Preset')}
                      name="preset"
                      id="preset-select"
                      aria-label={tr('Visual Preset')}
                    >
                      <option value="custom" className="bg-zinc-900 font-bold text-amber-400">{tr('Custom ✨')}</option>
                      <option value="default" className="bg-zinc-900">{tr('Default')}</option>
                      <option value="large" className="bg-zinc-900">{tr('Big Text')}</option>
                      <option value="large_upper" className="bg-zinc-900">{tr('Big Text (UP)')}</option>
                      <option value="big_center" className="bg-zinc-900">{tr('Big Center')}</option>
                      <option value="metal" className="bg-zinc-900">{tr('Metal')}</option>
                      <option value="kids" className="bg-zinc-900">{tr('Kids')}</option>
                      <option value="sad" className="bg-zinc-900">{tr('Sad')}</option>
                      <option value="romantic" className="bg-zinc-900">{tr('Romantic')}</option>
                      <option value="tech" className="bg-zinc-900">{tr('Tech')}</option>
                      <option value="gothic" className="bg-zinc-900">{tr('Gothic')}</option>
                      <option value="classic" className="bg-zinc-900">{tr('Classic Serif')}</option>
                      <option value="monospace" className="bg-zinc-900">{tr('Monospace')}</option>
                      <option value="testing_up" className="bg-zinc-900">{tr('Testing (UP)')}</option>
                      <option value="testing" className="bg-zinc-900">{tr('Testing')}</option>
                      <option value="one_line_up" className="bg-zinc-900">{tr('One Line (UP)')}</option>
                      <option value="one_line" className="bg-zinc-900">{tr('One Line')}</option>
                      <option value="slideshow" className="bg-zinc-900">{tr('Slideshow')}</option>
                      <option value="just_video" className="bg-zinc-900">{tr('Just Video')}</option>
                      <option value="subtitle" className="bg-zinc-900">{tr('Subtitle')}</option>
                      <option value="none" className="bg-zinc-900">{tr('None')}</option>
                    </select>
                    <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-1 text-zinc-500">
                      <svg className="fill-current h-3 w-3" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z" /></svg>
                    </div>
                  </div>


                </div>

                <div className="flex items-center gap-4 lg:gap-6 justify-center order-1 lg:order-none w-full lg:w-auto mb-2 lg:mb-0">
                  <button
                    className="text-zinc-400 hover:text-white transition-colors disabled:opacity-50"
                    onClick={stopPlayback}
                    title={tr('Stop (S)')}
                    disabled={isRendering}
                  >
                    <Square size={20} fill="currentColor" />
                  </button>
                  <button className="text-zinc-400 hover:text-white transition-colors disabled:opacity-50" disabled={isRendering || playlist.length === 0} onClick={playPreviousSong} title={tr('Previous Song')}>
                    <SkipBack size={24} />
                  </button>
                  <button className="text-zinc-400 hover:text-white transition-colors disabled:opacity-50" disabled={isRendering} onClick={() => audioRef.current && (audioRef.current.currentTime -= 5)} title={tr('Rewind 5s')}>
                    <Rewind size={20} />
                  </button>
                  <button
                    onClick={togglePlay}
                    disabled={isRendering}
                    title={isPlaying ? '暂停' : '播放'}
                    className="w-14 h-14 flex items-center justify-center bg-white text-black rounded-full hover:scale-105 transition-transform shadow-lg shadow-amber-500/20 disabled:opacity-50 disabled:hover:scale-100"
                  >
                    {isPlaying ? <Pause size={28} fill="currentColor" /> : <Play size={28} fill="currentColor" className="ml-1" />}
                  </button>
                  <button className="text-zinc-400 hover:text-white transition-colors disabled:opacity-50" disabled={isRendering} onClick={() => audioRef.current && (audioRef.current.currentTime += 5)} title={tr('Fast Forward 5s')}>
                    <FastForward size={20} />
                  </button>
                  <button className="text-zinc-400 hover:text-white transition-colors disabled:opacity-50" disabled={isRendering || playlist.length === 0} onClick={playNextSong} title={tr('Next Song')}>
                    <SkipForward size={24} />
                  </button>
                  <button
                    className={`transition-colors disabled:opacity-50 ${repeatMode !== 'off' ? 'text-green-400 hover:text-green-300' : 'text-zinc-400 hover:text-white'}`}
                    onClick={toggleRepeat}
                    title={`${tr('Repeat')}: ${tr(repeatMode === 'off' ? 'Off' : repeatMode === 'one' ? 'One' : repeatMode === 'all' ? 'Play All (No Repeat)' : 'Loop All')} (R)`}
                    disabled={isRendering}
                  >
                    {repeatMode === 'one' && <Repeat1 size={20} />}
                    {repeatMode === 'all_repeat' && <Repeat size={20} />}
                    {repeatMode === 'all' && <ListMusic size={20} />}
                    {repeatMode === 'off' && <Repeat size={20} className="opacity-50" />}
                  </button>


                </div>

                <div className="flex items-center gap-1 justify-center lg:justify-end group flex-wrap order-3 lg:order-none w-auto lg:w-full">

                  <div className="flex items-center gap-1">
                    {/* Lyric Visibility Toggle */}
                    <button
                      onClick={() => setRenderConfig(prev => ({
                        ...prev,
                        lyricVisibilityMode: (prev.lyricVisibilityMode ?? 'default') === 'auto' ? 'default' : 'auto',
                      }))}
                      className={`bg-zinc-800/50 border border-white/5 text-[10px] font-mono rounded-lg px-2 h-9 transition-colors disabled:opacity-30 ${(renderConfig.lyricVisibilityMode ?? 'default') === 'auto' ? 'text-amber-400 border-amber-500/50' : 'text-zinc-300 hover:text-white'}`}
                      title={`${tr('Lyric Visibility')}: ${tr((renderConfig.lyricVisibilityMode ?? 'default') === 'auto' ? 'Auto' : 'Default')}`}
                      disabled={isRendering}
                    >
                      {(renderConfig.lyricVisibilityMode ?? 'default') === 'auto' ? 'AUTO' : 'DEFAULT'}
                    </button>
                    {/* Background Blur Toggle */}
                    <button
                      onClick={() => setRenderConfig(prev => ({ ...prev, backgroundBlurStrength: prev.backgroundBlurStrength > 0 ? 0 : 12 }))}
                      className={`bg-zinc-800/50 border border-white/5 text-[10px] font-mono rounded-lg px-2 h-9 transition-colors disabled:opacity-30 ${isBlurEnabled ? 'text-amber-400 border-amber-500/50' : 'text-zinc-300 hover:text-white'}`}
                      title={`${tr('Background Blur')}: ${tr(isBlurEnabled ? 'On' : 'Off')}`}
                      disabled={isRendering}
                    >
                      {isBlurEnabled ? 'BLUR' : 'SHARP'}
                    </button>
                    {/* Highlight Toggle */}
                    <button
                      onClick={() => setRenderConfig(prev => ({ ...prev, highlightEffect: prev.highlightEffect === 'none' ? 'karaoke' : 'none' }))}
                      className={`p-2 rounded-full transition-all ${renderConfig.highlightEffect !== 'none' ? 'bg-orange-500 text-white shadow-[0_0_15px_rgba(249,115,22,0.5)]' : 'hover:bg-zinc-800 text-zinc-400'}`}
                      title={tr('Toggle Lyric Highlight')}
                    >
                      <Type size={20} />
                    </button>

                    {/* Resolution Toggle */}
                    <button
                      onClick={() => setResolution(prev => prev === '1080p' ? '720p' : '1080p')}
                      className="bg-zinc-800/50 border border-white/5 text-[10px] font-mono text-zinc-300 hover:text-white rounded-lg px-2 h-9 transition-colors disabled:opacity-30"
                      title={tr('Toggle Resolution (720p / 1080p)')}
                      disabled={isRendering}
                    >
                      {resolution}
                    </button>
                    {/* Aspect Ratio Toggle */}
                    <button
                      onClick={() => setAspectRatio(prev => {
                        if (prev === '16:9') return '9:16';
                        if (prev === '9:16') return '3:4';
                        if (prev === '3:4') return '1:1';
                        if (prev === '1:1') return '1:2';
                        if (prev === '1:2') return '2:1';
                        if (prev === '2:1') return '2:3';
                        if (prev === '2:3') return '3:2';
                        return '16:9';
                      })}
                      className="bg-zinc-800/50 border border-white/5 text-[10px] font-mono text-zinc-300 hover:text-white rounded-lg px-2 h-9 transition-colors disabled:opacity-30"
                      title={tr('Toggle Aspect Ratio (16:9 / 9:16 / 3:4 / 1:1 / 1:2 / 2:1 / 2:3 / 3:2)')}
                      disabled={isRendering}
                    >
                      {aspectRatio}
                    </button>
                  </div>
                  {/* Render Engine Selection */}
                  <div className="relative group">
                    <select
                      value={renderEngine}
                      onChange={(e) => setRenderEngine(e.target.value as RenderEngine)}
                      className="appearance-none bg-zinc-800/50 border border-white/5 text-zinc-300 text-xs rounded-lg px-3 pr-8 w-26 h-9 focus:outline-none focus:border-amber-500 cursor-pointer text-ellipsis overflow-hidden"
                      disabled={isRendering}
                      title={tr('Select Render Engine')}
                      name="engine"
                      id="engine-select"
                      aria-label={tr('Render Engine')}
                    >
                      <option value="mediarecorder" className="bg-zinc-900">{tr('Realtime')}</option>
                      <option value="webcodecs" className="bg-zinc-900">{tr('WebCodecs')}</option>
                      <option value="ffmpeg" className="bg-zinc-900">{tr('FFMPEG')}</option>
                    </select>
                    <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-1 text-zinc-500">
                      <svg className="fill-current h-3 w-3" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z" /></svg>
                    </div>
                  </div>

                  {/* FPS Selection */}
                  {/* FPS Selection (Hidden) */}
                  {/* <div className="relative group">
                    <select
                      value={renderFps}
                      onChange={(e) => setRenderFps(parseInt(e.target.value))}
                      className="appearance-none bg-zinc-800/50 border border-white/5 text-zinc-300 text-xs rounded-lg px-3 pr-8 w-20 h-9 focus:outline-none focus:border-amber-500 cursor-pointer"
                      disabled={isRendering}
                      title={tr('Select Frame Rate')}
                    >
                      <option value="24" className="bg-zinc-900">24 FPS</option>
                      <option value="25" className="bg-zinc-900">25 FPS</option>
                      <option value="30" className="bg-zinc-900">30 FPS</option>
                      <option value="50" className="bg-zinc-900">50 FPS</option>
                      <option value="60" className="bg-zinc-900">60 FPS</option>
                    </select>
                    <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-1 text-zinc-500">
                      <svg className="fill-current h-3 w-3" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z" /></svg>
                    </div>
                  </div> */}

                  {/* Export Button */}
                  <button
                    onClick={handleExportVideoDispatch}
                    disabled={isRendering || !audioSrc}
                    className="p-2 rounded-lg hover:bg-white/10 text-zinc-400 hover:text-white cursor-pointer transition-colors"
                    title={`${tr('Export as Video')} (${renderEngine === 'ffmpeg' ? 'FFmpeg' : 'MediaRecorder'})`}
                  >
                    <Video size={18} />
                  </button>


                </div>
              </div>
            </div>
          </div>
        </div>
        </div>{/* end Preview Zone Wrapper */}

        {/* --- Bottom Timeline Editor or Playlist --- */}
        {isPlaylistMode ? (
          <div className="no-minimal-mode-toggle animate-slide-up border-t border-white/10 z-30 shrink-0 w-full max-w-full overflow-hidden">
            <PlaylistEditor
              playlist={playlist}
              setPlaylist={setPlaylist}
              currentTrackIndex={currentTrackIndex}
              setCurrentTrackIndex={setCurrentTrackIndex}
              onPlayTrack={playTrack}
              isPlaying={isPlaying}
              onTogglePlay={togglePlay}
              currentTime={currentTime}
              onSeek={(time) => {
                if (audioRef.current && !isRendering) {
                  audioRef.current.currentTime = time;
                  setCurrentTime(time);
                }
              }}
              onClearPlaylist={() => {
                // Stop playback and clear audio state
                stopPlayback();
                setAudioSrc(null);
                setLyrics([]);
                setCurrentTrackIndex(-1);
                setMetadata({ title: 'No Audio Loaded', artist: 'Select a file', coverUrl: null, backgroundType: 'image' });
              }}
              onRemoveTrack={(index) => {
                if (index === currentTrackIndex) {
                  stopPlayback();
                  setAudioSrc(null);
                  setLyrics([]);
                  setCurrentTrackIndex(-1);
                  setMetadata({ title: 'No Audio Loaded', artist: 'Select a file', coverUrl: null, backgroundType: 'image' });
                } else if (index < currentTrackIndex) {
                  setCurrentTrackIndex(prev => prev - 1);
                }
                setPlaylist(prev => {
                  const newList = [...prev];
                  newList.splice(index, 1);
                  return newList;
                });
              }}
              onClose={() => setIsPlaylistMode(false)}
            />
          </div>
        ) : (
          activeTab === TabView.EDITOR && (
            <div className="no-minimal-mode-toggle animate-slide-up border-t border-white/10 z-30 shrink-0 w-full max-w-full overflow-hidden min-w-0">
              <VisualEditor
                slides={visualSlides}
                setSlides={setVisualSlides}
                currentTime={currentTime}
                duration={duration || 60}
                lyrics={lyrics}
                onSeek={(time) => {
                  if (audioRef.current && !isRendering) {
                    audioRef.current.currentTime = time;
                    setCurrentTime(time);
                  }
                }}
                onClose={() => setActiveTab(TabView.PLAYER)}
                renderConfig={renderConfig}
                setRenderConfig={setRenderConfig}
              />
            </div>
          )
        )}

      </div>



      {/* Rendering Overlay */}
      {
        isRendering && (
          <div className="absolute inset-0 z-50 bg-black/90 flex flex-col items-center justify-center p-8 text-center space-y-6">
            <div className={renderEngine === 'ffmpeg' ? "animate-pulse" : "animate-bounce"}>
              <Video size={48} className={renderEngine === 'ffmpeg' ? "text-orange-500" : "text-amber-500"} />
            </div>
            <h2 className="text-2xl font-bold text-white">
              {renderEngine === 'ffmpeg' ? 'FFmpeg Rendering' : 'Rendering Video'} ({aspectRatio} {resolution})
            </h2>
            <p className="text-zinc-400 max-w-md">
              {renderEngine === 'ffmpeg' ? (
                <>
                  Frame-by-frame capture using FFmpeg WASM.<br />
                  <span className="text-orange-400 font-medium">{ffmpegRenderStage || 'Initializing...'}</span><br />
                  This is faster than realtime - no audio playback needed.
                </>
              ) : (
                <>
                  Rendering in real-time using Canvas 2D engine.<br />
                  The audio will play during capture.<br />
                  Please keep this tab active for best performance.
                </>
              )}
            </p>

            <div className="w-full max-w-md h-2 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ease-linear ${renderEngine === 'ffmpeg' ? 'bg-orange-500' : 'bg-amber-500'}`}
                style={{ width: `${renderProgress}%` }}
              ></div>
            </div>
            <p className="text-sm font-mono text-zinc-500">{Math.round(renderProgress)}%</p>

            <button
              onClick={handleAbortRender}
              className="mt-4 px-6 py-2 bg-red-500/20 text-red-400 hover:bg-red-500/30 hover:text-red-300 rounded-full transition-colors flex items-center gap-2 border border-red-500/50"
            >
              <Square size={16} fill="currentColor" />
              Abort Rendering
            </button>
          </div>
        )
      }

      {
        showRenderSettings && (
          <RenderSettings
            config={renderConfig}
            setConfig={setRenderConfig}
            preset={preset}
            setPreset={setPreset}
            onClose={() => setShowRenderSettings(false)}
            isPlaylistMode={isPlaylistMode}
            hasPlaylist={playlist.length > 0}
            onRender={handleExportVideoDispatch}
            customFontName={customFontName}
            onFontUpload={handleFontUpload}
            onClearCustomFont={() => {
              setCustomFontName(null);
              setRenderConfig(prev => ({ ...prev, fontFamily: 'ui-sans-serif, system-ui, sans-serif' }));
            }}
            customChannelFontName={customChannelFontName}
            onChannelFontUpload={handleChannelFontUpload}
            onClearChannelCustomFont={() => {
              setCustomChannelFontName(null);
              setRenderConfig(prev => ({ ...prev, channelInfoFontFamily: undefined }));
            }}
            customInfoFontName={customInfoFontName}
            onInfoFontUpload={handleInfoFontUpload}
            onClearInfoCustomFont={() => {
              setCustomInfoFontName(null);
              setRenderConfig(prev => ({ ...prev, infoFontFamily: undefined }));
            }}
            resolution={resolution}
            setResolution={setResolution}
            aspectRatio={aspectRatio}
            setAspectRatio={setAspectRatio}
            renderCodec={renderCodec}
            setRenderCodec={setRenderCodec}
            supportedCodecs={supportedCodecs}
            renderQuality={renderQuality}
            setRenderQuality={setRenderQuality}
            renderFps={renderFps}
            setRenderFps={setRenderFps}
            renderEngine={renderEngine}
            setRenderEngine={setRenderEngine}
            ffmpegCodec={ffmpegCodec}
            setFfmpegCodec={setFfmpegCodec}
          />
        )
      }

      {/* Shortcut Info Overlay */}
      {
        showShortcutInfo && (
          <div
            className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200"
            onClick={() => setShowShortcutInfo(false)}
          >
            <div
              className="no-minimal-mode-toggle bg-zinc-900 border border-white/10 rounded-2xl p-6 max-w-2xl w-full max-h-[80vh] overflow-y-auto custom-scrollbar shadow-2xl relative"
              onClick={e => e.stopPropagation()}
            >
              <button
                onClick={() => setShowShortcutInfo(false)}
                className="absolute top-4 right-4 p-2 rounded-full hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
              >
                <X size={20} />
              </button>
              <h2 className="text-2xl font-bold text-white mb-6 flex items-center gap-2">
                <Keyboard className="text-amber-500" />
                {tr('Keyboard Shortcuts')}
              </h2>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-6">
                <div className="space-y-4">
                  <h3 className="text-sm font-bold text-zinc-500 uppercase tracking-wider">{tr('Playback')}</h3>
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Play / Pause')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">{tr('Space')}</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Stop')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">{tr('S / V')}</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Previous Song')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">B</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Next Song')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">N</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Rewind 5s')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">←</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Forward 5s')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">→</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Repeat Mode')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">R</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Mute')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">M</span></div>
                  </div>

                  <h3 className="text-sm font-bold text-zinc-500 uppercase tracking-wider mt-6">{tr('File Loading')}</h3>
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Load Audio / Video')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">1</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Load Lyrics / Sub-file')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">2</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Load Font File')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">3</span></div>
                  </div>

                  <h3 className="text-sm font-bold text-zinc-500 uppercase tracking-wider mt-6">{tr('Interface')}</h3>
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Fullscreen')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">F</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Minimal Mode')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">O</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Hold UI (No Auto-Hide)')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">H</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Toggle Header Info')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">I</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Toggle Shortcut Info')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">K</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Toggle Player')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">Y</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Lyric Visibility: Default / Auto')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">Q</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('UI Scale (Zoom / Reset)')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">8 / 9 / 0</span></div>
                  </div>
                </div>

                <div className="space-y-4">
                  <h3 className="text-sm font-bold text-zinc-500 uppercase tracking-wider">{tr('Editor & Styles')}</h3>
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Toggle Timeline')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">T</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Toggle Playlist')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">P</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Render Settings')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">D</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Random Settings')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">L</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Export Video')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">Ctrl+Shift+E</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Font Size')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">+ / -</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Cycle Visual Preset')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">J</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Cycle Highight Effect')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">Z</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Toggle Highlight')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">X</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Cycle Text Case')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">C</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Cycle Lyric Mode')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">G</span></div>
                  </div>


                  <h3 className="text-sm font-bold text-zinc-500 uppercase tracking-wider mt-6">{tr('Mouse & Touch')}</h3>
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Toggle Minimal Mode')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">{tr('Double Click / Tap')}</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Seek to Lyric')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">{tr('Click Line')}</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-300">{tr('Copy Active Lyric')}</span> <span className="font-mono text-amber-400 bg-white/5 px-2 py-0.5 rounded">{tr('Click Active Line')}</span></div>
                  </div>
                </div>
              </div>

              <div className="mt-8 pt-6 border-t border-white/5 text-center">
                <p className="text-zinc-500 text-sm">
                  {tr('Shortcuts are disabled during video rendering.')}
                </p>
              </div>
            </div>
          </div>
        )
      }
    </div >
  );
}

export default App;