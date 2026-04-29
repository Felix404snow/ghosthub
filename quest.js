const {
    Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
    ButtonStyle, StringSelectMenuBuilder, ActivityType, REST, Routes,
    SlashCommandBuilder, AttachmentBuilder, ModalBuilder, TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const axios                              = require('axios');
const QRCode                             = require('qrcode');
const fs                                 = require('fs').promises;
const fss                                = require('fs');
const path                               = require('path');
const http                               = require('http');
const https                              = require('https');
const { createCanvas, loadImage, Image } = require('canvas');

const axiosInstance = axios.create({
    httpAgent:  new http.Agent({ keepAlive: true, maxSockets: 50 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 50 }),
    timeout:    30000
});

const CONFIG_PATH   = path.join(__dirname, 'config.json');
const DATABASE_PATH = path.join(__dirname, 'database.json');
const CACHE_DIR     = path.join(__dirname, 'cache');

let config          = {};
let database        = {};
let userSessions    = {};
const premiumSessions = new Map();
const pixSessions     = new Map();

const DEFAULT_CONFIG = {
    channelId:          '',
    listChannelId:      '',
    expiredChannelId:   '',
    statsChannelId:     '',
    questsChannelId:    '',
    premiumChannelId:   '',
    notificationRoleId: '',
    premiumRoleId:      '',
    ownerId:            '',
    botToken:           '',
    guildId:            '',
    premiumPrice:       10,
    xSuperProperties:   'eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiQ2hyb21lIiwiZGV2aWNlIjoiIiwic3lzdGVtX2xvY2FsZSI6InB0LUJSIiwiaGFzX2NsaWVudF9tb2RzIjpmYWxzZSwiYnJvd3Nlcl91c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzEyMC4wLjAuMCBTYWZhcmkvNTM3LjM2IiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTIwLjAuMC4wIiwib3NfdmVyc2lvbiI6IjEwIiwicmVmZXJyZXIiOiIiLCJyZWZlcnJpbmdfZG9tYWluIjoiIiwicmVsZWFzZV9jaGFubmVsIjoic3RhYmxlIiwiY2xpZW50X2J1aWxkX251bWJlciI6OTk5OTk5LCJjbGllbnRfZXZlbnRfc291cmNlIjpudWxsfQ==',
    userAgent:          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9217 Chrome/138.0.7204.251 Electron/37.6.0 Safari/537.36',
    listingToken:       '',
    pixgg: {
        email:    '',
        password: ''
    },
    presence: {
        status:          'online',
        rotateInterval:  30,
        activities: [
            { type: 'Watching',  name: 'Discord Quests'    },
            { type: 'Playing',   name: 'Auto-Quest'        },
            { type: 'Listening', name: 'missões do Discord' }
        ]
    }
};

const DEFAULT_DATABASE = {
    panelMessageId:        null,
    premiumPanelMessageId: null,
    pixggCache:            { authToken: '', apiKey: '', streamerId: '' },
    users:                 {},
    premiumUsers:          {},
    listedQuests:          {},
    expiredQuests:         {},
    monthlyQuests:         { month: '', count: 0 }
};

const TASK_TYPES = {
    'WATCH_VIDEO':           '🎦 Video',
    'WATCH_VIDEO_ON_MOBILE': '🎦 Video',
    'PLAY_ON_DESKTOP':       '🕹 Jogar',
    'PLAY_ON_XBOX':          '🕹 Jogar',
    'PLAY_ON_PLAYSTATION':   '🕹 Jogar'
};

const TASK_TEXT_MAP = {
    'WATCH_VIDEO':           'Video de',
    'WATCH_VIDEO_ON_MOBILE': 'Video de',
    'PLAY_ON_DESKTOP':       'Jogar por',
    'PLAY_ON_XBOX':          'Jogar por',
    'PLAY_ON_PLAYSTATION':   'Jogar por'
};

const TASK_PRIORITY = ['PLAY_ON_DESKTOP', 'PLAY_ON_XBOX', 'PLAY_ON_PLAYSTATION', 'WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE'];

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// ─── Config & Database ────────────────────────────────────────────────────────

async function loadConfig() {
    try {
        const saved = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        config = { ...DEFAULT_CONFIG, ...saved };
    } catch {
        config = { ...DEFAULT_CONFIG };
    }
    await saveConfig();
}

async function saveConfig() {
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function loadDatabase() {
    try {
        database = JSON.parse(await fs.readFile(DATABASE_PATH, 'utf8'));
    } catch {
        database = {};
    }
    await repairDatabase();
}

async function repairDatabase() {
    const fixes = [];
    const fix   = (msg) => fixes.push(msg);

    const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

    // ── 1. Campos raiz ausentes ───────────────────────────────────────
    if (!isObj(database.users))                                                           { database.users                 = {};                        fix('users: ausente/inválido → {}'); }
    if (!isObj(database.premiumUsers))                                                    { database.premiumUsers          = {};                        fix('premiumUsers: ausente/inválido → {}'); }
    if (!isObj(database.listedQuests))                                                    { database.listedQuests          = {};                        fix('listedQuests: ausente/inválido → {}'); }
    if (!isObj(database.expiredQuests))                                                   { database.expiredQuests         = {};                        fix('expiredQuests: ausente/inválido → {}'); }
    if (!isObj(database.pixggCache))                                                      { database.pixggCache            = { authToken: '', apiKey: '', streamerId: '' }; fix('pixggCache: ausente/inválido → resetado'); }
    if (!('panelMessageId' in database))                                                  { database.panelMessageId        = null;                      fix('panelMessageId: ausente → null'); }
    if (!('premiumPanelMessageId' in database))                                           { database.premiumPanelMessageId = null;                      fix('premiumPanelMessageId: ausente → null'); }
    if (!isObj(database.monthlyQuests) ||
        typeof database.monthlyQuests.month !== 'string' ||
        typeof database.monthlyQuests.count !== 'number' ||
        !isFinite(database.monthlyQuests.count))                                          { database.monthlyQuests         = { month: '', count: 0 };   fix('monthlyQuests: inválido → resetado'); }

    // ── 2. Chaves raiz desconhecidas ──────────────────────────────────
    const validRoot = new Set(['panelMessageId', 'premiumPanelMessageId', 'pixggCache', 'users', 'premiumUsers', 'listedQuests', 'expiredQuests', 'monthlyQuests']);
    for (const k of Object.keys(database)) {
        if (!validRoot.has(k)) { delete database[k]; fix(`raiz: campo desconhecido "${k}" removido`); }
    }

    // ── 3. Usuários ───────────────────────────────────────────────────
    const validUserKeys = new Set(['token', 'id', 'username', 'globalName', 'avatar', 'activeQuest', 'resumeChannelId', 'resumeMessageId', 'premium', 'premiumQueue']);

    for (const [userId, user] of Object.entries(database.users)) {
        if (!isObj(user)) {
            delete database.users[userId];
            fix(`users[${userId}]: não é objeto → removido`);
            continue;
        }

        const missing = ['token', 'id', 'username', 'globalName'].find(f => typeof user[f] !== 'string' || !user[f]);
        if (missing) {
            delete database.users[userId];
            fix(`users[${userId}]: campo obrigatório "${missing}" inválido → usuário removido`);
            continue;
        }

        if (user.id !== userId) {
            user.id = userId;
            fix(`users[${userId}]: "id" divergia da chave → corrigido`);
        }

        if (typeof user.avatar !== 'string' || !user.avatar) {
            user.avatar = 'https://cdn.discordapp.com/embed/avatars/0.png';
            fix(`users[${userId}]: "avatar" ausente → padrão definido`);
        }

        const shouldBePremium = !!database.premiumUsers[userId];
        if (user.premium !== shouldBePremium) {
            user.premium = shouldBePremium;
            fix(`users[${userId}]: "premium" inconsistente → corrigido para ${shouldBePremium}`);
        }

        if (user.activeQuest !== undefined) {
            const aq             = user.activeQuest;
            const requiredAqKeys = ['questId', 'questName', 'taskType', 'target', 'rewardText', 'startedAt', 'duration'];
            const aqBroken       =
                !isObj(aq) ||
                requiredAqKeys.some(f => aq[f] === undefined || aq[f] === null) ||
                typeof aq.startedAt !== 'number' ||
                typeof aq.duration  !== 'number';

            if (aqBroken) {
                delete user.activeQuest;
                fix(`users[${userId}]: "activeQuest" corrompido → removido`);
            } else if (Date.now() >= aq.startedAt + (aq.duration + 10) * 1000) {
                delete user.activeQuest;
                fix(`users[${userId}]: "activeQuest" expirado → removido`);
            }
        }

        if (!user.activeQuest) {
            if (user.resumeChannelId || user.resumeMessageId) {
                delete user.resumeChannelId;
                delete user.resumeMessageId;
                fix(`users[${userId}]: "resumeChannelId/MessageId" órfãos → removidos`);
            }
            if (user.premiumQueue !== undefined) {
                delete user.premiumQueue;
                fix(`users[${userId}]: "premiumQueue" órfão → removido`);
            }
        } else if (user.premiumQueue !== undefined && !Array.isArray(user.premiumQueue)) {
            delete user.premiumQueue;
            fix(`users[${userId}]: "premiumQueue" não é array → removido`);
        }

        for (const k of Object.keys(user)) {
            if (!validUserKeys.has(k)) { delete user[k]; fix(`users[${userId}]: chave desconhecida "${k}" → removida`); }
        }
    }

    // ── 4. premiumUsers ───────────────────────────────────────────────
    for (const [pid, data] of Object.entries(database.premiumUsers)) {
        if (!isObj(data) || typeof data.since !== 'number') {
            database.premiumUsers[pid] = { since: Date.now() };
            fix(`premiumUsers[${pid}]: estrutura inválida → corrigida`);
        }
    }

    // ── 5. listedQuests / expiredQuests ───────────────────────────────
    const validQuestKeys = new Set(['messageIds', 'messageUrl', 'reward']);

    for (const [storeName, store] of [['listedQuests', database.listedQuests], ['expiredQuests', database.expiredQuests]]) {
        for (const [questId, quest] of Object.entries(store)) {
            if (!isObj(quest)) {
                delete store[questId];
                fix(`${storeName}[${questId}]: não é objeto → removido`);
                continue;
            }

            if (!Array.isArray(quest.messageIds) || quest.messageIds.length === 0 || typeof quest.messageUrl !== 'string' || !quest.messageUrl) {
                delete store[questId];
                fix(`${storeName}[${questId}]: "messageIds" ou "messageUrl" inválidos → removido`);
                continue;
            }

            if (quest.reward !== null && quest.reward !== undefined && (!isObj(quest.reward) || !quest.reward.type)) {
                quest.reward = null;
                fix(`${storeName}[${questId}]: "reward" corrompido → nullado`);
            }

            for (const k of Object.keys(quest)) {
                if (!validQuestKeys.has(k)) { delete quest[k]; fix(`${storeName}[${questId}]: chave desconhecida "${k}" → removida`); }
            }
        }
    }

    // ── 6. pixggCache ─────────────────────────────────────────────────
    if (typeof database.pixggCache.authToken  !== 'string') { database.pixggCache.authToken  = ''; fix('pixggCache.authToken: inválido → limpo');  }
    if (typeof database.pixggCache.apiKey     !== 'string') { database.pixggCache.apiKey     = ''; fix('pixggCache.apiKey: inválido → limpo');     }
    if (typeof database.pixggCache.streamerId !== 'string') { database.pixggCache.streamerId = ''; fix('pixggCache.streamerId: inválido → limpo'); }

    // ── Relatório ─────────────────────────────────────────────────────
    const line = '─'.repeat(50);
    console.log(`\n  ╔${line}╗`);
    console.log(`  ║  🔧 Database Repair`);
    console.log(`  ╠${line}╣`);
    if (fixes.length === 0) {
        console.log(`  ║  ✅ Nenhum problema encontrado.`);
    } else {
        for (const msg of fixes) console.log(`  ║  ⚠ ${msg}`);
        console.log(`  ╠${line}╣`);
        console.log(`  ║  ✅ ${fixes.length} problema(s) corrigido(s). Database salva.`);
        await saveDatabase();
    }
    console.log(`  ╚${line}╝\n`);
}

async function saveDatabase() {
    await fs.writeFile(DATABASE_PATH, JSON.stringify(database, null, 2));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jitter(baseMs, rangeMs = 1500) {
    return baseMs + Math.floor(Math.random() * rangeMs);
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function isConfigured(value) {
    return !!(value && String(value).trim() !== '');
}

function isPremiumUser(discordId) {
    return !!database.premiumUsers?.[discordId];
}

function setPremiumUser(discordId, active) {
    if (active) {
        database.premiumUsers[discordId] = { since: Date.now() };
        if (database.users[discordId]) database.users[discordId].premium = true;
    } else {
        delete database.premiumUsers[discordId];
        if (database.users[discordId]) {
            database.users[discordId].premium = false;
            delete database.users[discordId].premiumQueue;
        }
    }
}

function isTokenValid(userId) {
    return !!(database.users[userId]?.token);
}

function getCdnUrl(assetPath) {
    if (!assetPath) return null;
    return assetPath.startsWith('http') ? assetPath : `https://cdn.discordapp.com/${assetPath}`;
}

function getTaskTypeText(taskType) {
    return TASK_TEXT_MAP[taskType] || taskType;
}

function formatDate(dateString) {
    const d = new Date(dateString);
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getFullYear()).slice(-2)}`;
}

function formatTime(seconds) {
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function getTaskDuration(target) {
    if (target >= 60) {
        const m = Math.floor(target / 60), s = target % 60;
        return s > 0 ? `${m}min ${s}s` : `${m} minutos`;
    }
    return `${Math.floor(target)} segundos`;
}

function getRewardInfo(rewards) {
    if (!rewards?.length) return null;
    const r = rewards[0];
    if (r.type === 4 && r.orb_quantity) return { type: 'orbs', typeName: 'Recompensa', amount: r.orb_quantity, name: r.messages?.name || 'Orbs', asset: null };
    if (r.type === 1) return { type: 'code', typeName: 'Itens no Jogo', name: r.messages?.name || 'Codigo de Resgate', asset: r.asset || null };
    return { type: 'decoration', typeName: 'Decoracao', name: r.messages?.name || 'Decoracao para Discord', asset: r.asset || null, expiresAt: r.expires_at || null };
}

function getPriorityTask(tasks) {
    for (const taskType of TASK_PRIORITY) {
        if (tasks[taskType]) return { key: taskType, task: tasks[taskType] };
    }
    const first = Object.keys(tasks)[0];
    return first ? { key: first, task: tasks[first] } : null;
}

function parseRewardText(r) {
    if (!r) return 'Recompensa desconhecida';
    if (r.type === 4) return `${r.orb_quantity} Orbs`;
    if (r.type === 3) return r.messages?.name || 'Decoracao de Avatar';
    if (r.type === 1) return r.messages?.name || 'Item no jogo';
    return 'Recompensa desconhecida';
}

function getBestTask(tasks) {
    let selectedTask = null, bestPriority = 999;
    for (const [type, data] of Object.entries(tasks)) {
        if (!TASK_TYPES[type]) continue;
        const p = TASK_PRIORITY.indexOf(type);
        if (p !== -1 && p < bestPriority) { bestPriority = p; selectedTask = { taskType: type, taskData: data }; }
    }
    return selectedTask;
}

// ─── PixGG ────────────────────────────────────────────────────────────────────

const PIXGG_HEADERS = {
    'content-type': 'application/json',
    'accept':       '*/*',
    'user-agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'origin':       'https://app.pixgg.com',
    'referer':      'https://app.pixgg.com/'
};

async function refreshPixggToken() {
    const { email, password } = config.pixgg ?? {};
    if (!isConfigured(email) || !isConfigured(password)) throw new Error('NO_CREDENTIALS');

    const { data } = await axiosInstance.post(
        'https://app.pixgg.com/users/login',
        { name: '', email, password },
        { headers: { ...PIXGG_HEADERS, authorization: 'Bearer null' } }
    );

    let streamerId = database.pixggCache?.streamerId || '';
    try {
        const { data: bankData } = await axiosInstance.get('https://app.pixgg.com/BankAccounts', {
            headers: { ...PIXGG_HEADERS, authorization: `Bearer ${data.authToken}` }
        });
        streamerId = bankData?.[0]?.streamerId ?? streamerId;
    } catch {}

    database.pixggCache = { authToken: data.authToken, apiKey: data.apiKey, streamerId };
    await saveDatabase();
    return data.authToken;
}

async function pixggRequest(method, endpoint, body = null) {
    if (!database.pixggCache?.authToken) throw new Error('NOT_LOGGED_IN');

    const doRequest = (token) => axiosInstance({
        method, url: endpoint,
        headers: { ...PIXGG_HEADERS, authorization: `Bearer ${token}` },
        data: body
    });

    try {
        return (await doRequest(database.pixggCache.authToken)).data;
    } catch (err) {
        if (err?.response?.status === 401 || err?.response?.status === 403) {
            return (await doRequest(await refreshPixggToken())).data;
        }
        throw err;
    }
}

async function initPixgg() {
    if (!isConfigured(config.pixgg?.email) || !isConfigured(config.pixgg?.password)) return;
    try {
        await refreshPixggToken();
        console.log('  [PixGG] ✅ Autenticado com sucesso.');
    } catch (err) {
        console.error('  [PixGG] ❌ Falha na autenticação —', err.message);
    }
}

// ─── Canvas Image Generator ───────────────────────────────────────────────────

async function ensureCacheDir() {
    if (!fss.existsSync(CACHE_DIR)) await fs.mkdir(CACHE_DIR, { recursive: true });
}

async function tryLoadImage(url) {
    if (!url) return null;
    try {
        const res = await axiosInstance.get(url, { responseType: 'arraybuffer', timeout: 8000 });
        const img = new Image();
        img.src   = Buffer.from(res.data);
        return img;
    } catch {
        return null;
    }
}

function drawRoundedRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y,     x + w, y + h, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x,     y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x,     y + h, x,     y,     r);
    ctx.lineTo(x,     y + r);
    ctx.arcTo(x,     y,     x + w, y,     r);
    ctx.closePath();
}

function drawBackground(ctx, W, H) {
    ctx.fillStyle = '#0e0e0e';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    const GRID = 28;
    for (let x = GRID; x < W; x += GRID) {
        for (let y = GRID; y < H; y += GRID) {
            ctx.beginPath();
            ctx.arc(x, y, 1, 0, Math.PI * 2);
            ctx.fill();
        }
    }
}

function textW(ctx, text) {
    return ctx.measureText(text).width;
}

function wrapText(ctx, text, maxWidth) {
    const words = text.split(' ');
    const lines = [];
    let current = '';
    for (const word of words) {
        const test = current ? `${current} ${word}` : word;
        if (ctx.measureText(test).width > maxWidth && current) {
            lines.push(current);
            current = word;
        } else {
            current = test;
        }
    }
    if (current) lines.push(current);
    return lines;
}

async function savePng(canvas, filename) {
    const filePath  = path.join(CACHE_DIR, filename);
    const outStream = fss.createWriteStream(filePath);
    const pngStream = canvas.createPNGStream();
    await new Promise((res, rej) => {
        pngStream.pipe(outStream);
        outStream.on('finish', res);
        outStream.on('error', rej);
    });
    return filePath;
}

async function cleanCacheFile(filePath) {
    try { await fs.unlink(filePath); } catch {}
}

async function generateProgressCard(storedQuest, current, total, isCompleted, fileName) {
    const W = 900, H = 380;
    const cvs = createCanvas(W, H);
    const ctx = cvs.getContext('2d');

    ctx.shadowBlur  = 0;
    ctx.shadowColor = 'transparent';
    drawBackground(ctx, W, H);

    const thumbImg   = await tryLoadImage(storedQuest.thumbnailImage);
    const THUMB_SIZE = 110, THUMB_X = 36, THUMB_Y = 30;

    if (thumbImg) {
        ctx.save();
        drawRoundedRect(ctx, THUMB_X, THUMB_Y, THUMB_SIZE, THUMB_SIZE, 14);
        ctx.clip();
        ctx.drawImage(thumbImg, THUMB_X, THUMB_Y, THUMB_SIZE, THUMB_SIZE);
        ctx.restore();
        ctx.strokeStyle = '#2a2a2a';
        ctx.lineWidth   = 2;
        drawRoundedRect(ctx, THUMB_X, THUMB_Y, THUMB_SIZE, THUMB_SIZE, 14);
        ctx.stroke();
    }

    const COL_X = thumbImg ? THUMB_X + THUMB_SIZE + 24 : 36;
    const COL_W = W - COL_X - 36;

    ctx.font = 'bold 32px sans-serif';
    const nameLines   = wrapText(ctx, storedQuest.questName, COL_W);
    const titleLineH  = 38;
    const titleHeight = Math.min(nameLines.length, 2) * titleLineH;

    const BADGE_LABEL = isCompleted ? 'MISSÃO CONCLUÍDA' : 'EM ANDAMENTO';
    const BADGE_H     = 38;
    ctx.font = 'bold 16px sans-serif';
    const badgeWidth  = textW(ctx, BADGE_LABEL) + 40;

    const DIVIDER_H   = 2;
    const BAR_H       = 24;
    const INFO_LINE_H = 28;
    const REWARD_H    = 32;

    let contentHeight = titleHeight + 16 + BADGE_H + 24 + DIVIDER_H + 20 + BAR_H + 20 + INFO_LINE_H + 24 + DIVIDER_H + 20 + REWARD_H;
    let currentY = (H - contentHeight) / 2;

    ctx.font      = 'bold 32px sans-serif';
    ctx.fillStyle = '#ffffff';
    nameLines.slice(0, 2).forEach((line, i) => {
        ctx.fillText(line, COL_X, currentY + 32 + i * titleLineH);
    });
    currentY += titleHeight + 16;

    const BADGE_COLOR = isCompleted ? '#57F287' : '#5865F2';
    const BADGE_BG    = isCompleted ? '#1a3d2b' : '#1e2060';

    ctx.font      = 'bold 16px sans-serif';
    ctx.fillStyle = BADGE_BG;
    drawRoundedRect(ctx, COL_X, currentY, badgeWidth, BADGE_H, 8);
    ctx.fill();
    ctx.strokeStyle = BADGE_COLOR;
    ctx.lineWidth   = 2;
    drawRoundedRect(ctx, COL_X, currentY, badgeWidth, BADGE_H, 8);
    ctx.stroke();
    ctx.fillStyle = BADGE_COLOR;
    ctx.fillText(BADGE_LABEL, COL_X + 20, currentY + 26);
    currentY += BADGE_H + 24;

    ctx.fillStyle = '#333333';
    ctx.fillRect(36, currentY, W - 72, DIVIDER_H);
    currentY += DIVIDER_H + 20;

    const pct    = Math.min(Math.floor((current / total) * 100), 100);
    const BAR_X  = 36, BAR_R = 12, PCT_LW = 70;
    const BAR_W  = W - 72 - PCT_LW;

    ctx.fillStyle = '#1e1e1e';
    drawRoundedRect(ctx, BAR_X, currentY, BAR_W, BAR_H, BAR_R);
    ctx.fill();
    ctx.strokeStyle = '#3a3a3a';
    ctx.lineWidth   = 2;
    drawRoundedRect(ctx, BAR_X, currentY, BAR_W, BAR_H, BAR_R);
    ctx.stroke();

    const fillW = Math.max(BAR_R * 2, (pct / 100) * BAR_W);
    ctx.fillStyle = isCompleted ? '#57F287' : '#5865F2';
    drawRoundedRect(ctx, BAR_X, currentY, fillW, BAR_H, BAR_R);
    ctx.fill();

    ctx.font      = 'bold 20px sans-serif';
    ctx.fillStyle = isCompleted ? '#57F287' : '#aaaaff';
    ctx.fillText(`${pct}%`, BAR_X + BAR_W + 15, currentY + BAR_H / 2 + 8);
    currentY += BAR_H + 20;

    const remaining = Math.max(0, total - current);

    if (isCompleted) {
        ctx.font      = 'bold 20px sans-serif';
        ctx.fillStyle = '#57F287';
        ctx.fillText('✓ CONCLUÍDO COM SUCESSO!', BAR_X, currentY + 10);
    } else {
        ctx.font      = 'bold 17px sans-serif';
        ctx.fillStyle = '#888888';
        ctx.fillText('PROGRESSO', BAR_X, currentY + 10);
        const PROG_LABEL_W = textW(ctx, 'PROGRESSO');

        ctx.font      = 'bold 20px sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(`${formatTime(current)} / ${formatTime(total)}`, BAR_X + PROG_LABEL_W + 15, currentY + 10);

        const REST_X = BAR_X + BAR_W - 100;
        ctx.font      = 'bold 17px sans-serif';
        ctx.fillStyle = '#888888';
        ctx.fillText('RESTANTE', REST_X, currentY + 10);
        const REST_LABEL_W = textW(ctx, 'RESTANTE');

        ctx.font      = 'bold 20px sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(formatTime(remaining), REST_X + REST_LABEL_W + 12, currentY + 10);
    }
    currentY += INFO_LINE_H + 24;

    ctx.fillStyle = '#333333';
    ctx.fillRect(36, currentY, W - 72, DIVIDER_H);
    currentY += DIVIDER_H + 20;

    ctx.font      = 'bold 17px sans-serif';
    ctx.fillStyle = '#888888';
    ctx.fillText('RECOMPENSA', BAR_X, currentY + 12);
    const REWARD_LABEL_W = textW(ctx, 'RECOMPENSA');

    ctx.font      = 'bold 24px sans-serif';
    ctx.fillStyle = '#f0c040';
    ctx.fillText(storedQuest.rewardText, BAR_X + REWARD_LABEL_W + 15, currentY + 12);

    ctx.font      = '13px sans-serif';
    ctx.fillStyle = '#3a3a3a';
    const idLabel = `ID: ${storedQuest.questId}`;
    ctx.fillText(idLabel, W - 36 - textW(ctx, idLabel), H - 18);

    return savePng(cvs, fileName);
}

// ─── Embeds ───────────────────────────────────────────────────────────────────

function createTextProgressBar(current, total, size = 12) {
    const pct    = Math.min(Math.floor((current / total) * 100), 100);
    const filled = Math.round((pct / 100) * size);
    const empty  = size - filled;
    let bar;
    if (filled === 0)        bar = '●' + '─'.repeat(size - 1);
    else if (filled >= size) bar = '━'.repeat(size - 1) + '●';
    else                     bar = '━'.repeat(filled - 1) + '●' + '─'.repeat(empty);
    return `\`⠀${bar}⠀\``;
}

async function buildProgressEmbed(storedQuest, current, total, isCompleted = false) {
    const pct       = Math.min(Math.floor((current / total) * 100), 100);
    const remaining = Math.max(0, total - current);

    try {
        const fileName   = `quest_progress_${Date.now()}.png`;
        const filePath   = await generateProgressCard(storedQuest, current, total, isCompleted, fileName);
        const attachment = new AttachmentBuilder(filePath, { name: fileName });

        const embed = new EmbedBuilder()
            .setColor(isCompleted ? '#57F287' : '#5865F2')
            .setImage(`attachment://${fileName}`)
            .setFooter({ text: `ID ${storedQuest.questId} • 🎁 ${storedQuest.rewardText.slice(0, 40)}` });

        setTimeout(() => cleanCacheFile(filePath), 25000);
        return { embeds: [embed], files: [attachment] };
    } catch {
        const bar   = createTextProgressBar(current, total);
        const embed = new EmbedBuilder()
            .setColor(isCompleted ? '#57F287' : '#5865F2')
            .setFooter({ text: `ID ${storedQuest.questId} • 🎁 ${storedQuest.rewardText.slice(0, 40)}` });

        if (storedQuest.heroImage)      embed.setImage(storedQuest.heroImage);
        if (storedQuest.thumbnailImage) embed.setThumbnail(storedQuest.thumbnailImage);

        embed.setDescription(
            isCompleted
                ? `## ✅ Missão Concluída!\n\n**${storedQuest.questName}**\n\n${bar} **100%**\n\n🎁 **Recompensa:** ${storedQuest.rewardText}`
                : `## ⚡ ${storedQuest.questName}\n\n${bar} **${pct}%**\n\n✅ **Progresso:** \`${formatTime(current)}\` / \`${formatTime(total)}\`\n🕐 **Restante:** \`${formatTime(remaining)}\`\n\n🎁 **Recompensa:** ${storedQuest.rewardText}`
        );

        return { embeds: [embed], files: [] };
    }
}

async function editProgressMessage(msg, payload) {
    try {
        await msg.edit({ ...payload, components: [] });
        return msg;
    } catch (err) {
        console.error('Erro ao editar progresso:', err);
        return msg;
    }
}

function createQuestEmbed(quest, isExpired = false) {
    const cfg      = quest.config;
    const messages = cfg.messages;
    const assets   = cfg.assets;
    const tasks    = cfg.task_config_v2?.tasks || {};
    const reward   = getRewardInfo(cfg.rewards_config?.rewards);

    const embed = new EmbedBuilder()
        .setColor(isExpired ? '#ED4245' : '#5865F2')
        .setDescription(`# ${messages.quest_name}`)
        .setFooter({ text: `ID: ${quest.id} • ${messages.game_publisher}` });

    if (assets?.hero)           embed.setImage(getCdnUrl(assets.hero));
    if (assets?.game_tile_dark) embed.setThumbnail(getCdnUrl(assets.game_tile_dark));

    embed.addFields({
        name:   '<:calendar:1446473443142008925>┃Período',
        value:  `**Início:** ${formatDate(cfg.starts_at)}\n**Término:** ${formatDate(cfg.expires_at)}`,
        inline: true
    });

    const priorityTask = getPriorityTask(tasks);
    if (priorityTask) {
        embed.addFields({
            name:   '<:sucesso:1440932976522166373>┃Tarefa',
            value:  `${getTaskTypeText(priorityTask.key)} ${getTaskDuration(priorityTask.task.target)}`,
            inline: true
        });
    }

    if (reward) {
        embed.addFields({
            name:   `<:gift:1446475869479501824>┃${reward.typeName}`,
            value:  reward.type === 'orbs' ? `**${reward.amount} Orbs**` : `**${reward.name}**`,
            inline: false
        });
    }

    return embed;
}

function createDecorationEmbed(reward) {
    const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('<:gift:1446475869479501824>┃Recompensa da Quest')
        .setDescription(`**${reward.name}**`);

    if (reward.asset) {
        const url = getCdnUrl(reward.asset);
        if (reward.asset.endsWith('.mp4')) {
            embed.setDescription(`**${reward.name}**\n\nEsta recompensa possui uma animação especial!\n\n[🔹 Clique aqui para ver o vídeo](${url})`);
        } else {
            embed.setImage(url);
        }
    }

    if (reward.expiresAt) embed.setFooter({ text: `Expira em: ${formatDate(reward.expiresAt)}` });
    return embed;
}

function createSeparatorEmbed() {
    return new EmbedBuilder().setImage('https://i.imgur.com/n5Sp6iE.png').setColor('#131416');
}

function createQuestButtons(questId, hasReward) {
    const components = [
        new ButtonBuilder()
            .setLabel('┃Ir para missão!')
            .setEmoji('1446492982269448232')
            .setStyle(ButtonStyle.Link)
            .setURL(`https://discord.com/quests/${questId}`)
    ];

    if (hasReward) {
        components.push(
            new ButtonBuilder()
                .setCustomId(`view_decoration_${questId}`)
                .setLabel('┃Ver Recompensa')
                .setEmoji('1446475869479501824')
                .setStyle(ButtonStyle.Secondary)
        );
    }

    return new ActionRowBuilder().addComponents(components);
}

// ─── API ──────────────────────────────────────────────────────────────────────

async function makeRequest(endpoint, method, token, body = null) {
    try {
        const headers = {
            'authorization':      token,
            'x-super-properties': config.xSuperProperties,
            'user-agent':         config.userAgent,
            'accept-language':    'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
            'sec-ch-ua':          '"Chromium";v="138", "Not=A?Brand";v="8"',
            'sec-ch-ua-mobile':   '?0',
            'sec-ch-ua-platform': '"Windows"',
            'origin':             'https://discord.com',
            'referer':            'https://discord.com/channels/@me'
        };
        if (body) headers['content-type'] = 'application/json';

        return await axiosInstance({
            method,
            url:            `https://discord.com/api/v9${endpoint}`,
            headers,
            data:           body,
            validateStatus: () => true
        });
    } catch {
        return { status: 500, data: null };
    }
}

// ─── Panel ────────────────────────────────────────────────────────────────────

async function sendPanel(channel) {
    if (database.panelMessageId) {
        try {
            const msgs = await channel.messages.fetch({ limit: 100 });
            const old  = msgs.get(database.panelMessageId);
            if (old) await old.delete();
        } catch {}
        database.panelMessageId = null;
        await saveDatabase();
    }

    const embed = new EmbedBuilder()
        .setDescription(
            '## <:quest:1450101744142123143>┃Discord Quest Bot\n\u200B\n' +
            '`[+] Sobre o sistema:`\n> Conheça um dos únicos bot com sistema para concluir missões do Discord automaticamente, sem nenhuma dor de cabeça! Simples, rápido e seguro!\n' +
            '`[+] Missões de vídeos:`\n> Conclua as missões de vídeo do Discord de forma muito mais rápida e automatizada! Não é preciso manter o vídeo aberto, e o processo é até **6x mais rápido** do que assistir ao vídeo normalmente.\n' +
            '`[+] Missões de jogos:`\n> Com o nosso sistema, as missões de jogos do Discord ficam muito mais fáceis, pois **não é necessário baixar, comprar ou jogar o jogo.** Nosso sistema simula o jogo mesmo sem você tê-lo ou estar jogando.\n\u200B'
        )
        .addFields(
            { name: '<:login:1450106597920477318>┃Login',     value: 'Conecte sua conta Discord',      inline: true },
            { name: '<:alvo:1451001713132572703>┃Auto-Quest', value: 'Execute missões automaticamente', inline: true },
            { name: '<:orbs:1450104645484675115>┃Orbs',       value: 'Consulte seu saldo de Orbs',      inline: true }
        )
        .setColor('#5865F2')
        .setImage('https://i.imgur.com/PCXVVCY.png');

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('login').setLabel('Login').setEmoji('1450106597920477318').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('autoquest').setLabel('Auto-Quest').setEmoji('1451001713132572703').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('orbs').setLabel('Orbs').setEmoji('1450104645484675115').setStyle(ButtonStyle.Secondary)
    );

    const msg = await channel.send({ embeds: [embed], components: [row] });
    database.panelMessageId = msg.id;
    await saveDatabase();
}

async function sendPremiumPanel() {
    if (!isConfigured(config.premiumChannelId)) return;
    const channel = await client.channels.fetch(config.premiumChannelId).catch(() => null);
    if (!channel) return;

    if (database.premiumPanelMessageId) {
        try {
            const old = await channel.messages.fetch(database.premiumPanelMessageId);
            await old.delete();
        } catch {}
        database.premiumPanelMessageId = null;
    }

    const price = parseFloat(config.premiumPrice ?? 10).toFixed(2);

    const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('⭐┃Acesso Premium')
        .setDescription(
            'Desbloqueie o máximo do bot com uma assinatura **Premium**.\n' +
            'Tenha acesso a funcionalidades exclusivas que tornam sua experiência muito mais poderosa e automatizada.\n\u200B'
        )
        .addFields(
            {
                name: '🎁┃Benefícios inclusos',
                value: [
                    '`[+] Realização de missões automaticamente`',
                    '> O bot faz as missões por você, sem precisar clicar em nada',
                    '`[+] Missões feitas mais rápidas`',
                    '> Execução otimizada, muito mais veloz que o processo manual',
                    '`[+] Logs em tempo real na DM`',
                    '> Acompanhe cada missão sendo concluída diretamente na sua mensagem privada',
                    '`[+] Missões de outros países`',
                    '> Acesso a quests exclusivas de regiões diferentes, aumentando seus ganhos',
                    '`[+] Em breve: Reivindicar Orbs automaticamente`',
                    '> Coleta automática de Orbs assim que estiverem disponíveis'
                ].join('\n'),
                inline: false
            },
            {
                name: '💳┃Produto',
                value: `> **R$ ${price}** — pagamento único via PIX\n> Ativação em poucos minutos após o pagamento.`,
                inline: false
            }
        )
        .setFooter({ text: 'Clique em "Adquirir Premium" para iniciar o processo de compra.' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('premium_adquirir')
            .setLabel('⭐┃Adquirir Premium')
            .setStyle(ButtonStyle.Secondary)
    );

    const msg = await channel.send({ embeds: [embed], components: [row] });
    database.premiumPanelMessageId = msg.id;
    await saveDatabase();
}

// ─── Quest Listing ────────────────────────────────────────────────────────────

async function fetchQuestsForListing() {
    try {
        const res = await axiosInstance.get('https://discord.com/api/v9/quests/@me', {
            headers: {
                'authorization':      config.listingToken,
                'user-agent':         config.userAgent,
                'x-super-properties': config.xSuperProperties
            }
        });
        return res.data;
    } catch {
        return null;
    }
}

async function deleteQuestMessages(channel, questId, isExpired = false) {
    const store = isExpired ? database.expiredQuests : database.listedQuests;
    const data  = store[questId];
    if (!data?.messageIds) return;

    for (const msgId of data.messageIds) {
        try { await (await channel.messages.fetch(msgId)).delete(); } catch {}
    }

    delete store[questId];
}

async function sendQuestToChannel(quest, channel, isExpired = false) {
    try {
        const reward    = getRewardInfo(quest.config.rewards_config?.rewards);
        const hasReward = reward && (reward.type === 'decoration' || reward.type === 'code');
        const mention   = !isExpired && config.notificationRoleId?.trim() ? `<@&${config.notificationRoleId}>` : '';

        const questMsg = await channel.send({ content: mention, embeds: [createQuestEmbed(quest, isExpired)], components: [createQuestButtons(quest.id, hasReward)] });
        const sepMsg   = await channel.send({ embeds: [createSeparatorEmbed()] });

        const entry = {
            messageIds: [questMsg.id, sepMsg.id],
            messageUrl: `https://discord.com/channels/${channel.guild.id}/${channel.id}/${questMsg.id}`,
            reward:     hasReward ? reward : null
        };

        if (isExpired) database.expiredQuests[String(quest.id)] = entry;
        else           database.listedQuests[String(quest.id)]  = entry;
    } catch (err) {
        console.error('❌ Erro ao enviar embed:', err);
    }
}

async function processQuestListing() {
    if (!isConfigured(config.listChannelId)) return;

    const activeChannel = await client.channels.fetch(config.listChannelId).catch(() => null);
    if (!activeChannel) return;

    let expiredChannel = null;
    if (isConfigured(config.expiredChannelId)) {
        expiredChannel = await client.channels.fetch(config.expiredChannelId).catch(() => null);
    }

    const data = await fetchQuestsForListing();
    if (!data?.quests) return;

    const now           = new Date();
    const activeQuests  = [];
    const expiredQuests = [];

    for (const q of data.quests) {
        const expired = new Date(q.config.expires_at) < now;
        if (expired && q.user_status?.completed_at && q.user_status?.claimed_at) expiredQuests.push(q);
        else if (!expired) activeQuests.push(q);
    }

    const activeIds  = new Set(activeQuests.map(q => String(q.id)));
    const expiredIds = new Set(expiredQuests.map(q => String(q.id)));

    for (const questId of Object.keys(database.listedQuests)) {
        if (!activeIds.has(questId)) {
            const expiredQuest = expiredQuests.find(q => String(q.id) === questId);
            await deleteQuestMessages(activeChannel, questId, false);
            if (expiredQuest && expiredChannel && !database.expiredQuests[questId]) {
                await sendQuestToChannel(expiredQuest, expiredChannel, true);
            }
        }
    }

    if (expiredChannel) {
        for (const questId of Object.keys(database.expiredQuests)) {
            if (!expiredIds.has(questId)) await deleteQuestMessages(expiredChannel, questId, true);
        }
    }

    for (const q of activeQuests) {
        if (!database.listedQuests[String(q.id)]) await sendQuestToChannel(q, activeChannel, false);
    }

    if (expiredChannel) {
        for (const q of expiredQuests) {
            if (!database.expiredQuests[String(q.id)]) await sendQuestToChannel(q, expiredChannel, true);
        }
    }

    await saveDatabase();
    renderDashboard();
    await triggerPremiumForNewQuests();
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleLogin(interaction) {
    if (isTokenValid(interaction.user.id)) {
        const userData = database.users[interaction.user.id];
        return interaction.reply({
            embeds: [new EmbedBuilder()
                .setDescription(`### <:sucesso:1440932976522166373>┃Conta Conectada\n\u200B\n**Nome:** ${userData.globalName}\n**ID:** ${userData.id}`)
                .setThumbnail(userData.avatar)
                .setColor('#57F287')],
            components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('disconnect').setLabel('Desconectar').setStyle(ButtonStyle.Danger)
            )],
            ephemeral: true
        });
    }

    const modal = new ModalBuilder().setCustomId('login_modal').setTitle('Login - Discord Quest');
    modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
            .setCustomId('token_input')
            .setLabel('Token da sua conta Discord')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setPlaceholder('Cole seu token aqui...')
    ));
    await interaction.showModal(modal);
}

