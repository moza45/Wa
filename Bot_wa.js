require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ╔══════════════════════════════════════════════════════════════╗
// ║         W A - K I C K E R   B O T   v 5 . 0 . 0            ║
// ║      S T E A L T H   H U M A N   D E L A Y   E D I T I O N ║
// ╚══════════════════════════════════════════════════════════════╝

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN tidak ditemukan di .env!');
    process.exit(1);
}

const ADMIN_IDS = (process.env.ADMIN_IDS || '')
    .split(',')
    .map(id => parseInt(id.trim()))
    .filter(id => !isNaN(id));

if (ADMIN_IDS.length === 0) {
    console.error('❌ ADMIN_IDS tidak ditemukan atau tidak valid di .env!');
    process.exit(1);
}

const BOT_NAME             = process.env.BOT_NAME || '⚡ WA Kicker Bot';
const PAYMENT_BANK_NAME    = process.env.PAYMENT_BANK_NAME   || 'SEA';
const PAYMENT_BANK_NUMBER  = process.env.PAYMENT_BANK_NUMBER || '1234567890';
const PAYMENT_BANK_HOLDER  = process.env.PAYMENT_BANK_HOLDER || 'Bot Owner';
const PAYMENT_DANA         = process.env.PAYMENT_DANA        || '081234567890';
const PAYMENT_CONTACT      = process.env.PAYMENT_CONTACT     || '@adminusername';
const TRIAL_DURATION_HOURS = parseInt(process.env.TRIAL_DURATION_HOURS || '24');
const KICK_LIMIT_PER_SESSION = parseInt(process.env.KICK_LIMIT || '20');

const PAYMENT_INFO =
    `Transfer ke:\n` +
    `🏦 ${PAYMENT_BANK_NAME}: ${PAYMENT_BANK_NUMBER} a/n ${PAYMENT_BANK_HOLDER}\n` +
    `💚 Dana/Shopeepay: ${PAYMENT_DANA}`;

const PACKAGES = {
    '1bulan':  { label: '1 Bulan',  days: 30,  price: parseInt(process.env.PRICE_1BULAN  || '50000')  },
    '3bulan':  { label: '3 Bulan',  days: 90,  price: parseInt(process.env.PRICE_3BULAN  || '125000') },
    '6bulan':  { label: '6 Bulan',  days: 180, price: parseInt(process.env.PRICE_6BULAN  || '200000') },
    '1tahun':  { label: '1 Tahun',  days: 365, price: parseInt(process.env.PRICE_1TAHUN  || '350000') },
};

const DATA_FILE        = './bot_users.json';
const AUTH_BASE_FOLDER = './auth_states';

const tgBot = new Telegraf(TELEGRAM_BOT_TOKEN);
const userSessions   = new Map();
const kickSelections = new Map();

// ── Anti-Stream-Conflict state ───────────────────────────────
const loginLocks        = new Map();
const conflictCooldowns = new Map();
const reconnectAttempts = new Map();
const CONFLICT_COOLDOWN_MS   = 35_000;
const MAX_RECONNECT_ATTEMPTS = 3;

if (!fs.existsSync(AUTH_BASE_FOLDER)) fs.mkdirSync(AUTH_BASE_FOLDER, { recursive: true });

// ══════════════════════════════════════════════════════════════
//  STEALTH: HUMAN DELAY FUNCTIONS (NATURAL & VARIED PER LANGKAH)
// ══════════════════════════════════════════════════════════════

function poissonRandom(lambda) {
    let L = Math.exp(-lambda);
    let p = 1.0;
    let k = 0;
    do {
        k++;
        p *= Math.random();
    } while (p > L);
    return k;
}

function exponentialRandom(rate) {
    return -Math.log(1 - Math.random()) / rate;
}

async function humanDelayKick() {
    // Jeda khusus untuk KICK: 12 - 45 detik dengan cluster di 20-30 detik
    const r = Math.random();
    let delaySec;
    
    if (r < 0.3) {
        delaySec = 12 + Math.random() * 6;
    } else if (r < 0.7) {
        delaySec = 20 + Math.random() * 10;
    } else {
        delaySec = 32 + Math.random() * 13;
    }
    
    delaySec = delaySec * (0.9 + Math.random() * 0.2);
    const ms = Math.floor(delaySec * 1000);
    
    console.log(`[HumanDelay] Jeda antar kick: ${Math.round(delaySec)} detik`);
    return new Promise(r => setTimeout(r, ms));
}

async function humanDelayAdd() {
    // Jeda khusus untuk ADD: 8 - 25 detik
    const r = Math.random();
    let delaySec;
    
    if (r < 0.4) {
        delaySec = 8 + Math.random() * 7;
    } else if (r < 0.8) {
        delaySec = 16 + Math.random() * 6;
    } else {
        delaySec = 23 + Math.random() * 3;
    }
    
    delaySec = delaySec * (0.85 + Math.random() * 0.3);
    const ms = Math.floor(delaySec * 1000);
    
    console.log(`[HumanDelay] Jeda antar add: ${Math.round(delaySec)} detik`);
    return new Promise(r => setTimeout(r, ms));
}

async function humanDelayBatchPause() {
    // Jeda antar batch (setelah burst 1-4 orang): 20 - 90 detik
    const r = Math.random();
    let delaySec;
    
    if (r < 0.4) {
        delaySec = 20 + Math.random() * 20;
    } else if (r < 0.7) {
        delaySec = 40 + Math.random() * 20;
    } else {
        delaySec = 60 + Math.random() * 30;
    }
    
    const ms = Math.floor(delaySec * 1000);
    console.log(`[HumanDelay] Jeda antar batch: ${Math.round(delaySec)} detik`);
    return new Promise(r => setTimeout(r, ms));
}

async function humanDelayError() {
    // Jeda setelah error: 45 - 120 detik
    const delaySec = 45 + Math.random() * 75;
    const ms = Math.floor(delaySec * 1000);
    console.log(`[HumanDelay] Jeda setelah error: ${Math.round(delaySec)} detik`);
    return new Promise(r => setTimeout(r, ms));
}

async function humanDelayNatural(minSec = 3, maxSec = 25) {
    const usePoisson = Math.random() > 0.6;
    let delaySec;
    
    if (usePoisson) {
        const lambda = (minSec + maxSec) / 3;
        delaySec = poissonRandom(lambda);
        delaySec = Math.min(maxSec, Math.max(minSec, delaySec));
    } else {
        delaySec = minSec + Math.random() * (maxSec - minSec);
    }
    
    delaySec = delaySec * (0.8 + Math.random() * 0.4);
    const ms = delaySec * 1000;
    return new Promise(r => setTimeout(r, ms));
}

async function delayRead() {
    const ms = 1500 + Math.random() * 2500;
    return new Promise(r => setTimeout(r, ms));
}

async function delayType() {
    const ms = 3000 + Math.random() * 5000;
    return new Promise(r => setTimeout(r, ms));
}

async function humanDelay(minMs = 1200, maxMs = 3800) {
    const delay = Math.floor(Math.random() * (maxMs - minMs + 1) + minMs);
    return new Promise(resolve => setTimeout(resolve, delay));
}

// ══════════════════════════════════════════════════════════════
//  STEALTH: SIMULASI MANUSIA
// ══════════════════════════════════════════════════════════════

async function simulateReadAndType(sock, jid, shouldType = false) {
    try {
        await sock.sendPresenceUpdate('available');
        await humanDelayNatural(1, 3);
        
        if (shouldType && Math.random() > 0.3) {
            await sock.sendPresenceUpdate('composing', jid);
            await humanDelayNatural(2, 6);
            await sock.sendPresenceUpdate('paused', jid);
        }
        
        await humanDelayNatural(1, 4);
    } catch (_) {}
}

function isActiveHours() {
    const hour = new Date().toLocaleString('en-US', {
        timeZone: 'Asia/Jakarta',
        hour: 'numeric',
        hour12: false
    });
    const h = parseInt(hour);
    return h >= 8 && h <= 22;
}

// ══════════════════════════════════════════════════════════════
//  STEALTH: DYNAMIC FINGERPRINT
// ══════════════════════════════════════════════════════════════

function generateDynamicFingerprint() {
    const chromeVersions = ['120', '121', '122', '123', '124'];
    const edgeVersions = ['120', '121', '122'];
    const safariVersions = ['16', '17', '17.4'];
    
    const osList = ['Windows', 'MacOS', 'Linux'];
    const os = osList[Math.floor(Math.random() * osList.length)];
    
    let browser, version;
    if (os === 'MacOS') {
        browser = 'Safari';
        version = safariVersions[Math.floor(Math.random() * safariVersions.length)];
    } else if (Math.random() > 0.3) {
        browser = 'Chrome';
        version = chromeVersions[Math.floor(Math.random() * chromeVersions.length)];
    } else {
        browser = 'Edge';
        version = edgeVersions[Math.floor(Math.random() * edgeVersions.length)];
    }
    
    const buildId = Math.floor(Math.random() * 9999);
    
    let userAgent = '';
    if (browser === 'Chrome') {
        userAgent = `Mozilla/5.0 (${os === 'Windows' ? 'Windows NT 10.0; Win64; x64' : 'Macintosh; Intel Mac OS X 10_15_7'}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.${buildId}.${Math.floor(Math.random() * 99)} Safari/537.36`;
    } else if (browser === 'Edge') {
        userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36 Edg/${version}.0.${buildId}`;
    } else {
        userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Safari/605.1.15`;
    }
    
    return [os, browser, `${version}.0.${buildId}`, userAgent];
}

function getEncryptedAuthFolder(userId) {
    const epochWeek = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
    const hash = crypto.createHash('sha256')
        .update(`wa_${userId}_v3_${epochWeek}`)
        .digest('hex')
        .substring(0, 32);
    return path.join(AUTH_BASE_FOLDER, hash);
}

// ══════════════════════════════════════════════════════════════
//  STEALTH: BACKGROUND ACTIVITY SPOOFER
// ══════════════════════════════════════════════════════════════

async function startBackgroundActivitySpooler(sock, userId) {
    const activities = [
        () => sock.sendPresenceUpdate('available'),
        () => sock.sendPresenceUpdate('unavailable'),
        () => sock.sendPresenceUpdate('recording'),
        () => sock.sendPresenceUpdate('paused'),
    ];
    
    const scheduleNext = async () => {
        const interval = (5 + Math.random() * 20) * 60 * 1000;
        setTimeout(async () => {
            const session = userSessions.get(userId);
            if (!session?.loggedIn) return;
            
            const act = activities[Math.floor(Math.random() * activities.length)];
            try {
                await act();
                if (Math.random() > 0.7 && session.groupId) {
                    await humanDelayNatural(0.5, 2);
                    await sock.sendPresenceUpdate('composing', session.groupId);
                    await humanDelayNatural(1, 4);
                    await sock.sendPresenceUpdate('paused', session.groupId);
                }
            } catch (_) {}
            scheduleNext();
        }, interval);
    };
    scheduleNext();
}

// ══════════════════════════════════════════════════════════════
//  MANAJEMEN DATA USER
// ══════════════════════════════════════════════════════════════

