import React, { useEffect, useState } from 'react';
import { AlertTriangle, X } from './Icons';
import { translate, loadLang } from '../locales';

interface ConfirmModalProps {
    isOpen: boolean;
    message: string;
    onConfirm: () => void;
    onCancel: () => void;
    title?: string;
}

// 这个组件由 UIProvider 直接渲染，拿不到 App 的 lang state，
// 所以每次渲染时从 localStorage 读取当前语言即可。
const t = (s: string) => translate(s, loadLang());

const ConfirmModal: React.FC<ConfirmModalProps> = ({ isOpen, message, onConfirm, onCancel, title }) => {
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
        if (isOpen) {
            setIsVisible(true);
        } else {
            setTimeout(() => setIsVisible(false), 300);
        }
    }, [isOpen]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!isOpen) return;

            if (e.key === 'Enter') {
                e.preventDefault();
                onConfirm();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                onCancel();
            }
        };

        if (isOpen) {
            window.addEventListener('keydown', handleKeyDown);
        }

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [isOpen, onConfirm, onCancel]);

    if (!isOpen && !isVisible) return null;

    return (
        <div className={`fixed inset-0 z-[9999] flex items-center justify-center p-4 transition-all duration-300 ${isOpen ? 'opacity-100' : 'opacity-0'}`}>
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
                onClick={onCancel}
            ></div>

            {/* Modal */}
            <div className={`
        relative bg-zinc-900 border border-white/10 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden transform transition-all duration-300
        ${isOpen ? 'scale-100 translate-y-0' : 'scale-95 translate-y-4'}
      `}>
                <div className="p-6">
                    <div className="flex items-start gap-4">
                        <div className="p-3 bg-orange-500/10 rounded-full shrink-0">
                            <AlertTriangle className="text-orange-500" size={24} />
                        </div>
                        <div className="flex-1">
                            <h3 className="text-lg font-bold text-white mb-2">{title || t('Confirm Action')}</h3>
                            <p className="text-zinc-400 text-sm leading-relaxed">
                                {message}
                            </p>
                        </div>
                        <button
                            onClick={onCancel}
                            className="text-zinc-500 hover:text-white transition-colors"
                        >
                            <X size={20} />
                        </button>
                    </div>
                </div>

                <div className="flex items-center justify-end gap-3 p-4 bg-zinc-950/50 border-t border-white/5">
                    <button
                        onClick={onCancel}
                        className="px-4 py-2 text-sm font-medium text-zinc-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors"
                    >
                        {t('Cancel')}
                    </button>
                    <button
                        onClick={onConfirm}
                        className="px-4 py-2 text-sm font-medium text-black bg-amber-500 hover:bg-amber-400 rounded-lg shadow-lg hover:shadow-amber-500/20 transition-all"
                    >
                        {t('Confirm')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ConfirmModal;
