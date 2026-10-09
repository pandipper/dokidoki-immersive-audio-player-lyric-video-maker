import { zh } from './zh';
import { zhPanels } from './zhPanels';

export type Lang = 'zh' | 'en';

export const LANG_STORAGE_KEY = 'dokidoki_lang';

const dictionaries: Record<Lang, Record<string, string>> = {
    zh: { ...zhPanels, ...zh },
    // 英文即原文，不需要字典；保留空表以便未来扩展
    en: {},
};

/**
 * 翻译一条界面文案。
 *
 * 以英文原文为 key 查表，查不到就原样返回英文 —— 这样即使有漏翻的词条，
 * 界面也只会显示英文，而不会出现空白或 `undefined`。
 */
export const translate = (en: string, lang: Lang): string => {
    if (lang === 'en') return en;
    return dictionaries[lang]?.[en] ?? en;
};

/**
 * 当前语言的**进程内缓存**。
 *
 * 设置面板里有数百个文案调用点，如果每次 `t()` 都去读一次 localStorage，
 * 一次渲染就会产生几百次同步 IO，明显拖慢面板。所以这里缓存一份，
 * 由 `saveLang()` 负责失效。
 */
let cachedLang: Lang | null = null;

export const loadLang = (): Lang => {
    if (cachedLang) return cachedLang;
    try {
        const saved = localStorage.getItem(LANG_STORAGE_KEY);
        if (saved === 'zh' || saved === 'en') {
            cachedLang = saved;
            return saved;
        }
    } catch {
        /* 隐私模式下 localStorage 不可用 */
    }
    cachedLang = 'zh';
    return cachedLang;
};

export const saveLang = (lang: Lang) => {
    cachedLang = lang;
    try {
        localStorage.setItem(LANG_STORAGE_KEY, lang);
    } catch {
        /* 忽略 */
    }
};
