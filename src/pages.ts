/**
 * pages — every user-facing HTML page and its copy tokens.
 *
 * The proxy gate renders three pages (token login, approval wait, device
 * home) plus healthz. All copy lives here as zh/en token dictionaries,
 * selected by Accept-Language (zh stays the default, matching the harness
 * fallback locale). Page functions are pure: inputs in, HTML string out —
 * nothing touches sockets or stores.
 */
import type { IncomingMessage } from 'node:http'
import { escapeHtml } from './http-util.ts'

/** Page locale: zh is the default, 'en' for explicit non-zh headers. */
export type PageLocale = 'zh' | 'en'

/** Proxy-internal route prefix (underscored so it cannot collide with the
 *  host's control surface). */
export const GATE_PREFIX = '/_dsh_reverse_proxy'
export const LOGIN_PATH = `${GATE_PREFIX}/login`
/** Opt-in post-login device hub: session facts, self-rename, logout. */
export const HOME_PATH = `${GATE_PREFIX}/home`
export const HOME_RENAME_PATH = `${HOME_PATH}/rename`
/** Self-service session revocation (own cookie only). */
export const LOGOUT_PATH = `${GATE_PREFIX}/logout`
export const HEALTHZ_PATH = `${GATE_PREFIX}/healthz`
export const WAIT_PREFIX = `${GATE_PREFIX}/wait`

export function waitPagePath(id: string) {
  return `${WAIT_PREFIX}/${id}`
}

export function waitStatusPath(id: string) {
  return `${WAIT_PREFIX}/${id}/status`
}

/** Parse a wait-page or wait-status path. Undefined when it is not a wait route. */
export function parseWaitPath(path: string): { id: string, kind: 'page' | 'status' } | undefined {
  if (!path.startsWith(`${WAIT_PREFIX}/`)) return undefined
  const rest = path.slice(WAIT_PREFIX.length + 1)
  if (rest.endsWith('/status')) {
    const id = rest.slice(0, -'/status'.length)
    if (id !== '' && !id.includes('/')) return { id, kind: 'status' }
    return undefined
  }
  if (rest !== '' && !rest.includes('/')) return { id: rest, kind: 'page' }
  return undefined
}