function loadData() {
    if (!fs.existsSync(DATA_FILE)) {
        const init = { users: [], pending: [], pendingPayment: [] };
        fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2));
        return init;
    }
    try {
        const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        if (!raw.users && raw.approved) {
            raw.users = raw.approved.map(u => ({
                ...u, role: 'regular', expiresAt: null, hadTrial: true
            }));
            delete raw.approved;
        }
        raw.users          = raw.users          || [];
        raw.pending        = raw.pending        || [];
        raw.pendingPayment = raw.pendingPayment || [];
        return raw;
    } catch {
        return { users: [], pending: [], pendingPayment: [] };
    }
}

function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function isAdmin(userId) {
    return ADMIN_IDS.includes(userId);
}

function getUser(userId) {
    if (isAdmin(userId)) return { id: userId, role: 'admin', status: 'active' };
    const data = loadData();
    return (data.users || []).find(u => u.id === userId) || null;
}

function getUserStatus(userId) {
    if (isAdmin(userId)) return 'admin';
    const u = getUser(userId);
    if (!u) return 'none';
    if (u.role === 'regular') {
        return new Date(u.expiresAt) > new Date() ? 'regular' : 'expired';
    }
    if (u.role === 'trial') {
        return new Date(u.trialExpiresAt) > new Date() ? 'trial' : 'trial_expired';
    }
    return 'none';
}

function canUseBot(userId) {
    return ['admin', 'regular', 'trial'].includes(getUserStatus(userId));
}

function isTrialOnly(userId) {
    return getUserStatus(userId) === 'trial';
}

function startTrial(user) {
    const data = loadData();
    const existing = data.users.find(u => u.id === user.id);
    if (existing) return { success: false, reason: 'already_user', user: existing };

    const hadTrial = data.users.some(u => u.id === user.id && u.hadTrial);
    if (hadTrial) return { success: false, reason: 'used_trial' };

    const now = new Date();
    const exp = new Date(now.getTime() + TRIAL_DURATION_HOURS * 60 * 60 * 1000);
    const newUser = {
        id: user.id,
        username: user.username || null,
        firstName: user.first_name || '',
        lastName: user.last_name || '',
        role: 'trial',
        trialStartedAt: now.toISOString(),
        trialExpiresAt: exp.toISOString(),
        hadTrial: true,
        createdAt: now.toISOString()
    };
    data.users.push(newUser);
    saveData(data);
    return { success: true, user: newUser, expiresAt: exp };
}

function addPendingPayment(user, packageKey) {
    const data = loadData();
    data.pendingPayment = data.pendingPayment.filter(p => p.id !== user.id);
    data.pendingPayment.push({
        id: user.id,
        username: user.username || null,
        firstName: user.first_name || '',
        lastName: user.last_name || '',
        packageKey,
        requestedAt: new Date().toISOString()
    });
    saveData(data);
}

function approvePayment(userId, packageKey) {
    const data = loadData();
    const pkg  = PACKAGES[packageKey];
    if (!pkg) return { success: false, reason: 'invalid_package' };

    const pendIdx = data.pendingPayment.findIndex(p => p.id === userId);
    let userInfo  = pendIdx >= 0 ? data.pendingPayment.splice(pendIdx, 1)[0] : null;

    const now = new Date();
    let expiresAt;

    const existingIdx = data.users.findIndex(u => u.id === userId);
    if (existingIdx >= 0) {
        const existing = data.users[existingIdx];
        const base = existing.expiresAt && new Date(existing.expiresAt) > now
            ? new Date(existing.expiresAt)
            : now;
        expiresAt = new Date(base.getTime() + pkg.days * 24 * 60 * 60 * 1000);
        data.users[existingIdx] = {
            ...existing,
            role: 'regular',
            expiresAt: expiresAt.toISOString(),
            lastPackage: packageKey,
            updatedAt: now.toISOString()
        };
    } else {
        expiresAt = new Date(now.getTime() + pkg.days * 24 * 60 * 60 * 1000);
        const src = userInfo || {};
        data.users.push({
            id: userId,
            username: src.username || null,
            firstName: src.firstName || '',
            lastName: src.lastName || '',
            role: 'regular',
            expiresAt: expiresAt.toISOString(),
            lastPackage: packageKey,
            hadTrial: true,
            createdAt: now.toISOString()
        });
    }

    saveData(data);
    return { success: true, expiresAt, pkg };
}

function revokeUser(userId) {
    const data = loadData();
    const idx  = data.users.findIndex(u => u.id === userId);
    if (idx === -1) return null;
    const [user] = data.users.splice(idx, 1);
    saveData(data);
    return user;
}

function getAllPendingPayments() { return loadData().pendingPayment || []; }
function getAllUsers()           { return loadData().users || []; }

function formatDate(isoStr) {
    if (!isoStr) return '-';
    return new Date(isoStr).toLocaleString('id-ID', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta'
    });
}

function formatCountdown(isoStr) {
    const ms = new Date(isoStr) - new Date();
    if (ms <= 0) return 'SUDAH EXPIRED';
    const hours = Math.floor(ms / 3600000);
    const mins  = Math.floor((ms % 3600000) / 60000);
    if (hours >= 24) {
        const days = Math.floor(hours / 24);
        return `${days} hari ${hours % 24} jam`;
    }
    return `${hours} jam ${mins} menit`;
}

function formatRupiah(num) {
    return 'Rp ' + num.toLocaleString('id-ID');
}

// ══════════════════════════════════════════════════════════════
//  ANIMASI HIDUP — LIVE MESSAGES
// ══════════════════════════════════════════════════════════════

const SPINNER_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
const CLOCK_FRAMES   = ['🕐','🕑','🕒','🕓','🕔','🕕','🕖','🕗','🕘','🕙','🕚','🕛'];
const PULSE_FRAMES   = ['🔴','🟠','🟡','🟢','🟡','🟠'];

async function liveMessage(ctx, initText, frameFn, interval = 900) {
    let msg;
    try { msg = await ctx.reply(initText, { parse_mode: 'Markdown' }); }
    catch (_) { return { stop: async () => {} }; }

    let frame = 0, stopped = false;
    const timer = setInterval(async () => {
        if (stopped) return;
        try {
            const text = frameFn(frame, msg);
            await ctx.telegram.editMessageText(
                msg.chat.id, msg.message_id, undefined,
                text, { parse_mode: 'Markdown' }
            );
        } catch (_) {}
        frame++;
    }, interval);

    return {
        stop: async (finalText) => {
            stopped = true;
            clearInterval(timer);
            if (finalText) {
                try {
                    await ctx.telegram.editMessageText(
                        msg.chat.id, msg.message_id, undefined,
                        finalText, { parse_mode: 'Markdown' }
                    );
                } catch (_) {}
            }
        }
    };
}

async function spinnerMessage(ctx, label) {
    return liveMessage(
        ctx,
        `${SPINNER_FRAMES[0]} *${label}*`,
        (i) => `${SPINNER_FRAMES[i % SPINNER_FRAMES.length]} *${label}*`,
        750
    );
}

function buildProgressBar(done, total, width = 14) {
    const pct    = total === 0 ? 1 : Math.min(done / total, 1);
    const filled = Math.round(pct * width);
    const empty  = width - filled;
    return '[' + '█'.repeat(filled) + '░'.repeat(empty) + '] ' + String(Math.round(pct * 100)).padStart(3) + '%';
}

async function liveKickProgress(ctx, total) {
    let current = 0;
    const anim = await liveMessage(
        ctx,
        `🦵 *Memulai kick...*\n${buildProgressBar(0, total)}\n0/${total} orang`,
        (i) => {
            const spin  = SPINNER_FRAMES[i % SPINNER_FRAMES.length];
            const pulse = PULSE_FRAMES[i % PULSE_FRAMES.length];
            return (
                `${pulse} *Sedang mengkick anggota...*\n\n` +
                `${buildProgressBar(current, total)}\n` +
                `${spin} \`${current}/${total}\` orang dikick\n\n` +
                `_Sabar, jeda antar kick untuk stealth mode..._`
            );
        },
        800
    );
    return {
        update: (n) => { current = n; },
        stop: (finalText) => anim.stop(finalText)
    };
}

async function liveCountdown(ctx, totalMs, headerText, onDone) {
    const endTime = Date.now() + totalMs;
    const anim = await liveMessage(
        ctx,
        `⏳ *${headerText}*\n\nMenghitung...`,
        (i) => {
            const left  = Math.max(0, endTime - Date.now());
            const sisa  = Math.ceil(left / 1000);
            const clock = CLOCK_FRAMES[i % CLOCK_FRAMES.length];
            const pulse = PULSE_FRAMES[i % PULSE_FRAMES.length];
            const menit = String(Math.floor(sisa / 60)).padStart(2, '0');
            const detik = String(sisa % 60).padStart(2, '0');
            const bar   = buildProgressBar(totalMs - left, totalMs, 14);
            return (
                `${pulse} *${headerText}*\n\n` +
                `${clock} Sisa waktu: \`${menit}:${detik}\`\n` +
                `${bar}\n\n` +
                `_WA server lagi ngelepas koneksi lama..._`
            );
        },
        1000
    );
    setTimeout(async () => {
        await anim.stop(
            `✅ *Cooldown selesai!*\n\n` +
            `Silakan tekan *🔑 Login WhatsApp* lagi.`
        );
        if (onDone) onDone();
    }, totalMs);
    return anim;
}

async function liveConnecting(ctx) {
    const labels = [
        'Menyiapkan koneksi WA',
        'Memuat auth session',
        'Menghubungi server WA',
        'Menunggu QR code',
    ];
    let phase = 0;
    return liveMessage(
        ctx,
        `${CLOCK_FRAMES[0]} *Menyambungkan ke WhatsApp...*`,
        (i) => {
            if (i > 0 && i % 4 === 0 && phase < labels.length - 1) phase++;
            const spin  = SPINNER_FRAMES[i % SPINNER_FRAMES.length];
            const clock = CLOCK_FRAMES[i % CLOCK_FRAMES.length];
            return (
                `${clock} *Menghubungkan ke WhatsApp*\n\n` +
                `${spin} ${labels[phase]}...\n\n` +
                `_QR code akan muncul sebentar lagi_`
            );
        },
        700
    );
}

function esc(text) {
    if (!text) return '';
    return String(text).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
}