async function handleLoginModal(interaction) {
    const token = interaction.fields.getTextInputValue('token_input').trim();
    await interaction.deferReply({ ephemeral: true });

    const response = await makeRequest('/users/@me', 'GET', token);

    if (response.status !== 200) {
        return interaction.editReply({
            embeds: [new EmbedBuilder()
                .setTitle('<:error:1440933007996489748>┃Token Inválido')
                .setDescription('O token informado é inválido ou expirou.')
                .setColor('#ED4245')]
        });
    }

    const userData = response.data;

    if (userData.id !== interaction.user.id) {
        return interaction.editReply({
            embeds: [new EmbedBuilder()
                .setTitle('<:info:1440936501918830743>┃Token Incorreto')
                .setDescription('Você só pode adicionar o token da sua própria conta!')
                .setColor('#FEE75C')]
        });
    }

    const avatarUrl = userData.avatar
        ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`
        : 'https://cdn.discordapp.com/embed/avatars/0.png';

    database.users[interaction.user.id] = {
        token,
        id:         userData.id,
        username:   userData.username,
        globalName: userData.global_name || userData.username,
        avatar:     avatarUrl,
        premium:    isPremiumUser(interaction.user.id)
    };

    await saveDatabase();
    await updateStatsChannel();
    renderDashboard();

    await interaction.editReply({
        embeds: [new EmbedBuilder()
            .setDescription(`### <:sucesso:1440932976522166373>┃Login Realizado\n\u200B\nSua conta foi conectada com sucesso.\n\n**Nome:** ${userData.global_name || userData.username}\n**ID:** \`${userData.id}\``)
            .setThumbnail(avatarUrl)
            .setColor('#57F287')]
    });
}

