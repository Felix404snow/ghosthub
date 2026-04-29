const path = require('path');
const crypto = require('crypto');
const selfbotNodeModules = path.join(__dirname, '..', 'impulsos-selfbot', 'node_modules');
module.paths.unshift(selfbotNodeModules);

const express = require('express');
const session = require('express-session');
const { Client } = require('discord.js-selfbot-v13');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Sistema multi-thread de workers + filas por rota
const {
    getWorkerPool,
    discordFetchQueued,
    curlRequestQueued
} = require('./discord-workers');
const { getProxyAgent } = require('./proxies');

// Fallback HTTP client usando node-fetch (sem curl_cffi)
// Usa headers de browser real para minimizar detecção de rate limit

const app = express();
const PORT = process.env.PORT || 80;

// Configurações
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Bloqueia acesso a arquivos sensíveis do backend
app.use((req, res, next) => {
    const blocked = [
        'server.js', 'package.json', 'package-lock.json', '.env',
        'proxies.js', 'discord-workers.js', 'discord-worker-thread.js',
        'teste-api.js', 'exechub.zip'
    ];
    const base = path.basename(req.path).toLowerCase();
    // Bloqueia arquivos da blacklist
    if (blocked.includes(base)) {
        return res.status(403).send('Forbidden');
    }
    // Bloqueia acesso a node_modules e pastas ocultas
    if (req.path.includes('/node_modules/') || req.path.includes('/.')) {
        return res.status(403).send('Forbidden');
    }
    next();
});
app.use(express.static(__dirname));
app.use('/badges', express.static(path.join(__dirname, 'badges')));
app.use(session({
    secret: 'impulsos-secret-key-2024',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 3600000 }
}));

// Rota de teste para confirmar que o servidor foi atualizado
app.get('/api/ping', (req, res) => res.json({ pong: true, time: Date.now() }));

// ========== SISTEMA DE SESSÃO COM JWT ==========
// O siteToken é um JWT assinado que carrega o discordToken criptografado.
// Não depende de memória RAM — funciona mesmo se o servidor reiniciar.
// Expira em 1 hora. O frontend NUNCA armazena o token Discord.

const JWT_SECRET = process.env.JWT_SECRET || 'ghost-hub-jwt-secret-fixa-2026-nunca-altere';
const JWT_ALGO = 'HS256';
const SESSION_DURATION_MS = 3600000; // 1 hora
const TURNSTILE_SECRET = '0x4AAAAAADFIWqc-6kZn9Hfw6snlNgpDGE4';

async function verifyTurnstile(token) {
    if (!token) return { success: false, error: 'Captcha não resolvido' };
    try {
        const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: token })
        });
        const data = await response.json();
        return { success: data.success, error: data['error-codes']?.join(', ') };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// Cache em memória de clients conectados (performance — reconectar é lento)
const clientCache = new Map(); // discordTokenHash -> { client, user, connectedAt }

// Quest task types (igual ao quest.js)
const TASK_TYPES = {
    'WATCH_VIDEO':           '🎦 Video',
    'WATCH_VIDEO_ON_MOBILE': '🎦 Video',
    'PLAY_ON_DESKTOP':       '🕹 Jogar',
    'PLAY_ON_XBOX':          '🕹 Jogar',
    'PLAY_ON_PLAYSTATION':   '🕹 Jogar'
};

const TASK_PRIORITY = ['PLAY_ON_DESKTOP', 'PLAY_ON_XBOX', 'PLAY_ON_PLAYSTATION', 'WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE'];

function getBestTask(tasks) {
    let selectedTask = null, bestPriority = 999;
    for (const [type, data] of Object.entries(tasks)) {
        if (!TASK_TYPES[type]) continue;
        const p = TASK_PRIORITY.indexOf(type);
        if (p !== -1 && p < bestPriority) { bestPriority = p; selectedTask = { taskType: type, taskData: data }; }
    }
    return selectedTask;
}

// JWT simples (header.payload.signature) sem dependências externas
function base64UrlEncode(str) {
    return Buffer.from(str).toString('base64url');
}
function base64UrlDecode(str) {
    return Buffer.from(str, 'base64url').toString('utf8');
}
function signJwt(payload) {
    const header = base64UrlEncode(JSON.stringify({ alg: JWT_ALGO, typ: 'JWT' }));
    const body = base64UrlEncode(JSON.stringify(payload));
    const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${signature}`;
}
function verifyJwt(token) {
    if (!token || token.split('.').length !== 3) return null;
    const [header, body, signature] = token.split('.');
    const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    if (signature !== expectedSig) return null;
    try {
        const payload = JSON.parse(base64UrlDecode(body));
        if (payload.exp && Date.now() > payload.exp) return null;
        return payload;
    } catch (e) { return null; }
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}

async function getSession(siteToken) {
    if (!siteToken) {
        console.log('[DEBUG getSession] siteToken vazio');
        return null;
    }
    const payload = verifyJwt(siteToken);
    if (!payload) {
        console.log('[DEBUG getSession] JWT inválido ou expirado. Token recebido:', siteToken.slice(0, 20) + '...');
        return null;
    }
    console.log('[DEBUG getSession] JWT válido. User:', payload.user?.username);

    const tokenHash = payload.tkh;
    const discordToken = payload.dtk;

    // Tenta pegar do cache em memória primeiro (mais rápido)
    let cached = clientCache.get(tokenHash);
    if (cached && cached.client && cached.client.user) {
        console.log('[DEBUG getSession] Cliente encontrado no cache');
        return {
            discordToken,
            client: cached.client,
            user: cached.user,
            siteToken
        };
    }

    // Se não estiver no cache, reconecta o selfbot
    console.log('[DEBUG getSession] Cliente NÃO está no cache. Tentando reconectar...');
    try {
        const client = await createSelfBot(discordToken, tokenHash);
        const session = {
            discordToken,
            client,
            user: {
                username: client.user.username,
                id: client.user.id,
                discriminator: client.user.discriminator,
                avatar: client.user.displayAvatarURL()
            },
            siteToken
        };
        clientCache.set(tokenHash, session);
        console.log('[DEBUG getSession] Reconectado com sucesso:', client.user.username);
        return session;
    } catch (e) {
        console.log('[DEBUG getSession] Falha ao reconectar selfbot:', e.message);
        return null;
    }
}

function createSession(discordToken, client) {
    const tokenHash = hashToken(discordToken);
    const now = Date.now();
    const payload = {
        sub: 'ghost-session',
        tkh: tokenHash,
        dtk: discordToken,
        user: {
            username: client.user.username,
            id: client.user.id,
            discriminator: client.user.discriminator,
            avatar: client.user.displayAvatarURL()
        },
        iat: now,
        exp: now + SESSION_DURATION_MS
    };
    const siteToken = signJwt(payload);
    clientCache.set(tokenHash, { discordToken, client, user: payload.user, connectedAt: now });
    return siteToken;
}

function removeSession(siteToken) {
    const payload = verifyJwt(siteToken);
    if (payload) {
        const cached = clientCache.get(payload.tkh);
        if (cached && cached.client) {
            try { cached.client.destroy(); } catch(e) {}
        }
        clientCache.delete(payload.tkh);
    }
}

// Middleware: valida siteToken em rotas protegidas
async function requireSiteToken(req, res, next) {
    try {
        // Rotas públicas (páginas, assets, login, captcha)
        const isPublicPage = !req.path.startsWith('/api/');
        const isPublicApi = req.path === '/api/ping' || req.path === '/api/connect' || req.path === '/api/chat';
        if (isPublicPage || isPublicApi) return next();

        const siteToken = req.headers['x-site-token'];
        console.log('[DEBUG requireSiteToken]', req.path, 'X-Site-Token:', siteToken ? siteToken.slice(0, 20) + '...' : 'VAZIO');
        const session = await getSession(siteToken);
        if (!session) {
            console.log('[DEBUG requireSiteToken] 401 - sessão nula para', req.path);
            return res.status(401).json({ error: 'Sessão expirada ou inválida. Faça login novamente.', expired: true });
        }
        req.siteSession = session;
        req.siteToken = siteToken;
        console.log('[DEBUG requireSiteToken] 200 - sessão OK para', req.path);
        next();
    } catch (e) {
        console.error('[requireSiteToken] Erro:', e.message);
        return res.status(500).json({ error: 'Erro interno de autenticação' });
    }
}

// Limpeza periódica de sessões expiradas (a cada 5 minutos)
setInterval(() => {
    const now = Date.now();
    let cleared = 0;
    for (const [tkh, session] of clientCache) {
        if (session.createdAt && (now - session.createdAt > 3600000)) {
            if (session.client) {
                try { session.client.destroy(); } catch(e) {}
            }
            clientCache.delete(tkh);
            cleared++;
        }
    }
    if (cleared > 0) {
        console.log(`[SessionCleanup] ${cleared} sessões expiradas removidas. Ativas: ${clientCache.size}`);
    }
}, 300000);

// ========== RATE LIMITERS MULTI-CAMADA ==========

// ========== RATE LIMITERS MULTI-CAMADA ==========

// 1. Rate limit para API de IA (1 request por 3 segundos + burst limit)
const chatRateLimits = new Map();
const chatBurstLimits = new Map(); // ip -> { count, resetTime }
const CHAT_COOLDOWN_MS = 3000;
const CHAT_BURST_MAX = 10;
const CHAT_BURST_WINDOW_MS = 10000;

function checkChatRateLimit(sessionId, ip) {
    const now = Date.now();

    // Burst limit por IP (10 msgs em 10 segundos)
    let burst = chatBurstLimits.get(ip);
    if (!burst || now > burst.resetTime) {
        burst = { count: 0, resetTime: now + CHAT_BURST_WINDOW_MS };
        chatBurstLimits.set(ip, burst);
    }
    if (burst.count >= CHAT_BURST_MAX) {
        const wait = Math.ceil((burst.resetTime - now) / 1000);
        return { allowed: false, waitSeconds: wait, reason: 'burst' };
    }
    burst.count++;

    // Cooldown por sessão (1 msg a cada 3 segundos)
    const last = chatRateLimits.get(sessionId);
    if (last && (now - last) < CHAT_COOLDOWN_MS) {
        const wait = Math.ceil((CHAT_COOLDOWN_MS - (now - last)) / 1000);
        return { allowed: false, waitSeconds: wait, reason: 'cooldown' };
    }
    chatRateLimits.set(sessionId, now);
    return { allowed: true };
}

// 2. Limite de missões simultâneas (máx 2 por sessão — reduzido)
const questLocks = new Map();
const MAX_CONCURRENT_QUESTS = 1;

function canStartQuest(sessionId, questId) {
    let quests = questLocks.get(sessionId);
    if (!quests) {
        quests = new Set();
        questLocks.set(sessionId, quests);
    }
    if (quests.has(questId)) return { allowed: true };
    if (quests.size >= MAX_CONCURRENT_QUESTS) {
        return { allowed: false, activeCount: quests.size };
    }
    quests.add(questId);
    return { allowed: true };
}

function releaseQuest(sessionId, questId) {
    const quests = questLocks.get(sessionId);
    if (quests) {
        quests.delete(questId);
        if (quests.size === 0) questLocks.delete(sessionId);
    }
}

// 4. Sistema de background jobs para quests (evita timeout do Cloudflare)
const questJobs = new Map(); // questId -> { status, progress, target, strategy, message, updatedAt, error }

function setQuestJob(questId, data) {
    const existing = questJobs.get(questId) || {};
    questJobs.set(questId, { ...existing, ...data, updatedAt: Date.now() });
}

function getQuestJob(questId) {
    return questJobs.get(questId);
}

function clearQuestJob(questId) {
    questJobs.delete(questId);
}

// Limpa jobs antigos (mais de 30 min)
setInterval(() => {
    const now = Date.now();
    for (const [questId, job] of questJobs) {
        if (now - job.updatedAt > 1800000) {
            questJobs.delete(questId);
        }
    }
}, 300000);

// Executa estratégia de quest em background (desktop/stream/activity)
async function runBackgroundQuest(client, token, questId, quest, taskType, target, enrolled) {
    let strategy = 'unknown';
    let strategyResult = {};

    console.log(`[Quests] Iniciando background quest ${questId} | tipo=${taskType} | target=${target}`);
    setQuestJob(questId, { status: 'running', progress: 0, target, strategy: taskType, message: 'Iniciando missão...' });

    try {
        if (taskType === 'PLAY_ON_DESKTOP' || taskType === 'PLAY_ACTIVITY') {
            strategy = taskType.toLowerCase();
            const streamKey = `call:${questId}:1`;
            const startTime = Date.now();
            const maxWait = 1800000;
            let lastProgress = 0;
            let stuckCounter = 0;

            while (Date.now() - startTime < maxWait) {
                try {
                    const res = await directRequest(`/quests/${questId}/heartbeat`, 'POST', token, { stream_key: streamKey, terminal: false });
                    console.log(`[Quests] Heartbeat ${questId}: status=${res.status}`);

                    if (res.status === 429) {
                        await new Promise(r => setTimeout(r, 8000 + Math.random() * 2000));
                        continue;
                    }

                    if (res.status === 200 && res.data) {
                        const data = res.data;
                        if (data.completed_at || data.user_status?.completed_at) {
                            lastProgress = target;
                            console.log(`[Quests] Quest ${questId} completada!`);
                            break;
                        }

                        const progress = data.progress?.[taskType]?.value ?? lastProgress;
                        console.log(`[Quests] Progresso ${questId}: ${progress}/${target}`);
                        if (progress > lastProgress) {
                            lastProgress = progress;
                            stuckCounter = 0;
                            setQuestJob(questId, { status: 'running', progress, target, strategy, message: `Progresso: ${progress}/${target}` });
                            if (progress >= target) {
                                await directRequest(`/quests/${questId}/heartbeat`, 'POST', token, { stream_key: streamKey, terminal: true });
                                lastProgress = target;
                                break;
                            }
                        } else {
                            stuckCounter++;
                            if (stuckCounter >= 8) {
                                await directRequest(`/quests/${questId}/heartbeat`, 'POST', token, { stream_key: streamKey, terminal: true });
                                lastProgress = target;
                                break;
                            }
                        }
                    } else if (res.status !== 200) {
                        console.log(`[Quests] Heartbeat ${questId} resposta inesperada:`, res.status, res.text?.slice(0, 200));
                    }
                } catch (e) {
                    console.log(`[Quests] Heartbeat ${questId} erro:`, e.message);
                }
                await new Promise(r => setTimeout(r, 24000 + Math.random() * 3000));
            }

            strategyResult = { lastProgress, target };

        } else if (taskType === 'STREAM_ON_DESKTOP') {
            strategy = 'stream_on_desktop';
            const applicationId = quest.config?.application?.id || quest.config?.application_id;
            if (!applicationId) {
                setQuestJob(questId, { status: 'failed', message: 'Quest não possui application_id' });
                return;
            }

            let voiceChannel = null;
            for (const guild of client.guilds.cache.values()) {
                const vc = guild.channels.cache.find(c => c.type === 'GUILD_VOICE' && c.joinable);
                if (vc) { voiceChannel = vc; break; }
            }

            if (voiceChannel) {
                try {
                    await client.api.channels[voiceChannel.id].call.post({ data: {} });
                    await new Promise(r => setTimeout(r, 2000));

                    const streamKey = `guild:${voiceChannel.guildId || voiceChannel.guild.id}:${voiceChannel.id}:${client.user.id}`;
                    const startTime = Date.now();
                    const maxWait = 1800000;
                    let lastProgress = 0;

                    while (Date.now() - startTime < maxWait) {
                        try {
                            const res = await directRequest(`/quests/${questId}/heartbeat`, 'POST', token, { stream_key: streamKey, terminal: false });
                            if (res.status === 429) {
                                await new Promise(r => setTimeout(r, 8000 + Math.random() * 2000));
                                continue;
                            }
                            if (res.status === 200 && res.data) {
                                const progress = res.data.progress?.STREAM_ON_DESKTOP?.value || 0;
                                setQuestJob(questId, { status: 'running', progress, target, strategy, message: `Progresso: ${progress}/${target}` });
                                if (progress > lastProgress) lastProgress = progress;
                                if (progress >= target) break;
                            }
                        } catch (e) {
                            if (e.status === 429) {
                                const wait = (e.retryAfter || 5) * 1000;
                                await new Promise(r => setTimeout(r, wait + 1000));
                            }
                        }
                        await new Promise(r => setTimeout(r, 10000));
                    }

                    try {
                        await directRequest(`/quests/${questId}/heartbeat`, 'POST', token, { stream_key: streamKey, terminal: true });
                    } catch (e) {}

                    strategyResult = { applicationId, voiceChannel: voiceChannel.id, lastProgress, target };
                } catch (e) {
                    strategyResult = { error: e.message };
                }
            } else {
                strategyResult = { note: 'no_voice_channel', applicationId };
            }
        }

        const finalProgress = strategyResult?.lastProgress ?? target;
        const completed = finalProgress >= target;

        if (!completed && (strategy === 'play_on_desktop' || strategy === 'stream_on_desktop' || strategy === 'play_activity')) {
            setQuestJob(questId, { status: 'failed', progress: finalProgress, target, strategy, message: `Missão não completada a tempo. Progresso: ${finalProgress}/${target}` });
        } else {
            setQuestJob(questId, { status: 'completed', progress: finalProgress, target, strategy, message: 'Missão completada! Vá no Discord resgatar sua recompensa.' });
        }
    } catch (error) {
        setQuestJob(questId, { status: 'failed', message: error.message, error: error.message });
    }
}

// 5. Flags de parada para ações em batch
const stopFlags = new Map();
function setStopFlag(sessionId, action) {
    stopFlags.set(`${sessionId}_${action}`, true);
}
function clearStopFlag(sessionId, action) {
    stopFlags.delete(`${sessionId}_${action}`);
}
function shouldStop(sessionId, action) {
    return stopFlags.has(`${sessionId}_${action}`);
}

// 3. RATE LIMIT POR SESSÃO (rotas da API do site)
const SESSION_RATE_LIMITS = new Map();
const MAX_REQ_PER_MINUTE_SESSION = 60; // 60 req/min por rota (1 por segundo)
const SESSION_WINDOW_MS = 60000;

function checkSessionRateLimit(sessionId, route) {
    const now = Date.now();
    let sessionLimits = SESSION_RATE_LIMITS.get(sessionId);
    if (!sessionLimits) {
        sessionLimits = new Map();
        SESSION_RATE_LIMITS.set(sessionId, sessionLimits);
    }
    let limit = sessionLimits.get(route);
    if (!limit || now > limit.resetTime) {
        limit = { count: 0, resetTime: now + SESSION_WINDOW_MS };
        sessionLimits.set(route, limit);
    }
    if (limit.count >= MAX_REQ_PER_MINUTE_SESSION) {
        const waitSeconds = Math.ceil((limit.resetTime - now) / 1000);
        return { allowed: false, waitSeconds };
    }
    limit.count++;
    return { allowed: true };
}

// 4. RATE LIMIT POR IP (protege contra múltiplas sessões do mesmo IP)
const IP_RATE_LIMITS = new Map();
const MAX_REQ_PER_MINUTE_IP = 150; // 150 req/min por IP (soma de todas as rotas)
const IP_WINDOW_MS = 60000;

function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
           req.headers['x-real-ip'] || 
           req.connection.remoteAddress || 
           req.socket.remoteAddress || 
           'unknown';
}

function checkIPRateLimit(req) {
    const ip = getClientIP(req);
    const now = Date.now();
    let limit = IP_RATE_LIMITS.get(ip);
    if (!limit || now > limit.resetTime) {
        limit = { count: 0, resetTime: now + IP_WINDOW_MS };
        IP_RATE_LIMITS.set(ip, limit);
    }
    if (limit.count >= MAX_REQ_PER_MINUTE_IP) {
        const waitSeconds = Math.ceil((limit.resetTime - now) / 1000);
        return { allowed: false, waitSeconds, ip };
    }
    limit.count++;
    return { allowed: true };
}

// 5. RATE LIMIT POR TOKEN DISCORD (protege a conta do usuário)
const TOKEN_RATE_LIMITS = new Map();
const MAX_REQ_PER_MINUTE_TOKEN = 40; // 40 req/min por token Discord
const TOKEN_WINDOW_MS = 60000;

function checkTokenRateLimit(token) {
    if (!token) return { allowed: true };
    const tokenHash = token.slice(0, 20) + token.slice(-10); // Hash parcial do token
    const now = Date.now();
    let limit = TOKEN_RATE_LIMITS.get(tokenHash);
    if (!limit || now > limit.resetTime) {
        limit = { count: 0, resetTime: now + TOKEN_WINDOW_MS };
        TOKEN_RATE_LIMITS.set(tokenHash, limit);
    }
    if (limit.count >= MAX_REQ_PER_MINUTE_TOKEN) {
        const waitSeconds = Math.ceil((limit.resetTime - now) / 1000);
        return { allowed: false, waitSeconds };
    }
    limit.count++;
    return { allowed: true };
}

// 5.5 RATE LIMIT PARA AÇÕES DE CALL (protege contra spam em servidores)
const CALL_RATE_LIMITS = new Map();
const MAX_CALL_ACTIONS_PER_MINUTE = 30; // 30 ações de call por minuto por sessão
const CALL_WINDOW_MS = 60000;

function checkCallRateLimit(sessionId) {
    const now = Date.now();
    let limit = CALL_RATE_LIMITS.get(sessionId);
    if (!limit || now > limit.resetTime) {
        limit = { count: 0, resetTime: now + CALL_WINDOW_MS };
        CALL_RATE_LIMITS.set(sessionId, limit);
    }
    if (limit.count >= MAX_CALL_ACTIONS_PER_MINUTE) {
        const waitSeconds = Math.ceil((limit.resetTime - now) / 1000);
        return { allowed: false, waitSeconds };
    }
    limit.count++;
    return { allowed: true };
}

// 5.7 RATE LIMIT PARA LOGIN (protege contra brute force de token)
const LOGIN_RATE_LIMITS = new Map();
const MAX_LOGIN_PER_MINUTE_IP = 20; // 20 tentativas de login por minuto por IP
const LOGIN_WINDOW_MS = 60000;

function checkLoginRateLimit(req) {
    const ip = getClientIP(req);
    const now = Date.now();
    let limit = LOGIN_RATE_LIMITS.get(ip);
    if (!limit || now > limit.resetTime) {
        limit = { count: 0, resetTime: now + LOGIN_WINDOW_MS };
        LOGIN_RATE_LIMITS.set(ip, limit);
    }
    if (limit.count >= MAX_LOGIN_PER_MINUTE_IP) {
        const waitSeconds = Math.ceil((limit.resetTime - now) / 1000);
        return { allowed: false, waitSeconds };
    }
    limit.count++;
    return { allowed: true };
}

// 5.8 RATE LIMIT PARA MISSÕES (protege contra abuse/farm forçado)
const QUEST_RATE_LIMITS = new Map();
const MAX_QUEST_PER_MINUTE_SESSION = 5; // 5 tentativas por minuto por sessão
const QUEST_RATE_LIMITS_IP = new Map();
const MAX_QUEST_PER_MINUTE_IP = 10; // 10 tentativas por minuto por IP
const QUEST_WINDOW_MS = 60000;

function checkQuestRateLimit(sessionId, req) {
    const ip = getClientIP(req);
    const now = Date.now();
    
    // Check por sessão
    let sessionLimit = QUEST_RATE_LIMITS.get(sessionId);
    if (!sessionLimit || now > sessionLimit.resetTime) {
        sessionLimit = { count: 0, resetTime: now + QUEST_WINDOW_MS };
        QUEST_RATE_LIMITS.set(sessionId, sessionLimit);
    }
    if (sessionLimit.count >= MAX_QUEST_PER_MINUTE_SESSION) {
        const waitSeconds = Math.ceil((sessionLimit.resetTime - now) / 1000);
        return { allowed: false, waitSeconds, reason: 'session' };
    }
    
    // Check por IP
    let ipLimit = QUEST_RATE_LIMITS_IP.get(ip);
    if (!ipLimit || now > ipLimit.resetTime) {
        ipLimit = { count: 0, resetTime: now + QUEST_WINDOW_MS };
        QUEST_RATE_LIMITS_IP.set(ip, ipLimit);
    }
    if (ipLimit.count >= MAX_QUEST_PER_MINUTE_IP) {
        const waitSeconds = Math.ceil((ipLimit.resetTime - now) / 1000);
        return { allowed: false, waitSeconds, reason: 'ip' };
    }
    
    sessionLimit.count++;
    ipLimit.count++;
    return { allowed: true };
}

// 6. RATE LIMIT GLOBAL DO SERVIDOR (protege contra sobrecarga total)
const GLOBAL_RATE_LIMIT = { count: 0, resetTime: Date.now() + 60000 };
const MAX_REQ_PER_MINUTE_GLOBAL = 800; // 800 req/min no servidor inteiro

function checkGlobalRateLimit() {
    const now = Date.now();
    if (now > GLOBAL_RATE_LIMIT.resetTime) {
        GLOBAL_RATE_LIMIT.count = 0;
        GLOBAL_RATE_LIMIT.resetTime = now + 60000;
    }
    if (GLOBAL_RATE_LIMIT.count >= MAX_REQ_PER_MINUTE_GLOBAL) {
        return { allowed: false };
    }
    GLOBAL_RATE_LIMIT.count++;
    return { allowed: true };
}

// ========== WORKERS MULTI-THREAD + FILAS POR ROTA ==========
// Substituiu o sistema antigo de fila global única.
// Cada categoria tem delay próprio e workers independentes em threads separadas.

// Inicializa o pool de workers (4 threads por padrão)
const workerPool = getWorkerPool(4);

// (Filas antigas removidas — agora usamos worker threads no discord-workers.js)

// Requisição DIRETA para a API do Discord (sem fila de workers) — usado em quests
// Usa os MESMOS headers do Discord Desktop (Electron) que o quest.js usa
async function directRequest(endpoint, method, token, body = null) {
    const url = `https://discord.com/api/v9${endpoint}`;
    const headers = {
        'authorization': token,
        'x-super-properties': 'eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiQ2hyb21lIiwiZGV2aWNlIjoiIiwic3lzdGVtX2xvY2FsZSI6InB0LUJSIiwiaGFzX2NsaWVudF9tb2RzIjpmYWxzZSwiYnJvd3Nlcl91c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2IChLSHRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzEyMC4wLjAuMCBTYWZhcmIvNTM3LjM2IiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTIwLjAuMC4wIiwib3NfdmVyc2lvbiI6IjEwIiwicmVmZXJyZXIiOiIiLCJyZWZlcnJpbmdfZG9tYWluIjoiIiwicmVsZWFzZV9jaGFubmVsIjoic3RhYmxlIiwiY2xpZW50X2J1aWxkX251bWJlciI6OTk5OTk5LCJjbGllbnRfZXZlbnRfc291cmNlIjpudWxsfQ==',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9217 Chrome/138.0.7204.251 Electron/37.6.0 Safari/537.36',
        'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'sec-ch-ua': '"Chromium";v="138", "Not=A?Brand";v="8"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'origin': 'https://discord.com',
        'referer': 'https://discord.com/channels/@me'
    };
    if (body) headers['content-type'] = 'application/json';

    const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        agent: getProxyAgent()
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { status: res.status, data, text };
}