function userDisplayName(u) {
    const name  = [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Tanpa Nama';
    const uname = u.username ? ` (@${u.username})` : '';
    return `${name}${uname}`;
}

function userDisplayNameEsc(u) {
    const name  = esc([u.firstName, u.lastName].filter(Boolean).join(' ') || 'Tanpa Nama');
    const uname = u.username ? ` (@${esc(u.username)})` : '';
    return `${name}${uname}`;
}

const DIVIDER      = '━━━━━━━━━━━━━━━━━━━━━━';
const DIVIDER_THIN = '┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄';

// ══════════════════════════════════════════════════════════════
//  REPLY KEYBOARDS
// ══════════════════════════════════════════════════════════════

const KB_LANDING = {
    reply_markup: {
        keyboard: [
            [{ text: '🎁 Coba Gratis (Trial)' }, { text: '⭐ Premium' }],
            [{ text: '❓ Bantuan' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
    }
};

const KB_PRE_LOGIN = {
    reply_markup: {
        keyboard: [
            [{ text: '🔑 Login WhatsApp' }],
            [{ text: '📊 Status' }, { text: '👤 Akun Saya' }],
            [{ text: '⭐ Premium' }, { text: '❓ Bantuan' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
    }
};

const KB_MAIN = {
    reply_markup: {
        keyboard: [
            [{ text: '📋 Daftar Grup' }, { text: '🎯 Pilih Grup' }],
            [{ text: '➕ Buat Grup WA' }, { text: '📥 Import VCF' }],
            [{ text: '🔴 Kick Menu' }, { text: '📡 Status' }],
            [{ text: '🚪 Logout WhatsApp' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
    }
};

const KB_ADMIN_PRE = {
    reply_markup: {
        keyboard: [
            [{ text: '🔑 Login WhatsApp' }],
            [{ text: '📋 Pending Payment' }, { text: '👥 User List' }],
            [{ text: '📊 Status' }, { text: '❓ Bantuan' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
    }
};

const KB_ADMIN_MAIN = {
    reply_markup: {
        keyboard: [
            [{ text: '📋 Daftar Grup' }, { text: '🎯 Pilih Grup' }],
            [{ text: '➕ Buat Grup WA' }, { text: '📥 Import VCF' }],
            [{ text: '🔴 Kick Menu' }, { text: '📡 Status' }],
            [{ text: '📋 Pending Payment' }, { text: '👥 User List' }],
            [{ text: '🚪 Logout WhatsApp' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
    }
};

function getKeyboard(userId) {
    const loggedIn = userSessions.get(userId)?.loggedIn;
    if (isAdmin(userId))   return loggedIn ? KB_ADMIN_MAIN : KB_ADMIN_PRE;
    const status = getUserStatus(userId);
    if (status === 'regular' || status === 'trial') return loggedIn ? KB_MAIN : KB_PRE_LOGIN;
    return KB_LANDING;
}

async function requireAccess(ctx, next) {
    const userId = ctx.from?.id;
    if (!userId) return;
    if (isAdmin(userId)) return next();
    const status = getUserStatus(userId);
    if (status === 'regular' || status === 'trial') return next();

    if (status === 'expired') {
        return ctx.reply(
            `╔${DIVIDER}╗\n║  AKSES BERAKHIR\n╚${DIVIDER}╝\n\n` +
            `Paket lo sudah expired.\nPerpanjang sekarang!\n\nKetik /beli untuk lihat paket.`,
            { parse_mode: 'Markdown', ...KB_LANDING }
        );
    }
    if (status === 'trial_expired') {
        return ctx.reply(
            `╔${DIVIDER}╗\n║  TRIAL BERAKHIR\n╚${DIVIDER}╝\n\n` +
            `Masa trial lo sudah habis.\nUpgrade ke paket reguler!\n\nKetik /beli untuk lihat paket.`,
            { parse_mode: 'Markdown', ...KB_LANDING }
        );
    }
    await ctx.reply(
        `╔${DIVIDER}╗\n║  AKSES DITOLAK\n╚${DIVIDER}╝\n\n` +
        `Bot ini berbayar.\n\n` +
        `🎁 Coba *gratis ${TRIAL_DURATION_HOURS} jam* → tekan tombol *Coba Gratis*\n` +
        `💳 Atau langsung beli paket → tekan *⭐ Premium*`,
        { parse_mode: 'Markdown', ...KB_LANDING }
    );
}

// ══════════════════════════════════════════════════════════════
//  QR SENDER
// ══════════════════════════════════════════════════════════════

async function sendQR(ctx, qr) {
    if (!qr) {
        await ctx.reply(`❌ QR code kosong, coba lagi.`);
        return;
    }

    await humanDelay(1800, 3600);

    const sendAsText = Math.random() < 0.25;

    try {
        if (!sendAsText) {
            const qrBuffer = await QRCode.toBuffer(qr, {
                type: 'png',
                width: 1024,
                margin: 2,
                color: { dark: '#000000', light: '#FFFFFF' },
                scale: 8
            });

            await ctx.replyWithPhoto(
                { source: qrBuffer },
                {
                    caption: `📱 *SCAN QR CODE DI WHATSAPP*\n\n` +
                             `1. Buka WhatsApp di HP\n` +
                             `2. Tap ⋮ (titik tiga) → *Perangkat Tertaut*\n` +
                             `3. Tap *Tautkan Perangkat*\n` +
                             `4. Scan QR code di atas\n\n` +
                             `_Kalo gagal scan, screenshot aja terus scan dari galeri_`,
                    parse_mode: 'Markdown'
                }
            );
        } else {
            await ctx.reply(
                `📱 *SCAN QR CODE MANUAL*\n\n` +
                `1. Buka WhatsApp → Perangkat Tertaut\n` +
                `2. Tautkan Perangkat\n` +
                `3. Scan kode dibawah (screenshot):\n\n` +
                `\`\`\`\n${qr}\n\`\`\``,
                { parse_mode: 'Markdown' }
            );
        }
    } catch (err) {
        await ctx.reply(
            `📱 *SCAN QR CODE (Teks Backup)*\n\n\`\`\`\n${qr}\n\`\`\``,
            { parse_mode: 'Markdown' }
        );
    }
}

// ══════════════════════════════════════════════════════════════
//  STEALTH KICK — BURST THEN PAUSE PATTERN (DENGAN JEDA PER LANGKAH)
// ══════════════════════════════════════════════════════════════

async function burstThenPauseKick(sock, groupId, jids, onProgress) {
    let totalKicked = 0;
    let i = 0;
    
    // Acak urutan biar gak keliatan sistematis
    const shuffledJids = [...jids];
    for (let iIdx = shuffledJids.length - 1; iIdx > 0; iIdx--) {
        const j = Math.floor(Math.random() * (iIdx + 1));
        [shuffledJids[iIdx], shuffledJids[j]] = [shuffledJids[j], shuffledJids[iIdx]];
    }
    
    while (i < shuffledJids.length) {
        const burstSize = Math.floor(Math.random() * 4) + 1;
        const batch = shuffledJids.slice(i, i + burstSize);
        
        try {
            await simulateReadAndType(sock, groupId, false);
            await sock.groupParticipantsUpdate(groupId, batch, 'remove');
            totalKicked += batch.length;
            if (onProgress) onProgress(totalKicked);
            
            console.log(`[Kick] Berhasil kick ${batch.length} orang (total: ${totalKicked}/${shuffledJids.length})`);
            
            if (i + burstSize < shuffledJids.length) {
                await humanDelayBatchPause();
            }
            
        } catch (err) {
            console.log(`[Kick Error] ${err.message}`);
            await humanDelayError();
        }
        
        i += burstSize;
    }
    
    return totalKicked;
}

// ══════════════════════════════════════════════════════════════
//  LOGIN
// ══════════════════════════════════════════════════════════════

async function destroySession(userId) {
    const old = userSessions.get(userId);
    if (!old) return;
    if (old.qrTimer)     clearTimeout(old.qrTimer);
    if (old.reconnTimer) clearTimeout(old.reconnTimer);
    try {
        old.sock.ev.removeAllListeners();
        old.sock.end(new Error('destroyed'));
    } catch (_) {}
    userSessions.delete(userId);
    await new Promise(r => setTimeout(r, 3500));
}

async function startLogin(ctx, userId) {
    const cooldownUntil = conflictCooldowns.get(userId);
    if (cooldownUntil && Date.now() < cooldownUntil) {
        const sisaDetik = Math.ceil((cooldownUntil - Date.now()) / 1000);
        return ctx.reply(
            `⏳ *Harap tunggu ${sisaDetik} detik lagi*\n\n` +
            `WA server masih melepas koneksi sebelumnya.\n` +
            `_(anti Stream Conflict aktif)_`,
            { parse_mode: 'Markdown' }
        );
    }

    if (loginLocks.get(userId)) {
        return ctx.reply(`⏳ *Proses login sedang berjalan*, harap tunggu...`, { parse_mode: 'Markdown' });
    }
    loginLocks.set(userId, true);

    try {
        if (userSessions.has(userId)) {
            await ctx.reply(`🔄 _Menutup koneksi lama..._`, { parse_mode: 'Markdown' });
            await destroySession(userId);
        }

        const authFolder  = getEncryptedAuthFolder(userId);
        const { version } = await fetchLatestBaileysVersion();
        const browserProfile = generateDynamicFingerprint();
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);

        const connectAnim = await liveConnecting(ctx);

        const sock = makeWASocket({
            auth: state,
            browser: browserProfile,
            logger: pino({ level: 'silent' }),
            connectTimeoutMs: 60_000,
            defaultQueryTimeoutMs: 30_000,
            keepAliveIntervalMs: 30_000,
            retryRequestDelayMs: 500,
            version,
            generateHighQualityLinkPreview: false,
            printQRInTerminal: false,
            shouldReconnect: () => false,
        });

        const session = {
            sock, saveCreds,
            qrTimer: null, reconnTimer: null,
            lastQR: null, qrBlocked: false,
            loggedIn: false, groupId: null, groupName: null, members: [],
            _groupPickerList: null,
            _vcfGroupPickerList: null
        };
        userSessions.set(userId, session);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                session.lastQR = qr;
                if (!session.qrBlocked) {
                    session.qrBlocked = true;
                    try { await connectAnim.stop(null); } catch (_) {}
                    await sendQR(ctx, qr);
                    session.qrTimer = setTimeout(async () => {
                        if (!session.loggedIn) {
                            session.qrBlocked = false;
                            await ctx.reply(
                                `⏱ *QR expired.* Ketik /refreshqr untuk QR baru.`,
                                { parse_mode: 'Markdown' }
                            );
                        }
                    }, 60_000);
                }
            }

            if (connection === 'close') {
                if (session.qrTimer)     clearTimeout(session.qrTimer);
                if (session.reconnTimer) clearTimeout(session.reconnTimer);

                const err        = lastDisconnect?.error;
                const statusCode = err?.output?.statusCode ?? err?.output?.payload?.statusCode;
                const attempts   = (reconnectAttempts.get(userId) || 0) + 1;

                console.log(`[${userId}] WA close — code=${statusCode}, attempt=${attempts}`);

                if (statusCode === 515) {
                    sock.ev.removeAllListeners();
                    userSessions.delete(userId);
                    reconnectAttempts.delete(userId);
                    conflictCooldowns.set(userId, Date.now() + CONFLICT_COOLDOWN_MS);
                    try { await connectAnim.stop(null); } catch (_) {}

                    await ctx.reply(
                        `⚠️ *Stream Conflict (515)*\n\n` +
                        `WA mendeteksi koneksi ganda dari device yang sama.\n\n` +
                        `*Penyebab umum:*\n` +
                        `• Bot di-restart terlalu cepat\n` +
                        `• Ada instance bot lain aktif\n` +
                        `• Session belum dilepas server WA`,
                        { parse_mode: 'Markdown' }
                    );

                    await liveCountdown(
                        ctx,
                        CONFLICT_COOLDOWN_MS,
                        'Cooldown Stream Conflict',
                        () => { conflictCooldowns.delete(userId); }
                    );
                    return;
                }

                if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                    sock.ev.removeAllListeners();
                    userSessions.delete(userId);
                    reconnectAttempts.delete(userId);
                    await ctx.reply(
                        `🚫 *Session ditolak WhatsApp.*\n\nLogin ulang diperlukan.\nTekan *🔑 Login WhatsApp*`,
                        { parse_mode: 'Markdown' }
                    );
                    return;
                }

                if (attempts <= MAX_RECONNECT_ATTEMPTS) {
                    reconnectAttempts.set(userId, attempts);
                    const delayMs  = Math.min(5000 * Math.pow(2, attempts - 1), 30000);
                    const delaySec = Math.ceil(delayMs / 1000);
                    sock.ev.removeAllListeners();
                    userSessions.delete(userId);

                    await ctx.reply(
                        `🔌 Koneksi terputus (code: ${statusCode || '?'}).\n` +
                        `🔄 Reconnect otomatis dalam *${delaySec} detik...* (percobaan ${attempts}/${MAX_RECONNECT_ATTEMPTS})`,
                        { parse_mode: 'Markdown' }
                    );

                    session.reconnTimer = setTimeout(async () => {
                        try { await startLogin(ctx, userId); }
                        catch (e) { console.error('Auto-reconnect error:', e); }
                    }, delayMs);

                } else {
                    sock.ev.removeAllListeners();
                    userSessions.delete(userId);
                    reconnectAttempts.delete(userId);
                    await ctx.reply(
                        `❌ *Koneksi gagal setelah ${MAX_RECONNECT_ATTEMPTS}x percobaan.*\n\n` +
                        `Tekan *🔑 Login WhatsApp* untuk coba manual.`,
                        { parse_mode: 'Markdown' }
                    );
                }
            }

            if (connection === 'open') {
                session.loggedIn = true;
                if (session.qrTimer) clearTimeout(session.qrTimer);
                reconnectAttempts.delete(userId);
                conflictCooldowns.delete(userId);
                try { await connectAnim.stop(null); } catch (_) {}
                try { await sock.sendPresenceUpdate('available'); } catch (_) {}
                
                startBackgroundActivitySpooler(sock, userId);
                
                const kb = isAdmin(userId) ? KB_ADMIN_MAIN : KB_MAIN;
                await ctx.reply(
                    `✅ *LOGIN WHATSAPP BERHASIL!*\n\nPilih menu di keyboard bawah.`,
                    { parse_mode: 'Markdown', ...kb }
                );
            }
        });

        sock.ev.on('creds.update', () => { saveCreds(); });

    } finally {
        loginLocks.delete(userId);
    }
}

// ══════════════════════════════════════════════════════════════
//  GROUP PICKER — KICK MENU
// ══════════════════════════════════════════════════════════════

async function showGroupPicker(ctx, userId, session) {
    const fetchAnim = await spinnerMessage(ctx, 'Mengambil daftar grup...');
    try {
        const chats  = await session.sock.groupFetchAllParticipating();
        const groups = Object.values(chats);

        if (groups.length === 0) {
            await fetchAnim.stop(`❌ *Tidak ada grup ditemukan.*`);
            return;
        }

        const isTrial       = isTrialOnly(userId);
        const displayGroups = isTrial ? groups.slice(0, 1) : groups;

        session._groupPickerList = displayGroups;

        const buttons = displayGroups.map((g, i) => {
            const memberCount = g.participants?.length || 0;
            const label = `${i + 1}. ${g.subject} (${memberCount} 👥)`.substring(0, 64);
            return [Markup.button.callback(label, `selectgrp_${i}`)];
        });
        buttons.push([Markup.button.callback('❌ Batal', 'selectgrp_cancel')]);

        await fetchAnim.stop(null);

        let header = `╔${DIVIDER}╗\n║  PILIH GRUP\n╚${DIVIDER}╝\n\n`;
        if (isTrial) header += `⚠️ _Trial: hanya 1 grup_\n\n`;
        header += `Ketuk nama grup yang ingin dipilih:`;

        await ctx.reply(header, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    } catch (err) {
        await fetchAnim.stop(`❌ *Error:* ${err.message}`);
    }
}

// ══════════════════════════════════════════════════════════════
//  KICK MENU BUILDER
// ══════════════════════════════════════════════════════════════

function buildMemberKeyboard(members, selected) {
    const buttons = [];
    for (const m of members) {
        const isSelected = selected.has(m.jid);
        buttons.push([Markup.button.callback(`${isSelected ? '✅' : '⬜'} ${m.name.substring(0, 25)}`, `toggle_${m.jid}`)]);
    }
    buttons.push([Markup.button.callback('🔨 KICK TERPILIH', 'do_kick')]);
    buttons.push([Markup.button.callback('❌ BATAL', 'cancel_kick')]);
    return { reply_markup: { inline_keyboard: buttons } };
}

async function showKickMenu(ctx, userId, session) {
    const fetchAnim = await spinnerMessage(ctx, 'Mengambil daftar anggota...');
    try {
        const metadata = await session.sock.groupMetadata(session.groupId);
        const myJid    = session.sock.user.id.replace(/:.*@/, '@');
        const allMembers = metadata.participants
            .filter(p => {
                const isMe  = p.id === myJid || p.id.split('@')[0] === myJid.split('@')[0];
                const isAdm = p.admin === 'admin' || p.admin === 'superadmin';
                return !isMe && !isAdm;
            })
            .map(p => ({ jid: p.id, name: p.id.split('@')[0] }));

        if (allMembers.length === 0) {
            await fetchAnim.stop(null);
            return ctx.reply(`ℹ️ *Tidak ada anggota yang bisa dikick.*\n\nSemua anggota adalah admin.`, { parse_mode: 'Markdown' });
        }

        const members = allMembers.slice(0, KICK_LIMIT_PER_SESSION);
        const limited = allMembers.length > KICK_LIMIT_PER_SESSION;

        session.members = members;
        kickSelections.set(userId, new Set());
        await fetchAnim.stop(null);

        let infoText = '';
        if (limited) {
            infoText = `\n⚠️ _Ditampilkan ${KICK_LIMIT_PER_SESSION} dari ${allMembers.length} anggota (batas per sesi)_`;
        }

        await ctx.reply(
            `╔${DIVIDER}╗\n║  MENU KICK ANGGOTA\n╚${DIVIDER}╝\n\n` +
            `🎯 Grup: *${session.groupName}*\n` +
            `👥 Non-admin: *${members.length} orang*${infoText}\n\n` +
            `Ketuk nama untuk pilih/batal.\n` +
            `Tekan *Kick Terpilih* jika sudah siap.\n\n` +
            `⚠️ _Aksi kick tidak bisa dibatalkan!_`,
            { parse_mode: 'Markdown', ...buildMemberKeyboard(members, kickSelections.get(userId)) }
        );
    } catch (err) {
        await fetchAnim.stop(`❌ *Error:* ${err.message}`);
    }
}

// ══════════════════════════════════════════════════════════════
//  VCF PARSER
// ══════════════════════════════════════════════════════════════

function parseVCF(vcfText) {
    const contacts = [];
    const seen     = new Set();
    const blocks   = vcfText.split(/END:VCARD/i).map(b => b.trim()).filter(Boolean);

    for (const block of blocks) {
        let name = 'Tanpa Nama';
        const fnMatch = block.match(/^FN[;:][^\r\n]*/mi);
        const nMatch  = block.match(/^N[;:][^\r\n]*/mi);
        if (fnMatch) {
            const qpMatch = fnMatch[0].match(/ENCODING=QUOTED-PRINTABLE.*?:(.*)/i);
            if (qpMatch) {
                try { name = decodeQP(qpMatch[1].trim()); } catch (_) {}
            } else {
                name = fnMatch[0].replace(/^FN.*?:/i, '').trim();
            }
        } else if (nMatch) {
            const raw   = nMatch[0].replace(/^N.*?:/i, '').trim();
            const parts = raw.split(';').map(p => p.trim()).filter(Boolean);
            name = parts.slice(0, 2).reverse().join(' ').trim() || 'Tanpa Nama';
        }
        name = name.replace(/[\x00-\x1F]/g, '').trim() || 'Tanpa Nama';

        const telLines = block.match(/^TEL[^\r\n]*/gim) || [];
        for (const telLine of telLines) {
            let num = telLine.replace(/^TEL[^:]*:/i, '').replace(/[\s\-().]/g, '').trim();
            if (!num) continue;
            num = normalizePhone(num);
            if (!num) continue;
            if (seen.has(num)) continue;
            seen.add(num);
            contacts.push({ name, phone: num });
        }
    }
    return contacts;
}

function decodeQP(str) {
    return str.replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function normalizePhone(raw) {
    const hasPlus = raw.trimStart().startsWith('+');
    let digits    = raw.replace(/\D/g, '');
    if (!digits) return null;

    if (hasPlus || digits.startsWith('00')) {
        const withCC = hasPlus ? digits : digits.slice(2);
        if (withCC.length >= 7) return withCC;
    }

    if (digits.startsWith('0')) return '62' + digits.slice(1);
    if (digits.startsWith('62')) return digits;
    if (digits.length >= 9) return '62' + digits;

    return digits.length >= 7 ? digits : null;
}

const vcfPending = new Map();

// ══════════════════════════════════════════════════════════════
//  ADD CONTACTS TO GROUP — DENGAN JEDA PER LANGKAH
// ══════════════════════════════════════════════════════════════

async function addContactsToGroup(ctx, userId, contacts, groupId, groupName) {
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) {
        return ctx.reply('❌ *Session WA berakhir.* Tekan *🔑 Login WhatsApp*.', { parse_mode: 'Markdown' });
    }

    const total  = contacts.length;
    let berhasil = 0, gagal = 0, notWA = 0;

    const statusMsg = await ctx.reply(`⏳ *Menambahkan ${total} kontak ke grup...*`, { parse_mode: 'Markdown' });

    for (let i = 0; i < contacts.length; i++) {
        const c = contacts[i];
        try {
            const [result] = await session.sock.onWhatsApp(c.phone);
            if (!result || !result.exists) { 
                notWA++; 
                console.log(`[Add] ${c.phone} => No WA`);
                continue; 
            }
            
            await simulateReadAndType(session.sock, groupId, true);
            await session.sock.groupParticipantsUpdate(groupId, [result.jid], 'add');
            berhasil++;
            console.log(`[Add] ✅ ${c.name} (${c.phone}) berhasil ditambahkan`);
            
            if (i + 1 < contacts.length) {
                await humanDelayAdd();
            }
            
            if ((i + 1) % 3 === 0 || i + 1 === total) {
                try {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id, statusMsg.message_id, null,
                        `⏳ Progres: ${i + 1}/${total}\n✅ Berhasil: ${berhasil} | 📵 No WA: ${notWA}`,
                        { parse_mode: 'Markdown' }
                    );
                } catch (_) {}
            }
            
        } catch (err) {
            gagal++;
            console.log(`[Add Error] ${c.phone}: ${err.message}`);
            await humanDelayError();
        }
    }

    let hasil = `╔${DIVIDER}╗\n║  HASIL IMPORT VCF\n╚${DIVIDER}╝\n\n`;
    hasil += `🎯 *Grup:* ${groupName}\n\n`;
    hasil += `${DIVIDER_THIN}\n`;
    hasil += `✅ *Berhasil ditambah:* ${berhasil} kontak\n`;
    hasil += `📵 *Tidak punya WA:* ${notWA} kontak\n`;
    hasil += `❌ *Error:* ${gagal} kontak\n`;

    await ctx.reply(hasil, { parse_mode: 'Markdown' });
    vcfPending.delete(userId);
}

// ══════════════════════════════════════════════════════════════
//  COMMAND HANDLERS
// ══════════════════════════════════════════════════════════════

tgBot.start(async (ctx) => {
    const userId   = ctx.from.id;
    const name     = ctx.from.first_name || 'User';
    const status   = getUserStatus(userId);
    const loggedIn = userSessions.get(userId)?.loggedIn;

    if (isAdmin(userId)) {
        const kb = loggedIn ? KB_ADMIN_MAIN : KB_ADMIN_PRE;
        return ctx.reply(
            `╔${DIVIDER}╗\n║  ${BOT_NAME}\n╚${DIVIDER}╝\n\n` +
            `👑 *Selamat datang, Admin ${esc(name)}!*\n\n` +
            `${DIVIDER_THIN}\n` +
            (loggedIn ? `✅ WA: *Terhubung*\n\n*Pilih menu di keyboard bawah:*` : `🔴 WA: *Belum login*\n\nTekan *🔑 Login WhatsApp* untuk mulai.`),
            { parse_mode: 'Markdown', ...kb }
        );
    }

    if (status === 'regular') {
        const u  = getUser(userId);
        const kb = loggedIn ? KB_MAIN : KB_PRE_LOGIN;
        return ctx.reply(
            `╔${DIVIDER}╗\n║  ${BOT_NAME}\n╚${DIVIDER}╝\n\n` +
            `✅ *Halo ${esc(name)}!*\n\n` +
            `${DIVIDER_THIN}\n` +
            `🏷️ Status: *Premium Aktif*\n` +
            `📅 Hingga: *${formatDate(u.expiresAt)}*\n` +
            `⏳ Sisa: *${formatCountdown(u.expiresAt)}*\n` +
            `${DIVIDER_THIN}\n\n` +
            (loggedIn ? `📡 WA: *Terhubung* ✅` : `🔴 WA: *Belum login*`),
            { parse_mode: 'Markdown', ...kb }
        );
    }

    if (status === 'trial') {
        const u  = getUser(userId);
        const kb = loggedIn ? KB_MAIN : KB_PRE_LOGIN;
        return ctx.reply(
            `╔${DIVIDER}╗\n║  ${BOT_NAME}\n╚${DIVIDER}╝\n\n` +
            `🎁 *Halo ${esc(name)}!*\n\n` +
            `${DIVIDER_THIN}\n` +
            `🏷️ Status: *Trial Aktif*\n` +
            `⏱ Habis: *${formatDate(u.trialExpiresAt)}*\n` +
            `⏳ Sisa: *${formatCountdown(u.trialExpiresAt)}*\n` +
            `${DIVIDER_THIN}\n\n` +
            (loggedIn ? `📡 WA: *Terhubung* ✅` : `🔴 WA: *Belum login*`),
            { parse_mode: 'Markdown', ...kb }
        );
    }

    if (status === 'expired' || status === 'trial_expired') {
        return ctx.reply(
            `⚠️ *Akses lo sudah berakhir.*\nPerpanjang untuk bisa pakai lagi!`,
            { parse_mode: 'Markdown', ...KB_LANDING }
        );
    }

    await ctx.reply(
        `👋 *Halo ${esc(name)}!*\n\n` +
        `Bot ini membantu lo *kick anggota grup WhatsApp*.\n\n` +
        `🎁 *COBA GRATIS ${TRIAL_DURATION_HOURS} JAM*\n` +
        `⭐ *PREMIUM* — akses penuh\n\n` +
        `Pilih di keyboard bawah:`,
        { parse_mode: 'Markdown', ...KB_LANDING }
    );
});

tgBot.command('trial', async (ctx) => {
    const user   = ctx.from;
    const status = getUserStatus(user.id);

    if (status === 'admin')   return ctx.reply('👑 Lo adalah admin.', KB_ADMIN_PRE);
    if (status === 'regular') return ctx.reply('✅ Lo sudah punya akses reguler.', getKeyboard(user.id));
    if (status === 'trial') {
        const u = getUser(user.id);
        return ctx.reply(`⏱ *Masih trial.* Sisa: ${formatCountdown(u.trialExpiresAt)}`, { parse_mode: 'Markdown', ...KB_PRE_LOGIN });
    }

    const result = startTrial(user);
    if (!result.success) return ctx.reply(`❌ Gagal: ${result.reason}`);

    await ctx.reply(
        `🎉 *TRIAL AKTIF!*\n\n✅ ${TRIAL_DURATION_HOURS} jam\n⏱ Berakhir: ${formatDate(result.expiresAt.toISOString())}\n\n` +
        `Tekan *🔑 Login WhatsApp* untuk mulai!`,
        { parse_mode: 'Markdown', ...KB_PRE_LOGIN }
    );
});

async function showPriceMenu(ctx) {
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback(`📦 1 Bulan — ${formatRupiah(PACKAGES['1bulan'].price)}`, 'buy_1bulan')],
        [Markup.button.callback(`📦 3 Bulan — ${formatRupiah(PACKAGES['3bulan'].price)}`, 'buy_3bulan')],
        [Markup.button.callback(`📦 6 Bulan — ${formatRupiah(PACKAGES['6bulan'].price)}`, 'buy_6bulan')],
        [Markup.button.callback(`🏆 1 Tahun — ${formatRupiah(PACKAGES['1tahun'].price)}`, 'buy_1tahun')],
    ]);

    await ctx.reply(
        `╔${DIVIDER}╗\n║  PAKET HARGA\n╚${DIVIDER}╝\n\n` +
        `📦 1 Bulan → ${formatRupiah(PACKAGES['1bulan'].price)}\n` +
        `📦 3 Bulan → ${formatRupiah(PACKAGES['3bulan'].price)}\n` +
        `📦 6 Bulan → ${formatRupiah(PACKAGES['6bulan'].price)}\n` +
        `🏆 1 Tahun → ${formatRupiah(PACKAGES['1tahun'].price)}\n\n` +
        `Pilih paket di bawah:`,
        { parse_mode: 'Markdown', ...keyboard }
    );
}

tgBot.command('beli', showPriceMenu);

Object.keys(PACKAGES).forEach(pkgKey => {
    tgBot.action(`buy_${pkgKey}`, async (ctx) => {
        await ctx.answerCbQuery();
        const pkg  = PACKAGES[pkgKey];
        const user = ctx.from;

        addPendingPayment(user, pkgKey);

        for (const adminId of ADMIN_IDS) {
            try {
                const approveKeyboard = Markup.inlineKeyboard([
                    [Markup.button.callback(`✅ Approve`, `admin_approve_${user.id}_${pkgKey}`), Markup.button.callback(`❌ Reject`, `admin_reject_${user.id}`)]
                ]);
                await tgBot.telegram.sendMessage(adminId, `🔔 *Permintaan Beli*\n👤 ${userDisplayName(user)}\n📦 ${pkg.label} (${formatRupiah(pkg.price)})`, { parse_mode: 'Markdown', ...approveKeyboard });
            } catch (_) {}
        }

        await ctx.reply(
            `✅ *Permintaan diterima!*\n\n💰 ${formatRupiah(pkg.price)}\n${PAYMENT_INFO}\n\nKonfirmasi ke ${PAYMENT_CONTACT} dengan format: \`KICKER-${user.id}-${pkgKey}\``,
            { parse_mode: 'Markdown' }
        );
    });
});

tgBot.action(/^admin_approve_(\d+)_(\w+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ditolak.');
    await ctx.answerCbQuery();

    const targetId = parseInt(ctx.match[1]);
    const pkgKey   = ctx.match[2];
    const result   = approvePayment(targetId, pkgKey);

    if (!result.success) return ctx.editMessageText(`❌ Gagal: ${result.reason}`);

    await ctx.editMessageText(`✅ *APPROVED!*\nID: ${targetId}\nPaket: ${result.pkg.label}\nAktif hingga: ${formatDate(result.expiresAt.toISOString())}`, { parse_mode: 'Markdown' });

    try {
        await tgBot.telegram.sendMessage(targetId, `🎉 *PEMBAYARAN DIKONFIRMASI!*\n\n📦 ${result.pkg.label}\n📅 Aktif hingga: ${formatDate(result.expiresAt.toISOString())}\n\nTekan *🔑 Login WhatsApp* untuk mulai.`, { parse_mode: 'Markdown', ...KB_PRE_LOGIN });
    } catch (_) {}
});

tgBot.action(/^admin_reject_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ditolak.');
    await ctx.answerCbQuery();

    const targetId = parseInt(ctx.match[1]);
    const data = loadData();
    const idx  = data.pendingPayment.findIndex(p => p.id === targetId);
    if (idx >= 0) data.pendingPayment.splice(idx, 1);
    saveData(data);

    await ctx.editMessageText(`❌ *REJECTED*\nID: ${targetId}`, { parse_mode: 'Markdown' });

    try {
        await tgBot.telegram.sendMessage(targetId, `❌ *Pembayaran ditolak.*\nHubungi ${PAYMENT_CONTACT}`, { parse_mode: 'Markdown', ...KB_LANDING });
    } catch (_) {}
});

tgBot.command('login', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (session && session.loggedIn) {
        return ctx.reply('✅ *Lo udah login!*', { parse_mode: 'Markdown' });
    }
    await ctx.reply(`🔄 *Memulai koneksi...*`, { parse_mode: 'Markdown' });
    try {
        await startLogin(ctx, userId);
    } catch (err) {
        await ctx.reply(`❌ *Gagal:* ${err.message}`, { parse_mode: 'Markdown' });
    }
});

tgBot.command('refreshqr', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session) return ctx.reply('❌ Belum ada sesi.', { parse_mode: 'Markdown' });
    if (session.loggedIn) return ctx.reply('✅ Sudah login!');
    if (!session.lastQR) return ctx.reply('⏳ QR belum tersedia.');
    await sendQR(ctx, session.lastQR);
});

tgBot.command('logout', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    if (!userSessions.has(userId)) return ctx.reply('❌ Belum login!');
    try {
        await destroySession(userId);
        const authFolder = getEncryptedAuthFolder(userId);
        if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
        kickSelections.delete(userId);
        reconnectAttempts.delete(userId);
        conflictCooldowns.delete(userId);
        loginLocks.delete(userId);
        await ctx.reply('✅ *Logout berhasil.*', { parse_mode: 'Markdown', ...KB_PRE_LOGIN });
    } catch (err) {
        await ctx.reply(`❌ *Error:* ${err.message}`, { parse_mode: 'Markdown' });
    }
});

tgBot.command('groups', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ *Login dulu!*', { parse_mode: 'Markdown' });
    await showGroupPicker(ctx, userId, session);
});

tgBot.command('select', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ *Login dulu!*', { parse_mode: 'Markdown' });

    const groupName = ctx.message.text.replace('/select', '').trim().replace(/^["']|["']$/g, '');
    if (groupName) {
        try {
            const chats  = await session.sock.groupFetchAllParticipating();
            const groups = Object.values(chats);
            const isTrial = isTrialOnly(userId);
            const allowedGroups = isTrial ? groups.slice(0, 1) : groups;
            const target = allowedGroups.find(g => g.subject.toLowerCase() === groupName.toLowerCase());
            if (!target) return ctx.reply(`❌ Grup "${groupName}" tidak ditemukan.`, { parse_mode: 'Markdown' });
            session.groupId   = target.id;
            session.groupName = target.subject;
            await ctx.reply(`✅ *Grup terpilih!*\n🎯 ${esc(target.subject)}\n👥 ${target.participants?.length || 0} anggota\n\nTekan *🔴 Kick Menu* untuk mulai.`, { parse_mode: 'Markdown' });
        } catch (err) {
            await ctx.reply(`❌ Error: ${err.message}`, { parse_mode: 'Markdown' });
        }
    } else {
        await showGroupPicker(ctx, userId, session);
    }
});

tgBot.command('kickmenu', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ *Login dulu!*', { parse_mode: 'Markdown' });
    if (!session.groupId) return ctx.reply('❌ *Pilih grup dulu!*', { parse_mode: 'Markdown' });
    await showKickMenu(ctx, userId, session);
});

tgBot.command('buatgrup', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ *Login dulu!*', { parse_mode: 'Markdown' });

    const namaGrup = ctx.message.text.replace('/buatgrup', '').trim().replace(/^["']|["']$/g, '');
    if (!namaGrup) return ctx.reply('Format: /buatgrup "Nama Grup"', { parse_mode: 'Markdown' });

    await ctx.reply(`⏳ *Membuat grup "${namaGrup}"...*`, { parse_mode: 'Markdown' });

    try {
        const result = await session.sock.groupCreate(namaGrup, []);
        session.groupId   = result.id;
        session.groupName = namaGrup;

        let inviteLink = '-';
        try {
            const code = await session.sock.groupInviteCode(result.id);
            inviteLink = `https://chat.whatsapp.com/${code}`;
        } catch (_) {}

        await ctx.reply(`✅ *Grup berhasil dibuat!*\n\n${namaGrup}\n🔗 ${inviteLink}\n\nTekan *🔴 Kick Menu* untuk mulai.`, { parse_mode: 'Markdown' });
    } catch (err) {
        await ctx.reply(`❌ Gagal: ${err.message}`, { parse_mode: 'Markdown' });
    }
});

tgBot.command('importvcf', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ *Login dulu!*', { parse_mode: 'Markdown' });

    const fetchAnim = await spinnerMessage(ctx, 'Mengambil daftar grup...');
    try {
        const chats  = await session.sock.groupFetchAllParticipating();
        const groups = Object.values(chats);

        if (groups.length === 0) {
            await fetchAnim.stop(`❌ *Tidak ada grup ditemukan.*`);
            return;
        }

        const isTrial       = isTrialOnly(userId);
        const displayGroups = isTrial ? groups.slice(0, 1) : groups;

        session._vcfGroupPickerList = displayGroups;

        const buttons = displayGroups.map((g, i) => {
            const memberCount = g.participants?.length || 0;
            const label = `${i + 1}. ${g.subject} (${memberCount} 👥)`.substring(0, 64);
            return [Markup.button.callback(label, `vcfgrp_${i}`)];
        });
        buttons.push([Markup.button.callback('❌ Batal', 'vcfgrp_cancel')]);

        await fetchAnim.stop(null);

        let header = `╔${DIVIDER}╗\n║  PILIH GRUP TUJUAN VCF\n╚${DIVIDER}╝\n\n`;
        if (isTrial) header += `⚠️ _Trial: hanya 1 grup_\n\n`;
        header += `Pilih grup yang akan ditambahkan kontaknya:`;

        await ctx.reply(header, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    } catch (err) {
        await fetchAnim.stop(`❌ *Error:* ${err.message}`);
    }
});

tgBot.command('status', requireAccess, async (ctx) => {
    const userId    = ctx.from.id;
    const session   = userSessions.get(userId);
    const accStatus = getUserStatus(userId);
    const u         = getUser(userId);

    let waStatus = '🔴 Belum Login';
    if (session && !session.loggedIn) waStatus = '🟡 Menunggu QR';
    if (session && session.loggedIn)  waStatus = '🟢 Terhubung';

    let accLine = '';
    if (accStatus === 'admin')        accLine = '👑 Admin';
    else if (accStatus === 'regular') accLine = `⭐ Reguler (${formatCountdown(u?.expiresAt)})`;
    else if (accStatus === 'trial')   accLine = `🎁 Trial (${formatCountdown(u?.trialExpiresAt)})`;

    await ctx.reply(`📡 WA: ${waStatus}\n🏷️ Akun: ${accLine}\n🎯 Grup: ${session?.groupName || 'Belum pilih'}`, { parse_mode: 'Markdown' });
});

tgBot.command('myaccount', async (ctx) => {
    const userId = ctx.from.id;
    const status = getUserStatus(userId);
    if (status === 'admin') return ctx.reply(`👑 Admin bot.`, { parse_mode: 'Markdown' });
    const u = getUser(userId);
    if (!u) return ctx.reply(`Belum terdaftar. Tekan *🎁 Coba Gratis*`, { parse_mode: 'Markdown', ...KB_LANDING });
    await ctx.reply(`👤 ${userDisplayNameEsc(u)}\n🆔 ${u.id}\nStatus: ${status}\nExp: ${u.expiresAt ? formatDate(u.expiresAt) : u.trialExpiresAt ? formatDate(u.trialExpiresAt) : '-'}`, { parse_mode: 'Markdown' });
});

tgBot.command('help', async (ctx) => {
    await ctx.reply(
        "╔━━━━━━━━━━━━━━━━━━━━━━╗\n" +
        "║  PANDUAN PENGGUNAAN\n" +
        "╚━━━━━━━━━━━━━━━━━━━━━━╝\n\n" +
        "┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n" +
        "*📌 CARA PAKAI BOT:*\n" +
        "┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n" +
        "*1. Daftar & Aktifkan Akses*\n" +
        "   Tekan 🎁 Coba Gratis untuk trial gratis 24 jam\n" +
        "   Tekan ⭐ Premium untuk beli paket reguler\n\n" +
        "*2. Login WhatsApp*\n" +
        "   Tekan 🔑 Login WhatsApp\n" +
        "   → Scan QR di WA lo\n\n" +
        "*3. Pilih Grup (Kick)*\n" +
        "   Tekan 📋 Daftar Grup atau 🎯 Pilih Grup\n" +
        "   → Ketuk nama grup langsung dari daftar\n\n" +
        "*4. Import VCF*\n" +
        "   Tekan 📥 Import VCF\n" +
        "   → Pilih grup tujuan dari daftar\n" +
        "   → Kirim file .vcf\n\n" +
        "*5. Kick Anggota*\n" +
        "   Tekan 🔴 Kick Menu\n" +
        "   → Centang anggota yang mau dikick\n" +
        "   → Tekan tombol \"Kick\"\n\n" +
        "┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n" +
        "*⚠️ PENTING:*\n" +
        "• Bot hanya bisa kick jika lo adalah *admin grup*\n" +
        "• Akun WA yang login harus jadi *admin* di grup target\n" +
        "• Trial hanya bisa akses *1 grup*\n" +
        "• Kick & Import VCF punya *pilihan grup terpisah*\n" +
        "┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n" +
        `Butuh bantuan? Hubungi ${PAYMENT_CONTACT}`,
        { parse_mode: 'Markdown' }
    );
});

tgBot.command('pendingpayment', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const list = getAllPendingPayments();
    if (list.length === 0) return ctx.reply(`📭 Kosong.`);
    let msg = `PENDING: ${list.length}\n\n`;
    for (const p of list) {
        msg += `👤 ${p.id}\n📦 ${p.packageKey}\n📅 ${formatDate(p.requestedAt)}\n\n`;
    }
    await ctx.reply(msg);
});

tgBot.command('userlist', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Akses ditolak.');

    const users = getAllUsers();
    if (users.length === 0) return ctx.reply('*Belum ada user terdaftar.*', { parse_mode: 'Markdown' });

    const now     = new Date();
    const actives = users.filter(u => {
        const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
        return exp && new Date(exp) > now;
    });
    const expired = users.filter(u => {
        const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
        return !exp || new Date(exp) <= now;
    });

    let msg = "╔━━━━━━━━━━━━━━━━━━━━━━╗\n║  DAFTAR USER\n╚━━━━━━━━━━━━━━━━━━━━━━╝\n\n";
    msg += `✅ Aktif: ${actives.length}  |  ❌ Expired: ${expired.length}\n\n`;

    if (actives.length > 0) {
        msg += "┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n✅ USER AKTIF:\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n";
        for (let i = 0; i < actives.length; i++) {
            const u   = actives[i];
            const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
            const role = u.role === 'trial' ? '🎁 Trial' : '⭐ Reguler';
            msg += `${i + 1}. ${userDisplayName(u)}\n`;
            msg += `   ID: \`${u.id}\` | ${role}\n`;
            msg += `   Exp: ${formatDate(exp)} (${formatCountdown(exp)})\n\n`;
        }
    }

    if (expired.length > 0 && expired.length <= 10) {
        msg += "┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n❌ EXPIRED:\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n";
        expired.forEach((u, i) => {
            const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
            msg += `${i + 1}. ${userDisplayName(u)} | ID: \`${u.id}\`\n`;
            msg += `   Expired: ${formatDate(exp)}\n\n`;
        });
    } else if (expired.length > 10) {
        msg += `\n_(+${expired.length} user expired tidak ditampilkan)_\n\n`;
    }

    msg += `\n/revokeuser [id] — Cabut akses`;
    await ctx.reply(msg, { parse_mode: 'Markdown' });
});

tgBot.command('revokeuser', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Akses ditolak.');

    const args     = ctx.message.text.split(' ');
    const targetId = parseInt(args[1]);
    if (!targetId) return ctx.reply(`*Format:* /revokeuser [user_id]`, { parse_mode: 'Markdown' });

    const user = revokeUser(targetId);
    if (!user) return ctx.reply(`❌ User ID ${targetId} tidak ditemukan.`);

    if (userSessions.has(targetId)) {
        const session = userSessions.get(targetId);
        if (session.qrTimer) clearTimeout(session.qrTimer);
        try { session.sock.end(new Error('revoked')); } catch (_) {}
        userSessions.delete(targetId);
    }

    await ctx.reply(`🚫 Akses ${userDisplayName(user)} (ID: ${targetId}) dicabut.`);

    try {
        await tgBot.telegram.sendMessage(targetId,
            `⚠️ *Akses lo ke ${BOT_NAME} telah dicabut oleh admin.*\n\nHubungi ${PAYMENT_CONTACT} jika ada pertanyaan.`,
            { parse_mode: 'Markdown', ...KB_LANDING }
        );
    } catch (_) {}
});