async function handleDisconnect(interaction) {
    delete database.users[interaction.user.id];
    await saveDatabase();
    await updateStatsChannel();
    renderDashboard();
    await interaction.update({
        embeds: [new EmbedBuilder()
            .setDescription('### <:info:1440936501918830743>┃Conta Desconectada\n\u200B\nSua conta foi desconectada com sucesso.')
            .setColor('#FEE75C')],
        components: []
    });
}

async function handleOrbs(interaction) {
    if (!isTokenValid(interaction.user.id)) {
        return interaction.reply({
            embeds: [new EmbedBuilder()
                .setDescription('### <:info:1440936501918830743>┃Login Necessário\n\u200B\nPor favor, faça login primeiro clicando no botão **Login**.')
                .setColor('#FEE75C')],
            ephemeral: true
        });
    }

    await interaction.deferReply({ ephemeral: true });
    const response = await makeRequest('/users/@me/virtual-currency/balance', 'GET', database.users[interaction.user.id].token);

    if (response.status !== 200) {
        return interaction.editReply({
            embeds: [new EmbedBuilder().setTitle('❌ Erro').setDescription('Não foi possível consultar o saldo de Orbs.').setColor('#ED4245')]
        });
    }

    await interaction.editReply({
        embeds: [new EmbedBuilder()
            .setDescription(`### <:orbs:1450104645484675115>┃Saldo de Orbs\n\u200B\n➜ Você possui **${(response.data.balance || 0).toLocaleString('pt-BR')} Orbs**`)
            .setColor('#FFFFFF')]
    });
}