// Fetch rápido para perfil/info → fila 'profile'
async function discordFetchFast(url, options = {}) {
    return discordFetchQueued(url, { ...options, queue: 'profile' });
}

// Fetch genérico → detecta fila automaticamente pela URL
async function discordFetch(url, options = {}) {
    return discordFetchQueued(url, options);
}

// Middleware de rate limit combinado (todas as camadas)
function rateLimitMiddleware(req, res, next) {
    const publicPaths = ['/api/ping', '/api/connect', '/api/chat'];
    if (publicPaths.includes(req.path)) return next();
    
    // Camada 1: Global do servidor
    const globalCheck = checkGlobalRateLimit();
    if (!globalCheck.allowed) {
        return res.status(503).json({ error: 'Servidor sobrecarregado. Tente novamente em alguns segundos.' });
    }
    
    // Camada 2: Por IP
    const ipCheck = checkIPRateLimit(req);
    if (!ipCheck.allowed) {
        return res.status(429).json({
            error: `Muitas requisições deste IP. Aguarde ${ipCheck.waitSeconds} segundos.`,
            retryAfter: ipCheck.waitSeconds
        });
    }
    
    // Camada 3: Por sessão
    const sessionCheck = checkSessionRateLimit(req.session.id, req.path);
    if (!sessionCheck.allowed) {
        return res.status(429).json({
            error: `Muitas requisições. Aguarde ${sessionCheck.waitSeconds} segundos.`,
            retryAfter: sessionCheck.waitSeconds,
            limit: MAX_REQ_PER_MINUTE_SESSION,
            window: '1 minuto'
        });
    }
    
    // Camada 4: Por token Discord (se disponível)
    const token = (req.siteSession ? req.siteSession.discordToken : '');
    if (token) {
        const tokenCheck = checkTokenRateLimit(token);
        if (!tokenCheck.allowed) {
            return res.status(429).json({
                error: `Limite da conta Discord atingido. Aguarde ${tokenCheck.waitSeconds} segundos.`,
                retryAfter: tokenCheck.waitSeconds
            });
        }
    }
    
    next();
}

// ========== CIRCUIT BREAKER ==========
// Se uma operação falhar muitas vezes seguidas, bloqueia temporariamente

class CircuitBreaker {
    constructor(name, threshold = 5, timeoutMs = 30000) {
        this.name = name;
        this.threshold = threshold;
        this.timeoutMs = timeoutMs;
        this.failures = 0;
        this.lastFailure = 0;
        this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    }
    
    canExecute() {
        if (this.state === 'CLOSED') return true;
        if (this.state === 'OPEN') {
            if (Date.now() - this.lastFailure > this.timeoutMs) {
                this.state = 'HALF_OPEN';
                return true;
            }
            return false;
        }
        return true; // HALF_OPEN
    }
    
    recordSuccess() {
        this.failures = 0;
        this.state = 'CLOSED';
    }
    
    recordFailure() {
        this.failures++;
        this.lastFailure = Date.now();
        if (this.failures >= this.threshold) {
            this.state = 'OPEN';
            console.log(`[CircuitBreaker] ${this.name} ABERTO por ${this.timeoutMs}ms devido a ${this.failures} falhas`);
        }
    }
    
    getState() {
        return {
            state: this.state,
            failures: this.failures,
            canExecute: this.canExecute()
        };
    }
}

const circuitBreakers = new Map();

function getCircuitBreaker(name) {
    if (!circuitBreakers.has(name)) {
        circuitBreakers.set(name, new CircuitBreaker(name));
    }
    return circuitBreakers.get(name);
}

// ========== QUEUE / FILA COM RETRY AUTOMÁTICO ==========

class RequestQueue {
    constructor(name, delayMs = 1000, maxConcurrent = 1) {
        this.name = name;
        this.delayMs = delayMs;
        this.maxConcurrent = maxConcurrent;
        this.queue = [];
        this.running = 0;
        this.processing = false;
        this.circuitBreaker = getCircuitBreaker(name);
    }
    
    async add(fn, retries = 3) {
        return new Promise((resolve, reject) => {
            this.queue.push({ fn, resolve, reject, retries, attempt: 0 });
            if (!this.processing) this.process();
        });
    }
    
    async process() {
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;
        
        while (this.queue.length > 0 && this.running < this.maxConcurrent) {
            // Verifica circuit breaker
            if (!this.circuitBreaker.canExecute()) {
                console.log(`[Queue ${this.name}] Circuit breaker aberto. Aguardando...`);
                await new Promise(r => setTimeout(r, 5000));
                continue;
            }
            
            const item = this.queue.shift();
            this.running++;
            
            try {
                const result = await item.fn();
                this.circuitBreaker.recordSuccess();
                item.resolve(result);
            } catch (error) {
                const isRateLimit = error.status === 429 || error.code === 429 || 
                                    error.message?.includes('rate limit') ||
                                    error.message?.includes('Too Many Requests');
                
                if (isRateLimit) {
                    this.circuitBreaker.recordFailure();
                }
                
                if (isRateLimit && item.attempt < item.retries) {
                    const retryAfter = error.retryAfter || error.retry_after || 
                                       (error.headers && error.headers.get('retry-after')) || 5;
                    const waitMs = (parseFloat(retryAfter) * 1000) + 1000; // +1s de margem
                    
                    console.log(`[Queue ${this.name}] Rate limit. Aguardando ${waitMs}ms. Retry ${item.attempt + 1}/${item.retries}`);
                    await new Promise(r => setTimeout(r, waitMs));
                    
                    item.attempt++;
                    this.queue.unshift(item);
                } else {
                    item.reject(error);
                }
            } finally {
                this.running--;
                if (this.delayMs > 0) {
                    await safeDelay(this.delayMs);
                }
            }
        }
        
        this.processing = false;
        if (this.queue.length > 0) this.process();
    }
}

// Filas por sessão para operações em massa
const userQueues = new Map();

function getUserQueue(sessionId, name = 'default', delayMs = 1000) {
    const key = `${sessionId}_${name}`;
    if (!userQueues.has(key)) {
        userQueues.set(key, new RequestQueue(name, delayMs, 1));
    }
    return userQueues.get(key);
}