tgBot.command('adduser', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Akses ditolak.');

    const args     = ctx.message.text.split(' ');
    const targetId = parseInt(args[1]);
    const pkgKey   = args[2];

    if (!targetId || !pkgKey || !PACKAGES[pkgKey]) {
        return ctx.reply(
            `*Format:* /adduser [user_id] [paket]\n\nPaket: 1bulan / 3bulan / 6bulan / 1tahun`,
            { parse_mode: 'Markdown' }
        );
    }

    const result = approvePayment(targetId, pkgKey);
    if (!result.success) return ctx.reply(`❌ Gagal: ${result.reason}`);

    await ctx.reply(
        `✅ *User berhasil ditambahkan!*\n\n🆔 ID: \`${targetId}\`\n📦 Paket: *${result.pkg.label}*\n📅 Aktif hingga: *${formatDate(result.expiresAt.toISOString())}*`,
        { parse_mode: 'Markdown' }
    );

    try {
        await tgBot.telegram.sendMessage(targetId,
            `🎉 *Akses ke ${BOT_NAME} sudah diaktifkan!*\n\n📦 Paket: *${result.pkg.label}*\n📅 Aktif hingga: *${formatDate(result.expiresAt.toISOString())}*\n\nTekan *🔑 Login WhatsApp* untuk mulai.`,
            { parse_mode: 'Markdown', ...KB_PRE_LOGIN }
        );
    } catch (_) {}
});