async function handleAutoQuest(interaction) {
    if (!isTokenValid(interaction.user.id)) {
        return interaction.reply({
            embeds: [new EmbedBuilder()
                .setDescription('### <:info:1440936501918830743>┃Login Necessário\n\u200B\nPor favor, faça login primeiro clicando no botão **Login**.')
                .setColor('#FEE75C')],
            ephemeral: true
        });
    }

    const userQuestData = database.users[interaction.user.id];

    if (userQuestData?.activeQuest) {
        const { startedAt, duration } = userQuestData.activeQuest;
        const cooldownUntil           = startedAt + (duration + 10) * 1000;
        const now                     = Date.now();

        if (now < cooldownUntil) {
            const secsLeft = Math.ceil((cooldownUntil - now) / 1000);
            const m = Math.floor(secsLeft / 60), s = secsLeft % 60;
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setTitle('<:error:1440933007996489748>┃Missão em Andamento')
                    .setDescription(`Você já possui uma missão em andamento!\n\nAguarde **${m > 0 ? `${m}min ${s}s` : `${s}s`}** para iniciar outra missão.`)
                    .setColor('#ED4245')],
                ephemeral: true
            });
        }

        delete database.users[interaction.user.id].activeQuest;
        await saveDatabase();
    }

    await interaction.deferReply({ ephemeral: true });

    const response = await makeRequest('/quests/@me', 'GET', database.users[interaction.user.id].token);
    if (response.status !== 200) {
        return interaction.editReply({
            embeds: [new EmbedBuilder().setTitle('<:error:1440933007996489748>┃Erro').setDescription('Não foi possível carregar as missões disponíveis.').setColor('#ED4245')]
        });
    }

    const now             = new Date();
    const availableQuests = [];

    for (const quest of (response.data.quests || [])) {
        if (new Date(quest.config.expires_at) < now) continue;
        if (quest.user_status?.completed_at) continue;

        const tasks        = quest.config.task_config_v2?.tasks || {};
        const selectedTask = getBestTask(tasks);
        if (!selectedTask) continue;

        const target     = selectedTask.taskData.target || 0;
        const rewardText = parseRewardText(quest.config.rewards_config?.rewards?.[0]);

        availableQuests.push({
            questId:    quest.id,
            questName:  quest.config.messages.quest_name,
            taskType:   selectedTask.taskType,
            target,
            timeText:   `${Math.ceil(target / 60)} minutos`,
            rewardText,
            isEnrolled: quest.user_status?.enrolled_at,
            fullQuest:  quest
        });
    }

    if (!availableQuests.length) {
        return interaction.editReply({
            embeds: [new EmbedBuilder().setTitle('🔭┃Nenhuma Missão Disponível').setDescription('Não há missões disponíveis no momento.').setColor('#5865F2')]
        });
    }

    availableQuests.sort((a, b) => {
        const aOrbs = a.rewardText.includes('Orbs'), bOrbs = b.rewardText.includes('Orbs');
        if (aOrbs && !bOrbs) return -1;
        if (!aOrbs && bOrbs) return 1;
        return Math.ceil(a.target / 60) - Math.ceil(b.target / 60);
    });

    userSessions[interaction.user.id] = { availableQuests };

    const options = availableQuests.map((q, i) => ({
        label:       q.questName.substring(0, 100),
        description: `${TASK_TYPES[q.taskType]}⏱️ ${q.timeText}┃🎁 ${q.rewardText}`.substring(0, 100),
        value:       `quest_${i}`
    }));

    await interaction.editReply({
        embeds: [new EmbedBuilder()
            .setDescription(`### <:quest:1450101744142123143>┃Missões Disponíveis\n\u200B\nEncontradas **${availableQuests.length}** missões disponíveis.`)
            .setColor('#FFFFFF')
            .setImage('https://i.imgur.com/PCXVVCY.png')],
        components: [new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId('quest_select').setPlaceholder('Selecione uma missão').addOptions(options)
        )]
    });
}