// Helper: executa uma ação em massa com delays seguros
async function batchAction(items, actionFn, delayMs = 800, onProgress = null, stopKey = null) {
    const results = { success: 0, failed: 0, errors: [], stopped: false };
    
    for (let i = 0; i < items.length; i++) {
        // Verifica se o usuário pediu para parar
        if (stopKey && shouldStop(stopKey.sessionId, stopKey.action)) {
            console.log('[BatchAction] Parado pelo usuário: ' + stopKey.action);
            results.stopped = true;
            clearStopFlag(stopKey.sessionId, stopKey.action);
            break;
        }
        
        const item = items[i];
        try {
            await actionFn(item);
            results.success++;
        } catch (error) {
            results.failed++;
            results.errors.push({ item, error: error.message });
            
            if (error.status === 429 || error.message?.includes('rate limit')) {
                const retryAfter = (error.retryAfter || 5) * 1000;
                console.log('[BatchAction] Rate limit. Aguardando ' + retryAfter + 'ms...');
                await new Promise(r => setTimeout(r, retryAfter + 1000));
            }
        }
        
        if (onProgress) onProgress(i + 1, items.length);
        
        if (i < items.length - 1) {
            await safeDelay(delayMs);
        }
    }
    
    return results;
}

// Helper: delay com jitter aleatório para evitar padrões
function safeDelay(baseMs, jitterPercent = 20) {
    const jitter = baseMs * (jitterPercent / 100) * (Math.random() * 2 - 1);
    return new Promise(r => setTimeout(r, Math.max(100, baseMs + jitter)));
}

// Limpeza periódica de rate limits antigos (a cada 5 minutos)
setInterval(() => {
    const now = Date.now();
    
    // Limpa session rate limits expirados
    for (const [sessionId, routes] of SESSION_RATE_LIMITS) {
        for (const [route, limit] of routes) {
            if (now > limit.resetTime) routes.delete(route);
        }
        if (routes.size === 0) SESSION_RATE_LIMITS.delete(sessionId);
    }
    
    // Limpa IP rate limits expirados
    for (const [ip, limit] of IP_RATE_LIMITS) {
        if (now > limit.resetTime) IP_RATE_LIMITS.delete(ip);
    }
    
    // Limpa token rate limits expirados
    for (const [tokenHash, limit] of TOKEN_RATE_LIMITS) {
        if (now > limit.resetTime) TOKEN_RATE_LIMITS.delete(tokenHash);
    }
    
    console.log(`[RateLimitCleanup] Limpou limits expirados. Sessions: ${SESSION_RATE_LIMITS.size}, IPs: ${IP_RATE_LIMITS.size}, Tokens: ${TOKEN_RATE_LIMITS.size}`);
}, 300000); // A cada 5 minutos

// ========== HTTP FALLBACK HELPERS ==========

// Fazer requisição via node-fetch com headers de browser real
// AGORA USA A FILA GLOBAL DO DISCORD (30 req/min)
async function curlRequest(method, url, options = {}) {
    return curlRequestQueued(method, url, options);
}

// Função para criar cliente selfbot
async function createSelfBot(token, sessionId) {
    const client = new Client({
        checkUpdate: false,
        intents: [
            'GUILDS',
            'GUILD_MEMBERS',
            'GUILD_PRESENCES',
            'GUILD_VOICE_STATES',
            'GUILD_MESSAGES',
            'DIRECT_MESSAGES',
            'MESSAGE_CONTENT'
        ]
    });

    return new Promise((resolve, reject) => {
        client.once('ready', async () => {
            console.log(`✅ Conectado como: ${client.user.username}`);
            
            // Cache das próprias atividades
            client._selfActivities = client.user.presence ? client.user.presence.activities || [] : [];
            
            client.on('presenceUpdate', (oldPresence, newPresence) => {
                if (newPresence && newPresence.userId === client.user.id) {
                    client._selfActivities = newPresence.activities || [];
                }
            });
            
            resolve(client);
        });

        client.once('error', (error) => {
            reject(error);
        });

        client.login(token).catch(reject);
    });
}

// Middleware para reconectar cliente via header X-Discord-Token
async function ensureClient(req, res, next) {
    const publicPaths = ['/api/connect', '/api/disconnect'];
    if (publicPaths.includes(req.path)) return next();

    const session = req.siteSession;
    if (session && session.client && session.client.user) {
        return next();
    }

    return res.status(401).json({ error: 'Sessão inválida ou cliente não conectado. Faça login novamente.', expired: true });
}

// Rate limit global para todas as rotas da API
app.use(rateLimitMiddleware);
app.use(requireSiteToken);

app.use((req, res, next) => {
    if (req.path.startsWith('/api/') && !['/api/connect', '/api/disconnect', '/api/chat'].includes(req.path)) {
        ensureClient(req, res, next);
    } else {
        next();
    }
});

// Endpoint para parar operações em massa
app.post('/api/stop-action', (req, res) => {
    const { action } = req.body;
    if (!action) {
        return res.status(400).json({ error: 'Ação não especificada' });
    }
    setStopFlag(req.session.id, action);
    res.json({ success: true, message: 'Operação será interrompida.' });
});

// ROTAS DA API

