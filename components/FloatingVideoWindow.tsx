import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GripVertical, Minus, Music } from './Icons';

/**
 * FloatingVideoWindow —— 左侧边缘垂直居中的悬浮视频小窗。
 *
 * 设计要点：
 *  - 这个窗口**承载播放器本体**（<video> 作为 children 传进来），
 *    而不是另开一路视频流。这样音画永远同步，也不会出现两套解码器。
 *  - 隐藏时用 `opacity: 0 + pointer-events: none`，绝不用 `display: none`：
 *    媒体元素一旦 `display: none`，部分浏览器会暂停视频帧的解码，
 *    重新显示时会有明显黑屏/卡顿；`opacity` 则完全不影响解码与播放。
 *  - 位置/尺寸/可见性都持久化到 localStorage，重启后保持不变。
 */

const STORAGE_KEY = 'dokidoki_video_window';

interface PersistedState {
    x: number;
    y: number;          // 窗口中心点的 Y 坐标（px）
    width: number;
    visible: boolean;
    hasUserResized: boolean;
}

const DEFAULT_STATE: PersistedState = {
    x: 20,
    y: 0,               // 0 表示「跟随视口垂直居中」，首次挂载时再算真实值
    width: 340,
    visible: true,
    hasUserResized: false,
};

const MIN_WIDTH = 140;
const MIN_ASPECT_FALLBACK = 16 / 9;

function loadState(): PersistedState {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { ...DEFAULT_STATE };
        const parsed = JSON.parse(raw);
        return { ...DEFAULT_STATE, ...parsed };
    } catch {
        return { ...DEFAULT_STATE };
    }
}

function saveState(state: PersistedState) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
        /* localStorage 不可用（隐私模式）时静默忽略 */
    }
}

interface FloatingVideoWindowProps {
    /** 视频宽高比；<= 0 表示这是纯音频文件，窗口内显示音符占位 */
    aspect: number;
    /** 媒体文件名，显示在标题栏 */
    title: string;
    /** 当前是否可见 */
    visible: boolean;
    onVisibleChange: (visible: boolean) => void;
    /** 缩放比例补偿：根容器用 transform: scale(uiScale) 做了整体缩放 */
    uiScale: number;
    /** 是否处于渲染导出中（此时禁止交互） */
    disabled?: boolean;
    children: React.ReactNode;
}