const DM_BLOCKED_EMBED = new EmbedBuilder()
    .setDescription(
        '### <:error:1440933007996489748>┃DM Bloqueada\n\n' +
        '❌ **Não foi possível enviar o progresso da missão para sua DM!**\n\n' +
        'Para acompanhar o progresso da sua missão, você precisa **ativar as mensagens diretas**.\n\n' +
        '📌 **Como ativar:**\n' +
        '> `Configurações do Discord` → `Privacidade e segurança` → `Permitir mensagens diretas de membros do servidor`\n\n' +
        '⚠️ **A missão continuará sendo executada normalmente**, mas você não receberá as atualizações visuais do progresso.\n\n' +
        'Após ativar as DMs, clique novamente em **Auto-Quest** para iniciar uma nova missão.'
    )
    .setColor('#ED4245');

async function handleQuestSelect(interaction) {
    const userId = interaction.user.id;

    if (!userSessions[userId]?.availableQuests) {
        return interaction.reply({
            embeds: [new EmbedBuilder().setTitle('<:error:1440933007996489748>┃Sessão Expirada').setDescription('Por favor, clique em Auto-Quest novamente.').setColor('#ED4245')],
            ephemeral: true
        });
    }

    const quest     = userSessions[userId].availableQuests[parseInt(interaction.values[0].split('_')[1])];
    const token     = database.users[userId].token;
    const isPremium = isPremiumUser(userId);

    await interaction.deferUpdate();

    if (!quest.isEnrolled) {
        const res = await makeRequest(`/quests/${quest.questId}/enroll`, 'POST', token, { location: 11, is_targeted: false, metadata_raw: null });
        if (res.status !== 200) {
            return interaction.editReply({
                embeds: [new EmbedBuilder().setTitle('<:error:1440933007996489748>┃Erro ao Inscrever').setDescription('Não foi possível se inscrever na missão.').setColor('#ED4245')],
                components: []
            });
        }
    }

    const target      = quest.target;
    const storedQuest = {
        questId:        quest.questId,
        questName:      quest.questName,
        taskType:       quest.taskType,
        target,
        rewardText:     quest.rewardText,
        heroImage:      getCdnUrl(quest.fullQuest.config.assets?.hero),
        thumbnailImage: getCdnUrl(quest.fullQuest.config.assets?.game_tile_dark || quest.fullQuest.config.assets?.game_tile),
        startedAt:      Date.now(),
        duration:       target,
        progress:       0
    };

    database.users[userId].activeQuest = storedQuest;
    await saveDatabase();
    renderDashboard();

    const initialPayload = await buildProgressEmbed(storedQuest, 0, target);
    let dmMsg     = null;
    let dmBlocked = false;

    try {
        const discordUser = await client.users.fetch(userId);
        const dm          = await discordUser.createDM();
        dmMsg             = await dm.send(initialPayload);
        database.users[userId].resumeChannelId = dm.id;
        database.users[userId].resumeMessageId = dmMsg.id;
        await saveDatabase();
    } catch (err) {
        console.error(`❌ DM bloqueada para ${userId}:`, err.message);
        dmBlocked = true;
        await interaction.editReply({ embeds: [DM_BLOCKED_EMBED], components: [] });
    }

    if (!dmBlocked) {
        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setDescription(`### <:quest:1450101744142123143>┃Missão Iniciada\n\nAcompanhe o progresso na sua **DM**.`)
                .setColor('#5865F2')],
            components: isPremium ? [] : [new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setLabel('Abrir DM do Bot')
                    .setStyle(ButtonStyle.Link)
                    .setURL(`https://discord.com/users/${client.user.id}`)
            )]
        });
    }

    let lastDmEdit = 0;
    const updateDm = async (current, isCompleted = false) => {
        if (!dmMsg || dmBlocked) return;
        const now = Date.now();
        if (isCompleted || now - lastDmEdit >= 5000) {
            const payload = await buildProgressEmbed(storedQuest, current, target, isCompleted);
            dmMsg      = await editProgressMessage(dmMsg, payload);
            lastDmEdit = now;
            if (dmMsg?.id !== database.users[userId]?.resumeMessageId) {
                if (database.users[userId]) database.users[userId].resumeMessageId = dmMsg.id;
                await saveDatabase();
            }
        }
    };

    const finalProgress = await runQuestStandalone(userId, token, storedQuest, updateDm);

    delete userSessions[userId];
    delete database.users[userId].activeQuest;
    if (!dmBlocked) {
        delete database.users[userId].resumeChannelId;
        delete database.users[userId].resumeMessageId;
    }
    await saveDatabase();
    renderDashboard();

    if (dmMsg && !dmBlocked) {
        const finalPayload = await buildProgressEmbed(storedQuest, finalProgress, target, true);
        await editProgressMessage(dmMsg, finalPayload);
    }
}

// ─── DM Helpers ───────────────────────────────────────────────────────────────

async function sendDmToUser(userId, payload) {
    try {
        const user = await client.users.fetch(userId);
        const dm   = await user.createDM();
        return await dm.send(payload);
    } catch (err) {
        if (err.code !== 50278) console.error(`❌ Erro ao enviar DM para ${userId}:`, err.message);
        return null;
    }
}

async function sendPremiumActivatedDM(userId) {
    try {
        const user = await client.users.fetch(userId);
        await user.send({
            embeds: [new EmbedBuilder()
                .setColor('#FFD700')
                .setAuthor({ name: `${client.user.username} — Premium Ativado`, iconURL: client.user.displayAvatarURL({ size: 256 }) })
                .setTitle('⭐  Seu Premium foi Ativado!')
                .setDescription(`Olá, **${user.username}**! 🎉\n\nSeu acesso **Premium** foi ativado com sucesso!\n\u200B`)
                .addFields(
                    {
                        name: '🚀  O que mudou para você',
                        value: [
                            '> ✅ Missões executadas **automaticamente**',
                            '> ✅ Fila de missões — o bot executa uma após a outra',
                            '> ✅ Atualizações em tempo real via **DM**',
                            '> ✅ Prioridade no suporte',
                            '> ✅ Acesso a recursos exclusivos'
                        ].join('\n'),
                        inline: false
                    },
                    {
                        name: '📌  Como funciona',
                        value:
                            '> O bot monitora novas missões automaticamente.\n' +
                            '> Quando houver missões disponíveis, inicia a fila\n' +
                            '> sozinho e você recebe atualizações aqui na DM.',
                        inline: false
                    }
                )
                .setThumbnail(client.user.displayAvatarURL({ size: 512 }))
                .setFooter({ text: 'Obrigado pelo Premium! Qualquer dúvida, contate o suporte.' })
                .setTimestamp()]
        });
    } catch {}
}

async function sendPremiumRemovedDM(userId) {
    try {
        const user = await client.users.fetch(userId);
        await user.send({
            embeds: [new EmbedBuilder()
                .setTitle('⭐┃Premium Removido')
                .setDescription('Seu acesso **Premium** foi removido. O bot não irá mais executar missões automaticamente.')
                .setColor('#ED4245')]
        });
    } catch {}
}

// ─── Admin ────────────────────────────────────────────────────────────────────

