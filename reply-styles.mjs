import './extension/reply-style-catalog.js';
export const REPLY_STYLES=globalThis.XReplyStyleCatalog.styles;
export const REPLY_STYLE_LABELS=globalThis.XReplyStyleCatalog.labels;
export const LEGACY_REPLY_STYLES=globalThis.XReplyStyleCatalog.legacy;
export const REPLY_STYLE_IDS=Object.freeze(REPLY_STYLES.map(item=>item.id));
