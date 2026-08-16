/**
 * pages — every user-facing HTML page and its copy tokens.
 *
 * The proxy gate renders exactly two pages (the token login and the
 * first-visit approval wait). All copy lives here as zh/en token
 * dictionaries, selected by Accept-Language (zh stays the default, matching
 * the harness fallback locale). Page functions are pure: inputs in, HTML
 * string out — nothing touches sockets or stores.
 */
import type { IncomingMessage } from 'node:http'
import { escapeHtml } from './http-util.ts'

/** Page locale: zh is the default, 'en' for explicit non-zh headers. */
export type PageLocale = 'zh' | 'en'

/** Proxy-internal route prefix (underscored so it cannot collide with the
 *  host's control surface). */
export const LOGIN_PATH = '/_dsh_reverse_proxy/login'

/** Shared card chrome for both pages (light + dark). */
const CARD_CSS = `
  :root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}
  body{min-height:100dvh;margin:0;display:grid;place-items:center;padding:24px;
    background:radial-gradient(70% 46% at 50% -8%,#d7e4f4 0%,transparent 64%),#eef2f6;color:#15171a}
  .card{box-sizing:border-box;width:min(92vw,400px);padding:28px 28px 24px;border:1px solid #d5dbe3;border-radius:20px;background:#fff;box-shadow:0 18px 50px #1220331f}
  .kicker{margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#6a7380}
  h1{font-size:22px;margin:0 0 8px;letter-spacing:-.02em}
  p{font-size:14px;line-height:1.6;color:#5b6470}
  @media(prefers-color-scheme:dark){
    body{background:radial-gradient(70% 46% at 50% -8%,#243044 0%,transparent 64%),#111418;color:#f7f8fa}
    .card{background:#1b1f24;border-color:#343a43;box-shadow:0 18px 50px #0008}
    .kicker{color:#8b95a3}p{color:#aeb6c2}
  }`

const LOGIN_EXTRA_CSS = `label{display:block;font-size:13px;font-weight:600;margin:22px 0 8px}input,button{box-sizing:border-box;width:100%;min-height:48px;border-radius:12px;font:inherit}input{padding:0 14px;border:1px solid #c8ced7;background:transparent;color:inherit}button{margin-top:14px;border:0;background:#111;color:#fff;font-weight:650;cursor:pointer}@media(prefers-color-scheme:dark){input{border-color:#4b535e}button{background:#f7f8fa;color:#111}}@media(prefers-reduced-motion:no-preference){button{transition:transform .15s ease}button:active{transform:scale(.98)}}`

const WAIT_EXTRA_CSS = `.device{font-size:13px;color:#8a93a0;margin-top:14px}.spinner{width:18px;height:18px;border:2px solid #c8ced7;border-top-color:#111;border-radius:50%;margin-top:22px;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-color-scheme:dark){.device{color:#7c8694}.spinner{border-color:#4b535e;border-top-color:#f7f8fa}}`

export const LOGIN_COPY = {
  zh: {
    title: 'DeepSeek Harness 远程访问',
    intro: '此入口由通用反向代理保护。请输入本机控制面显示的访问令牌。',
    inviteHint: '正在使用一次性邀请登录…',
    label: '访问令牌',
    submit: '进入 DeepSeek Harness',
    invalidToken: '令牌无效，请重试。',
    invalidInvite: '邀请已失效或已使用，请重新生成。',
    invalidRequest: '请求无效，请重试。',
  },
  en: {
    title: 'DeepSeek Harness remote access',
    intro: 'This entry is protected by a reverse proxy. Enter the access token shown in the local control panel.',
    inviteHint: 'Signing in with a one-time invite…',
    label: 'Access token',
    submit: 'Enter DeepSeek Harness',
    invalidToken: 'Invalid token, please retry.',
    invalidInvite: 'This invite expired or was already used. Generate a new one.',
    invalidRequest: 'Invalid request, please retry.',
  },
}

export const WAIT_COPY = {
  zh: {
    title: '等待审批',
    intro: '此设备已提交访问请求，请在本机控制面板中批准。',
    pending: '等待批准中…',
    rejected: '访问请求被拒绝。',
    expired: '会话已失效，请重新登录。',
  },
  en: {
    title: 'Waiting for approval',
    intro: 'This device has requested access. Approve it from the local control panel.',
    pending: 'Waiting for approval…',
    rejected: 'Access request was rejected.',
    expired: 'This session expired. Please sign in again.',
  },
}

/** Pick the page locale: zh default, 'en' for explicit non-zh headers. */
export function loginLocale(req: IncomingMessage): PageLocale {
  const header = String(req.headers['accept-language'] ?? '').toLowerCase()
  if (header !== '' && !header.startsWith('zh')) return 'en'
  return 'zh'
}

function shell(locale: PageLocale, title: string) {
  return `<!doctype html><html lang="${locale === 'en' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${title}</title><style>${CARD_CSS}`
}

/** Token login gate. `error` is always one of our own copy tokens.
 *  Prefill comes only from invite links (`?invite=`); token values are never
 *  placed in the URL or the form to avoid leaking them through history. */
export function loginPage(locale: PageLocale, error = '', prefill: { invite?: string } = {}) {
  const copy = LOGIN_COPY[locale] ?? LOGIN_COPY.zh
  const message = error === '' ? '' : `<p role="alert">${error}</p>`
  const invite = String(prefill.invite ?? '')
  const safeInvite = escapeHtml(invite.slice(0, 128))
  const useInvite = safeInvite !== ''
  const autoSubmit = useInvite
    ? `<script>document.addEventListener('DOMContentLoaded',function(){var f=document.getElementById('login');if(f)f.requestSubmit()})</script>`
    : ''
  const fields = useInvite
    ? `<input type="hidden" name="invite" value="${safeInvite}"><p>${copy.inviteHint}</p><button type="submit">${copy.submit}</button>`
    : `<label for="token">${copy.label}</label><input id="token" name="token" type="password" autocomplete="current-password" required autofocus><button type="submit">${copy.submit}</button>`
  return `${shell(locale, copy.title)}${LOGIN_EXTRA_CSS}</style></head><body><main class="card"><p class="kicker">dsh-full-remote</p><h1>${copy.title}</h1><p>${copy.intro}</p>${message}<form id="login" method="post" action="${LOGIN_PATH}">${fields}</form>${autoSubmit}</main></body></html>`
}


/** First-visit approval waiting page: polls its own session status. */
export function waitPage(locale: PageLocale, id: string, label: string) {
  const copy = WAIT_COPY[locale] ?? WAIT_COPY.zh
  const safeId = escapeHtml(id)
  const safeLabel = escapeHtml(label)
  const rejected = copy.rejected.replaceAll("'", "\\'")
  const expired = copy.expired.replaceAll("'", "\\'")
  const poll = `fetch('/_dsh_reverse_proxy/wait/${safeId}/status',{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.json()}).then(function(d){if(d.status==='active'){location.href='/'}else if(d.status==='rejected'){clearInterval(t);document.getElementById('state').textContent='${rejected}'}else if(d.status==='unknown'){clearInterval(t);document.getElementById('state').textContent='${expired}'}},function(){})`
  return `${shell(locale, copy.title)}${WAIT_EXTRA_CSS}</style></head><body><main class="card"><p class="kicker">dsh-full-remote</p><h1>${copy.title}</h1><p>${copy.intro}</p><p class="device">${safeLabel}</p><div class="spinner" aria-hidden="true"></div><p id="state">${copy.pending}</p><script>var t=setInterval(function(){${poll}},2000)</script></main></body></html>`
}