// ══════════════════════════════════════════════════════════════
//  HEARS HANDLERS
// ══════════════════════════════════════════════════════════════

tgBot.hears('🎁 Coba Gratis (Trial)', async (ctx) => {
    const user   = ctx.from;
    const status = getUserStatus(user.id);
    if (status === 'regular') return ctx.reply('✅ Sudah punya akses.', getKeyboard(user.id));
    if (status === 'trial') {
        const u = getUser(user.id);
        return ctx.reply(`⏱ Masih trial: ${formatCountdown(u.trialExpiresAt)}`, { parse_mode: 'Markdown', ...KB_PRE_LOGIN });
    }
    const result = startTrial(user);
    if (!result.success) return ctx.reply(`❌ ${result.reason}`);
    await ctx.reply(`🎉 *TRIAL AKTIF!*\n\nTekan *🔑 Login WhatsApp* untuk mulai.`, { parse_mode: 'Markdown', ...KB_PRE_LOGIN });
});

tgBot.hears('⭐ Premium', async (ctx) => { await showPriceMenu(ctx); });

tgBot.hears('❓ Bantuan', async (ctx) => {
    await ctx.reply(
        "╔━━━━━━━━━━━━━━━━━━━━━━╗\n" +
        "║  PANDUAN PENGGUNAAN\n" +
        "╚━━━━━━━━━━━━━━━━━━━━━━╝\n\n" +
        "┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n" +
        "*📌 CARA PAKAI BOT:*\n" +
        "┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n" +
        "*1. Daftar & Aktifkan Akses*\n" +
        "   Tekan 🎁 Coba Gratis untuk trial gratis 24 jam\n" +
        "   Tekan ⭐ Premium untuk beli paket reguler\n\n" +
        "*2. Login WhatsApp*\n" +
        "   Tekan 🔑 Login WhatsApp\n" +
        "   → Scan QR di WA lo\n\n" +
        "*3. Pilih Grup (Kick)*\n" +
        "   Tekan 📋 Daftar Grup atau 🎯 Pilih Grup\n" +
        "   → Ketuk nama grup langsung dari daftar\n\n" +
        "*4. Import VCF*\n" +
        "   Tekan 📥 Import VCF\n" +
        "   → Pilih grup tujuan dari daftar\n" +
        "   → Kirim file .vcf\n\n" +
        "*5. Kick Anggota*\n" +
        "   Tekan 🔴 Kick Menu\n" +
        "   → Centang anggota yang mau dikick\n" +
        "   → Tekan tombol \"Kick\"\n\n" +
        "┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n" +
        "*⚠️ PENTING:*\n" +
        "• Bot hanya bisa kick jika lo adalah *admin grup*\n" +
        "• Akun WA yang login harus jadi *admin* di grup target\n" +
        "• Trial hanya bisa akses *1 grup*\n" +
        "• Kick & Import VCF punya *pilihan grup terpisah*\n" +
        "┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n" +
        `Butuh bantuan? Hubungi ${PAYMENT_CONTACT}`,
        { parse_mode: 'Markdown' }
    );
});

