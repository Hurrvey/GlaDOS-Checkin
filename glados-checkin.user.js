// ==UserScript==
// @name         GLaDOS 每日随机签到
// @namespace    local.glados.random-checkin
// @version      1.0.1
// @description  在指定 UTC 偏移的每日时间段内随机签到，保存计划并协调多个标签页。
// @match        http://*/*
// @match        https://*/*
// @noframes
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_getTab
// @grant        GM_saveTab
// @grant        GM_getTabs
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      glados.network
// ==/UserScript==

(function () {
    'use strict';

    const DEFAULTS = { start: '10:00', end: '15:00', offsetMinutes: 480 };
    const DAY_MS = 86400000;
    const ALREADY_MESSAGE = "Today's observation logged. Return tomorrow for more points.";
    const STATUS_LABELS = {
        success: '本次签到成功', already: '今日已签到', failed: '签到失败',
        unknown: '结果未知', pending: '已发起请求，等待结果',
    };
    const statusLabel = (status) => STATUS_LABELS[status] || status;

    function minutes(value) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
            throw new Error('时间必须是 HH:mm，例如 10:00。');
        }
        const [h, m] = value.split(':').map(Number);
        return h * 60 + m;
    }

    function getWindow(now, config) {
        const start = minutes(config.start);
        const end = minutes(config.end);
        if (start >= end) throw new Error('结束时间必须晚于开始时间，暂不支持跨午夜。');
        if (!Number.isInteger(config.offsetMinutes) || config.offsetMinutes < -720 || config.offsetMinutes > 840) {
            throw new Error('UTC 偏移必须是 -720 至 840 之间的整数分钟。');
        }
        const offset = config.offsetMinutes * 60000;
        const shifted = now + offset;
        const midnight = Math.floor(shifted / DAY_MS) * DAY_MS - offset;
        return {
            day: new Date(shifted).toISOString().slice(0, 10),
            start: midnight + start * 60000,
            end: midnight + end * 60000,
        };
    }

    function planTime(now, config, random = Math.random) {
        const window = getWindow(now, config);
        const lower = Math.max(now, window.start);
        return lower >= window.end ? null : lower + Math.floor(random() * (window.end - lower));
    }

    function normalizeCookie(input) {
        if (typeof input !== 'string' || /[\r\n]/.test(input)) throw new Error('Cookie 必须是一行文本。');
        const pairs = new Map(input.split(';').map((part) => {
            const i = part.indexOf('=');
            return i < 0 ? ['', ''] : [part.slice(0, i).trim(), part.slice(i + 1).trim()];
        }));
        return ['koa:sess', 'koa:sess.sig'].map((name) => {
            const value = pairs.get(name);
            if (!value || /\s/.test(value)) throw new Error(`Cookie 缺少有效的 ${name}。`);
            return `${name}=${value}`;
        }).join('; ');
    }

    function classify(httpStatus, body) {
        if (httpStatus < 200 || httpStatus >= 300) {
            return { status: 'failed', message: `HTTP ${httpStatus}；请检查登录凭证及网络。` };
        }
        let data;
        try { data = JSON.parse(body); } catch {
            return { status: 'unknown', message: '返回内容不是 JSON；可能遇到登录页或站点验证。' };
        }
        if (!data || typeof data.code !== 'number') {
            return { status: 'unknown', message: '响应缺少数字 code，无法确认是否成功。' };
        }
        const already = data.code === 1 && typeof data.message === 'string'
            && data.message.trim() === ALREADY_MESSAGE;
        return {
            status: already ? 'already' : data.code === 0 ? 'success' : 'failed',
            message: typeof data.message === 'string' ? data.message : `服务端 code=${data.code}`,
            code: data.code,
            points: typeof data.points === 'number' && Number.isFinite(data.points) ? data.points : null,
        };
    }

    // Node 测试只加载纯函数；浏览器内正常启动。
    if (typeof module !== 'undefined' && module.exports && typeof GM_getValue === 'undefined') {
        module.exports = { getWindow, planTime, normalizeCookie, classify };
        return;
    }

    // 普通 HTTP 页面可能没有 randomUUID；此标识仅用于协调，不作为安全令牌。
    const owner = typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const readConfig = () => ({ ...DEFAULTS, ...GM_getValue('config', {}) });
    const fingerprint = (config) => `${config.start}/${config.end}/${config.offsetMinutes}`;
    let busy = false;

    function format(time, config) {
        if (time == null) return '无';
        return new Date(time + config.offsetMinutes * 60000).toISOString().slice(0, 19).replace('T', ' ');
    }

    async function heartbeat() {
        const tab = await new Promise((resolve) => GM_getTab(resolve));
        tab.gladosRunner = { owner, seen: Date.now() };
        await new Promise((resolve) => GM_saveTab(tab, resolve));
    }

    async function isLeader() {
        const tabs = await new Promise((resolve) => GM_getTabs(resolve));
        const active = Object.entries(tabs).filter(([, tab]) =>
            tab.gladosRunner && Date.now() - tab.gladosRunner.seen < 180000);
        active.sort(([a], [b]) => Number(a) - Number(b));
        return active[0]?.[1].gladosRunner.owner === owner;
    }

    function recordResult(key, attemptedAt, result, cookie) {
        const state = GM_getValue(key, {});
        if (state.attemptedAt !== attemptedAt || state.owner !== owner) return;
        // 不保存完整响应，也不把凭证带入日志。
        let message = result.message;
        for (const part of cookie.split(';')) {
            const value = part.slice(part.indexOf('=') + 1).trim();
            if (value) message = message.split(value).join('[已隐藏]');
        }
        message = message.slice(0, 500);
        const entry = {
            day: key.slice(4), time: Date.now(), status: result.status, message,
            code: result.code ?? null, points: result.points ?? null,
        };
        GM_setValue(key, { ...state, ...entry });
        GM_setValue('history', [...GM_getValue('history', []), entry].slice(-30));
        console.log('[GLaDOS 签到]', statusLabel(entry.status), entry.message);
        try {
            GM_notification({ title: 'GLaDOS 签到', text: `${statusLabel(entry.status)}: ${message}`, timeout: 10000 });
        } catch { /* 通知失败不改变签到结果。 */ }
    }

    function send(key, state, cookie) {
        const finish = (result) => recordResult(key, state.attemptedAt, result, cookie);
        try {
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://glados.network/api/user/checkin',
                headers: {
                    'Content-Type': 'application/json;charset=UTF-8',
                    Origin: 'https://glados.network',
                    Referer: 'https://glados.network/console/checkin',
                },
                cookie,
                data: JSON.stringify({ token: 'glados.network' }),
                timeout: 30000,
                onload: (response) => finish(classify(response.status, response.responseText)),
                ontimeout: () => finish({ status: 'unknown', message: '请求超时；可能已经成功，当天不自动重试。' }),
                onerror: () => finish({ status: 'unknown', message: '网络错误或请求权限被拒绝；当天不自动重试。' }),
                onabort: () => finish({ status: 'unknown', message: '请求中止；当天不自动重试。' }),
            });
        } catch {
            finish({ status: 'unknown', message: '无法发送请求；请检查 Tampermonkey 权限，当天不自动重试。' });
        }
    }

    async function tick() {
        if (busy) return;
        busy = true;
        try {
            await heartbeat();
            if (!(await isLeader())) return;
            const previous = GM_getValue('claim', null);
            if (previous && previous.until > Date.now() && previous.owner !== owner) return;
            // GM 存储没有原子锁。选主 + 占用后复查是尽力防重，不是严格事务。
            GM_setValue('claim', { owner, until: Date.now() + 15000 });
            await sleep(1500);
            if (GM_getValue('claim', {}).owner !== owner || !(await isLeader())) return;
            const now = Date.now();
            if (GM_getValue('claim', {}).until <= now) return;
            const config = readConfig();
            const window = getWindow(now, config);
            const key = `day:${window.day}`;
            let state = GM_getValue(key, {});
            if (state.attemptedAt != null || now >= window.end) return;
            if (state.plannedAt == null || (state.config && state.config !== fingerprint(config))) {
                state = { plannedAt: planTime(now, config), config: fingerprint(config) };
                GM_setValue(key, state);
                console.log('[GLaDOS 签到] 今日计划：', format(state.plannedAt, config));
            }
            if (now < window.start || now < state.plannedAt) return;
            const storedCookie = GM_getValue('cookie', '');
            if (!storedCookie) return;
            const cookie = normalizeCookie(storedCookie);
            // 在联网之前记账：关闭页面、超时、失败都不会导致自动重发。
            state = { ...state, owner, attemptedAt: now, status: 'pending', message: '已发起请求；若页面关闭，结果可能无法记录。' };
            GM_setValue(key, state);
            send(key, state, cookie);
        } catch {
            console.error('[GLaDOS 签到] 调度失败，请检查脚本设置及扩展权限。');
        } finally {
            // 不删除共享占用，避免读后删除误伤另一个刚接管的标签页。
            busy = false;
        }
    }

    GM_registerMenuCommand('设置 Cookie', () => {
        const input = prompt('粘贴一整行 Cookie，包含 koa:sess 和 koa:sess.sig（不含 Cookie: 前缀）：');
        if (input == null) return;
        try {
            GM_setValue('cookie', normalizeCookie(input));
            alert('Cookie 已保存。当天如已尝试，不会再次自动签到。');
            void tick();
        } catch (error) { alert(error.message); }
    });

    GM_registerMenuCommand('设置时间段和 UTC 偏移', () => {
        const config = readConfig();
        const input = prompt('格式：开始时间,结束时间,UTC偏移分钟\n例如北京时间：10:00,15:00,480\n结束时间不包含在内，不支持跨午夜。',
            `${config.start},${config.end},${config.offsetMinutes}`);
        if (input == null) return;
        try {
            const parts = input.split(',').map((part) => part.trim());
            if (parts.length !== 3 || !parts[2]) throw new Error('请输入三个用英文逗号分隔的值。');
            const next = { start: parts[0], end: parts[1], offsetMinutes: Number(parts[2]) };
            getWindow(Date.now(), next);
            GM_setValue('config', next);
            alert('已保存。尚未执行的今日计划将在下一轮重新生成；已执行记录保留。');
            void tick();
        } catch (error) { alert(error.message); }
    });

    GM_registerMenuCommand('查看今日状态和最近记录', () => {
        const config = readConfig();
        const now = Date.now();
        const window = getWindow(now, config);
        const state = GM_getValue(`day:${window.day}`, {});
        const status = statusLabel(state.status) || (now >= window.end ? '已过时间段，今日跳过' : '等待计划或执行');
        const history = GM_getValue('history', []).slice(-10).map((entry) =>
            `${entry.day} ${statusLabel(entry.status)}（积分：${entry.points ?? '未知'}）: ${entry.message}`).join('\n');
        alert(`日期：${window.day}\nUTC 偏移：${config.offsetMinutes} 分钟\n时间段：${config.start}–${config.end}\nCookie：${GM_getValue('cookie', '') ? '已设置' : '未设置'}\n计划：${format(state.plannedAt, config)}\n尝试时间：${format(state.attemptedAt, config)}\n状态：${status}\n返回积分：${state.points ?? '未知'}\n${state.message || ''}\n\n最近记录：\n${history || '无'}`);
    });

    // 短轮询 + 恢复事件，避免依赖一个持续数小时的定时器。
    setInterval(() => { void tick(); }, 30000);
    window.addEventListener('pageshow', () => { void tick(); });
    window.addEventListener('focus', () => { void tick(); });
    window.addEventListener('online', () => { void tick(); });
    document.addEventListener('visibilitychange', () => { void tick(); });
    void tick();
})();