function buildAdminEmbed(targetId) {
    const userData  = database.users[targetId];
    const isPremium = userData?.premium === true;

    const lines = [
        `**Nome:** ${userData.globalName}`,
        `**Username:** @${userData.username}`,
        `**ID:** \`${userData.id}\``,
        `\u200B`,
        `**Premium:** ${isPremium ? '✅ Ativo' : '❌ Inativo'}`,
        `**Quest Ativa:** ${userData.activeQuest ? `✅ \`${userData.activeQuest.questName}\`` : '❌ Nenhuma'}`
    ];

    if (isPremium && userData.premiumQueue?.length > 0) {
        lines.push(`**Fila Premium:** ${userData.premiumQueue.length} quest(s) aguardando`);
    }

    return new EmbedBuilder()
        .setTitle('<:quest:1450101744142123143>┃Painel Admin — Usuário')
        .setDescription(lines.join('\n'))
        .setThumbnail(userData.avatar)
        .setColor(isPremium ? '#FFD700' : '#5865F2')
        .setFooter({ text: `Discord ID: ${targetId}` });
}

function buildAdminButtons(targetId) {
    const isPremium = database.users[targetId]?.premium === true;
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`admin_disconnect_${targetId}`).setLabel('Desconectar').setEmoji('🔌').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`admin_reset_${targetId}`).setLabel('Resetar Quest').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
        isPremium
            ? new ButtonBuilder().setCustomId(`admin_removepremium_${targetId}`).setLabel('Remover Premium').setEmoji('⭐').setStyle(ButtonStyle.Secondary)
            : new ButtonBuilder().setCustomId(`admin_premium_${targetId}`).setLabel('Ativar Premium').setEmoji('⭐').setStyle(ButtonStyle.Success)
    )];
}

async function handleAdminCommand(interaction) {
    if (!isConfigured(config.ownerId) || interaction.user.id !== config.ownerId) {
        return interaction.reply({
            embeds: [new EmbedBuilder()
                .setTitle('<:error:1440933007996489748>┃Sem Permissão')
                .setDescription('Apenas o dono do bot pode usar este comando.')
                .setColor('#ED4245')],
            ephemeral: true
        });
    }

    const input    = interaction.options.getString('usuario');
    const targetId = input.match(/^<@!?(\d+)>$/)?.[1] ?? input.trim();

    await interaction.deferReply({ ephemeral: true });

    if (!database.users[targetId]) {
        return interaction.editReply({
            embeds: [new EmbedBuilder()
                .setTitle('<:error:1440933007996489748>┃Usuário Não Encontrado')
                .setDescription(`O usuário com ID \`${targetId}\` não está registrado.`)
                .setColor('#ED4245')]
        });
    }

    await interaction.editReply({ embeds: [buildAdminEmbed(targetId)], components: buildAdminButtons(targetId) });
}

async function handleAdminButton(interaction) {
    if (!isConfigured(config.ownerId) || interaction.user.id !== config.ownerId) {
        return interaction.reply({ content: '❌ Sem permissão.', ephemeral: true });
    }

    const withoutPrefix = interaction.customId.slice('admin_'.length);
    const sep           = withoutPrefix.indexOf('_');
    const action        = withoutPrefix.slice(0, sep);
    const targetId      = withoutPrefix.slice(sep + 1);

    if (action === 'disconnect') {
        delete database.users[targetId];
        await saveDatabase();
        return interaction.update({
            embeds: [new EmbedBuilder()
                .setTitle('<:info:1440936501918830743>┃Usuário Desconectado')
                .setDescription(`O usuário \`${targetId}\` foi desconectado.${isPremiumUser(targetId) ? '\n\n⭐ O status **Premium** foi preservado.' : ''}`)
                .setColor('#FEE75C')],
            components: []
        });
    }

    if (!database.users[targetId]) {
        return interaction.reply({ content: '❌ Usuário não encontrado.', ephemeral: true });
    }

    if (action === 'reset') {
        const u = database.users[targetId];
        delete u.activeQuest;
        delete u.resumeChannelId;
        delete u.resumeMessageId;
        delete u.premiumQueue;
        await saveDatabase();
        return interaction.update({ embeds: [buildAdminEmbed(targetId)], components: buildAdminButtons(targetId) });
    }

    if (action === 'premium') {
        setPremiumUser(targetId, true);
        await saveDatabase();
        await sendPremiumActivatedDM(targetId);
        if (!database.users[targetId].activeQuest) runPremiumQueueForUser(targetId).catch(console.error);
        return interaction.update({ embeds: [buildAdminEmbed(targetId)], components: buildAdminButtons(targetId) });
    }

    if (action === 'removepremium') {
        setPremiumUser(targetId, false);
        await saveDatabase();
        await sendPremiumRemovedDM(targetId);
        return interaction.update({ embeds: [buildAdminEmbed(targetId)], components: buildAdminButtons(targetId) });
    }
}

// ─── Premium Payment ──────────────────────────────────────────────────────────

async function handlePremiumAdquirir(interaction) {
    const price     = parseFloat(config.premiumPrice ?? 10);
    const sessionId = interaction.id;

    const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`premium_confirmar_${sessionId}`)
            .setLabel('✅  Confirmar Compra')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`premium_cancelar_${sessionId}`)
            .setLabel('❌  Cancelar')
            .setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({
        embeds: [new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('⭐  Premium — Informações da Compra')
            .setDescription('Você está a um passo de adquirir o **Premium**!\nLeia as informações abaixo antes de confirmar.\n\u200B')
            .addFields(
                { name: '💳  Pagamento', value: `> **R$ ${price.toFixed(2)}** via PIX (pagamento único)`, inline: false },
                {
                    name: '⚡  Como funciona a ativação',
                    value:
                        '> **1.** Confirme a compra clicando no botão abaixo\n' +
                        '> **2.** Um QR Code PIX será gerado exclusivamente para você\n' +
                        '> **3.** Faça o pagamento em até **15 minutos**\n' +
                        '> **4.** Após confirmação, aguarde a ativação pelo administrador\n' +
                        '> **5.** Você receberá uma **DM** quando o Premium for ativado ✅',
                    inline: false
                },
                {
                    name: '⚠️  Importante',
                    value:
                        '> • O QR Code expira em **15 minutos** após gerado\n' +
                        '> • A ativação é feita **manualmente** pelo administrador\n' +
                        '> • Em caso de dúvidas, contate o suporte',
                    inline: false
                }
            )
            .setFooter({ text: 'Clique em "Confirmar Compra" para gerar seu PIX.' })],
        components: [confirmRow],
        ephemeral:  true
    });

    premiumSessions.set(sessionId, { userId: interaction.user.id, interaction, price });

    setTimeout(() => {
        if (!premiumSessions.has(sessionId)) return;
        premiumSessions.delete(sessionId);
        interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor('#ED4245')
                .setTitle('⏰  Tempo esgotado')
                .setDescription('Você não confirmou a tempo. Clique em **Adquirir Premium** novamente.')],
            components: []
        }).catch(() => {});
    }, 90_000);
}

async function processPremiumPix(session, btnInteraction) {
    const { interaction, price } = session;
    const sessionId = interaction.id;
    const guildId   = interaction.guild?.id ?? config.guildId;

    if (!database.pixggCache?.authToken || !database.pixggCache?.streamerId) {
        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor('#ED4245')
                .setTitle('❌  Pagamento indisponível')
                .setDescription('O sistema de pagamento ainda não foi configurado pelo administrador. Tente novamente mais tarde.')],
            components: []
        });
        return;
    }

    await interaction.editReply({
        embeds: [new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('🔄  Gerando seu PIX...')
            .setDescription('Aguarde um instante enquanto geramos o código de pagamento exclusivo para você.')],
        components: []
    });

    const chars  = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const codigo = Array.from({ length: 9 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    let pixUrl;

    try {
        const { data } = await axiosInstance.post(
            'https://app.pixgg.com/checkouts',
            { streamerId: database.pixggCache.streamerId, donatorNickname: interaction.user.username, donatorMessage: `PREMIUM-${codigo}`, donatorAmount: price, country: 'Brazil' },
            { headers: { ...PIXGG_HEADERS, authorization: `Bearer ${database.pixggCache.authToken}` } }
        );
        pixUrl = data.pixUrl;
    } catch (err) {
        console.error('[PixGG] Erro ao criar checkout:', err?.response?.status, JSON.stringify(err?.response?.data ?? err?.message));
        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor('#ED4245')
                .setTitle('❌  Erro ao gerar PIX')
                .setDescription('Não foi possível criar o código PIX. Tente novamente ou contate o suporte.')],
            components: []
        });
        return;
    }

    const EXPIRY_TIME = 15 * 60_000;

    const buildPaymentEmbed = (remaining) => {
        const pct    = Math.max(0, remaining / EXPIRY_TIME);
        const filled = Math.round(10 * pct);
        return new EmbedBuilder()
            .setColor('#FEE75C')
            .setTitle('⏳  Aguardando Pagamento')
            .setDescription('Escaneie o QR Code ou copie o código PIX abaixo para efetuar o pagamento.')
            .addFields(
                { name: '💵  Valor',            value: `\`R$ ${price.toFixed(2)}\``,  inline: true },
                { name: '🔒  Código',           value: `\`PREMIUM-${codigo}\``,       inline: true },
                { name: '📋  PIX Copia e Cola', value: `\`\`\`${pixUrl}\`\`\`` }
            )
            .setImage('attachment://qrcode.png')
            .setFooter({ text: `[${'█'.repeat(filled)}${'░'.repeat(10 - filled)}] ${Math.round(pct * 100)}% — Não feche esta mensagem.` });
    };

    const makeQR = async () => new AttachmentBuilder(
        await QRCode.toBuffer(pixUrl, { width: 300, margin: 2 }),
        { name: 'qrcode.png' }
    );

    const cancelRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`premium_pix_cancel_${sessionId}`)
            .setLabel('❌  Cancelar Pagamento')
            .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({ embeds: [buildPaymentEmbed(EXPIRY_TIME)], files: [await makeQR()], components: [cancelRow] });

    const expiry = Date.now() + EXPIRY_TIME;
    let done     = false;

    const finish = async (embed) => {
        if (done) return;
        done = true;
        clearInterval(ticker);
        pixSessions.delete(sessionId);
        await interaction.editReply({ embeds: [embed], components: [], files: [] }).catch(() => {});
    };

    pixSessions.set(sessionId, {
        userId: interaction.user.id,
        cancel: () => finish(new EmbedBuilder()
            .setColor('#ED4245')
            .setTitle('❌  Pagamento cancelado')
            .setDescription('Você cancelou o pagamento. Clique em **Adquirir Premium** quando quiser tentar novamente.'))
    });

    const ticker = setInterval(async () => {
        if (done) { clearInterval(ticker); return; }

        const remaining = expiry - Date.now();

        if (remaining <= 0) {
            await finish(new EmbedBuilder()
                .setColor('#ED4245')
                .setTitle('⌛  PIX expirado')
                .setDescription('O tempo de **15 minutos** foi atingido. Clique em **Adquirir Premium** para gerar um novo código.'));
            return;
        }

        try {
            const donations    = await pixggRequest('GET', 'https://app.pixgg.com/Reports/Donations?page=1&pageSize=20');
            const transactions = Array.isArray(donations) ? donations : donations.items ?? [];
            const found        = transactions.find(t => t.donatorMessage === `PREMIUM-${codigo}`);

            if (found) {
                const userId = interaction.user.id;

                setPremiumUser(userId, true);
                await saveDatabase();

                if (isConfigured(config.premiumRoleId)) {
                    try {
                        const guild  = client.guilds.cache.get(guildId);
                        const member = await guild?.members.fetch(userId);
                        await member?.roles.add(config.premiumRoleId);
                    } catch (err) {
                        console.error('[Premium] Erro ao atribuir cargo:', err?.message);
                    }
                }

                await finish(new EmbedBuilder()
                    .setColor('#57F287')
                    .setTitle('✅  Premium Ativado!')
                    .setDescription(
                        'Recebemos seu pagamento e seu **Premium foi ativado automaticamente**! 🎉\n\n' +
                        'O bot já está monitorando missões para você.\n' +
                        'Você receberá atualizações via **DM** assim que uma missão for iniciada. 🚀'
                    )
                    .addFields(
                        { name: '💵  Valor',   value: `\`R$ ${price.toFixed(2)}\``,      inline: true },
                        { name: '👤  Pagador', value: found.donatorNickname || 'Anônimo', inline: true },
                        { name: '🔒  Código',  value: `\`PREMIUM-${codigo}\``,           inline: true }
                    )
                    .setFooter({ text: 'Obrigado pelo Premium! Qualquer dúvida, contate o suporte.' }));

                await sendPremiumActivatedDM(userId);

                if (!database.users[userId]?.activeQuest) {
                    runPremiumQueueForUser(userId).catch(console.error);
                }

                if (isConfigured(config.ownerId)) {
                    try {
                        const owner = await client.users.fetch(config.ownerId);
                        const guild = client.guilds.cache.get(guildId);
                        await owner.send({
                            embeds: [new EmbedBuilder()
                                .setColor('#57F287')
                                .setTitle('⭐  Novo Premium Ativado Automaticamente!')
                                .setDescription('Pagamento confirmado e Premium ativado sem intervenção manual.\n\u200B')
                                .addFields(
                                    { name: '👤  Usuário',       value: `${interaction.user.tag}\n\`${userId}\``,              inline: true },
                                    { name: '🏠  Servidor',      value: guild?.name ?? `\`${guildId}\``,                       inline: true },
                                    { name: '💵  Valor',         value: `\`R$ ${price.toFixed(2)}\``,                         inline: true },
                                    { name: '🔒  Código',        value: `\`PREMIUM-${codigo}\``,                              inline: true },
                                    { name: '🧾  Pagador (API)', value: found.donatorNickname || 'Anônimo',                   inline: true }
                                )
                                .setFooter({ text: `Premium já ativo — ID: ${userId}` })
                                .setTimestamp()]
                        });
                    } catch {}
                }
                return;
            }

            await interaction.editReply({ embeds: [buildPaymentEmbed(remaining)], files: [await makeQR()], components: [cancelRow] }).catch(() => {});
        } catch {}
    }, 10_000);
}

