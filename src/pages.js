/**
 * pages — every user-facing HTML page and its copy tokens.
 *
 * The proxy gate renders exactly two pages (the token login and the
 * first-visit approval wait). All copy lives here as zh/en token
 * dictionaries, selected by Accept-Language (zh stays the default, matching
 * the harness fallback locale). Page functions are pure: inputs in, HTML
 * string out — nothing touches sockets or stores.
 */
import { escapeHtml } from './http-util.js'

/** Proxy-internal route prefix (underscored so it cannot collide with the
 *  host's control surface). */
export const LOGIN_PATH = '/_dsh_reverse_proxy/login'

/** Shared card chrome for both pages (light + dark). */
const CARD_CSS = `
  :root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}body{min-height:100dvh;margin:0;display:grid;place-items:center;background:#f4f6f8;color:#15171a}.card{box-sizing:border-box;width:min(92vw,420px);padding:28px;border:1px solid #d9dde3;border-radius:20px;background:#fff;box-shadow:0 16px 48px #0002}h1{font-size:22px;margin:0 0 8px}p{font-size:14px;line-height:1.6;color:#5b6470}@media(prefers-color-scheme:dark){body{background:#111418;color:#f7f8fa}.card{background:#1b1f24;border-color:#343a43}p{color:#aeb6c2}}`

const LOGIN_EXTRA_CSS = `label{display:block;font-size:13px;font-weight:600;margin:22px 0 8px}input,button{box-sizing:border-box;width:100%;min-height:48px;border-radius:12px;font:inherit}input{padding:0 14px;border:1px solid #c8ced7;background:transparent;color:inherit}button{margin-top:14px;border:0;background:#111;color:#fff;font-weight:650;cursor:pointer}@media(prefers-color-scheme:dark){input{border-color:#4b535e}button{background:#f7f8fa;color:#111}}@media(prefers-reduced-motion:no-preference){button{transition:transform .15s ease}button:active{transform:scale(.98)}}`

const WAIT_EXTRA_CSS = `.device{font-size:13px;color:#8a93a0;margin-top:14px}.spinner{width:18px;height:18px;border:2px solid #c8ced7;border-top-color:#111;border-radius:50%;margin-top:22px;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-color-scheme:dark){.device{color:#7c8694}.spinner{border-color:#4b535e;border-top-color:#f7f8fa}}`

export const LOGIN_COPY = {
  zh: {
    title: 'DeepSeek Harness 远程访问',
    intro: '此入口由通用反向代理保护。请输入本机控制面显示的访问令牌。',
    label: '访问令牌',
    submit: '进入 DeepSeek Harness',
    invalidToken: '令牌无效，请重试。',
    invalidRequest: '请求无效，请重试。',
  },
  en: {
    title: 'DeepSeek Harness remote access',
    intro: 'This entry is protected by a reverse proxy. Enter the access token shown in the local control panel.',
    label: 'Access token',
    submit: 'Enter DeepSeek Harness',
    invalidToken: 'Invalid token, please retry.',
    invalidRequest: 'Invalid request, please retry.',
  },
}

export const WAIT_COPY = {
  zh: {
    title: '等待审批',
    intro: '此设备已提交访问请求，请在本机控制面板中批准。',
    pending: '等待批准中…',
    rejected: '访问请求被拒绝。',
  },
  en: {
    title: 'Waiting for approval',
    intro: 'This device has requested access. Approve it from the local control panel.',
    pending: 'Waiting for approval…',
    rejected: 'Access request was rejected.',
  },
}

/** Pick the page locale: zh default, 'en' for explicit non-zh headers. */
export function loginLocale(req) {
  const header = String(req.headers['accept-language'] ?? '').toLowerCase()
  if (header !== '' && !header.startsWith('zh')) return 'en'
  return 'zh'
}

function shell(locale, title) {
  return `<!doctype html><html lang="${locale === 'en' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${title}</title><style>${CARD_CSS}`
}

/** Token login gate. `error` is always one of our own copy tokens. */
export function loginPage(locale, error = '') {
  const copy = LOGIN_COPY[locale] ?? LOGIN_COPY.zh
  const message = error === '' ? '' : `<p role="alert">${error}</p>`
  return `${shell(locale, copy.title)}${LOGIN_EXTRA_CSS}</style></head><body><main class="card"><h1>${copy.title}</h1><p>${copy.intro}</p>${message}<form method="post" action="${LOGIN_PATH}"><label for="token">${copy.label}</label><input id="token" name="token" type="password" autocomplete="current-password" required autofocus><button type="submit">${copy.submit}</button></form></main></body></html>`
}

/** First-visit approval waiting page: polls its own session status. */
export function waitPage(locale, id, label) {
  const copy = WAIT_COPY[locale] ?? WAIT_COPY.zh
  const safeId = escapeHtml(id)
  const safeLabel = escapeHtml(label)
  const rejected = copy.rejected.replaceAll("'", "\\'")
  const poll = `fetch('/_dsh_reverse_proxy/wait/${safeId}/status',{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.json()}).then(function(d){if(d.status==='active'){location.href='/'}else if(d.status==='rejected'||d.status==='unknown'){clearInterval(t);document.getElementById('state').textContent='${rejected}'}},function(){})`
  return `${shell(locale, copy.title)}${WAIT_EXTRA_CSS}</style></head><body><main class="card"><h1>${copy.title}</h1><p>${copy.intro}</p><p class="device">${safeLabel}</p><div class="spinner" aria-hidden="true"></div><p id="state">${copy.pending}</p><script>var t=setInterval(function(){${poll}},2000)</script></main></body></html>`
}