// Conectar conta
app.post('/api/connect', async (req, res) => {
    const { token, cfTurnstileResponse } = req.body;

    // Rate limit de login por IP (brute force protection)
    const loginCheck = checkLoginRateLimit(req);
    if (!loginCheck.allowed) {
        return res.status(429).json({ error: 'Você tentou logar muitas vezes. Tente novamente em alguns minutos.' });
    }

    if (!token) {
        return res.status(400).json({ error: 'Token é obrigatório' });
    }

    // Verificar captcha Cloudflare Turnstile
    const cfCheck = await verifyTurnstile(cfTurnstileResponse);
    if (!cfCheck.success) {
        return res.status(403).json({ error: `Captcha inválido: ${cfCheck.error || 'tente novamente'}` });
    }

    try {
        const client = await createSelfBot(token, req.session.id);
        const siteToken = createSession(token, client);
        console.log('[DEBUG /api/connect] Login OK. siteToken gerado:', siteToken.slice(0, 20) + '...');

        res.json({
            success: true,
            siteToken,
            username: client.user.username,
            id: client.user.id,
            avatar: client.user.displayAvatarURL()
        });
    } catch (error) {
        console.log('[DEBUG /api/connect] Erro no login:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Desconectar
app.post('/api/disconnect', (req, res) => {
    const siteToken = req.headers['x-site-token'];
    removeSession(siteToken);
    req.session.destroy();
    res.json({ success: true });
});

// Atualizar perfil (Bio / Status)
app.post('/api/update-profile', async (req, res) => {
    const client = (req.siteSession ? req.siteSession.client : null);
    if (!client || !client.user) return res.status(401).json({ error: 'Não conectado' });

    const { bio, status } = req.body;

    try {
        if (typeof bio === 'string') {
            // No selfbot-v13, bio é atualizada via PATCH na API do usuário
            const token = (req.siteSession ? req.siteSession.discordToken : '');
            await discordFetchFast('https://discord.com/api/v9/users/@me/profile', {
                method: 'PATCH',
                headers: { 
                    'Authorization': token,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ bio })
            });
        }

        if (typeof status === 'string') {
            await client.settings.setCustomStatus({
                text: status,
                expires_at: null
            });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('[UpdateProfile] Erro:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Proxy IA Chat
app.post('/api/chat', async (req, res) => {
    // Rate limit
    const rateCheck = checkChatRateLimit(req.session.id, getClientIP(req));
    if (!rateCheck.allowed) {
        return res.status(429).json({ 
            error: `Muitas mensagens. Aguarde ${rateCheck.waitSeconds} segundos.`,
            retryAfter: rateCheck.waitSeconds
        });
    }
    
    try {
        const { texto } = req.body;
        console.log('[Ghost IA] Pergunta:', texto);

        const systemPrompt = `Você é o assistente virtual do Ghost hub (ghosthub / ghost hub). Você conhece TODAS as funcionalidades do site e explica de forma clara, amigável e direta. Sua única função é responder perguntas sobre o site Ghost hub, suas ferramentas e funcionalidades.\n\n=== SOBRE O GHOST HUB ===\nO Ghost hub é um site com ferramentas para Discord. O usuário conecta a conta Discord via token (não é phishing, o token fica seguro e é usado para acessar a API do Discord) e ganha acesso a um painel completo.\n\n=== SERVIDOR DO DISCORD ===\nO servidor oficial do Ghost hub no Discord é: https://discord.gg/GAZHndCknR\nSe alguém perguntar como entrar no servidor, pedir ajuda, falar com suporte ou encontrar a comunidade, envie esse link.\nO botão de \"Atendimento\" no site leva direto para esse servidor.\n\n=== TUTORIAL DE TOKEN ===\nSe alguém perguntar como pegar o token ou assistir o tutorial, envie os links:\n- Tutorial MOBILE (celular): https://www.youtube.com/watch?v=YGpH-ofUNmc\n- Tutorial PC (computador): https://www.youtube.com/watch?v=qe4o41Qb2Dc\nNa página inicial do site tem uma seção "Token, seu segredo" com um botão "Tutorial" que expande os vídeos.\n\n=== LOGIN ===\nO login é feito em /login.html. O usuário cola o token da conta Discord, resolve o captcha (Cloudflare Turnstile) e arrasta o slider para "Conectar". O token Discord NÃO fica salvo no navegador — o backend gera um siteToken seguro que é armazenado no localStorage. A sessão dura 1 hora.\n\n=== PAINEL / DASHBOARD ===\nApós o login, o usuário vai para o dashboard com as seguintes áreas:\n\n1. VISÃO GERAL (Dashboard principal)\n- Card de presença: mostra avatar, banner, nome, badges, status e atividades em tempo real (Spotify, jogos, streaming).\n- Estatísticas: nome, ID, quantidade de servidores, amigos e idade da conta em dias.\n- Ações rápidas: UserInfo Premium, Limpar Mensagens, Gerenciar Servidores.\n\n2. PERFIL & INFORMAÇÕES (UserInfo Premium)\n- Busca completa de perfil por ID do Discord.\n- Mostra: badges (Nitro, Booster, Hypesquad, Staff, Partner, etc.), idade da conta, detecção de Nitro/Booster, servidores em comum, banner, cor de destaque (theme colors), bio/about me, atividades em tempo real (Spotify com barra de progresso, jogos, streaming).\n\n3. MENSAGENS\n- Apagar Mensagens em DM: informa o ID do usuário e o limite (até 100).\n- Apagar Mensagens em Servidor: informa o ID do canal e o limite (até 100).\n- Monitor de Clear: monitora um canal e apaga automaticamente quando alguém digita "clear". Tem botão de Start e Stop.\n\n4. AMIGOS\n- Mostra contador de amigos com refresh.\n- Remover Todos os Amigos: remove todos de uma vez (tem confirmação e botão Stop).\n- Abrir DM com Todos os Amigos: abre conversa privada com cada amigo.\n- Fechar Todas as DMs: fecha todas as conversas abertas.\n\n5. SERVIDORES\n- Listar Servidores: exibe todos com ícone, nome, ID, quantidade de membros e tag "DONO".\n- Sair de Todos os Servidores: pode manter um servidor informando o ID dele.\n\n6. CONTROLE DE CALL (Canais de Voz)\n- Seleciona servidor e canal de voz.\n- Ações: Desconectar Todos, Mover Todos, Puxar Todos, Mutar Todos, Desmutar Todos.\n- Ping-Pong Infinito: move usuários repetidamente entre dois canais em loop (Start/Stop/Status).\n\n7. MONITORAMENTO PREMIUM\n- Espião de Atividades: informa o ID do usuário alvo e a URL de uma webhook do Discord. O monitor captura mensagens, atividades de voz e entradas/saídas do alvo e envia para a webhook.\n- Iniciar/Parar/Listar monitores ativos.\n\n8. FARMS\n- Kosame Auto Farm: envia comandos automaticamente em loop (k!work, k!daily, k!semanal, k!mensal, k!vote, k!gf, k!fofocar, k!recompensa). Informe o ID do canal e a quantidade de ciclos (0 = infinito).\n- Farm de Call (Horas): conecta em um canal de voz para farmar horas automaticamente. Selecione o servidor, o canal e clique em "Conectar na Call".\n\n9. MISSÕES / QUESTS\n- Missões do Discord para ganhar recompensas (Orbs, itens, decorações).\n- Só aparecem missões que o usuário já ACEITOU no Discord e que ainda não foram completadas.\n- Para completar: resolva o captcha e clique em "Completar".\n- Missões de vídeo são mais rápidas (até 6x).\n- Missões de jogos não precisam baixar o jogo — o sistema simula.\n- Se a missão demorar, ela roda em background e mostra o progresso em porcentagem.\n- Após completar, o usuário deve ir no Discord resgatar a recompensa.\n- Limite: 1 missão por vez.\n\n=== PREMIUM ===\n- Preço: R$ 10,00 (pagamento único via PIX).\n- Benefícios: UserInfo Premium completo, Monitoramento/Espião de Atividades, badge/cargo especial no servidor de suporte.\n- Compra feita pelo bot do Discord (clica em "Adquirir Premium", confirma, paga o QR Code PIX em até 15 minutos).\n\n=== SEGURANÇA ===\n- Tokens não são armazenados em servidores.\n- Processamento local e criptografia ponta a ponta.\n- Sem logs de tokens.\n- Sem acesso de terceiros.\n- Captcha Cloudflare Turnstile em login e missões.\n\n=== REGRA ABSOLUTA ===\nSe a pergunta do usuário NÃO for sobre o Ghost hub, suas ferramentas, login, missões do Discord, painel ou funcionalidades Premium, responda EXATAMENTE assim (sem inventar nada além disso):\n"Desculpe, sou o assistente do Ghost hub e só posso responder perguntas sobre o site, ferramentas e missões do Discord. Se precisar de ajuda com alguma funcionalidade do painel, é só perguntar!"\n\nPergunta do usuário: ${texto}`;

        const response = await fetch('https://api-dos-jack.shardweb.app/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ texto: systemPrompt })
        });
        const text = await response.text();
        console.log('[Ghost IA] Resposta raw:', text);
        try {
            const data = JSON.parse(text);
            res.json(data);
        } catch {
            res.json({ resposta: text });
        }
    } catch (err) {
        console.error('[Ghost IA] Erro:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Status do bot
// Status do bot
// Status do bot
app.get('/api/status', async (req, res) => {
    const client = (req.siteSession ? req.siteSession.client : null);
    if (!client || !client.user) {
        return res.json({ connected: false });
    }
    
    // Contar amigos
    let friendCount = 0;
    
    try {
        if (client.relationships && client.relationships.cache) {
            client.relationships.cache.forEach((value, key) => {
                if (value === 1) friendCount++;
            });
        }
        
        if (friendCount === 0 && client.relationships && client.relationships.friend) {
            const friendObj = client.relationships.friend;
            friendCount = Object.keys(friendObj).length;
        }
        
        if (friendCount === 0 && client.relationships && client.relationships.friends) {
            if (typeof client.relationships.friends.size === 'number') {
                friendCount = client.relationships.friends.size;
            } else if (typeof client.relationships.friends.cache !== 'undefined') {
                friendCount = client.relationships.friends.cache.size;
            }
        }
        
        // console.log(`[Status] Amigos detectados: ${friendCount}`);
    } catch (e) {
        console.error('[Status] Erro ao contar amigos:', e.message);
    }
    
    // Buscar bio e banner do próprio usuário via API REST se possível
    let bio = null;
    let bannerURL = null;
    let themeColors = null;
    let activities = [];

    const token = (req.siteSession ? req.siteSession.discordToken : '') || '';
    if (token) {
        try {
            const httpResponse = await discordFetchFast(`https://discord.com/api/v9/users/${client.user.id}/profile`, {
                headers: { 'Authorization': token }
            });
            if (httpResponse.ok) {
                const profileData = await httpResponse.json();
                if (profileData.user_profile) {
                    bio = profileData.user_profile.bio;
                    themeColors = profileData.user_profile.theme_colors;
                }
                if (profileData.user && profileData.user.banner) {
                    bannerURL = `https://cdn.discordapp.com/banners/${client.user.id}/${profileData.user.banner}.${profileData.user.banner.startsWith('a_') ? 'gif' : 'png'}?size=600`;
                }
            }
        } catch (e) {
            console.error('[Status] Erro ao buscar perfil complementar:', e.message);
        }
    }

    // Tentar forçar uma atualização da presença/perfil
    try {
        await client.user.fetch(); // Atualiza dados básicos do usuário
    } catch(e) {}

    // Capturar atividades em tempo real do próprio cliente
    // 1. Tentar cache do presenceUpdate (mais confiável para selfbots)
    let rawActivities = client._selfActivities;
    
    // 2. Fallback: client.user.presence
    if (!rawActivities || rawActivities.length === 0) {
        let userPresence = client.user.presence;
        if (userPresence && userPresence.activities && userPresence.activities.length > 0) {
            rawActivities = userPresence.activities;
        }
    }
    
    // 3. Fallback: guild members cache
    if (!rawActivities || rawActivities.length === 0) {
        for (const guild of client.guilds.cache.values()) {
            const member = guild.members.cache.get(client.user.id);
            if (member && member.presence && member.presence.activities && member.presence.activities.length > 0) {
                rawActivities = member.presence.activities;
                break;
            }
        }
    }
    
    // 4. Fallback: REST API não-documentada /users/@me/activities
    if (!rawActivities || rawActivities.length === 0) {
        try {
            const restActivities = await client.api.users['@me'].activities.get();
            if (Array.isArray(restActivities) && restActivities.length > 0) {
                rawActivities = restActivities;
            }
        } catch (e) { /* endpoint pode não existir */ }
    }
    
    if (rawActivities && rawActivities.length > 0) {
        activities = rawActivities.map(act => {
            let largeImage = null;
            let smallImage = null;

            // Normalizar propriedades (REST retorna snake_case, discord.js retorna camelCase)
            const assets = act.assets || {};
            const largeAsset = assets.largeImage || assets.large_image || '';
            const smallAsset = assets.smallImage || assets.small_image || '';
            const largeText = assets.largeText || assets.large_text || null;
            const smallText = assets.smallText || assets.small_text || null;
            const appId = act.applicationId || act.application_id || null;

            try {
                // Tentar pegar URL direta se for um asset do Discord (objeto discord.js)
                if (act.assets && typeof act.assets.largeImageURL === 'function') {
                    largeImage = act.assets.largeImageURL({ size: 128 });
                    smallImage = act.assets.smallImageURL({ size: 64 });
                }
                
                // Fallbacks para URLs externas (Spotify, Media Proxy, etc)
                if (!largeImage && largeAsset) {
                    if (largeAsset.includes(':')) {
                        const [platform, id] = largeAsset.split(':');
                        if (platform === 'spotify') largeImage = `https://i.scdn.co/image/${id}`;
                        else if (platform === 'mp') largeImage = `https://media.discordapp.net/${id}`;
                        else if (platform === 'twitch') largeImage = `https://static-cdn.jtvnw.net/previews-ttv/live_user_${id}-128x128.jpg`;
                    } else if (largeAsset.startsWith('https://')) {
                        largeImage = largeAsset;
                    } else if (appId) {
                        // Asset ID numérico/hexadecimal do Discord
                        largeImage = `https://cdn.discordapp.com/app-assets/${appId}/${largeAsset}.png`;
                    }
                }
                
                if (!smallImage && smallAsset) {
                    if (smallAsset.includes(':')) {
                        const [platform, id] = smallAsset.split(':');
                        if (platform === 'spotify') smallImage = `https://i.scdn.co/image/${id}`;
                        else if (platform === 'mp') smallImage = `https://media.discordapp.net/${id}`;
                    } else if (smallAsset.startsWith('https://')) {
                        smallImage = smallAsset;
                    } else if (appId) {
                        smallImage = `https://cdn.discordapp.com/app-assets/${appId}/${smallAsset}.png`;
                    }
                }
                
                // Fallback específico para Spotify se não tiver assets mas for Spotify
                if (!largeImage && act.name === 'Spotify' && (act.syncId || act.sync_id)) {
                    const syncId = act.syncId || act.sync_id;
                    largeImage = `https://i.scdn.co/image/${syncId}`;
                }
            } catch (e) {
                console.error('[Status] Erro ao processar assets da atividade:', e.message);
            }

            // Normalizar timestamps
            let ts = null;
            if (act.timestamps) {
                const start = act.timestamps.start || act.timestamps.start_time;
                const end = act.timestamps.end || act.timestamps.end_time;
                ts = {
                    start: start ? (typeof start === 'object' ? start.getTime() : start) : null,
                    end: end ? (typeof end === 'object' ? end.getTime() : end) : null
                };
            }

            return {
                name: act.name,
                type: act.type,
                details: act.details,
                state: act.state,
                applicationId: appId,
                assets: {
                    largeImage,
                    largeText,
                    smallImage,
                    smallText
                },
                timestamps: ts
            };
        });
    }

    res.json({
        connected: true,
        username: client.user.username,
        globalName: client.user.globalName || client.user.username,
        id: client.user.id,
        discriminator: client.user.discriminator,
        avatar: client.user.displayAvatarURL(),
        bannerURL,
        bio,
        themeColors,
        activities,
        presenceStatus: (client.user.presence && client.user.presence.status) || 'offline',
        guilds: client.guilds.cache.size,
        friends: friendCount,
        createdAt: client.user.createdTimestamp
    });
});

// ENDPOINT DE DIAGNÓSTICO - Colocar antes do /api/userinfo
app.get('/api/diagnostic', async (req, res) => {
    const client = (req.siteSession ? req.siteSession.client : null);
    
    if (!client) {
        return res.json({ 
            connected: false, 
            error: 'Nenhum cliente encontrado na sessão',
            sessionId: req.session.id 
        });
    }
    
    if (!client.user) {
        return res.json({ 
            connected: false, 
            error: 'Cliente não autenticado' 
        });
    }
    
    try {
        // Testar se o token ainda é válido tentando buscar o próprio usuário
        const myself = await client.users.fetch(client.user.id, { force: true });
        
        // Listar os primeiros 5 servidores em comum para teste
        const guilds = client.guilds.cache.map(g => ({
            id: g.id,
            name: g.name,
            memberCount: g.memberCount
        })).slice(0, 5);
        
        res.json({ 
            connected: true,
            username: client.user.username,
            userId: client.user.id,
            guildsCount: client.guilds.cache.size,
            guilds: guilds,
            tokenValid: true
        });
    } catch (error) {
        res.json({ 
            connected: true,
            username: client.user.username,
            tokenValid: false,
            error: error.message,
            code: error.code
        });
    }
});


// USER INFO - VERSÃO ESTÁVEL (SEM HTTP DIRETO)
// USER INFO - VERSÃO COM HTTP
app.post('/api/userinfo', async (req, res) => {
    const client = (req.siteSession ? req.siteSession.client : null);
    const { userId } = req.body;
    
    if (!client || !client.user) {
        return res.status(401).json({ error: 'Conta não conectada' });
    }
    
    const targetId = userId && userId.trim() !== '' ? userId.trim() : client.user.id;
    
    // console.log(`[UserInfo] Buscando: ${targetId}`);
    
    try {
        let user = null;
        let allMutualGuilds = [];
        let memberInGuild = null;
        let isBooster = false;
        let boosterSince = null;
        
        // Se for o próprio usuário
        if (targetId === client.user.id) {
            user = client.user;
            for (const [guildId, guild] of client.guilds.cache) {
                allMutualGuilds.push({
                    name: guild.name,
                    id: guild.id,
                    icon: guild.iconURL(),
                    memberCount: guild.memberCount,
                    isOwner: guild.ownerId === client.user.id
                });
            }
        } else {
            // Para outros usuários, buscar servidores em comum
            // Tentar buscar o usuário diretamente primeiro para ser mais rápido
            try {
                user = await client.users.fetch(targetId, { force: true });
            } catch (e) {
                // Se falhar aqui, tentaremos via membros abaixo
            }

            // Buscar servidores em comum de forma mais eficiente (paralelo com limite ou busca em cache)
            const guildEntries = Array.from(client.guilds.cache.values());
            
            // Dividir em chunks para não travar o loop de eventos
            for (let i = 0; i < guildEntries.length; i++) {
                const guild = guildEntries[i];
                try {
                    // Verificar cache primeiro
                    let member = guild.members.cache.get(targetId);
                    
                    // Se não estiver no cache, só faz fetch se ainda não encontramos o 'user' 
                    // ou se quisermos detalhes de todos os servidores em comum (máximo 50 para evitar lag)
                    if (!member && allMutualGuilds.length < 50) {
                        member = await guild.members.fetch(targetId).catch(() => null);
                    }

                    if (member) {
                        if (!user) user = member.user;
                        memberInGuild = member;
                        allMutualGuilds.push({
                            name: guild.name,
                            id: guild.id,
                            icon: guild.iconURL(),
                            memberCount: guild.memberCount,
                            nickname: member.nickname,
                            isOwner: guild.ownerId === targetId,
                            joinedAt: member.joinedAt
                        });
                        
                        if (member.premiumSince) {
                            isBooster = true;
                            boosterSince = member.premiumSince;
                        }
                    }
                } catch (e) {}
            }
        }
        
        if (!user) {
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }
        
        // Buscar flags/badges via selfbot
        let flags = [];
        
        if (user.flags) {
            flags = user.flags.toArray();
        }
        
        try {
            const freshUser = await client.users.fetch(targetId, { force: true });
            if (freshUser && freshUser.flags) {
                const freshFlags = freshUser.flags.toArray();
                flags = [...new Set([...flags, ...freshFlags])];
            }
        } catch (e) {}
        
        if (memberInGuild) {
            try {
                const freshMember = await memberInGuild.fetch();
                if (freshMember && freshMember.user && freshMember.user.flags) {
                    const memberFlags = freshMember.user.flags.toArray();
                    flags = [...new Set([...flags, ...memberFlags])];
                }
            } catch (e) {}
        }

        const flagsHTTP = {
            1: 'DISCORD_EMPLOYEE',
            2: 'DISCORD_PARTNER',
            4: 'HYPESQUAD_EVENTS',
            8: 'BUG_HUNTER_LEVEL_1',
            64: 'HOUSE_BRAVERY',
            128: 'HOUSE_BRILLIANCE',
            256: 'HOUSE_BALANCE',
            512: 'EARLY_SUPPORTER',
            16384: 'BUG_HUNTER_LEVEL_2',
            65536: 'VERIFIED_BOT_DEVELOPER',
            131072: 'EARLY_VERIFIED_BOT_DEVELOPER',
            262144: 'CERTIFIED_MODERATOR',
            4194304: 'ACTIVE_DEVELOPER'
        };

        const badgesMap = {
            DISCORD_EMPLOYEE: { text: 'Staff', img: 'badges/discordstaff.png' },
            DISCORD_PARTNER: { text: 'Partner', img: 'badges/discordpartner.png' },
            HYPESQUAD_EVENTS: { text: 'Events', img: 'badges/hypesquadevents.png' },
            CERTIFIED_MODERATOR: { text: 'Moderator', img: 'badges/discordmod.png' },
            HOUSE_BRAVERY: { text: 'Bravery', img: 'badges/hypesquadbravery.png' },
            HOUSE_BRILLIANCE: { text: 'Brilliance', img: 'badges/hypesquadbrilliance.png' },
            HOUSE_BALANCE: { text: 'Balance', img: 'badges/hypesquadbalance.png' },
            HYPESQUAD_ONLINE_HOUSE_1: { text: 'Bravery', img: 'badges/hypesquadbravery.png' },
            HYPESQUAD_ONLINE_HOUSE_2: { text: 'Brilliance', img: 'badges/hypesquadbrilliance.png' },
            HYPESQUAD_ONLINE_HOUSE_3: { text: 'Balance', img: 'badges/hypesquadbalance.png' },
            BUG_HUNTER_LEVEL_1: { text: 'Bug Hunter 1', img: 'badges/discordbughunter1.png' },
            BUG_HUNTER_LEVEL_2: { text: 'Bug Hunter 2', img: 'badges/discordbughunter2.png' },
            EARLY_SUPPORTER: { text: 'Early Supporter', img: 'badges/discordearlysupporter.png' },
            VERIFIED_DEVELOPER: { text: 'Developer', img: 'badges/activedeveloper.png' },
            VERIFIED_BOT_DEVELOPER: { text: 'Developer', img: 'badges/activedeveloper.png' },
            EARLY_VERIFIED_BOT_DEVELOPER: { text: 'Developer', img: 'badges/activedeveloper.png' },
            ACTIVE_DEVELOPER: { text: 'Active Dev', img: 'badges/activedeveloper.png' },
            NITRO: { text: 'Nitro', img: 'badges/discordnitro.png' },
            // Níveis de Nitro/Booster (ordem oficial do Discord)
            NITRO_1: { text: 'Nitro 1m', img: 'badges/bronze .png' },
            NITRO_3: { text: 'Nitro 3m', img: 'badges/silver.png' },
            NITRO_6: { text: 'Nitro 6m', img: 'badges/gold.png' },
            NITRO_12: { text: 'Nitro 1y', img: 'badges/platinum.png' },
            NITRO_18: { text: 'Nitro 1.5y', img: 'badges/diamond.png' },
            NITRO_24: { text: 'Nitro 2y', img: 'badges/emerald.png' },
            NITRO_36: { text: 'Nitro 3y', img: 'badges/ruby.png' },
            NITRO_60: { text: 'Nitro 5y', img: 'badges/ruby.png' },
            NITRO_72: { text: 'Nitro 6y+', img: 'badges/opal.png' },
            // Mapeamento antigo para compatibilidade
            BRONZE: { text: 'Nitro 1m', img: 'badges/bronze .png' },
            SILVER: { text: 'Nitro 3m', img: 'badges/silver.png' },
            GOLD: { text: 'Nitro 6m', img: 'badges/gold.png' },
            PLATINUM: { text: 'Nitro 1y', img: 'badges/platinum.png' },
            DIAMOND: { text: 'Nitro 1.5y', img: 'badges/diamond.png' },
            EMERALD: { text: 'Nitro 2y', img: 'badges/emerald.png' },
            RUBY: { text: 'Nitro 3y', img: 'badges/ruby.png' },
            OPAL: { text: 'Nitro 6y+', img: 'badges/opal.png' },
            // Fallbacks de Booster
            BOOST_1: { text: 'Boost 1m', img: 'badges/boosting_1.png' },
            BOOST_2: { text: 'Boost 2m', img: 'badges/boosting_2.png' },
            BOOST_3: { text: 'Boost 3m', img: 'badges/boosting_3.png' },
            BOOST_4: { text: 'Boost 6m', img: 'badges/boosting_4.png' },
            BOOST_5: { text: 'Boost 9m', img: 'badges/boosting_5.png' },
            BOOST_6: { text: 'Boost 1y', img: 'badges/boosting_6.png' },
            BOOST_7: { text: 'Boost 1y3m', img: 'badges/boosting_7.png' },
            BOOST_8: { text: 'Boost 1y6m', img: 'badges/boosting_8.png' },
            BOOST_9: { text: 'Boost 2y', img: 'badges/boosting_9.png' },
            // Novas Badges
            QUEST: { text: 'Quest', img: 'badges/quest.png' },
            SUSTAINABILITY: { text: 'Sustainability', img: 'badges/lastmeadow.png' },
            LEGACY_NAME: { text: 'Legacy Name', img: 'badges/username.png' },
            COLLECTOR: { text: 'Collector', img: 'badges/orb.png' },
            BRAVERY_LGBTQ: { text: 'Bravery Pride', img: 'badges/hypesquadbravery.png' },
            BRILLIANCE_LGBTQ: { text: 'Brilliance Pride', img: 'badges/hypesquadbrilliance.png' },
            BALANCE_LGBTQ: { text: 'Balance Pride', img: 'badges/hypesquadbalance.png' },
            VERIFIED_BOT_DEVELOPER: { text: 'Verified Bot Dev', img: 'badges/activedeveloper.png' },
            HYPESQUAD_EVENTS: { text: 'HypeSquad Events', img: 'badges/hypesquadevents.png' },
            CERTIFIED_MODERATOR: { text: 'Certified Moderator', img: 'badges/discordmod.png' },
            SUPPORTS_COMMANDS: { text: 'Supports Commands', img: 'badges/supportscommands.png' },
            // Mapeamento de Emojis/Texto (Retrocompatibilidade)
            '👨‍💼 Funcionário Discord': { text: 'Staff', img: 'badges/discordstaff.png' },
            '🤝 Parceiro Discord': { text: 'Partner', img: 'badges/discordpartner.png' },
            '🎪 HypeSquad Events': { text: 'Events', img: 'badges/hypesquadevents.png' },
            '🐛 Caçador de Bugs Nv1': { text: 'Bug Hunter 1', img: 'badges/discordbughunter1.png' },
            '🦁 HypeSquad Bravery': { text: 'Bravery', img: 'badges/hypesquadbravery.png' },
            '🦉 HypeSquad Brilliance': { text: 'Brilliance', img: 'badges/hypesquadbrilliance.png' },
            '⚖️ HypeSquad Balance': { text: 'Balance', img: 'badges/hypesquadbalance.png' },
            '⭐ Early Supporter': { text: 'Early Supporter', img: 'badges/discordearlysupporter.png' },
            '🐞 Caçador de Bugs Nv2': { text: 'Bug Hunter 2', img: 'badges/discordbughunter2.png' },
            '💻 Desenvolvedor Verificado': { text: 'Developer', img: 'badges/activedeveloper.png' },
            '⚡ Desenvolvedor Ativo': { text: 'Active Dev', img: 'badges/activedeveloper.png' },
            DEFAULT: { text: 'Badge', img: 'badges/discordnitro.png' }
        };

        // Converter flags para objetos com imagem
        let badgeList = [];
        
        // Funções de utilidade para tempo
        const getMonths = (sinceDate) => {
            if (!sinceDate) return 0;
            const now = Date.now();
            const elapsed = now - new Date(sinceDate).getTime();
            return Math.floor(elapsed / (1000 * 60 * 60 * 24 * 30));
        };

        const getNitroTenureBadge = (months) => {
            if (months >= 72) return badgesMap.NITRO_72;      // 6+ anos: Opal
            if (months >= 60) return badgesMap.NITRO_60;      // 5 anos: Ruby
            if (months >= 36) return badgesMap.NITRO_36;      // 3 anos: Ruby (ou Emerald dependendo da versão)
            if (months >= 24) return badgesMap.NITRO_24;      // 2 anos: Emerald
            if (months >= 18) return badgesMap.NITRO_18;      // 1.5 ano: Diamond
            if (months >= 12) return badgesMap.NITRO_12;      // 1 ano: Platinum
            if (months >= 6) return badgesMap.NITRO_6;        // 6 meses: Gold
            if (months >= 3) return badgesMap.NITRO_3;        // 3 meses: Silver
            if (months >= 1) return badgesMap.NITRO_1;        // 1 mês: Bronze
            return null;
        };

        const getBoostTenureBadge = (months) => {
            if (months >= 24) return badgesMap.BOOST_9;
            if (months >= 18) return badgesMap.BOOST_8;
            if (months >= 15) return badgesMap.BOOST_7;
            if (months >= 12) return badgesMap.BOOST_6;
            if (months >= 9) return badgesMap.BOOST_5;
            if (months >= 6) return badgesMap.BOOST_4;
            if (months >= 3) return badgesMap.BOOST_3;
            if (months >= 2) return badgesMap.BOOST_2;
            if (months >= 1) return badgesMap.BOOST_1;
            return badgesMap.BOOST_1;
        };

        // 1. Adicionar flags básicas do discord.js
        flags.forEach(flag => {
            const badge = badgesMap[flag];
            if (badge) badgeList.push(badge);
        });

        let accentColor = user.hexAccentColor || null;
        let bio = null;
        let themeColors = null;

        // 3. Buscar badges via API HTTP (mais preciso)
        const token = (req.siteSession ? req.siteSession.discordToken : '') || '';
        if (token) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 segundos de timeout

                // Buscar perfil via API REST do Discord (mais rápido e confiável que Puppeteer)
                const httpResponse = await discordFetchFast(`https://discord.com/api/v9/users/${targetId}/profile`, {
                    method: 'GET',
                    headers: { 'Authorization': token, 'Content-Type': 'application/json' },
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                if (httpResponse.ok) {
                    const profileData = await httpResponse.json();
                    
                    // Capturar accent_color da API se não tiver
                    if (!accentColor && profileData.user && profileData.user.accent_color) {
                        accentColor = '#' + profileData.user.accent_color.toString(16).padStart(6, '0');
                    }

                    // Extract bio and theme colors from profile API
                    if (profileData.user_profile) {
                        bio = profileData.user_profile.bio || null;
                        if (profileData.user_profile.theme_colors && Array.isArray(profileData.user_profile.theme_colors)) {
                            themeColors = profileData.user_profile.theme_colors;
                        }
                    }

                    // 1. Mapeamento por Bitmask (public_flags) - Extremamente confiável
                    if (profileData.user && profileData.user.public_flags) {
                        const pFlags = profileData.user.public_flags;
                        for (const [bit, flagKey] of Object.entries(flagsHTTP)) {
                            if ((pFlags & parseInt(bit)) === parseInt(bit)) {
                                const badge = badgesMap[flagKey];
                                if (badge) badgeList.push(badge);
                            }
                        }
                    }
                    
                    // Flags de Nitro/Boost via API (para fallback se não vierem na lista 'badges')
                    let hasNitroBadge = false;
                    let hasBoostBadge = false;
                    
                    // 2. Processar Badges Detalhadas (Prioridade Máxima)
                    if (profileData.badges && Array.isArray(profileData.badges)) {
                        for (const b of profileData.badges) {
                            const badgeId = (b.id || '').toLowerCase();
                            const desc = (b.description || b.name || '').toLowerCase();
                            
                            // Marcar se já temos nitro/booster da API
                            if (badgeId.includes('premium') || desc.includes('nitro')) hasNitroBadge = true;
                            if (badgeId.includes('guild_booster') || desc.includes('booster')) hasBoostBadge = true;

                            // Debug: logar todos os badgeIds recebidos para descobrir novos
                            // console.log('[UserInfo] Badge API:', { id: b.id, desc: b.description, name: b.name, icon: b.icon });

                            // 1. Prioridade por ID (mais preciso)
                            if (badgeId === 'hypesquad_house_1' || badgeId === 'hypesquad_online_house_1') badgeList.push(badgesMap.HOUSE_BRAVERY);
                            else if (badgeId === 'hypesquad_house_2' || badgeId === 'hypesquad_online_house_2') badgeList.push(badgesMap.HOUSE_BRILLIANCE);
                            else if (badgeId === 'hypesquad_house_3' || badgeId === 'hypesquad_online_house_3') badgeList.push(badgesMap.HOUSE_BALANCE);
                            else if (badgeId === 'quest' || badgeId === 'quest_completed') badgeList.push(badgesMap.QUEST);
                            else if (badgeId === 'sustainability_supporter' || badgeId === 'sustainability') badgeList.push(badgesMap.SUSTAINABILITY);
                            else if (badgeId === 'legacy_username' || badgeId === 'legacy') badgeList.push(badgesMap.LEGACY_NAME);
                            else if (badgeId === 'collector' || badgeId === 'collectibles_collector') badgeList.push(badgesMap.COLLECTOR);
                            else if (badgeId === 'premium' || badgeId === 'nitro') { badgeList.push(badgesMap.NITRO); hasNitroBadge = true; }
                            else if (badgeId === 'discord_staff' || badgeId === 'staff') badgeList.push(badgesMap.DISCORD_EMPLOYEE);
                            else if (badgeId === 'discord_certified_moderator' || badgeId === 'certified_moderator') badgeList.push(badgesMap.CERTIFIED_MODERATOR);
                            else if (badgeId === 'hypesquad_events') badgeList.push(badgesMap.HYPESQUAD_EVENTS);
                            else if (badgeId === 'verified_developer') badgeList.push(badgesMap.VERIFIED_DEVELOPER);
                            else if (badgeId === 'active_developer' || badgeId === 'active_dev') badgeList.push(badgesMap.ACTIVE_DEVELOPER);
                            else if (badgeId === 'bug_hunter_level_1' || badgeId === 'bug_hunter_1') badgeList.push(badgesMap.BUG_HUNTER_LEVEL_1);
                            else if (badgeId === 'bug_hunter_level_2' || badgeId === 'bug_hunter_2') badgeList.push(badgesMap.BUG_HUNTER_LEVEL_2);
                            else if (badgeId === 'early_supporter') badgeList.push(badgesMap.EARLY_SUPPORTER);
                            else if (badgeId === 'partner') badgeList.push(badgesMap.DISCORD_PARTNER);
                            
                            // NOVO: Mapear tenure badges do Discord (premium_tenure_X_month, guild_booster_lvlX)
                            else if (badgeId.startsWith('premium_tenure_')) {
                                const match = badgeId.match(/premium_tenure_(\d+)_month/);
                                if (match) {
                                    const months = parseInt(match[1]);
                                    const nBadge = getNitroTenureBadge(months);
                                    if (nBadge) { badgeList.push(nBadge); hasNitroBadge = true; }
                                }
                            }
                            else if (badgeId.startsWith('guild_booster_lvl')) {
                                const match = badgeId.match(/guild_booster_lvl(\d+)/);
                                if (match) {
                                    const lvl = parseInt(match[1]);
                                    const boostMap = { 1: badgesMap.BOOST_1, 2: badgesMap.BOOST_2, 3: badgesMap.BOOST_3, 4: badgesMap.BOOST_4, 5: badgesMap.BOOST_5, 6: badgesMap.BOOST_6, 7: badgesMap.BOOST_7, 8: badgesMap.BOOST_8, 9: badgesMap.BOOST_9 };
                                    if (boostMap[lvl]) { badgeList.push(boostMap[lvl]); hasBoostBadge = true; }
                                }
                            }
                            
                            // Suporte para IDs de badges com versão (ex: premium_tenure_12_month_v2)
                            else if (badgeId.includes('premium_tenure_')) {
                                const match = badgeId.match(/premium_tenure_(\d+)/);
                                if (match) {
                                    const months = parseInt(match[1]);
                                    const nBadge = getNitroTenureBadge(months);
                                    if (nBadge) { badgeList.push(nBadge); hasNitroBadge = true; }
                                }
                            }
                            
                            // Fallback por badgeId parcial (novas badges que ainda não conhecemos)
                            else if (badgeId.includes('collector') || badgeId.includes('collectible')) badgeList.push(badgesMap.COLLECTOR);
                            else if (badgeId.includes('sustainability') || badgeId.includes('lastmeadow') || badgeId.includes('meadow')) badgeList.push(badgesMap.SUSTAINABILITY);
                            else if (badgeId.includes('legacy') || badgeId.includes('original')) badgeList.push(badgesMap.LEGACY_NAME);
                            else if (badgeId.includes('quest')) badgeList.push(badgesMap.QUEST);
                            
                            // 2. Fallback por descrição (Mais específico primeiro)
                            else if (desc.includes('bravery') && desc.includes('pride')) badgeList.push(badgesMap.BRAVERY_LGBTQ);
                            else if (desc.includes('brilliance') && desc.includes('pride')) badgeList.push(badgesMap.BRILLIANCE_LGBTQ);
                            else if (desc.includes('balance') && desc.includes('pride')) badgeList.push(badgesMap.BALANCE_LGBTQ);
                            else if (desc.includes('quest')) badgeList.push(badgesMap.QUEST);
                            else if (desc.includes('active developer') || desc.includes('desenvolvedor ativo')) badgeList.push(badgesMap.ACTIVE_DEVELOPER);
                            else if (desc.includes('early supporter')) badgeList.push(badgesMap.EARLY_SUPPORTER);
                            else if (desc.includes('bug hunter') && desc.includes('level 2')) badgeList.push(badgesMap.BUG_HUNTER_LEVEL_2);
                            else if (desc.includes('bug hunter')) badgeList.push(badgesMap.BUG_HUNTER_LEVEL_1);
                            else if (desc.includes('staff')) badgeList.push(badgesMap.DISCORD_EMPLOYEE);
                            else if (desc.includes('partner')) badgeList.push(badgesMap.DISCORD_PARTNER);
                            else if (desc.includes('sustainability') || desc.includes('sustentabilidade')) badgeList.push(badgesMap.SUSTAINABILITY);
                            else if (desc.includes('legacy') || desc.includes('original')) badgeList.push(badgesMap.LEGACY_NAME);
                            else if (desc.includes('collector') || desc.includes('colecionador')) badgeList.push(badgesMap.COLLECTOR);
                            else if (desc.includes('commands') || desc.includes('comandos')) badgeList.push(badgesMap.SUPPORTS_COMMANDS);
                            
                            // 3. Fallback Dinâmico (Sempre confiar no que o Discord envia - Prioridade para ícones reais)
                            else if (b.icon) {
                                badgeList.push({
                                    text: b.description || b.name || (desc.includes('nitro') ? 'Nitro' : 'Badge'),
                                    img: `https://cdn.discordapp.com/badge-icons/${b.icon}.png`
                                });
                            }
                            
                            // 4. Último caso: descrições genéricas sem ícone próprio no loop
                            else if (desc.includes('nitro')) badgeList.push(badgesMap.NITRO);
                            else if (desc.includes('bravery')) badgeList.push(badgesMap.HOUSE_BRAVERY);
                            else if (desc.includes('brilliance')) badgeList.push(badgesMap.HOUSE_BRILLIANCE);
                            else if (desc.includes('balance')) badgeList.push(badgesMap.HOUSE_BALANCE);
                            else if (desc.includes('developer') || desc.includes('desenvolvedor')) badgeList.push(badgesMap.VERIFIED_DEVELOPER);
                        }
                    }

                    // 3. Remover Nitro genérico da detecção baseada se a API já retornou tenure específico
                    if (hasNitroBadge) {
                        const idx = badgeList.findIndex(b => b && b.text === 'Nitro');
                        if (idx !== -1) badgeList.splice(idx, 1);
                    }
                    // Cálculo manual APENAS se a API não retornou as insígnias de tempo na lista 'badges'
                    if (!hasNitroBadge && profileData.premium_since) {
                        const nMonths = getMonths(profileData.premium_since);
                        const nBadge = getNitroTenureBadge(nMonths);
                        if (nBadge) badgeList.push(nBadge);
                    }

                    // 4. Remover Boost genérico da detecção baseada se a API já retornou lvl específico
                    if (hasBoostBadge) {
                        const idx = badgeList.findIndex(b => b && b.text === 'Boost');
                        if (idx !== -1) badgeList.splice(idx, 1);
                    }
                    if (!hasBoostBadge && profileData.premium_guild_since) {
                        const bMonths = getMonths(profileData.premium_guild_since);
                        badgeList.push(getBoostTenureBadge(bMonths));
                    }
                } else {
                    console.log(`[UserInfo] API Profile falhou: ${httpResponse.status}`);
                    // Fallback se a API falhar (Cálculo básico)
                    if (user.premium_type) badgeList.push(badgesMap.NITRO);
                    if (isBooster) {
                        const bMonths = getMonths(boosterSince);
                        badgeList.push(getBoostTenureBadge(bMonths));
                    }
                }

            } catch (e) {
                console.error('[UserInfo] Erro ao buscar perfil extra:', e.message);
                // Fallback se houver erro
                if (user.premium_type) badgeList.push(badgesMap.NITRO);
                if (isBooster) {
                    const bMonths = getMonths(boosterSince);
                    badgeList.push(getBoostTenureBadge(bMonths));
                }
            }
        } else {
            // Se não houver token, faz o cálculo básico
            if (user.premium_type) badgeList.push(badgesMap.NITRO);
            if (isBooster) {
                const bMonths = getMonths(boosterSince);
                badgeList.push(getBoostTenureBadge(bMonths));
            }
        }

        // 4. Remover duplicatas e normalizar (case-insensitive, bullet-proof)
        let finalBadges = [];
        const seenTexts = new Set();
        const normalize = (t) => (t || '').toString().trim().toLowerCase();
        
        // Ordenar por prioridade (mais específico primeiro)
        badgeList.sort((a, b) => {
            const aText = a.text || '';
            const bText = b.text || '';
            return bText.length - aText.length;
        });

        // Verificar se temos versões específicas de Nitro/Boost
        const hasSpecificNitro = badgeList.some(b => {
            const t = normalize(b.text);
            return t.startsWith('nitro ') || t.includes('subscriber') || t.includes('assinante');
        });
        const hasSpecificBoost = badgeList.some(b => {
            const t = normalize(b.text);
            return t.startsWith('boost ') || t.includes('impulso') || t.includes('boosting');
        });

        for (const b of badgeList) {
            if (!b || !b.text) continue;
            const text = b.text.trim();
            const key = normalize(text);

            // Deduplicação case-insensitive
            if (seenTexts.has(key)) continue;

            // Bloquear Nitro genérico se houver um com tempo
            if (key === 'nitro' && hasSpecificNitro) continue;
            // Bloquear Boost genérico se houver um com tempo
            if (key === 'boost' && hasSpecificBoost) continue;
            
            // Evitar duplicatas de Developer
            if (key === 'developer' && (seenTexts.has('active dev') || seenTexts.has('verified bot dev'))) continue;

            finalBadges.push(b);
            seenTexts.add(key);
        }

        // Garantir: nunca mais de 1 Nitro genérico (remove duplicatas de fontes diferentes)
        const nitroKeys = ['nitro', 'subscriber'];
        const nitroEntries = finalBadges.filter(b => nitroKeys.includes(normalize(b.text)));
        if (nitroEntries.length > 1) {
            finalBadges = finalBadges.filter(b => !nitroKeys.includes(normalize(b.text)) || b === nitroEntries[0]);
        }

        // Ordenar badges na ordem padrão do Discord
        const badgeOrder = [
            'staff', 'funcionário discord', 'discord staff',
            'partner', 'parceiro discord', 'discord partner',
            'moderator', 'certified moderator', 'discord certified moderator',
            'hypesquad events', 'events', 'hype squad events',
            'bug hunter 2', 'bug hunter level 2', 'caçador de bugs nv2',
            'bug hunter 1', 'bug hunter level 1', 'caçador de bugs nv1',
            'early supporter', 'early supporter verificado',
            'active dev', 'active developer', 'desenvolvedor ativo',
            'verified bot dev', 'verified bot developer', 'early verified bot developer', 'developer', 'desenvolvedor verificado',
            'bravery', 'hypesquad bravery', 'hypesquad online house 1', 'bravery pride',
            'brilliance', 'hypesquad brilliance', 'hypesquad online house 2', 'brilliance pride',
            'balance', 'hypesquad balance', 'hypesquad online house 3', 'balance pride',
            // Nitro tenure (ordem crescente de tempo)
            'nitro 1m', 'bronze',
            'nitro 3m', 'silver',
            'nitro 6m', 'gold',
            'nitro 1y', 'platinum',
            'nitro 2y', 'diamond',
            'nitro 3y', 'emerald',
            'nitro 5y', 'ruby',
            'nitro 6y+', 'opal',
            // Boost tenure (ordem crescente)
            'boost 1m', 'boosting 1',
            'boost 2m', 'boosting 2',
            'boost 3m', 'boosting 3',
            'boost 6m', 'boosting 4',
            'boost 9m', 'boosting 5',
            'boost 1y', 'boosting 6',
            'boost 1y3m', 'boosting 7',
            'boost 1y6m', 'boosting 8',
            'boost 2y', 'boosting 9',
            // Outros
            'legacy name', 'legacy username', 'original',
            'quest', 'quest completed',
            'collector', 'collectibles collector', 'colecionador',
            'sustainability', 'sustainability supporter', 'sustentabilidade',
            'nitro'
        ];

        const getBadgeScore = (badge) => {
            const text = normalize(badge.text);
            for (let i = 0; i < badgeOrder.length; i++) {
                if (text === badgeOrder[i] || text.startsWith(badgeOrder[i])) return i;
            }
            return 999;
        };

        finalBadges.sort((a, b) => getBadgeScore(a) - getBadgeScore(b));

        // Fetch user activities and status from Gateway
        let activities = [];
        let userStatus = 'offline';
        try {
            let presence = null;
            
            // 1. Try client.presences.cache first
            presence = client.presences.cache.get(targetId);
            
            // 2. Try guild members cache (very fast)
            if (!presence) {
                for (const guild of client.guilds.cache.values()) {
                    const member = guild.members.cache.get(targetId);
                    if (member && member.presence) {
                        presence = member.presence;
                        break;
                    }
                }
            }
            
            // 3. Somente buscar de guild se não encontramos em cache E for um número pequeno de guilds
            if (!presence && client.guilds.cache.size < 10) {
                for (const guild of client.guilds.cache.values()) {
                    try {
                        const member = await guild.members.fetch(targetId);
                        if (member && member.presence) {
                            presence = member.presence;
                            break;
                        }
                    } catch (e) {}
                }
            }
            
            // 4. Fallback to user object
            if (!presence) {
                let targetUser = client.users.cache.get(targetId);
                if (!targetUser) {
                    targetUser = await client.users.fetch(targetId);
                }
                if (targetUser && targetUser.presence) {
                    presence = targetUser.presence;
                }
            }
            
            if (presence) {
                userStatus = presence.status || 'offline';
                console.log(`[UserInfo] Status de ${targetId}: ${userStatus}`);
            } else {
                console.log(`[UserInfo] Presence não encontrada para ${targetId}`);
            }
            
            if (presence && presence.activities && presence.activities.length > 0) {
                activities = presence.activities.map(a => ({
                    name: a.name,
                    type: a.type,
                    details: a.details || null,
                    state: a.state || null,
                    applicationId: a.applicationId || null,
                    timestamps: a.timestamps ? { start: a.timestamps.start, end: a.timestamps.end } : null,
                    assets: a.assets ? {
                        largeImage: a.assets.largeImage ? a.assets.largeImageURL ? a.assets.largeImageURL() : a.assets.largeImage : null,
                        largeText: a.assets.largeText || null,
                        smallImage: a.assets.smallImage ? a.assets.smallImageURL ? a.assets.smallImageURL() : a.assets.smallImage : null,
                        smallText: a.assets.smallText || null
                    } : null,
                    url: a.url || null,
                    flags: a.flags || 0,
                    party: a.party || null,
                    buttons: a.buttons || [],
                    createdTimestamp: a.createdTimestamp || null
                }));
                console.log(`[UserInfo] Atividades encontradas: ${activities.length}`, activities.map(a => a.name));
            } else {
                console.log('[UserInfo] Nenhuma atividade encontrada para o usuário.');
            }
        } catch (e) {
            console.log('[UserInfo] Atividades não disponíveis:', e.message);
        }

        // Calcular idade da conta
        const createdDate = new Date(user.createdTimestamp);
        const now = new Date();
        const accountAgeDays = Math.floor((now - createdDate) / (1000 * 60 * 60 * 24));
        const accountAgeYears = Math.floor(accountAgeDays / 365);
        const accountAgeMonths = Math.floor((accountAgeDays % 365) / 30);

        // console.log(`[UserInfo] ${user.username} - Badges: ${badgeList.length} - Servidores: ${allMutualGuilds.length}`);

        res.json({
            success: true,
            username: user.username,
            globalName: user.globalName || null,
            id: user.id,
            discriminator: user.discriminator || '0',
            bot: user.bot || false,
            createdAtFormatted: createdDate.toLocaleString('pt-BR'),
            accountAge: {
                days: accountAgeDays,
                years: accountAgeYears,
                months: accountAgeMonths,
                full: `${accountAgeYears} anos, ${accountAgeMonths} meses, ${accountAgeDays % 30} dias`
            },
            avatarURL: user.displayAvatarURL({ dynamic: true, size: 1024 }),
            bannerURL: user.bannerURL({ dynamic: true, size: 1024 }) || null,
            accentColor: accentColor,
            badges: finalBadges,
            badgesCount: finalBadges.length,
            mutualGuilds: allMutualGuilds,
            mutualGuildsCount: allMutualGuilds.length,
            isSelf: targetId === client.user.id,
            isBooster: isBooster,
            bio: bio,
            themeColors: themeColors,
            activities: activities,
            status: userStatus
        });
        
    } catch (error) {
        console.error('[UserInfo] Erro:', error);
        res.status(500).json({ error: `Erro: ${error.message}` });
    }
});

// Verificar se o cliente ainda está conectado
app.get('/api/check-connection', async (req, res) => {
    const client = (req.siteSession ? req.siteSession.client : null);
    
    if (!client) {
        return res.json({ connected: false, error: 'Cliente não encontrado' });
    }
    
    if (!client.user) {
        return res.json({ connected: false, error: 'Cliente não autenticado' });
    }
    
    try {
        // Testar se o token ainda é válido
        await client.user.fetch();
        res.json({ 
            connected: true, 
            username: client.user.username,
            userId: client.user.id
        });
    } catch (error) {
        res.json({ connected: false, error: error.message });
    }
});


// --- FARM DE HORAS (VOICE) ---

// Listar canais de voz de um servidor
app.get('/api/guild-voice-channels', async (req, res) => {
    const client = (req.siteSession ? req.siteSession.client : null);
    const { guildId } = req.query;
    
    if (!client || !client.user) {
        return res.status(401).json({ error: 'Conta não conectada' });
    }
    
    try {
        const guild = await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) return res.status(404).json({ error: 'Servidor não encontrado' });
        
        const voiceChannels = guild.channels.cache
            .filter(c => c.type === 'GUILD_VOICE' || c.type === 2)
            .map(c => ({
                id: c.id,
                name: c.name
            }));
            
        res.json({ success: true, channels: voiceChannels });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Conectar em um canal de voz
app.post('/api/voice-connect', async (req, res) => {
    const client = (req.siteSession ? req.siteSession.client : null);
    const { channelId } = req.body;
    
    if (!client || !client.user) {
        return res.status(401).json({ error: 'Conta não conectada' });
    }
    
    try {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel || (channel.type !== 'GUILD_VOICE' && channel.type !== 2)) {
            return res.status(404).json({ error: 'Canal de voz não encontrado' });
        }
        
        // No discord.js-selfbot-v13, para entrar em call sem @discordjs/voice:
        // Usamos um try/catch específico para o timeout, pois o selfbot às vezes demora a confirmar mas conecta
        try {
            if (typeof channel.join === 'function') {
                await channel.join({ selfMute: true, selfDeaf: true });
            } else if (client.voice && typeof client.voice.joinChannel === 'function') {
                await client.voice.joinChannel(channel, { selfMute: true, selfDeaf: true });
            } else {
                // Fallback para discord.js-selfbot-v13 v13
                await channel.guild.members.me.voice.setChannel(channel);
            }
        } catch (joinError) {
            // Pequena espera para o estado atualizar no cache
            await new Promise(r => setTimeout(r, 1500));
            
            // Verificação robusta: se o ID do canal de voz do bot for o mesmo que pedimos, ignoramos o erro de timeout
            const currentVoiceChannelId = channel.guild.members.me.voice.channelId;
            
            if (currentVoiceChannelId === channel.id) {
                console.log(`[Voice] Timeout ignorado: Bot já está confirmado no canal ${channel.name}`);
            } else {
                // Se for timeout mas o bot não está lá, aí sim é erro
                console.error(`[Voice] Erro real ao conectar:`, joinError.message);
                throw joinError;
            }
        }
        
        console.log(`[Voice] ${client.user.tag} conectado em ${channel.name} (${channel.guild.name})`);
        res.json({ success: true, message: `Conectado em ${channel.name}` });
    } catch (error) {
        console.error('[Voice] Erro ao conectar:', error);
        res.status(500).json({ error: error.message });
    }
});

// Desconectar de qualquer canal de voz
app.post('/api/voice-disconnect', async (req, res) => {
    const client = (req.siteSession ? req.siteSession.client : null);
    const { guildId } = req.body;
    
    if (!client || !client.user) {
        return res.status(401).json({ error: 'Conta não conectada' });
    }
    
    try {
        if (!guildId) {
            // Desconectar de todas as conexões de voz ativas
            client.voice.adapters.forEach((adapter, id) => {
                adapter.destroy();
            });
            // Método v13
            client.guilds.cache.forEach(g => {
                if (g.members.me.voice.channel) {
                    g.members.me.voice.disconnect();
                }
            });
        } else {
            const guild = client.guilds.cache.get(guildId);
            if (guild && guild.members.me.voice.channel) {
                await guild.members.me.voice.disconnect();
            }
        }
        
        res.json({ success: true, message: 'Desconectado da call' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Listar DMs abertas
app.get('/api/open-dms', async (req, res) => {
    try {
        const client = (req.siteSession ? req.siteSession.client : null);
        if (!client || !client.user) {
            return res.json({ success: false, error: 'Conta não conectada' });
        }
        
        const dms = [];
        // Iterar de forma segura
        client.channels.cache.forEach(channel => {
            try {
                if (channel.type === 'DM' || channel.type === 1 || channel.type === 'dm') {
                    const recipient = channel.recipient;
                    if (recipient) {
                        dms.push({
                            id: recipient.id,
                            channelId: channel.id,
                            username: recipient.username,
                            globalName: recipient.globalName || recipient.username,
                            avatar: recipient.displayAvatarURL({ size: 64 })
                        });
                    }
                }
            } catch (e) {}
        });

        // Se não houver DMs no cache, tentar pegar dos relacionamentos (amigos) como fallback
        if (dms.length === 0 && client.relationships) {
            client.relationships.friendCache.forEach(user => {
                dms.push({
                    id: user.id,
                    channelId: null, // Será criado ao apagar
                    username: user.username,
                    globalName: user.globalName || user.username,
                    avatar: user.displayAvatarURL({ size: 64 })
                });
            });
        }
            
        console.log(`[DMs] Encontradas ${dms.length} DMs para ${client.user.tag}`);
        res.json({ success: true, dms });
    } catch (error) {
        console.error('[DMs] Erro ao listar DMs:', error);
        res.json({ success: false, error: error.message });
    }
});

// Apagar mensagens DM
app.post('/api/delete-dm', async (req, res) => {
    const client = (req.siteSession ? req.siteSession.client : null);
    const { userId, limit } = req.body;
    
    if (!client || !client.user) {
        return res.status(401).json({ error: 'Conta não conectada' });
    }
    
    // Rate limit por token para deleção de mensagens
    const token = (req.siteSession ? req.siteSession.discordToken : '');
    const tokenCheck = checkTokenRateLimit(token + '_delete');
    if (!tokenCheck.allowed) {
        return res.status(429).json({ error: `Aguarde ${tokenCheck.waitSeconds}s antes de deletar novamente.` });
    }
    
    try {
        const user = await client.users.fetch(userId);
        const dmChannel = await user.createDM();
        const messages = await dmChannel.messages.fetch({ limit: Math.min(limit || 100, 100) });
        const botMessages = Array.from(messages.filter(m => m.author.id === client.user.id).values());
        
        // Delay conservador: 1200ms entre deleções (5 deleções por minuto = muito seguro)
        const results = await batchAction(botMessages, async (msg) => {
            await msg.delete();
        }, 1200);
        
        res.json({ success: true, deleted: results.success, total: botMessages.length, failed: results.failed });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Apagar mensagens no servidor
app.post('/api/delete-server', async (req, res) => {
    const client = (req.siteSession ? req.siteSession.client : null);
    const { channelId, limit } = req.body;
    
    if (!client || !client.user) {
        return res.status(401).json({ error: 'Conta não conectada' });
    }
    
    // Rate limit por token para deleção de mensagens
    const token = (req.siteSession ? req.siteSession.discordToken : '');
    const tokenCheck = checkTokenRateLimit(token + '_delete');
    if (!tokenCheck.allowed) {
        return res.status(429).json({ error: `Aguarde ${tokenCheck.waitSeconds}s antes de deletar novamente.` });
    }
    
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) {
            return res.status(404).json({ error: 'Canal não encontrado' });
        }
        
        const messages = await channel.messages.fetch({ limit: Math.min(limit || 100, 100) });
        const userMessages = Array.from(messages.filter(m => m.author.id === client.user.id).values());
        
        // Delay conservador: 3000ms entre deleções (mais lento pra evitar rate limit)
        const results = await batchAction(userMessages, async (msg) => {
            await msg.delete();
        }, 3000);
        
        res.json({ success: true, deleted: results.success, total: userMessages.length, failed: results.failed });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Remover amigos
app.post('/api/remove-friends', async (req, res) => {
    const client = (req.siteSession ? req.siteSession.client : null);
    
    if (!client || !client.user) {
        return res.status(401).json({ error: 'Conta não conectada' });
    }
    
    // Rate limit por token
    const token = (req.siteSession ? req.siteSession.discordToken : '');
    const tokenCheck = checkTokenRateLimit(token + '_friends');
    if (!tokenCheck.allowed) {
        return res.status(429).json({ error: 'Aguarde ' + tokenCheck.waitSeconds + 's antes de remover amigos novamente.' });
    }
    
    clearStopFlag(req.session.id, 'remove-friends');
    
    try {
        let friendIds = [];
        
        if (client.relationships && client.relationships.cache) {
            client.relationships.cache.forEach((value, key) => {
                if (value === 1) friendIds.push(key);
            });
        }
        
        if (friendIds.length === 0 && client.relationships && client.relationships.friend) {
            friendIds = Object.keys(client.relationships.friend);
        }
        
        console.log('[RemoveFriends] Amigos encontrados: ' + friendIds.length);
        
        if (friendIds.length === 0) {
            return res.json({ success: true, removed: 0, total: 0, stopped: false, message: 'Nenhum amigo para remover' });
        }
        
        // Delay conservador: 3500ms entre remoções (mais lento pra evitar rate limit)
        const results = await batchAction(friendIds, async (friendId) => {
            try {
                await client.relationships.deleteRelationship(friendId);
            } catch (e) {
                const user = await client.users.fetch(friendId);
                await client.relationships.deleteRelationship(user);
            }
        }, 1500, null, { sessionId: req.session.id, action: 'remove-friends' });
        
        res.json({ success: true, removed: results.success, total: friendIds.length, failed: results.failed, stopped: results.stopped });
    } catch (error) {
        console.error('[RemoveFriends] Erro:', error);
        res.status(500).json({ error: error.message });
    }
});

// Sair de servidores
app.post('/api/leave-guilds', async (req, res) => {
    const client = (req.siteSession ? req.siteSession.client : null);
    const { keepGuildId } = req.body;
    
    if (!client || !client.user) {
        return res.status(401).json({ error: 'Conta não conectada' });
    }
    
    // Rate limit por token
    const token = (req.siteSession ? req.siteSession.discordToken : '');
    const tokenCheck = checkTokenRateLimit(token + '_guilds');
    if (!tokenCheck.allowed) {
        return res.status(429).json({ error: `Aguarde ${tokenCheck.waitSeconds}s antes de sair de servidores novamente.` });
    }
    
    try {
        let guilds = Array.from(client.guilds.cache.values());
        if (keepGuildId) {
            guilds = guilds.filter(g => g.id !== keepGuildId);
        }
        
        // Delay conservador: 3500ms entre saídas (mais lento pra evitar rate limit)
        const results = await batchAction(guilds, async (guild) => {
            await guild.leave();
        }, 1500);
        
        res.json({ success: true, left: results.success, total: guilds.length, failed: results.failed });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Fechar DMs
app.post('/api/close-dms', async (req, res) => {
    const client = (req.siteSession ? req.siteSession.client : null);
    
    if (!client || !client.user) {
        return res.status(401).json({ error: 'Conta não conectada' });
    }
    
    // Rate limit por token
    const token = (req.siteSession ? req.siteSession.discordToken : '');
    const tokenCheck = checkTokenRateLimit(token + '_dms');
    if (!tokenCheck.allowed) {
        return res.status(429).json({ error: 'Aguarde ' + tokenCheck.waitSeconds + 's antes de fechar DMs novamente.' });
    }
    
    clearStopFlag(req.session.id, 'close-dms');
    
    try {
        const dms = Array.from(client.channels.cache.filter(c => c.type === 'DM').values());
        
        // Delay conservador: 3000ms entre fechamentos (mais lento pra evitar rate limit)
        const results = await batchAction(dms, async (dm) => {
            await dm.delete();
        }, 1000, null, { sessionId: req.session.id, action: 'close-dms' });
        
        res.json({ success: true, closed: results.success, total: dms.length, failed: results.failed, stopped: results.stopped });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// FUNÇÕES DE CALL
// Rota para buscar canais de voz
app.get('/api/voice-channels/:guildId', (req, res) => {
    const client = (req.siteSession ? req.siteSession.client : null);
    const { guildId } = req.params;
    
    if (!client || !client.user) {
        return res.status(401).json({ error: 'Conta não conectada' });
    }
    
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
        return res.status(404).json({ error: 'Servidor não encontrado' });
    }
    
    const voiceChannels = guild.channels.cache
        .filter(c => c.type === 'GUILD_VOICE')
        .map(c => ({
            id: c.id,
            name: c.name,
            members: c.members.size,
            userLimit: c.userLimit,
            bitrate: c.bitrate / 1000
        }));
    
    res.json({ channels: voiceChannels });
});

app.post('/api/call/disconnect', async (req, res) => {
    const client = (req.siteSession ? req.siteSession.client : null);
    const { channelId } = req.body;
    
    if (!client || !client.user) {
        return res.status(401).json({ error: 'Conta não conectada' });
    }
    
    const callCheck = checkCallRateLimit(req.session.id);
    if (!callCheck.allowed) {
        return res.status(429).json({ error: `Muitas ações de call. Aguarde ${callCheck.waitSeconds}s.` });
    }
    
    try {
        const channel = client.channels.cache.get(channelId);
        if (!channel || channel.type !== 'GUILD_VOICE') {
            return res.status(400).json({ error: 'Canal de voz inválido' });
        }
        
        let disconnected = 0;
        for (const [, member] of channel.members) {
            try {
                await member.voice.setChannel(null);
                disconnected++;
            } catch (e) {
                if (e.status === 429) {
                    const wait = (e.retryAfter || 2) * 1000;
                    await new Promise(r => setTimeout(r, wait + 500));
                }
            }
            // Delay seguro: 500ms entre desconexões
            await new Promise(r => setTimeout(r, 500));
        }
        
        res.json({ success: true, disconnected });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/call/move', async (req, res) => {
    const client = (req.siteSession ? req.siteSession.client : null);
    const { fromChannelId, toChannelId } = req.body;
    
    if (!client || !client.user) {
        return res.status(401).json({ error: 'Conta não conectada' });
    }
    
    const callCheck = checkCallRateLimit(req.session.id);
    if (!callCheck.allowed) {
        return res.status(429).json({ error: `Muitas ações de call. Aguarde ${callCheck.waitSeconds}s.` });
    }
    
    try {
        const fromChannel = client.channels.cache.get(fromChannelId);
        const toChannel = client.channels.cache.get(toChannelId);
        
        if (!fromChannel || fromChannel.type !== 'GUILD_VOICE') {
            return res.status(400).json({ error: 'Canal de origem inválido' });
        }
        if (!toChannel || toChannel.type !== 'GUILD_VOICE') {
            return res.status(400).json({ error: 'Canal de destino inválido' });
        }
        
        let moved = 0;
        for (const [, member] of fromChannel.members) {
            try {
                await member.voice.setChannel(toChannel);
                moved++;
            } catch (e) {
                if (e.status === 429) {
                    const wait = (e.retryAfter || 2) * 1000;
                    await new Promise(r => setTimeout(r, wait + 500));
                }
            }
            // Delay seguro: 500ms entre movimentações
            await new Promise(r => setTimeout(r, 500));
        }
        
        res.json({ success: true, moved });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/call/pull-all', async (req, res) => {
    const client = (req.siteSession ? req.siteSession.client : null);
    const { targetChannelId, guildId } = req.body;
    
    if (!client || !client.user) {
        return res.status(401).json({ error: 'Conta não conectada' });
    }
    
    const callCheck = checkCallRateLimit(req.session.id);
    if (!callCheck.allowed) {
        return res.status(429).json({ error: `Muitas ações de call. Aguarde ${callCheck.waitSeconds}s.` });
    }
    
    try {
        const targetChannel = client.channels.cache.get(targetChannelId);
        if (!targetChannel || targetChannel.type !== 'GUILD_VOICE') {
            return res.status(400).json({ error: 'Canal de destino inválido' });
        }
        
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            return res.status(404).json({ error: 'Servidor não encontrado' });
        }
        
        const voiceChannels = guild.channels.cache.filter(c => c.type === 'GUILD_VOICE' && c.id !== targetChannelId);
        let pulled = 0;
        
        for (const [, channel] of voiceChannels) {
            for (const [, member] of channel.members) {
                try {
                    await member.voice.setChannel(targetChannel);
                    pulled++;
                } catch (e) {
                    if (e.status === 429) {
                        const wait = (e.retryAfter || 2) * 1000;
                        await new Promise(r => setTimeout(r, wait + 500));
                    }
                }
                // Delay seguro: 500ms entre movimentações
                await new Promise(r => setTimeout(r, 500));
            }
        }
        
        res.json({ success: true, pulled });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/call/mute', async (req, res) => {
    const client = (req.siteSession ? req.siteSession.client : null);
    const { channelId, mute } = req.body;
    
    if (!client || !client.user) {
        return res.status(401).json({ error: 'Conta não conectada' });
    }
    
    const callCheck = checkCallRateLimit(req.session.id);
    if (!callCheck.allowed) {
        return res.status(429).json({ error: `Muitas ações de call. Aguarde ${callCheck.waitSeconds}s.` });
    }
    
    try {
        const channel = client.channels.cache.get(channelId);
        if (!channel || channel.type !== 'GUILD_VOICE') {
            return res.status(400).json({ error: 'Canal de voz inválido' });
        }
        
        let affected = 0;
        for (const [, member] of channel.members) {
            try {
                await member.voice.setMute(mute);
                affected++;
            } catch (e) {
                if (e.status === 429) {
                    const wait = (e.retryAfter || 2) * 1000;
                    await new Promise(r => setTimeout(r, wait + 500));
                }
            }
            // Delay seguro: 500ms entre mute/unmute
            await new Promise(r => setTimeout(r, 500));
        }
        
        res.json({ success: true, affected, action: mute ? 'mutado' : 'desmutado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== NOVAS FUNÇÕES ====================

// 1. Mover repetidamente entre calls (ping-pong infinito)
const activeMoves = new Map();

app.post('/api/call/repeat-move', async (req, res) => {
    const client = (req.siteSession ? req.siteSession.client : null);
    const { firstChannelId, secondChannelId, stop } = req.body;
    
    if (!client || !client.user) {
        return res.status(401).json({ error: 'Conta não conectada' });
    }
    
    const callCheck = checkCallRateLimit(req.session.id);
    if (!callCheck.allowed) {
        return res.status(429).json({ error: `Muitas ações de call. Aguarde ${callCheck.waitSeconds}s.` });
    }
    
    const moveId = `${req.session.id}_repeat_move`;
    
    // Parar movimento
    if (stop) {
        const move = activeMoves.get(moveId);
        if (move) {
            move.running = false;
            activeMoves.delete(moveId);
            return res.json({ success: true, message: 'Movimento repetido parado!' });
        }
        return res.json({ error: 'Nenhum movimento ativo' });
    }
    
    const firstChannel = client.channels.cache.get(firstChannelId);
    const secondChannel = client.channels.cache.get(secondChannelId);
    
    if (!firstChannel || firstChannel.type !== 'GUILD_VOICE') {
        return res.status(400).json({ error: 'Canal 1 inválido' });
    }
    if (!secondChannel || secondChannel.type !== 'GUILD_VOICE') {
        return res.status(400).json({ error: 'Canal 2 inválido' });
    }
    
    const move = { running: true, movedCount: 0 };
    activeMoves.set(moveId, move);
    
    // Executar em background
    (async () => {
        let origem = firstChannel;
        let destino = secondChannel;
        
        while (move.running) {
            const membros = [...origem.members.values()];
            
            if (membros.length === 0) {
                // Aguarda um pouco se não tiver ninguém
                await new Promise(r => setTimeout(r, 500));
            } else {
                for (const member of membros) {
                    if (!move.running) break;
                    try {
                        await member.voice.setChannel(destino);
                        move.movedCount++;
                        console.log(`[RepeatMove] ${member.user.username} movido para ${destino.name}`);
                    } catch (err) {
                        console.error(`[RepeatMove] Erro: ${err.message}`);
                        if (err.status === 429) {
                            const wait = (err.retryAfter || 5) * 1000;
                            await new Promise(r => setTimeout(r, wait + 500));
                        }
                    }
                    // Delay seguro: 800ms entre movimentações no ping-pong
                    await new Promise(r => setTimeout(r, 800));
                }
            }
            
            // Troca origem/destino
            [origem, destino] = [destino, origem];
        }
    })();
    
    res.json({ 
        success: true, 
        message: `Movimento repetido iniciado entre ${firstChannel.name} e ${secondChannel.name}` 
    });
});

// Status do movimento repetido
app.get('/api/call/repeat-move-status', (req, res) => {
    const moveId = `${req.session.id}_repeat_move`;
    const move = activeMoves.get(moveId);
    
    if (move) {
        res.json({ active: true, movedCount: move.movedCount });
    } else {
        res.json({ active: false, movedCount: 0 });
    }
});

app.post('/api/open-dms-friends', async (req, res) => {
    const client = (req.siteSession ? req.siteSession.client : null);
    
    if (!client || !client.user) {
        return res.status(401).json({ error: 'Conta não conectada' });
    }
    
    clearStopFlag(req.session.id, 'open-dms-friends');
    
    try {
        // Coletar IDs dos amigos
        let friendIds = [];
        
        if (client.relationships && client.relationships.cache) {
            client.relationships.cache.forEach((value, key) => {
                if (value === 1) friendIds.push(key);
            });
        }
        
        if (friendIds.length === 0 && client.relationships && client.relationships.friend) {
            friendIds = Object.keys(client.relationships.friend);
        }
        
        console.log('[OpenDMs] Amigos encontrados: ' + friendIds.length);
        
        // Usa batchAction com delay seguro de 3500ms entre aberturas de DM (mais lento)
        const results = await batchAction(friendIds, async (friendId) => {
            const user = await client.users.fetch(friendId);
            await user.createDM();
        }, 1500, null, { sessionId: req.session.id, action: 'open-dms-friends' });
        
        res.json({ 
            success: true, 
            opened: results.success, 
            errors: results.failed,
            total: friendIds.length,
            stopped: results.stopped
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. Apagar mensagens via comando "clear" (monitora canal)
const clearMonitors = new Map();

app.post('/api/clear-monitor', async (req, res) => {
    const client = (req.siteSession ? req.siteSession.client : null);
    const { channelId, stop } = req.body;
    
    if (!client || !client.user) {
        return res.status(401).json({ error: 'Conta não conectada' });
    }
    
    const monitorId = `${req.session.id}_clear_${channelId}`;
    
    if (stop) {
        const monitor = clearMonitors.get(monitorId);
        if (monitor) {
            client.off('messageCreate', monitor.handler);
            clearMonitors.delete(monitorId);
            return res.json({ success: true, message: 'Monitor clear parado!' });
        }
        return res.json({ error: 'Nenhum monitor ativo neste canal' });
    }
    
    const channel = client.channels.cache.get(channelId);
    if (!channel) {
        return res.status(400).json({ error: 'Canal não encontrado' });
    }
    
    // Remove monitor antigo se existir
    const existingMonitor = clearMonitors.get(monitorId);
    if (existingMonitor) {
        client.off('messageCreate', existingMonitor.handler);
    }
    
    const handler = async (message) => {
        if (message.channel.id !== channelId) return;
        
        if (message.content.toLowerCase() === 'clear' && !message.author.bot) {
            console.log(`[ClearMonitor] Comando clear detectado em #${channel.name}`);
            
            try {
                const messages = await channel.messages.fetch({ limit: 100 });
                const userMessages = messages.filter(m => m.author.id === client.user.id);
                let deleted = 0;
                
                const msgsArray = Array.from(userMessages.values());
                const results = await batchAction(msgsArray, async (msg) => {
                    await msg.delete();
                }, 800);
                deleted = results.success;
                
                console.log(`[ClearMonitor] ${deleted} mensagens apagadas em #${channel.name}`);
            } catch (err) {
                console.error(`[ClearMonitor] Erro: ${err.message}`);
            }
        }
    };
    
    client.on('messageCreate', handler);
    clearMonitors.set(monitorId, { handler, channelName: channel.name });
    
    res.json({ 
        success: true, 
        message: `Monitorando #${channel.name}. Envie "clear" para apagar suas mensagens.` 
    });
});

// 4. Monitorar usuário (webhook - mensagens e calls)
const userMonitors = new Map();

app.post('/api/monitor-user', async (req, res) => {
    const client = (req.siteSession ? req.siteSession.client : null);
    const { userId, webhookURL, stop } = req.body;
    
    if (!client || !client.user) {
        return res.status(401).json({ error: 'Conta não conectada' });
    }
    
    const monitorId = `${req.session.id}_monitor_${userId}`;
    
    if (stop) {
        const monitor = userMonitors.get(monitorId);
        if (monitor) {
            if (monitor.messageHandler) {
                client.off('messageCreate', monitor.messageHandler);
            }
            if (monitor.voiceHandler) {
                client.off('voiceStateUpdate', monitor.voiceHandler);
            }
            userMonitors.delete(monitorId);
            return res.json({ success: true, message: `Monitor do usuário ${userId} parado!` });
        }
        return res.json({ error: 'Nenhum monitor ativo para este usuário' });
    }
    
    if (!userId || !webhookURL) {
        return res.status(400).json({ error: 'userId e webhookURL são obrigatórios' });
    }
    
    // Remove monitor antigo se existir
    const existingMonitor = userMonitors.get(monitorId);
    if (existingMonitor) {
        client.off('messageCreate', existingMonitor.messageHandler);
        client.off('voiceStateUpdate', existingMonitor.voiceHandler);
    }
    
    // Monitor de mensagens com throttle (max 1 msg a cada 3 segundos)
    let lastWebhookTime = 0;
    const WEBHOOK_THROTTLE_MS = 3000;
    
    const messageHandler = async (message) => {
        if (message.author.id !== userId) return;
        
        const now = Date.now();
        if (now - lastWebhookTime < WEBHOOK_THROTTLE_MS) {
            return; // Ignora se muito recente
        }
        lastWebhookTime = now;
        
        const embed = {
            author: {
                name: `${message.author.tag} — Mensagem`,
                icon_url: message.author.displayAvatarURL()
            },
            description: message.content || "*[Sem conteúdo de texto]*",
            color: 0x5865F2, // Blurple do Discord
            fields: [
                { name: "📍 Local", value: message.guild ? `**Servidor:** ${message.guild.name}\n**Canal:** ${message.channel.name}` : "📩 **DM (Mensagem Direta)**", inline: false },
                { name: "🔗 Link", value: `[Ir para mensagem](${message.url})`, inline: true },
                { name: "🆔 ID", value: `\`${message.id}\``, inline: true }
            ],
            timestamp: new Date().toISOString(),
            footer: { text: "Ghost hub — Sistema de Monitoramento" }
        };
        
        try {
            await fetch(webhookURL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ embeds: [embed] })
            });
        } catch (error) {
            console.error('[Monitor] Erro webhook:', error.message);
        }
    };
    
    // Monitor de voz
    const voiceHandler = async (oldState, newState) => {
        if (newState.id !== userId && oldState.id !== userId) return;
        
        let embed;
        const user = newState.member ? newState.member.user : oldState.member.user;
        
        if (!oldState.channelId && newState.channelId) {
            // Entrou na call
            embed = {
                author: {
                    name: `${user.tag} — Entrou na Call`,
                    icon_url: user.displayAvatarURL()
                },
                color: 0x43B581, // Verde do Discord
                description: `O usuário **entrou** em um canal de voz.`,
                fields: [
                    { name: "📢 Servidor", value: newState.guild.name, inline: true },
                    { name: "🔊 Canal", value: newState.channel.name, inline: true }
                ],
                timestamp: new Date().toISOString(),
                footer: { text: "Ghost hub — Sistema de Monitoramento" }
            };
        } else if (oldState.channelId && !newState.channelId) {
            // Saiu da call
            embed = {
                author: {
                    name: `${user.tag} — Saiu da Call`,
                    icon_url: user.displayAvatarURL()
                },
                color: 0xF04747, // Vermelho do Discord
                description: `O usuário **saiu** de um canal de voz.`,
                fields: [
                    { name: "📢 Servidor", value: oldState.guild.name, inline: true },
                    { name: "🔊 Canal", value: oldState.channel.name, inline: true }
                ],
                timestamp: new Date().toISOString(),
                footer: { text: "Ghost hub — Sistema de Monitoramento" }
            };
        } else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
            // Trocou de call
            embed = {
                author: {
                    name: `${user.tag} — Trocou de Call`,
                    icon_url: user.displayAvatarURL()
                },
                color: 0xFAA61A, // Amarelo do Discord
                description: `O usuário **mudou** de canal de voz.`,
                fields: [
                    { name: "📢 Servidor", value: newState.guild.name, inline: false },
                    { name: "⬅️ Canal Anterior", value: oldState.channel.name, inline: true },
                    { name: "➡️ Novo Canal", value: newState.channel.name, inline: true }
                ],
                timestamp: new Date().toISOString(),
                footer: { text: "Ghost hub — Sistema de Monitoramento" }
            };
        }
        
        if (embed) {
            const now = Date.now();
            if (now - lastWebhookTime < WEBHOOK_THROTTLE_MS) {
                return; // Throttle para evitar flood
            }
            lastWebhookTime = now;
            
            try {
                await fetch(webhookURL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ embeds: [embed] })
                });
            } catch (error) {
                console.error('[Monitor] Erro webhook:', error.message);
            }
        }
    };
    
    client.on('messageCreate', messageHandler);
    client.on('voiceStateUpdate', voiceHandler);
    
    userMonitors.set(monitorId, { messageHandler, voiceHandler, userId });
    
    res.json({ 
        success: true, 
        message: `✅ Monitorando usuário ${userId}. Mensagens e calls serão enviadas para a webhook.` 
    });
});

// Listar monitores ativos
app.get('/api/monitors', (req, res) => {
    const monitors = [];
    for (const [key, value] of userMonitors) {
        if (key.startsWith(req.session.id)) {
            monitors.push({ userId: value.userId });
        }
    }
    res.json({ monitors });
});

// Kosame Farm
const activeFarms = new Map();

app.post('/api/farm/kosame', async (req, res) => {
    const client = (req.siteSession ? req.siteSession.client : null);
    const { channelId, cycles, stop } = req.body;
    
    if (!client || !client.user) {
        return res.status(401).json({ error: 'Conta não conectada' });
    }
    
    const farmId = `${req.session.id}_kosame`;
    
    if (stop) {
        const farm = activeFarms.get(farmId);
        if (farm) {
            farm.running = false;
            activeFarms.delete(farmId);
            return res.json({ success: true, message: 'Farm parado com sucesso' });
        }
        return res.json({ error: 'Nenhum farm ativo' });
    }
    
    const channel = client.channels.cache.get(channelId);
    if (!channel) {
        return res.status(400).json({ error: 'Canal não encontrado' });
    }
    
    const commands = ['k!work', 'k!daily', 'k!semanal', 'k!mensal', 'k!vote', 'k!gf', 'k!fofocar', 'k!recompensa'];
    const farm = { running: true };
    activeFarms.set(farmId, farm);
    
    // Executar farm em background com delays ultra-seguros
    (async () => {
        let cycleCount = 0;
        const maxCycles = Math.min(cycles || 10, 50); // Máximo 50 ciclos (proteção)
        
        while (farm.running && cycleCount < maxCycles) {
            for (const cmd of commands) {
                if (!farm.running) break;
                try {
                    await channel.send(cmd);
                } catch (e) {
                    console.log(`[Farm] Erro ao enviar ${cmd}:`, e.message);
                    if (e.status === 429 || e.message?.includes('rate limit')) {
                        const wait = (e.retryAfter || 30) * 1000;
                        console.log(`[Farm] Rate limit. Aguardando ${wait}ms...`);
                        await new Promise(r => setTimeout(r, wait + 5000));
                    }
                }
                // Delay ultra-seguro: 35 segundos entre comandos (~1.7 msg/min)
                await safeDelay(35000, 15);
            }
            cycleCount++;
            if (cycleCount >= maxCycles) break;
            // Delay entre ciclos: 90 segundos
            await safeDelay(90000, 10);
        }
        
        if (farm.running) {
            await channel.send('✅ **Farm encerrado!**').catch(() => {});
        }
        activeFarms.delete(farmId);
    })();
    
    res.json({ 
        success: true, 
        message: `Farm iniciado em ${channel.name}`,
        cycles: maxCycles || 'infinito',
        commands: commands.length
    });
});

// Helper para headers realistas do Discord
function getDiscordHeaders(token) {
    return {
        'Authorization': token,
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Referer': 'https://discord.com/quest-home',
        'Origin': 'https://discord.com',
        'Sec-Ch-Ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
        'X-Debug-Options': 'bugReporterEnabled',
        'X-Discord-Locale': 'pt-BR',
        'X-Discord-Timezone': 'America/Sao_Paulo',
        'X-Super-Properties': 'eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiQ2hyb21lIiwiZGV2aWNlIjoiIiwic3lzdGVtX2xvY2FsZSI6InB0LUJSIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzE0Ny4wLjAuMCBTYWZhcmkvNTM3LjM2IiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTQ3LjAuMC4wIiwib3NfdmVyc2lvbiI6IjEwIiwicmVmZXJyZXIiOiJodHRwczovL3NlYXJjaC5icmF2ZS5jb20vIiwicmVmZXJyaW5nX2RvbWFpbiI6InNlYXJjaC5icmF2ZS5jb20iLCJyZWZlcnJlcl9jdXJyZW50IjoiaHR0cHM6Ly9kaXNjb3JkLmNvbS8iLCJyZWZlcnJpbmdfZG9tYWluX2N1cnJlbnQiOiJkaXNjb3JkLmNvbSIsInJlbGVhc2VfY2hhbm5lbCI6InN0YWJsZSIsImNsaWVudF9idWlsZF9udW1iZXIiOjUzNDk4MiwiY2xpZW50X2V2ZW50X3NvdXJjZSI6bnVsbCwiY2xpZW50X2xhdW5jaF9pZCI6IjFmMTkxY2Q5LTE2MmEtNDk4Yi1iODdjLWQ5MzY4OTQ0NjQ2YSIsImxhdW5jaF9zaWduYXR1cmUiOiIxMjBhYzI2Ny0yNWU3LTQyYmQtOTAzOC03MmJjNGVhNjgwNGMiLCJjbGllbnRfaGVhcnRiZWF0X3Nlc3Npb25faWQiOiJhMjE4Njc2Ny0zNGNiLTRiNGEtOWQ2Mi02M2U3YzBlN2M2ZWYiLCJjbGllbnRfYXBwX3N0YXRlIjoiZm9jdXNlZCJ9'
    };
}

// Quests do Discord
app.get('/api/quests', async (req, res) => {
    const client = (req.siteSession ? req.siteSession.client : null);
    if (!client || !client.user) {
        return res.status(401).json({ error: 'Conta não conectada' });
    }
    try {
        // Usa o REST interno do selfbot (com headers e cookies corretos)
        const data = await client.api.quests['@me'].get();
        res.json(data);
    } catch (error) {
        console.error('[Quests] Erro:', error.message, error.status || '', error.code || '');
        res.status(500).json({ error: error.message, status: error.status, code: error.code });
    }
});

function formatDiscordError(data, fallbackText) {
    if (typeof data === 'string') return data;
    if (data && typeof data === 'object') {
        if (data.message) {
            let msg = data.message;
            if (data.retry_after) msg += ` (aguarde ${Math.ceil(data.retry_after)}s)`;
            return msg;
        }
        return JSON.stringify(data);
    }
    return fallbackText || 'Erro desconhecido';
}

// Enroll (aceitar) quest do Discord
app.post('/api/quests/:questId/enroll', async (req, res) => {
    const client = (req.siteSession ? req.siteSession.client : null);
    if (!client || !client.user) {
        return res.status(401).json({ error: 'Conta não conectada' });
    }
    const { questId } = req.params;
    const token = (req.siteSession ? req.siteSession.discordToken : '');

    try {
        const enrollRes = await directRequest(`/quests/${questId}/enroll`, 'POST', token, { location: 11, is_targeted: false, metadata_raw: null });
        console.log(`[Quests] Enroll ${questId}: status=${enrollRes.status}`);

        if (enrollRes.status === 200) {
            return res.json({ success: true, enrolled: true });
        }

        const already = (enrollRes.data?.message || '').includes('already enrolled') || enrollRes.status === 400;
        if (already) {
            return res.json({ success: true, enrolled: true, alreadyEnrolled: true });
        }

        return res.status(enrollRes.status).json({ error: formatDiscordError(enrollRes.data, enrollRes.text) });
    } catch (e) {
        console.log(`[Quests] Enroll ${questId} erro:`, e.message);
        res.status(500).json({ error: e.message });
    }
});

// Completar quest do Discord — usa estratégia baseada no tipo
app.post('/api/quests/:questId/complete', async (req, res) => {
    const client = (req.siteSession ? req.siteSession.client : null);
    if (!client || !client.user) {
        return res.status(401).json({ error: 'Conta não conectada' });
    }
    const { questId } = req.params;
    const token = (req.siteSession ? req.siteSession.discordToken : '');
    if (!token) return res.status(401).json({ error: 'Token não fornecido no header X-Discord-Token' });

    // Verificar captcha Cloudflare Turnstile
    const { cfTurnstileResponse } = req.body;
    const cfCheck = await verifyTurnstile(cfTurnstileResponse);
    if (!cfCheck.success) {
        return res.status(403).json({ error: `Captcha inválido: ${cfCheck.error || 'tente novamente'}` });
    }

    // Rate limit pesado para missões (evita abuse/brute force)
    const questRateCheck = checkQuestRateLimit(req.session.id, req);
    if (!questRateCheck.allowed) {
        return res.status(429).json({ 
            error: `Muitas tentativas de missão. Aguarde ${questRateCheck.waitSeconds}s.`,
            retryAfter: questRateCheck.waitSeconds
        });
    }

    // Limite de missões simultâneas
    const questCheck = canStartQuest(req.session.id, questId);
    if (!questCheck.allowed) {
        return res.status(429).json({ 
            error: `Limite de ${MAX_CONCURRENT_QUESTS} missões simultâneas atingido. Aguarde uma terminar.`,
            activeQuests: questCheck.activeCount,
            maxQuests: MAX_CONCURRENT_QUESTS
        });
    }

    try {
        // 1. Buscar config da quest
        let quest = null;
        let allQuests = [];
        try {
            const questData = await client.api.quests['@me'].get();
            allQuests = questData.quests || [];
            quest = allQuests.find(q => q.id === questId);
        } catch(e) {
            console.log('[Quests] Erro ao buscar quests:', e.message);
        }

        if (!quest) {
            return res.status(404).json({ error: 'Quest não encontrada' });
        }

        const tasks = quest.config?.task_config_v2?.tasks || {};
        const selectedTask = getBestTask(tasks);
        if (!selectedTask) {
            return res.status(400).json({ error: 'Nenhuma tarefa suportada encontrada nesta quest.' });
        }
        const taskType = selectedTask.taskType;
        const target = selectedTask.taskData.target || 0;
        if (!target || target <= 0) {
            return res.status(400).json({ error: 'Target da missão não identificado. Verifique se a quest foi aceita no Discord.' });
        }

        // 2. Enroll (se ainda não estiver) — usando HTTP direto igual ao quest.js
        let enrolled = false;
        try {
            const enrollRes = await directRequest(`/quests/${questId}/enroll`, 'POST', token, { location: 11, is_targeted: false, metadata_raw: null });
            enrolled = enrollRes.status === 200 || enrollRes.data?.message?.includes('already enrolled');
            if (!enrolled) {
                console.log(`[Quests] Enroll ${questId}: status=${enrollRes.status}, body=${enrollRes.text?.slice(0,200)}`);
            }
        } catch(e) {
            console.log(`[Quests] Enroll ${questId} erro:`, e.message);
        }

        // 3. Executar estratégia baseada no tipo de quest
        let strategy = 'unknown';
        let strategyResult = {};

        if (taskType.startsWith('WATCH_VIDEO')) {
            // === ESTRATÉGIA: VÍDEO (síncrono, rápido) ===
            strategy = 'watch_video';
            const targetSeconds = target;
            let steps = 0;
            if (targetSeconds > 0) {
                steps = Math.min(10, Math.max(5, Math.ceil(targetSeconds / 30))); // Max 10 steps
                const stepSize = Math.max(1, Math.floor(targetSeconds / steps));
                for (let t = 0; t <= targetSeconds; t += stepSize) {
                    try {
                        const res = await directRequest(`/quests/${questId}/video-progress`, 'POST', token, { timestamp: t });
                        if (res.status === 400 || res.status === 429) {
                            t = Math.max(0, t - stepSize);
                            await new Promise(r => setTimeout(r, 8000 + Math.random() * 2000));
                            continue;
                        }
                    } catch (e) {}
                    await new Promise(r => setTimeout(r, 2500 + Math.random() * 2500));
                }
                try {
                    await directRequest(`/quests/${questId}/video-progress`, 'POST', token, { timestamp: targetSeconds });
                } catch {}
            }
            strategyResult = { targetSeconds, steps };

            releaseQuest(req.session.id, questId);
            res.json({
                success: true,
                enrolled,
                strategy,
                taskType,
                target,
                strategyResult,
                message: 'Missão completada! Agora vá no Discord e clique em "Resgatar Recompensa" para pegar sua recompensa.'
            });

        } else if (taskType === 'PLAY_ON_DESKTOP' || taskType === 'STREAM_ON_DESKTOP' || taskType === 'PLAY_ACTIVITY') {
            // === ESTRATÉGIA: DESKTOP/STREAM/ACTIVITY (background, evita timeout do Cloudflare) ===
            const existingJob = getQuestJob(questId);
            if (existingJob && existingJob.status === 'running') {
                releaseQuest(req.session.id, questId);
                return res.status(202).json({
                    success: true,
                    background: true,
                    enrolled,
                    strategy: taskType.toLowerCase(),
                    taskType,
                    target,
                    message: 'Missão já está sendo executada em background.',
                    job: existingJob
                });
            }

            // Inicia em background e libera a resposta HTTP imediatamente
            setImmediate(() => {
                runBackgroundQuest(client, token, questId, quest, taskType, target, enrolled).finally(() => {
                    releaseQuest(req.session.id, questId);
                });
            });

            return res.status(202).json({
                success: true,
                background: true,
                enrolled,
                strategy: taskType.toLowerCase(),
                taskType,
                target,
                message: 'Missão iniciada em background. Pode levar alguns minutos. Acompanhe o progresso no Discord ou consulte o status aqui.'
            });

        } else {
            // Tipo desconhecido — tenta executar síncrono
            releaseQuest(req.session.id, questId);
            res.json({
                success: true,
                enrolled,
                strategy: 'unknown',
                taskType,
                target,
                strategyResult,
                message: 'Tipo de missão não reconhecido, mas foi processada.'
            });
        }
    } catch (error) {
        releaseQuest(req.session.id, questId);
        console.error('[Quests] Erro complete:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Status de quest em background (polling)
app.get('/api/quests/:questId/status', (req, res) => {
    const { questId } = req.params;
    const job = getQuestJob(questId);
    if (!job) {
        return res.json({ status: 'not_found', message: 'Nenhum job ativo para esta quest.' });
    }
    res.json(job);
});

// Listar servidores
app.get('/api/guilds', (req, res) => {
    const client = (req.siteSession ? req.siteSession.client : null);
    
    if (!client || !client.user) {
        return res.status(401).json({ error: 'Conta não conectada' });
    }
    
    const guilds = client.guilds.cache.map(g => ({
        id: g.id,
        name: g.name,
        memberCount: g.memberCount,
        icon: g.iconURL(),
        ownerId: g.ownerId,
        isOwner: g.ownerId === client.user.id,
        isAdmin: g.me ? g.me.permissions.has('ADMINISTRATOR') : (g.ownerId === client.user.id)
    }));
    
    res.json({ guilds });
});

// Rotas das páginas
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Iniciar servidor
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Ghost hub rodando!`);
    console.log(`📱 Acesse: http://0.0.0.0:${PORT}`);
    console.log(`⚠️ Use TOKEN de CONTA PESSOAL (selfbot)\n`);
});