tgBot.hears('🔑 Login WhatsApp', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (session && session.loggedIn) {
        return ctx.reply('✅ *Lo udah login!*', { parse_mode: 'Markdown' });
    }
    await ctx.reply(`🔄 *Memulai koneksi...*`, { parse_mode: 'Markdown' });
    try {
        await startLogin(ctx, userId);
    } catch (err) {
        await ctx.reply(`❌ *Gagal:* ${err.message}`, { parse_mode: 'Markdown' });
    }
});

tgBot.hears('📊 Status', requireAccess, async (ctx) => {
    const userId    = ctx.from.id;
    const session   = userSessions.get(userId);
    const accStatus = getUserStatus(userId);
    const u         = getUser(userId);

    let waStatus = '🔴 Belum Login';
    if (session && !session.loggedIn) waStatus = '🟡 Menunggu QR';
    if (session && session.loggedIn)  waStatus = '🟢 Terhubung';

    let accLine = '';
    if (accStatus === 'admin')        accLine = '👑 Admin';
    else if (accStatus === 'regular') accLine = `⭐ Reguler (${formatCountdown(u?.expiresAt)})`;
    else if (accStatus === 'trial')   accLine = `🎁 Trial (${formatCountdown(u?.trialExpiresAt)})`;

    await ctx.reply(`📡 WA: ${waStatus}\n🏷️ Akun: ${accLine}\n🎯 Grup: ${session?.groupName || 'Belum pilih'}`, { parse_mode: 'Markdown' });
});