const FloatingVideoWindow: React.FC<FloatingVideoWindowProps> = ({
    aspect,
    title,
    visible,
    onVisibleChange,
    uiScale,
    disabled = false,
    children,
}) => {
    const initial = useMemo(loadState, []);
    const [x, setX] = useState(initial.x);
    const [y, setY] = useState(() => (initial.y > 0 ? initial.y : window.innerHeight / 2));
    const [width, setWidth] = useState(initial.width);
    const [hasUserResized, setHasUserResized] = useState(initial.hasUserResized);
    const [isHovered, setIsHovered] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const [isResizing, setIsResizing] = useState(false);

    const dragStateRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
    const resizeStateRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

    const safeAspect = aspect > 0 ? aspect : MIN_ASPECT_FALLBACK;
    const height = width / safeAspect;

    // 持久化
    useEffect(() => {
        saveState({ x, y, width, visible, hasUserResized });
    }, [x, y, width, visible, hasUserResized]);

    // 视口尺寸变化时，把窗口拉回可视范围内
    useEffect(() => {
        const handleResize = () => {
            setY(prev => Math.min(Math.max(prev, 60), window.innerHeight - 60));
            setX(prev => Math.min(Math.max(prev, 0), Math.max(0, window.innerWidth - 80)));
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    // 首次拿到真实视频比例时，自动选一个合适的初始宽度（用户手动调过就不再干预）
    useEffect(() => {
        if (hasUserResized || aspect <= 0) return;
        const targetWidth = aspect >= 1 ? 340 : 340 * aspect;
        setWidth(Math.round(Math.max(MIN_WIDTH, targetWidth)));
    }, [aspect, hasUserResized]);

    const handleDragStart = useCallback((e: React.PointerEvent) => {
        if (disabled) return;
        e.stopPropagation();
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        dragStateRef.current = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            originX: x,
            originY: y,
        };
        setIsDragging(true);
    }, [disabled, x, y]);

    const handleDragMove = useCallback((e: React.PointerEvent) => {
        const st = dragStateRef.current;
        if (!st || st.pointerId !== e.pointerId) return;
        e.stopPropagation();
        // 根容器有 scale(uiScale)，鼠标位移要除以缩放系数才是元素自身的位移
        const scale = uiScale || 1;
        const dx = (e.clientX - st.startX) / scale;
        const dy = (e.clientY - st.startY) / scale;
        const halfH = (width / safeAspect) / 2;
        setX(Math.min(Math.max(st.originX + dx, 0), Math.max(0, window.innerWidth - 60)));
        setY(Math.min(Math.max(st.originY + dy, halfH + 8), window.innerHeight - halfH - 8));
    }, [uiScale, width, safeAspect]);

    const handleDragEnd = useCallback((e: React.PointerEvent) => {
        const st = dragStateRef.current;
        if (!st || st.pointerId !== e.pointerId) return;
        e.stopPropagation();
        dragStateRef.current = null;
        setIsDragging(false);
    }, []);

    const handleResizeStart = useCallback((e: React.PointerEvent) => {
        if (disabled) return;
        e.stopPropagation();
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        resizeStateRef.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: width };
        setIsResizing(true);
    }, [disabled, width]);

    const handleResizeMove = useCallback((e: React.PointerEvent) => {
        const st = resizeStateRef.current;
        if (!st || st.pointerId !== e.pointerId) return;
        e.stopPropagation();
        const scale = uiScale || 1;
        const dx = (e.clientX - st.startX) / scale;
        const maxWidth = Math.max(MIN_WIDTH, window.innerWidth * 0.6);
        setWidth(Math.min(Math.max(st.startWidth + dx, MIN_WIDTH), maxWidth));
        setHasUserResized(true);
    }, [uiScale]);

    const handleResizeEnd = useCallback((e: React.PointerEvent) => {
        const st = resizeStateRef.current;
        if (!st || st.pointerId !== e.pointerId) return;
        e.stopPropagation();
        resizeStateRef.current = null;
        setIsResizing(false);
    }, []);

    const chromeVisible = (isHovered || isDragging || isResizing) && !disabled;

    return (
        <div
            className="absolute z-[80] select-none"
            style={{
                left: `${x}px`,
                top: `${y}px`,
                width: `${width}px`,
                transform: 'translateY(-50%)',
                opacity: visible ? 1 : 0,
                pointerEvents: visible && !disabled ? 'auto' : 'none',
                transition: isDragging || isResizing ? 'none' : 'opacity 300ms ease',
            }}
            onPointerEnter={() => setIsHovered(true)}
            onPointerLeave={() => setIsHovered(false)}
            onPointerDown={e => e.stopPropagation()}
            onPointerMove={e => e.stopPropagation()}
            onDoubleClick={e => e.stopPropagation()}
        >
            {/* 窗口本体 */}
            <div
                className={`relative rounded-xl overflow-hidden bg-black ring-1 transition-shadow duration-300 ${chromeVisible
                    ? 'ring-amber-400/50 shadow-[0_0_0_1px_rgba(0,0,0,0.6),0_18px_48px_-12px_rgba(0,0,0,0.9)]'
                    : 'ring-white/10 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.85)]'
                    }`}
                style={{ height: `${height}px` }}
            >
                {/* 媒体本体 */}
                <div className="absolute inset-0">
                    {children}
                </div>

                {/* 纯音频占位 */}
                {aspect <= 0 && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-zinc-600 pointer-events-none">
                        <Music size={Math.max(18, Math.min(40, width * 0.16))} />
                        <span className="text-[10px] tracking-wide">纯音频</span>
                    </div>
                )}

                {/* 拖拽 / 标题栏 */}
                <div
                    className="absolute inset-x-0 top-0 h-7 flex items-center gap-1.5 px-2 cursor-grab active:cursor-grabbing"
                    style={{
                        background: chromeVisible ? 'linear-gradient(to bottom, rgba(0,0,0,0.85), rgba(0,0,0,0))' : 'transparent',
                        opacity: chromeVisible ? 1 : 0,
                        transition: 'opacity 200ms ease',
                    }}
                    onPointerDown={handleDragStart}
                    onPointerMove={handleDragMove}
                    onPointerUp={handleDragEnd}
                    onPointerCancel={handleDragEnd}
                    title="拖动移动窗口"
                >
                    <GripVertical size={13} className="text-amber-400/80 shrink-0" />
                    <span className="text-[10px] text-zinc-300 truncate flex-1">{title || '视频'}</span>
                    <button
                        className="p-0.5 rounded text-zinc-400 hover:text-white hover:bg-white/15 transition-colors shrink-0"
                        title="隐藏视频窗口"
                        onPointerDown={e => e.stopPropagation()}
                        onClick={e => { e.stopPropagation(); onVisibleChange(false); }}
                    >
                        <Minus size={12} />
                    </button>
                </div>

                {/* 缩放手柄 */}
                <div
                    className="absolute bottom-0 right-0 w-5 h-5 cursor-nwse-resize"
                    style={{
                        opacity: chromeVisible ? 1 : 0,
                        transition: 'opacity 200ms ease',
                        background: 'linear-gradient(135deg, transparent 50%, rgba(251,191,36,0.55) 50%)',
                        borderBottomRightRadius: '0.75rem',
                    }}
                    onPointerDown={handleResizeStart}
                    onPointerMove={handleResizeMove}
                    onPointerUp={handleResizeEnd}
                    onPointerCancel={handleResizeEnd}
                    title="拖动缩放窗口"
                />
            </div>
        </div>
    );
};

export default FloatingVideoWindow;