// ─── Quest Runner ─────────────────────────────────────────────────────────────

async function runQuestStandalone(userId, token, storedQuest, updateMessage) {
    const { questId, taskType, target } = storedQuest;
    let currentProgress = storedQuest.progress || 0;

    if (taskType.startsWith('WATCH_')) {
        let timestamp = currentProgress;

        while (currentProgress < target) {
            const res = await makeRequest(`/quests/${questId}/video-progress`, 'POST', token, { timestamp });

            if (res.status === 400 || res.status === 429) {
                timestamp = Math.max(0, timestamp - 10);
                await sleep(jitter(8000));
                continue;
            }

            if (res.status === 200) {
                if (res.data.completed_at) { currentProgress = target; break; }
                currentProgress = timestamp;
                timestamp += 10;
                if (database.users[userId]?.activeQuest) database.users[userId].activeQuest.progress = currentProgress;
                if (currentProgress % 50 === 0) await saveDatabase();
                await updateMessage(currentProgress, false);
                if (currentProgress >= target) break;
            }

            await sleep(jitter(2500, 2500));
        }
    } else if (taskType.startsWith('PLAY_')) {
        const streamKey  = `call:${questId}:1`;
        const MAX_STUCK  = 8;
        let stuckCounter = 0;

        while (currentProgress < target) {
            const res = await makeRequest(`/quests/${questId}/heartbeat`, 'POST', token, { stream_key: streamKey, terminal: false });

            if (res.status === 429) { await sleep(jitter(8000)); continue; }

            if (res.status === 200) {
                const data = res.data;

                if (data.completed_at || data.user_status?.completed_at) { currentProgress = target; break; }

                const newProgress = data.progress?.[taskType]?.value ?? currentProgress;

                if (newProgress > currentProgress) {
                    currentProgress = newProgress;
                    stuckCounter    = 0;
                    if (database.users[userId]?.activeQuest) database.users[userId].activeQuest.progress = currentProgress;
                    await saveDatabase();
                    await updateMessage(currentProgress, false);

                    if (currentProgress >= target) {
                        await makeRequest(`/quests/${questId}/heartbeat`, 'POST', token, { stream_key: streamKey, terminal: true });
                        currentProgress = target;
                        break;
                    }
                } else {
                    stuckCounter++;
                    if (stuckCounter >= MAX_STUCK) {
                        await makeRequest(`/quests/${questId}/heartbeat`, 'POST', token, { stream_key: streamKey, terminal: true });
                        currentProgress = target;
                        break;
                    }
                }
            }

            await sleep(jitter(24000, 3000));
        }
    }

    await updateMessage(currentProgress, true);
    await incrementMonthlyCount();
    return currentProgress;
}

// ─── Resume on Startup ────────────────────────────────────────────────────────

async function resumeQuestsOnStartup() {
    for (const userId of Object.keys(database.users)) {
        const userData = database.users[userId];
        if (!userData.activeQuest) continue;

        const { startedAt, duration, target, progress } = userData.activeQuest;

        if (Date.now() >= startedAt + (duration + 10) * 1000) {
            delete database.users[userId].activeQuest;
            delete database.users[userId].resumeChannelId;
            delete database.users[userId].resumeMessageId;
            await saveDatabase();
            continue;
        }

        const token       = userData.token;
        const storedQuest = userData.activeQuest;
        const { resumeChannelId, resumeMessageId } = userData;

        (async () => {
            try {
                let resumeMsg = null;

                if (resumeChannelId && resumeMessageId) {
                    try {
                        const ch  = await client.channels.fetch(resumeChannelId);
                        resumeMsg = await ch.messages.fetch(resumeMessageId);
                        const payload = await buildProgressEmbed(storedQuest, progress || 0, target);
                        await resumeMsg.edit({ ...payload, components: [] });
                    } catch { resumeMsg = null; }
                }

                let lastEdit = 0;
                const update = async (current, isCompleted) => {
                    if (!resumeMsg) return;
                    const now = Date.now();
                    if (isCompleted || now - lastEdit >= 5000) {
                        const payload = await buildProgressEmbed(storedQuest, current, target, isCompleted);
                        resumeMsg = await editProgressMessage(resumeMsg, payload);
                        lastEdit  = now;
                    }
                };

                const finalProgress = await runQuestStandalone(userId, token, storedQuest, update);

                delete database.users[userId].activeQuest;
                delete database.users[userId].resumeChannelId;
                delete database.users[userId].resumeMessageId;
                await saveDatabase();

                if (resumeMsg) {
                    await editProgressMessage(resumeMsg, await buildProgressEmbed(storedQuest, finalProgress, target, true));
                }

                if (database.users[userId]?.premium) {
                    await sleep(jitter(15000, 3000));
                    runPremiumQueueForUser(userId).catch(console.error);
                }
            } catch (err) {
                console.error(`❌ Erro ao retomar quest de ${userData.username}:`, err);
            }
        })();
    }

    renderDashboard();
}

// ─── Premium Queue ────────────────────────────────────────────────────────────

async function fetchAvailableQuestsForUser(token) {
    const res = await makeRequest('/quests/@me', 'GET', token);
    if (res.status !== 200) return [];

    const now    = new Date();
    const result = [];

    for (const quest of (res.data.quests || [])) {
        if (new Date(quest.config.expires_at) < now) continue;
        if (quest.user_status?.completed_at) continue;

        const tasks        = quest.config.task_config_v2?.tasks || {};
        const selectedTask = getBestTask(tasks);
        if (!selectedTask) continue;

        const target     = selectedTask.taskData.target || 0;
        const rewardText = parseRewardText(quest.config.rewards_config?.rewards?.[0]);

        result.push({
            questId:        quest.id,
            questName:      quest.config.messages.quest_name,
            taskType:       selectedTask.taskType,
            target,
            rewardText,
            isEnrolled:     !!quest.user_status?.enrolled_at,
            heroImage:      getCdnUrl(quest.config.assets?.hero),
            thumbnailImage: getCdnUrl(quest.config.assets?.game_tile_dark || quest.config.assets?.game_tile),
            fullQuest:      quest
        });
    }

    result.sort((a, b) => {
        const aOrbs = a.rewardText.includes('Orbs'), bOrbs = b.rewardText.includes('Orbs');
        if (aOrbs && !bOrbs) return -1;
        if (!aOrbs && bOrbs) return 1;
        return a.target - b.target;
    });

    return result;
}

async function runPremiumQueueForUser(userId) {
    const userData = database.users[userId];
    if (!userData?.premium || !userData?.token || userData?.activeQuest) return;

    const quests = await fetchAvailableQuestsForUser(userData.token);

    if (!quests.length) {
        await sendDmToUser(userId, { embeds: [new EmbedBuilder()
            .setTitle('🔭┃Sem Missões Disponíveis')
            .setDescription('Nenhuma missão disponível no momento. Assim que aparecerem novas, o bot iniciará automaticamente.')
            .setColor('#5865F2')
        ]});
        return;
    }

    const completedIndices = new Set();

    const buildQueueEmbed = (currentIndex) => {
        const lista = quests.map((q, i) => {
            const done    = completedIndices.has(i);
            const current = i === currentIndex && !done;
            const marker  = done ? '✅' : (current ? '▶️' : `**${i + 1}.**`);
            const name    = done ? `~~${q.questName}~~` : q.questName;
            return `${marker} ${name} — \`${getTaskDuration(q.target)}\` — 🎁 ${q.rewardText}`;
        }).join('\n');

        return new EmbedBuilder()
            .setTitle('⭐┃Fila Premium Iniciada')
            .setDescription(`O bot irá executar **${quests.length}** missão(ões) automaticamente:\n\n${lista}`)
            .setColor('#FFD700');
    };

    let queueMsg    = await sendDmToUser(userId, { embeds: [buildQueueEmbed(0)] });
    let progressMsg = null;

    const safeEditQueue = async (embed) => {
        if (!queueMsg) return;
        try {
            await queueMsg.edit({ embeds: [embed] });
        } catch {
            try { await queueMsg.delete(); } catch {}
            queueMsg = await sendDmToUser(userId, { embeds: [embed] });
        }
    };

    const sendOrEditProgress = async (payload) => {
        if (!progressMsg) {
            progressMsg = await sendDmToUser(userId, payload);
        } else {
            try {
                await progressMsg.edit({ ...payload, components: [] });
            } catch {
                try { await progressMsg.delete(); } catch {}
                progressMsg = await sendDmToUser(userId, payload);
            }
        }
    };

    database.users[userId].premiumQueue = quests.map(q => q.questId);
    await saveDatabase();

    const completedQuests = [];

    for (let qi = 0; qi < quests.length; qi++) {
        const quest = quests[qi];
        const freshUser = database.users[userId];
        if (!freshUser?.premium) break;

        if (!quest.isEnrolled) {
            const res = await makeRequest(`/quests/${quest.questId}/enroll`, 'POST', freshUser.token, { location: 11, is_targeted: false, metadata_raw: null });
            if (res.status !== 200) continue;
        }

        const activeQuest = {
            questId:        quest.questId,
            questName:      quest.questName,
            taskType:       quest.taskType,
            target:         quest.target,
            rewardText:     quest.rewardText,
            heroImage:      quest.heroImage,
            thumbnailImage: quest.thumbnailImage,
            startedAt:      Date.now(),
            duration:       quest.target,
            progress:       0
        };

        database.users[userId].activeQuest = activeQuest;
        await saveDatabase();

        await safeEditQueue(buildQueueEmbed(qi));
        await sendOrEditProgress(await buildProgressEmbed(activeQuest, 0, quest.target));

        if (progressMsg) {
            database.users[userId].resumeChannelId = progressMsg.channel.id;
            database.users[userId].resumeMessageId = progressMsg.id;
            await saveDatabase();
        }

        let lastDmEdit = 0;
        const updateDm = async (current, isCompleted = false) => {
            const now = Date.now();
            if (isCompleted || now - lastDmEdit >= 5000) {
                const payload = await buildProgressEmbed(activeQuest, current, quest.target, isCompleted);
                await sendOrEditProgress(payload);
                lastDmEdit = now;
                if (isCompleted) {
                    completedIndices.add(qi);
                    await safeEditQueue(buildQueueEmbed(qi + 1));
                }
            }
        };

        await runQuestStandalone(userId, freshUser.token, activeQuest, updateDm);

        completedQuests.push({ questName: quest.questName, rewardText: quest.rewardText });
        completedIndices.add(qi);

        delete database.users[userId].activeQuest;
        delete database.users[userId].resumeChannelId;
        delete database.users[userId].resumeMessageId;
        if (database.users[userId]?.premiumQueue) {
            database.users[userId].premiumQueue = database.users[userId].premiumQueue.filter(id => id !== quest.questId);
        }
        await saveDatabase();

        if (qi < quests.length - 1) {
            await sleep(jitter(300000, 30000));
        }
    }

    const freshUser = database.users[userId];
    if (freshUser) { delete freshUser.premiumQueue; await saveDatabase(); }

    try { if (queueMsg)    await queueMsg.delete();    } catch {}
    try { if (progressMsg) await progressMsg.delete(); } catch {}

    const listaFeita = completedQuests.length > 0
        ? completedQuests.map((q, i) => `**${i + 1}.** ${q.questName} — 🎁 ${q.rewardText}`).join('\n')
        : 'Nenhuma missão foi concluída.';

    await sendDmToUser(userId, { embeds: [new EmbedBuilder()
        .setTitle('⭐┃Fila Finalizada!')
        .setDescription(
            `Todas as missões disponíveis foram concluídas! O bot continuará monitorando novas missões automaticamente.\n\n` +
            `**Missões concluídas (${completedQuests.length}/${quests.length}):**\n${listaFeita}`
        )
        .setColor('#57F287')
    ]});
}