/** JSON for inline scripts: stringify plus `<` so `</script>` cannot break out. */
function jsValue(value: unknown) {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

/** Shared card chrome for login, wait, and home (light + dark). */
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

const LOGIN_EXTRA_CSS = `label{display:block;font-size:13px;font-weight:600;margin:22px 0 8px}input,button{box-sizing:border-box;width:100%;min-height:48px;border-radius:12px;font:inherit}input{padding:0 14px;border:1px solid #c8ced7;background:transparent;color:inherit}button{margin-top:14px;border:0;background:#111;color:#fff;font-weight:650;cursor:pointer}button.secondary{background:transparent;color:#3d4652;border:1px solid #c8ced7}@media(prefers-color-scheme:dark){input{border-color:#4b535e}button{background:#f7f8fa;color:#111}button.secondary{background:transparent;color:#c9d1dc;border-color:#4b535e}}@media(prefers-reduced-motion:no-preference){button{transition:transform .15s ease}button:active{transform:scale(.98)}}`

const WAIT_EXTRA_CSS = `.device{font-size:13px;color:#8a93a0;margin-top:14px}.spinner{width:18px;height:18px;border:2px solid #c8ced7;border-top-color:#111;border-radius:50%;margin-top:22px;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-color-scheme:dark){.device{color:#7c8694}.spinner{border-color:#4b535e;border-top-color:#f7f8fa}}`

export const LOGIN_COPY = {
  zh: {
    title: 'DeepSeek Harness 远程访问',
    intro: '此入口由通用反向代理保护。请输入本机控制面显示的访问令牌。',
    inviteHint: '正在使用一次性邀请登录…',
    label: '访问令牌',
    submit: '进入 DeepSeek Harness',
    invalidToken: '令牌无效，请重试。',
    invalidInvite: '邀请已失效或已使用。如果刚才已经登录成功，直接打开首页即可；否则请回到控制面板重新生成邀请。',
    invalidRequest: '请求无效，请重试。',
    deviceHome: '设备主页',
  },
  en: {
    title: 'DeepSeek Harness remote access',
    intro: 'This entry is protected by a reverse proxy. Enter the access token shown in the local control panel.',
    inviteHint: 'Signing in with a one-time invite…',
    label: 'Access token',
    submit: 'Enter DeepSeek Harness',
    invalidToken: 'Invalid token, please retry.',
    invalidInvite: 'This invite expired or was already used. If you were just signed in, open the home page directly; otherwise ask the owner to generate a new invite.',
    invalidRequest: 'Invalid request, please retry.',
    deviceHome: 'Device home',
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

export const HOME_COPY = {
  zh: {
    title: '设备主页',
    intro: '你已连接到这台 DeepSeek Harness。',
    via: '当前入口',
    device: '本设备',
    ip: '登录 IP',
    signedIn: '登录时间',
    expires: '会话最长保留至',
    security: '安全状态',
    tokenGate: '访问令牌门已启用',
    approvalOn: '新设备需主人审批后才能访问',
    approvalOff: '新设备登录即可访问（未开启审批）',
    enter: '进入 DeepSeek Harness',
    renameLabel: '给这台设备起个名字',
    renameHint: '主人会在设备列表里看到这个名字，例如「小王的 iPhone」。',
    renameSubmit: '保存名字',
    logout: '退出登录',
    logoutHint: '退出后这台设备的会话立即失效，再次访问需要重新登录。',
  },
  en: {
    title: 'Device home',
    intro: 'You are connected to this DeepSeek Harness.',
    via: 'Current entry',
    device: 'This device',
    ip: 'Login IP',
    signedIn: 'Signed in',
    expires: 'Session kept until',
    security: 'Security posture',
    tokenGate: 'Access-token gate is on',
    approvalOn: 'New devices require the owner’s approval',
    approvalOff: 'New devices get in on login (approval off)',
    enter: 'Enter DeepSeek Harness',
    renameLabel: 'Name this device',
    renameHint: 'The owner sees this name in the device list, e.g. "Juan’s iPhone".',
    renameSubmit: 'Save name',
    logout: 'Sign out',
    logoutHint: 'Signing out revokes this device’s session immediately; the next visit needs a fresh login.',
  },
}

const HOME_EXTRA_CSS = `.via{font-size:12px;color:#8a93a0;word-break:break-all;margin:-2px 0 0}dl{margin:18px 0 0;display:grid;grid-template-columns:auto 1fr;gap:8px 14px;font-size:13px}dt{color:#8a93a0;font-weight:600}dd{margin:0;word-break:break-all}.enter{display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:100%;min-height:48px;margin-top:22px;border-radius:12px;background:#111;color:#fff;font-weight:650;text-decoration:none}.rename{margin-top:24px;padding-top:20px;border-top:1px solid #e2e7ee}.rename label{display:block;font-size:13px;font-weight:600;margin:0 0 8px}.rename input,.rename button,.logout button{box-sizing:border-box;width:100%;min-height:48px;border-radius:12px;font:inherit}.rename input{padding:0 14px;border:1px solid #c8ced7;background:transparent;color:inherit}.rename button{margin-top:10px;background:transparent;color:#3d4652;border:1px solid #c8ced7;cursor:pointer}.logout{margin-top:22px}.logout button{background:transparent;color:#b3261e;border:1px solid #e0b4b0;cursor:pointer}.hint{font-size:12px;color:#8a93a0;margin:8px 0 0}@media(prefers-color-scheme:dark){.via,.hint,dt{color:#7c8694}.enter{background:#f7f8fa;color:#111}.rename{border-top-color:#343a43}.rename input{border-color:#4b535e}.rename button{color:#c9d1dc;border-color:#4b535e}.logout button{color:#f2b8b5;border-color:#6b3a38}}`

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
    : `<label for="token">${copy.label}</label><input id="token" name="token" type="password" autocomplete="current-password" required autofocus><button type="submit">${copy.submit}</button><button type="submit" name="next" value="home" class="secondary">${copy.deviceHome}</button>`
  return `${shell(locale, copy.title)}${LOGIN_EXTRA_CSS}</style></head><body><main class="card"><p class="kicker">dsh-full-remote</p><h1>${copy.title}</h1><p>${copy.intro}</p>${message}<form id="login" method="post" action="${LOGIN_PATH}">${fields}</form>${autoSubmit}</main></body></html>`
}


/** First-visit approval waiting page: polls its own session status. */
export function waitPage(locale: PageLocale, id: string, label: string) {
  const copy = WAIT_COPY[locale] ?? WAIT_COPY.zh
  const safeLabel = escapeHtml(label)
  const poll = `fetch(${jsValue(waitStatusPath(id))},{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.json()}).then(function(d){if(d.status==='active'){location.href='/'}else if(d.status==='rejected'){clearInterval(t);document.getElementById('state').textContent=${jsValue(copy.rejected)}}else if(d.status==='unknown'){clearInterval(t);document.getElementById('state').textContent=${jsValue(copy.expired)}}},function(){})`
  return `${shell(locale, copy.title)}${WAIT_EXTRA_CSS}</style></head><body><main class="card"><p class="kicker">dsh-full-remote</p><h1>${copy.title}</h1><p>${copy.intro}</p><p class="device">${safeLabel}</p><div class="spinner" aria-hidden="true"></div><p id="state">${copy.pending}</p><script>var t=setInterval(function(){${poll}},2000)</script></main></body></html>`
}

/** Format a timestamp for the page locale (server timezone — the gate pages
 *  have no client clock access under the zero-JS CSP). */
function formatPageTime(locale: PageLocale, ts: number) {
  return new Date(ts).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN', { hour12: false })
}

/** Opt-in device hub reached from the login page's secondary button or a
 *  direct visit. Zero-JS: enter is a link, rename/logout are plain forms. */
export function homePage(locale: PageLocale, data: {
  host: string
  label: string
  createdIp?: string
  createdAt: number
  sessionMaxAgeSeconds: number
  approvalMode: boolean
}) {
  const copy = HOME_COPY[locale] ?? HOME_COPY.zh
  const safeLabel = escapeHtml(data.label)
  const via = data.host === '' ? '' : `<p class="via">${copy.via}: ${escapeHtml(data.host)}</p>`
  const ipRow = data.createdIp === undefined || data.createdIp === ''
    ? ''
    : `<dt>${copy.ip}</dt><dd>${escapeHtml(data.createdIp)}</dd>`
  const expires = formatPageTime(locale, data.createdAt + data.sessionMaxAgeSeconds * 1000)
  const approval = data.approvalMode ? copy.approvalOn : copy.approvalOff
  return `${shell(locale, copy.title)}${HOME_EXTRA_CSS}</style></head><body><main class="card"><p class="kicker">dsh-full-remote</p><h1>${copy.title}</h1><p>${copy.intro}</p>${via}<dl><dt>${copy.device}</dt><dd>${safeLabel}</dd>${ipRow}<dt>${copy.signedIn}</dt><dd>${formatPageTime(locale, data.createdAt)}</dd><dt>${copy.expires}</dt><dd>${expires}</dd><dt>${copy.security}</dt><dd>${copy.tokenGate} · ${approval}</dd></dl><a class="enter" href="/">${copy.enter}</a><form class="rename" method="post" action="${HOME_RENAME_PATH}"><label for="label">${copy.renameLabel}</label><input id="label" name="label" type="text" maxlength="64" value="${safeLabel}"><p class="hint">${copy.renameHint}</p><button type="submit">${copy.renameSubmit}</button></form><form class="logout" method="post" action="${LOGOUT_PATH}"><button type="submit">${copy.logout}</button><p class="hint">${copy.logoutHint}</p></form></main></body></html>`
}