tgBot.hears('👤 Akun Saya', async (ctx) => {
    const userId = ctx.from.id;
    const status = getUserStatus(userId);
    if (status === 'admin') return ctx.reply(`👑 Admin bot.`, { parse_mode: 'Markdown' });
    const u = getUser(userId);
    if (!u) return ctx.reply(`Belum terdaftar. Tekan *🎁 Coba Gratis*`, { parse_mode: 'Markdown', ...KB_LANDING });
    await ctx.reply(`👤 ${userDisplayNameEsc(u)}\n🆔 ${u.id}\nStatus: ${status}\nExp: ${u.expiresAt ? formatDate(u.expiresAt) : u.trialExpiresAt ? formatDate(u.trialExpiresAt) : '-'}`, { parse_mode: 'Markdown' });
});

tgBot.hears('📋 Daftar Grup', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ *Login dulu!*', { parse_mode: 'Markdown' });
    await showGroupPicker(ctx, userId, session);
});

tgBot.hears('🎯 Pilih Grup', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ *Login dulu!*', { parse_mode: 'Markdown' });
    await showGroupPicker(ctx, userId, session);
});

tgBot.hears('➕ Buat Grup WA', requireAccess, async (ctx) => {
    await ctx.reply(`Format: /buatgrup "Nama Grup"\n\nContoh: /buatgrup "Arisan RT 05"`, { parse_mode: 'Markdown' });
});

tgBot.hears('📥 Import VCF', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ *Login dulu!*', { parse_mode: 'Markdown' });

    const fetchAnim = await spinnerMessage(ctx, 'Mengambil daftar grup...');
    try {
        const chats  = await session.sock.groupFetchAllParticipating();
        const groups = Object.values(chats);

        if (groups.length === 0) {
            await fetchAnim.stop(`❌ *Tidak ada grup ditemukan.*`);
            return;
        }

        const isTrial       = isTrialOnly(userId);
        const displayGroups = isTrial ? groups.slice(0, 1) : groups;

        session._vcfGroupPickerList = displayGroups;

        const buttons = displayGroups.map((g, i) => {
            const memberCount = g.participants?.length || 0;
            const label = `${i + 1}. ${g.subject} (${memberCount} 👥)`.substring(0, 64);
            return [Markup.button.callback(label, `vcfgrp_${i}`)];
        });
        buttons.push([Markup.button.callback('❌ Batal', 'vcfgrp_cancel')]);

        await fetchAnim.stop(null);

        let header = `╔${DIVIDER}╗\n║  PILIH GRUP TUJUAN VCF\n╚${DIVIDER}╝\n\n`;
        if (isTrial) header += `⚠️ _Trial: hanya 1 grup_\n\n`;
        header += `Pilih grup yang akan ditambahkan kontaknya:`;

        await ctx.reply(header, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    } catch (err) {
        await fetchAnim.stop(`❌ *Error:* ${err.message}`);
    }
});

tgBot.hears('🔴 Kick Menu', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ *Login dulu!*', { parse_mode: 'Markdown' });
    if (!session.groupId) return ctx.reply('❌ *Pilih grup dulu!*', { parse_mode: 'Markdown' });
    await showKickMenu(ctx, userId, session);
});

tgBot.hears('📡 Status', requireAccess, async (ctx) => {
    const userId    = ctx.from.id;
    const session   = userSessions.get(userId);
    const accStatus = getUserStatus(userId);
    const u         = getUser(userId);

    let waStatus = '🔴 Belum Login';
    if (session && !session.loggedIn) waStatus = '🟡 Menunggu QR';
    if (session && session.loggedIn)  waStatus = '🟢 Terhubung';

    let accLine = '';
    if (accStatus === 'admin')        accLine = '👑 Admin';
    else if (accStatus === 'regular') accLine = `⭐ Reguler (${formatCountdown(u?.expiresAt)})`;
    else if (accStatus === 'trial')   accLine = `🎁 Trial (${formatCountdown(u?.trialExpiresAt)})`;

    await ctx.reply(`📡 WA: ${waStatus}\n🏷️ Akun: ${accLine}\n🎯 Grup: ${session?.groupName || 'Belum pilih'}`, { parse_mode: 'Markdown' });
});

tgBot.hears('🚪 Logout WhatsApp', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    if (!userSessions.has(userId)) return ctx.reply('❌ Belum login!');
    try {
        await destroySession(userId);
        const authFolder = getEncryptedAuthFolder(userId);
        if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
        kickSelections.delete(userId);
        reconnectAttempts.delete(userId);
        conflictCooldowns.delete(userId);
        loginLocks.delete(userId);
        await ctx.reply('✅ *Logout berhasil.*', { parse_mode: 'Markdown', ...KB_PRE_LOGIN });
    } catch (err) {
        await ctx.reply(`❌ *Error:* ${err.message}`, { parse_mode: 'Markdown' });
    }
});

tgBot.hears('📋 Pending Payment', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const list = getAllPendingPayments();
    if (list.length === 0) return ctx.reply(`📭 Kosong.`);
    let msg = `PENDING: ${list.length}\n\n`;
    for (const p of list) {
        msg += `👤 ${p.id}\n📦 ${p.packageKey}\n📅 ${formatDate(p.requestedAt)}\n\n`;
    }
    await ctx.reply(msg);
});

tgBot.hears('👥 User List', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Akses ditolak.');

    const users = getAllUsers();
    if (users.length === 0) return ctx.reply('*Belum ada user terdaftar.*', { parse_mode: 'Markdown' });

    const now     = new Date();
    const actives = users.filter(u => {
        const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
        return exp && new Date(exp) > now;
    });
    const expired = users.filter(u => {
        const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
        return !exp || new Date(exp) <= now;
    });

    let msg = `╔${DIVIDER}╗\n║  DAFTAR USER\n╚${DIVIDER}╝\n\n`;
    msg += `✅ Aktif: ${actives.length}  |  ❌ Expired: ${expired.length}\n\n`;

    if (actives.length > 0) {
        msg += `${DIVIDER_THIN}\n✅ USER AKTIF:\n${DIVIDER_THIN}\n`;
        actives.forEach((u, i) => {
            const exp  = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
            const role = u.role === 'trial' ? '🎁 Trial' : '⭐ Reguler';
            msg += `${i + 1}. ${userDisplayName(u)}\n`;
            msg += `   ID: \`${u.id}\` | ${role}\n`;
            msg += `   Exp: ${formatDate(exp)} (${formatCountdown(exp)})\n\n`;
        });
    }

    if (expired.length > 0 && expired.length <= 10) {
        msg += `${DIVIDER_THIN}\n❌ EXPIRED:\n${DIVIDER_THIN}\n`;
        expired.forEach((u, i) => {
            const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
            msg += `${i + 1}. ${userDisplayName(u)} | ID: \`${u.id}\`\n`;
            msg += `   Expired: ${formatDate(exp)}\n\n`;
        });
    } else if (expired.length > 10) {
        msg += `\n_(+${expired.length} user expired tidak ditampilkan)_`;
    }

    msg += `\n\n/revokeuser [id] — Cabut akses`;
    await ctx.reply(msg, { parse_mode: 'Markdown' });
});