async function triggerPremiumForNewQuests() {
    for (const [userId, userData] of Object.entries(database.users)) {
        if (!userData.premium || !userData.token || userData.activeQuest) continue;
        const quests = await fetchAvailableQuestsForUser(userData.token);
        if (quests.length > 0) runPremiumQueueForUser(userId).catch(console.error);
    }
}

// ─── Terminal Dashboard ───────────────────────────────────────────────────────

let _lastDashboardState = '';

function renderDashboard() {
    const users        = Object.keys(database.users).length;
    const activeQuests = Object.values(database.users).filter(u => u.activeQuest).length;
    const listedCount  = Object.keys(database.listedQuests).length;
    const expiredCount = Object.keys(database.expiredQuests).length;
    const monthly      = getMonthlyCount();

    const state = `${users}|${activeQuests}|${listedCount}|${expiredCount}|${monthly}`;
    if (state === _lastDashboardState) return;
    _lastDashboardState = state;

    const now     = new Date();
    const timeStr = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const line    = '─'.repeat(44);

    const pad = (label, value, width = 44) => `  ${label}: ${value}`.padEnd(width);

    console.log(`  ╔${line}╗`);
    console.log(`  ║${pad('👥 Usuários conectados', users)}`);
    console.log(`  ║${pad('⚡ Missões em andamento', activeQuests)}`);
    console.log(`  ╠${line}╣`);
    console.log(`  ║${pad('🟢 Quests ativas (listing)', listedCount)}`);
    console.log(`  ║${pad('🔴 Quests expiradas (listing)', expiredCount)}`);
    console.log(`  ╠${line}╣`);
    console.log(`  ║${pad('🏆 Missões concluídas este mês', monthly)}`);
    console.log(`  ╚${line}╝\n`);
}

function getMonthlyKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function getMonthlyCount() {
    const key = getMonthlyKey();
    if (database.monthlyQuests?.month !== key) return 0;
    return database.monthlyQuests?.count || 0;
}

async function incrementMonthlyCount() {
    const key = getMonthlyKey();
    if (database.monthlyQuests?.month !== key) {
        database.monthlyQuests = { month: key, count: 0 };
    }
    database.monthlyQuests.count++;
    await saveDatabase();
    await updateQuestsChannel();
    renderDashboard();
}

// ─── Stats & Commands ─────────────────────────────────────────────────────────

async function updateStatsChannel() {
    try {
        if (!config.statsChannelId) return;
        const channel = await client.channels.fetch(config.statsChannelId);
        await channel.setName(`👥┃𝖴𝗌𝗎𝖺𝗋𝗂𝗈𝗌 𝖠𝗍𝗂𝗏𝗈𝗌: ${Object.keys(database.users).length}`);
    } catch {}
}

async function updateQuestsChannel() {
    try {
        if (!config.questsChannelId) return;
        const channel = await client.channels.fetch(config.questsChannelId);
        await channel.setName(`🏆┃𝖬𝗂𝗌𝗌𝗈̃𝖾𝗌 𝗇𝗈 𝖬𝖾̂𝗌: ${getMonthlyCount()}`);
    } catch {}
}

function setupPresence() {
    const presence   = config.presence ?? {};
    const activities = Array.isArray(presence.activities) && presence.activities.length
        ? presence.activities
        : [{ type: 'Watching', name: 'Discord Quests' }];
    const status   = presence.status ?? 'online';
    const interval = Math.max(10, presence.rotateInterval ?? 30) * 1000;

    let index = 0;
    const apply = () => {
        const act = activities[index % activities.length];
        client.user.setPresence({
            status,
            activities: [{ name: act.name, type: ActivityType[act.type] ?? ActivityType.Watching }]
        });
    };

    apply();
    if (activities.length > 1) setInterval(() => { index++; apply(); }, interval);
}

async function registerSlashCommands() {
    try {
        const rest = new REST({ version: '10' }).setToken(config.botToken);
        await rest.put(Routes.applicationGuildCommands(client.user.id, config.guildId), {
            body: [
                new SlashCommandBuilder()
                    .setName('admin')
                    .setDescription('Gerenciar usuário (apenas dono)')
                    .addStringOption(opt => opt
                        .setName('usuario')
                        .setDescription('@usuário ou ID do Discord')
                        .setRequired(true)
                    )
                    .toJSON()
            ]
        });
    } catch (err) {
        console.error('❌ Erro ao registrar slash commands:', err);
    }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

client.once('clientReady', async () => {
    await loadDatabase();
    await ensureCacheDir();

    for (const userId of Object.keys(database.users)) {
        database.users[userId].premium = isPremiumUser(userId);
    }
    await saveDatabase();

    setupPresence();

    if (!isConfigured(config.channelId)) {
        console.error('❌ Configure o "channelId" no config.json e reinicie.');
        process.exit(1);
    }

    try {
        const channel = await client.channels.fetch(config.channelId);
        await sendPanel(channel);

        if (!isConfigured(config.statsChannelId)) {
            const statsChannel = await channel.guild.channels.create({
                name: '👥┃𝖴𝗌𝗎𝖺𝗋𝗂𝗈𝗌 𝖠𝗍𝗂𝗏𝗈𝗌: 0',
                type: 2,
                permissionOverwrites: [{ id: channel.guild.roles.everyone, deny: ['Connect'], allow: ['ViewChannel'] }]
            });
            config.statsChannelId = statsChannel.id;
            await saveConfig();
        }

        if (!isConfigured(config.questsChannelId)) {
            const questsChannel = await channel.guild.channels.create({
                name: '🏆┃𝖬𝗂𝗌𝗌𝗈̃𝖾𝗌 𝗇𝗈 𝖬𝖾̂𝗌: 0',
                type: 2,
                permissionOverwrites: [{ id: channel.guild.roles.everyone, deny: ['Connect'], allow: ['ViewChannel'] }]
            });
            config.questsChannelId = questsChannel.id;
            await saveConfig();
        }
    } catch (err) {
        console.error('❌ Erro ao configurar painel:', err.message);
        process.exit(1);
    }

    await initPixgg();
    await sendPremiumPanel();
    await updateStatsChannel();
    await updateQuestsChannel();
    renderDashboard();
    await resumeQuestsOnStartup();

    setInterval(renderDashboard, 10000);

    if (isConfigured(config.botToken) && isConfigured(config.guildId)) {
        await registerSlashCommands();
    }

    if (isConfigured(config.listChannelId)) {
        await processQuestListing();
        setInterval(processQuestListing, 300000);
    }
});

client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isChatInputCommand()) {
            if (interaction.commandName === 'admin') await handleAdminCommand(interaction);
            return;
        }

        if (interaction.isButton()) {
            if (interaction.customId === 'premium_adquirir')        return handlePremiumAdquirir(interaction);
            if (interaction.customId.startsWith('admin_'))          return handleAdminButton(interaction);

            if (interaction.customId.startsWith('premium_confirmar_')) {
                const sessionId = interaction.customId.replace('premium_confirmar_', '');
                const session   = premiumSessions.get(sessionId);
                if (!session || session.userId !== interaction.user.id) {
                    return interaction.reply({ content: '❌ Sessão expirada ou inválida.', ephemeral: true });
                }
                premiumSessions.delete(sessionId);
                await interaction.deferUpdate();
                return processPremiumPix(session, interaction);
            }

            if (interaction.customId.startsWith('premium_cancelar_')) {
                const sessionId = interaction.customId.replace('premium_cancelar_', '');
                const session   = premiumSessions.get(sessionId);
                if (!session || session.userId !== interaction.user.id) {
                    return interaction.reply({ content: '❌ Sessão expirada ou inválida.', ephemeral: true });
                }
                premiumSessions.delete(sessionId);
                return interaction.update({
                    embeds: [new EmbedBuilder()
                        .setColor('#ED4245')
                        .setTitle('❌  Compra cancelada')
                        .setDescription('Você cancelou o processo. Clique em **Adquirir Premium** quando quiser tentar novamente.')],
                    components: []
                });
            }

            if (interaction.customId.startsWith('premium_pix_cancel_')) {
                const sessionId = interaction.customId.replace('premium_pix_cancel_', '');
                const session   = pixSessions.get(sessionId);
                if (!session || session.userId !== interaction.user.id) {
                    return interaction.deferUpdate();
                }
                await interaction.deferUpdate();
                return session.cancel();
            }

            switch (interaction.customId) {
                case 'login':      return handleLogin(interaction);
                case 'disconnect': return handleDisconnect(interaction);
                case 'orbs':       return handleOrbs(interaction);
                case 'autoquest':  return handleAutoQuest(interaction);
                default:
                    if (interaction.customId.startsWith('view_decoration_')) {
                        const questId   = interaction.customId.replace('view_decoration_', '');
                        const questData = database.listedQuests[questId] || database.expiredQuests[questId];
                        if (questData?.reward) {
                            await interaction.reply({ embeds: [createDecorationEmbed(questData.reward)], ephemeral: true });
                        } else {
                            await interaction.reply({ content: '❌ Não foi possível encontrar informações sobre esta recompensa.', ephemeral: true });
                        }
                    }
            }
            return;
        }

        if (interaction.isModalSubmit()) {
            if (interaction.customId === 'login_modal') await handleLoginModal(interaction);
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId === 'quest_select') {
            await handleQuestSelect(interaction);
        }
    } catch (err) {
        console.error('Erro ao processar interação:', err);
    }
});

loadConfig().then(() => {
    if (!isConfigured(config.botToken)) {
        console.error('❌ Configure o "botToken" no config.json e reinicie.');
        process.exit(1);
    }
    client.login(config.botToken);
});