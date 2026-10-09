import { zh } from './zh';

export type Lang = 'zh' | 'en';

export const LANG_STORAGE_KEY = 'dokidoki_lang';

const dictionaries: Record<Lang, Record<string, string>> = {
    zh,
    // 英文即原文，不需要字典；保留空表以便未来扩展
    en: {},
};

/**
 * 翻译一条主界面文案。
 *
 * 以英文原文为 key 查表，查不到就原样返回英文 —— 这样即使有漏翻的词条，
 * 界面也只会显示英文，而不会出现空白或 `undefined`。
 */
export const translate = (en: string, lang: Lang): string => {
    if (lang === 'en') return en;
    return dictionaries[lang]?.[en] ?? en;
};

export const loadLang = (): Lang => {
    try {
        const saved = localStorage.getItem(LANG_STORAGE_KEY);
        if (saved === 'zh' || saved === 'en') return saved;
    } catch {
        /* 隐私模式下 localStorage 不可用 */
    }
    return 'zh';
};

export const saveLang = (lang: Lang) => {
    try {
        localStorage.setItem(LANG_STORAGE_KEY, lang);
    } catch {
        /* 忽略 */
    }
};