// ══════════════════════════════════════════════════════════════
//  DOCUMENT HANDLER (VCF)
// ══════════════════════════════════════════════════════════════

tgBot.on('document', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const pending = vcfPending.get(userId);
    if (!pending || !pending.waitingFile) return;

    const doc   = ctx.message.document;
    const fname = doc.file_name || '';

    if (!fname.toLowerCase().endsWith('.vcf')) {
        return ctx.reply('⚠️ *File harus .vcf*', { parse_mode: 'Markdown' });
    }

    await ctx.reply('⏳ *Membaca file VCF...*', { parse_mode: 'Markdown' });

    try {
        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const resp     = await fetch(fileLink.href);
        const vcfText  = await resp.text();
        const contacts = parseVCF(vcfText);

        if (contacts.length === 0) {
            vcfPending.delete(userId);
            return ctx.reply('❌ *Tidak ada nomor valid.*', { parse_mode: 'Markdown' });
        }

        pending.contacts    = contacts;
        pending.waitingFile = false;
        vcfPending.set(userId, pending);

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback(`✅ Tambah Semua (${contacts.length})`, 'vcf_add_all')],
            [Markup.button.callback('❌ Batal', 'vcf_cancel')]
        ]);

        await ctx.reply(
            `📊 *${contacts.length} kontak* ditemukan.\n🎯 Grup tujuan: *${pending.groupName}*\n\nTambahkan sekarang?`,
            { parse_mode: 'Markdown', ...keyboard }
        );
    } catch (err) {
        vcfPending.delete(userId);
        await ctx.reply(`❌ Error: ${err.message}`, { parse_mode: 'Markdown' });
    }
});

// ══════════════════════════════════════════════════════════════
//  INLINE BUTTON HANDLERS
// ══════════════════════════════════════════════════════════════

tgBot.action(/^selectgrp_(\d+|cancel)$/, requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    await ctx.answerCbQuery();

    const param   = ctx.match[1];
    const session = userSessions.get(userId);

    if (param === 'cancel') {
        if (session) session._groupPickerList = null;
        return ctx.editMessageText('✖ *Pemilihan grup dibatalkan.*', { parse_mode: 'Markdown' });
    }

    if (!session || !session.loggedIn) {
        return ctx.editMessageText('❌ *Session habis. Login ulang.*', { parse_mode: 'Markdown' });
    }

    const idx       = parseInt(param);
    const groupList = session._groupPickerList;

    if (!groupList || idx >= groupList.length) {
        return ctx.editMessageText('❌ *Data grup tidak ditemukan. Coba lagi.*', { parse_mode: 'Markdown' });
    }

    const target = groupList[idx];
    session.groupId          = target.id;
    session.groupName        = target.subject;
    session._groupPickerList = null;

    const memberCount = target.participants?.length || 0;

    await ctx.editMessageText(
        `✅ *Grup terpilih!*\n\n` +
        `🎯 *${esc(target.subject)}*\n` +
        `👥 ${memberCount} anggota\n\n` +
        `Tekan *🔴 Kick Menu* untuk mulai.`,
        { parse_mode: 'Markdown' }
    );
});

tgBot.action(/^vcfgrp_(\d+|cancel)$/, requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    await ctx.answerCbQuery();

    const param   = ctx.match[1];
    const session = userSessions.get(userId);

    if (param === 'cancel') {
        if (session) session._vcfGroupPickerList = null;
        return ctx.editMessageText('✖ *Import VCF dibatalkan.*', { parse_mode: 'Markdown' });
    }

    if (!session || !session.loggedIn) {
        return ctx.editMessageText('❌ *Session habis. Login ulang.*', { parse_mode: 'Markdown' });
    }

    const idx       = parseInt(param);
    const groupList = session._vcfGroupPickerList;

    if (!groupList || idx >= groupList.length) {
        return ctx.editMessageText('❌ *Data grup tidak ditemukan. Coba lagi.*', { parse_mode: 'Markdown' });
    }

    const target = groupList[idx];
    session._vcfGroupPickerList = null;

    vcfPending.set(userId, {
        waitingFile: true,
        groupId:     target.id,
        groupName:   target.subject
    });

    await ctx.editMessageText(
        `✅ *Grup tujuan VCF dipilih!*\n\n` +
        `🎯 *${esc(target.subject)}*\n` +
        `👥 ${target.participants?.length || 0} anggota\n\n` +
        `📎 *Sekarang kirim file .vcf ke chat ini.*`,
        { parse_mode: 'Markdown' }
    );
});

tgBot.action('vcf_add_all', async (ctx) => {
    const userId = ctx.from.id;
    if (!canUseBot(userId)) return ctx.answerCbQuery('⛔ Ditolak.');
    await ctx.answerCbQuery();

    const pending = vcfPending.get(userId);
    if (!pending || !pending.contacts) return ctx.reply('❌ Data tidak ditemukan.');

    await addContactsToGroup(ctx, userId, pending.contacts, pending.groupId, pending.groupName);
});

tgBot.action('vcf_cancel', async (ctx) => {
    vcfPending.delete(ctx.from.id);
    await ctx.answerCbQuery('Dibatalkan');
    await ctx.reply('✖ *Import dibatalkan.*', { parse_mode: 'Markdown' });
});

tgBot.action(/^toggle_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    if (!canUseBot(userId)) return ctx.answerCbQuery('⛔ Ditolak.');

    const jid     = ctx.match[1];
    const session = userSessions.get(userId);
    if (!session || !kickSelections.has(userId)) return ctx.answerCbQuery('Session expired.');

    const selected = kickSelections.get(userId);
    if (selected.has(jid)) {
        selected.delete(jid);
        await ctx.answerCbQuery('❌ Dihapus');
    } else {
        selected.add(jid);
        await ctx.answerCbQuery('✅ Ditambahkan');
    }
    try { await ctx.editMessageReplyMarkup(buildMemberKeyboard(session.members, selected).reply_markup); } catch (_) {}
});

tgBot.action('do_kick', async (ctx) => {
    const userId = ctx.from.id;
    if (!canUseBot(userId)) return ctx.answerCbQuery('⛔ Ditolak.');
    await ctx.answerCbQuery();

    if (!isAdmin(userId) && !isActiveHours()) {
        return ctx.reply(
            `⚠️ *Untuk keamanan akun WA, kick hanya bisa dilakukan jam 08.00 - 22.00 WIB.*\n\n` +
            `_Ini untuk menghindari deteksi otomatis dari WhatsApp._`,
            { parse_mode: 'Markdown' }
        );
    }

    const session  = userSessions.get(userId);
    const selected = kickSelections.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ Session expired.');
    if (!selected || selected.size === 0) return ctx.reply('⚠️ *Belum ada yang dipilih!*', { parse_mode: 'Markdown' });

    const jidList = Array.from(selected);
    const kickAnim = await liveKickProgress(ctx, jidList.length);

    const totalKicked = await burstThenPauseKick(session.sock, session.groupId, jidList, (progress) => {
        kickAnim.update(progress);
    });

    kickSelections.set(userId, new Set());
    await kickAnim.stop(
        `✅ *Kick Selesai\\!*\n\n` +
        `🦵 *${totalKicked}* dari *${jidList.length}* anggota berhasil dikick\\.\n` +
        `🎯 Grup: *${esc(session.groupName || 'N/A')}*`
    );
});

tgBot.action('cancel_kick', async (ctx) => {
    kickSelections.set(ctx.from.id, new Set());
    await ctx.answerCbQuery('Dibatalkan');
    await ctx.reply('✖ *Kick dibatalkan.*', { parse_mode: 'Markdown' });
});

// ══════════════════════════════════════════════════════════════
//  AUTO EXPIRE NOTIF
// ══════════════════════════════════════════════════════════════

setInterval(async () => {
    const users = getAllUsers();
    const now   = new Date();
    for (const u of users) {
        const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
        if (!exp) continue;
        const msLeft = new Date(exp) - now;
        if (msLeft > 0 && msLeft <= 24 * 60 * 60 * 1000 && !u.notifiedExpiry) {
            try {
                await tgBot.telegram.sendMessage(u.id, `⚠️ *Akses akan habis dalam ${formatCountdown(exp)}*\nPerpanjang: /beli`, { parse_mode: 'Markdown' });
                const data = loadData();
                const idx  = data.users.findIndex(x => x.id === u.id);
                if (idx >= 0) data.users[idx].notifiedExpiry = true;
                saveData(data);
            } catch (_) {}
        }
    }
}, 60 * 60 * 1000);

// ══════════════════════════════════════════════════════════════
//  HEALTH CHECK
// ══════════════════════════════════════════════════════════════

const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: 'ok',
        bot: 'WA Kicker Bot v5.0.0',
        uptime: Math.floor(process.uptime()) + 's',
        activeSessions: userSessions.size,
        timestamp: new Date().toISOString()
    }));
}).listen(PORT, () => {
    console.log(`🌐 Health check aktif di port ${PORT}`);
});

// ══════════════════════════════════════════════════════════════
//  LAUNCH
// ══════════════════════════════════════════════════════════════

tgBot.launch().then(() => {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║          W A - K I C K E R   B O T   v 5 . 0 . 0            ║');
    console.log('║        S T E A L T H   H U M A N   D E L A Y   E D I T I O N ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  Admin IDs      : ${ADMIN_IDS.join(', ')}`);
    console.log(`║  Trial          : ${TRIAL_DURATION_HOURS} jam`);
    console.log(`║  Kick Limit     : ${KICK_LIMIT_PER_SESSION} per sesi`);
    console.log(`║  Kick Pattern   : Burst (1-4) + Pause 20-90s per batch`);
    console.log(`║  Add Pattern    : 1 per 1 + Pause 8-25s per member`);
    console.log(`║  Active Hours   : 08.00 - 22.00 WIB`);
    console.log(`║  Fingerprint    : Dynamic (rotates per login)`);
    console.log(`║  Human Sim      : Poisson + Exponential delays`);
    console.log(`║  Background     : Activity spooler ACTIVE`);
    console.log(`║  VCF Picker     : TERPISAH dari Kick Grup`);
    console.log(`║  Stealth Level  : ULTIMATE`);
    console.log('╚══════════════════════════════════════════════════════════════╝\n');
});

process.on('SIGINT',  () => { tgBot.stop('SIGINT');  process.exit(); });
process.on('SIGTERM', () => { tgBot.stop('SIGTERM'); process.exit(); });