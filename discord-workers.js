/**
 * Discord Workers — Pool multi-thread + Filas por rota
 *
 * Arquitetura:
 *   - Cada categoria de rota tem sua própria fila (delay independente)
 *   - Workers rodam em threads separadas (worker_threads)
 *   - Workers consomem jobs das filas conforme disponibilidade
 *   - Retry 429 automático dentro da thread
 *
 * Filas:
 *   'quest'    → heartbeats, video-progress, enroll (mais restrito)
 *   'message'  → enviar, deletar, editar mensagens
 *   'voice'    → call actions: join, move, mute, disconnect
 *   'profile'  → perfil, bio, status, fetch info
 *   'other'    → fallback para tudo o mais
 */
const { Worker } = require('worker_threads');
const path = require('path');

// ========== RATE LIMITER GLOBAL POR TOKEN ==========
// Protege a conta do Discord: soma TODAS as requisições de um token
// e impede que ultrapasse MAX_REQ_PER_MINUTE_TOKEN (padrão 30).

class TokenRateLimiter {
    constructor(maxPerMinute = 30) {
        this.maxPerMinute = maxPerMinute;
        this.windows = new Map(); // tokenHash -> [timestamps]
        this.minIntervalMs = Math.ceil(60000 / maxPerMinute); // ms entre requests
    }

    getTokenHash(jobData) {
        const auth = jobData?.headers?.Authorization || jobData?.headers?.authorization || '';
        return auth ? auth.slice(0, 20) + auth.slice(-10) : '__no_token__';
    }

    canProcess(jobData) {
        const hash = this.getTokenHash(jobData);
        const now = Date.now();
        let timestamps = this.windows.get(hash);
        if (!timestamps) {
            timestamps = [];
            this.windows.set(hash, timestamps);
        }
        // Limpa timestamps antigos (> 60s)
        const cutoff = now - 60000;
        while (timestamps.length > 0 && timestamps[0] < cutoff) {
            timestamps.shift();
        }
        // Verifica se está dentro do limite
        if (timestamps.length >= this.maxPerMinute) {
            const nextAvailable = timestamps[0] + 60000;
            const wait = nextAvailable - now;
            return { allowed: false, wait };
        }
        // Também respeita o intervalo mínimo entre requests do MESMO token
        const last = timestamps.length > 0 ? timestamps[timestamps.length - 1] : 0;
        if (now - last < this.minIntervalMs) {
            return { allowed: false, wait: this.minIntervalMs - (now - last) };
        }
        return { allowed: true };
    }

    record(jobData) {
        const hash = this.getTokenHash(jobData);
        let timestamps = this.windows.get(hash);
        if (!timestamps) {
            timestamps = [];
            this.windows.set(hash, timestamps);
        }
        timestamps.push(Date.now());
    }

    getStats() {
        const stats = {};
        for (const [hash, timestamps] of this.windows) {
            const recent = timestamps.filter(t => Date.now() - t < 60000);
            stats[hash] = recent.length;
        }
        return stats;
    }
}

class RouteQueue {
    constructor(name, minIntervalMs = 1500, maxWorkers = 2) {
        this.name = name;
        this.jobs = [];                 // { id, data, addedAt }
        this.minIntervalMs = minIntervalMs;
        this.maxWorkers = maxWorkers;   // limite de workers paralelos NESTA fila
        this.activeWorkers = 0;
        this.lastProcessedTime = 0;
        this.resolvers = new Map();     // jobId -> { resolve, reject, timer }
        this.jobIdCounter = 0;
        this.totalProcessed = 0;
        this.totalFailed = 0;
        this.totalQueued = 0;
    }

    add(jobData) {
        return new Promise((resolve, reject) => {
            const id = ++this.jobIdCounter;
            this.jobs.push({ id, data: jobData, addedAt: Date.now() });
            this.totalQueued++;

            // Timeout global para não deixar promise pendente para sempre
            const timer = setTimeout(() => {
                if (this.resolvers.has(id)) {
                    this.resolvers.delete(id);
                    reject(new Error(`Job ${this.name}#${id} timeout após 5 minutos na fila/worker`));
                    // Remove da fila se ainda estiver lá
                    const idx = this.jobs.findIndex(j => j.id === id);
                    if (idx !== -1) this.jobs.splice(idx, 1);
                }
            }, 300000); // 5 minutos

            this.resolvers.set(id, { resolve, reject, timer });
        });
    }

    canProcess(tokenLimiter = null) {
        const elapsed = Date.now() - this.lastProcessedTime;
        if (this.jobs.length === 0 || this.activeWorkers >= this.maxWorkers || elapsed < this.minIntervalMs) {
            return false;
        }
        // Verifica rate limit global por token (se fornecido)
        if (tokenLimiter) {
            const check = tokenLimiter.canProcess(this.jobs[0].data);
            if (!check.allowed) return false;
        }
        return true;
    }

    peek() {
        return this.jobs.length > 0 ? this.jobs[0] : null;
    }

    getNext(tokenLimiter = null) {
        if (!this.canProcess(tokenLimiter)) return null;
        this.activeWorkers++;
        this.lastProcessedTime = Date.now();
        const job = this.jobs.shift();
        if (tokenLimiter && job) {
            tokenLimiter.record(job.data);
        }
        return job;
    }

    releaseWorker() {
        this.activeWorkers = Math.max(0, this.activeWorkers - 1);
    }

    resolve(jobId, result) {
        this.releaseWorker();
        const r = this.resolvers.get(jobId);
        if (r) {
            clearTimeout(r.timer);
            r.resolve(result);
            this.resolvers.delete(jobId);
            this.totalProcessed++;
        }
    }

    reject(jobId, error) {
        this.releaseWorker();
        const r = this.resolvers.get(jobId);
        if (r) {
            clearTimeout(r.timer);
            r.reject(error);
            this.resolvers.delete(jobId);
            this.totalFailed++;
        }
    }

    getStats() {
        return {
            name: this.name,
            queued: this.jobs.length,
            active: this.activeWorkers,
            totalQueued: this.totalQueued,
            totalProcessed: this.totalProcessed,
            totalFailed: this.totalFailed,
            minIntervalMs: this.minIntervalMs
        };
    }
}

class DiscordWorkerPool {
    constructor(numWorkers = 4, maxReqPerMinuteToken = 30) {
        this.queues = new Map();
        this.workers = [];
        this.running = true;
        this.tokenLimiter = new TokenRateLimiter(maxReqPerMinuteToken);

        // Registrar filas padrão
        // IMPORTANTE: os delays por fila respeitam o limite global por token.
        // Se todas as filas estiverem ativas, o tokenLimiter segura o excedente.
        this.registerQueue('quest', 4000, 1);     // Quests: muito restrito, 1 worker
        this.registerQueue('message', 2000, 1);   // Mensagens: 30/min se sozinha
        this.registerQueue('voice', 2000, 1);     // Call: 30/min se sozinha
        this.registerQueue('profile', 2000, 1);   // Perfil: 30/min se sozinha
        this.registerQueue('other', 2000, 1);     // Restante: 30/min se sozinha

        for (let i = 0; i < numWorkers; i++) {
            this.spawnWorker(i);
        }

        // Loop de dispatch: verifica a cada 50ms se há fila pronta + worker livre
        this.loopInterval = setInterval(() => this.dispatch(), 50);

        // Log de status a cada 30s
        this.statsInterval = setInterval(() => this.logStats(), 30000);
    }

    spawnWorker(id) {
        const workerPath = path.join(__dirname, 'discord-worker-thread.js');
        const worker = new Worker(workerPath);
        worker.id = id;
        worker.busy = false;
        worker.startedAt = Date.now();
        worker.jobsCompleted = 0;

        worker.on('message', (msg) => {
            if (msg.type === 'result') {
                const queue = this.queues.get(msg.queueName);
                if (queue) queue.resolve(msg.jobId, msg.result);
                worker.jobsCompleted++;
            } else if (msg.type === 'error') {
                const queue = this.queues.get(msg.queueName);
                if (queue) {
                    const err = new Error(msg.error);
                    err.status = msg.status;
                    err.retryAfter = msg.retryAfter;
                    queue.reject(msg.jobId, err);
                }
            } else if (msg.type === 'rateLimit') {
                console.log(`[WorkerPool] Rate limit em ${msg.url} | retryAfter=${msg.retryAfter}ms | global=${msg.isGlobal} | tentativa=${msg.attempt}`);
            } else if (msg.type === 'retry') {
                console.log(`[WorkerPool] Retry em ${msg.url} | erro="${msg.error}" | tentativa=${msg.attempt} | backoff=${Math.round(msg.backoff)}ms`);
            }
            worker.busy = false;
        });

        worker.on('error', (err) => {
            console.error(`[Worker ${id}] Erro fatal na thread:`, err.message);
            worker.busy = false;
            // Recria o worker se morrer
            setTimeout(() => this.replaceWorker(id), 1000);
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                console.error(`[Worker ${id}] Thread encerrou com código ${code}. Recriando...`);
                this.replaceWorker(id);
            }
        });

        this.workers.push(worker);
    }

    replaceWorker(id) {
        const idx = this.workers.findIndex(w => w.id === id);
        if (idx !== -1) {
            try { this.workers[idx].terminate(); } catch(e) {}
            this.workers.splice(idx, 1);
        }
        this.spawnWorker(id);
    }

    registerQueue(name, minIntervalMs, maxWorkers) {
        this.queues.set(name, new RouteQueue(name, minIntervalMs, maxWorkers));
        console.log(`[WorkerPool] Fila registrada: ${name} | delay=${minIntervalMs}ms | maxWorkers=${maxWorkers}`);
    }

    /**
     * Executa um job em uma fila específica.
     * O jobData deve conter: url, method, headers, body, etc.
     */
    async execute(queueName, jobData) {
        const queue = this.queues.get(queueName);
        if (!queue) {
            throw new Error(`Fila "${queueName}" não registrada. Filas: ${[...this.queues.keys()].join(', ')}`);
        }
        return queue.add(jobData);
    }

    /**
     * Dispatch: pega fila pronta + worker livre e envia o job.
     * Cada job passa pelo tokenLimiter ANTES de sair, garantindo que
     * a SOMA de todas as filas nunca ultrapasse o limite global do token.
     */
    dispatch() {
        if (!this.running) return;

        const availableWorkers = this.workers.filter(w => !w.busy);
        if (availableWorkers.length === 0) return;

        // Coleta filas que podem processar (incluindo check de token)
        const readyQueues = [];
        for (const q of this.queues.values()) {
            if (q.canProcess(this.tokenLimiter)) readyQueues.push(q);
        }
        if (readyQueues.length === 0) return;

        // Ordena por: mais jobs pendentes primeiro (evita starvation)
        readyQueues.sort((a, b) => b.jobs.length - a.jobs.length);

        let workerIdx = 0;
        for (const queue of readyQueues) {
            if (workerIdx >= availableWorkers.length) break;

            const job = queue.getNext(this.tokenLimiter);
            if (!job) continue;

            const worker = availableWorkers[workerIdx++];
            worker.busy = true;
            worker.postMessage({
                queueName: queue.name,
                jobId: job.id,
                data: job.data
            });
        }
    }

    logStats() {
        const stats = [...this.queues.values()].map(q => q.getStats());
        const totalQueued = stats.reduce((a, s) => a + s.queued, 0);
        const totalActive = stats.reduce((a, s) => a + s.active, 0);
        const totalProcessed = stats.reduce((a, s) => a + s.totalProcessed, 0);
        const totalFailed = stats.reduce((a, s) => a + s.totalFailed, 0);
        const tokenStats = this.tokenLimiter.getStats();
        const tokenSummary = Object.entries(tokenStats).map(([h, c]) => `${h.slice(0, 6)}…${h.slice(-4)}:${c}`).join(', ');

        if (totalQueued > 0 || totalActive > 0 || tokenSummary) {
            console.log(`[WorkerPool] Status | Workers=${this.workers.length} | Ativos=${totalActive} | Fila=${totalQueued} | OK=${totalProcessed} | Fail=${totalFailed}`);
            if (tokenSummary) {
                console.log(`  └─ Tokens (req/min): ${tokenSummary}`);
            }
            for (const s of stats) {
                if (s.queued > 0 || s.active > 0) {
                    console.log(`  └─ ${s.name}: fila=${s.queued} ativos=${s.active} ok=${s.totalProcessed} fail=${s.totalFailed}`);
                }
            }
        }
    }

    getStats() {
        return {
            workers: this.workers.length,
            queues: [...this.queues.values()].map(q => q.getStats())
        };
    }

    async terminate() {
        this.running = false;
        clearInterval(this.loopInterval);
        clearInterval(this.statsInterval);
        await Promise.all(this.workers.map(w => w.terminate()));
    }
}

// Singleton exportado
let poolInstance = null;

function getWorkerPool(numWorkers = 4) {
    if (!poolInstance) {
        poolInstance = new DiscordWorkerPool(numWorkers);
    }
    return poolInstance;
}

/**
 * Helpers para usar no server.js mantendo compatibilidade.
 */

// Determina qual fila usar baseado na URL/método
function detectQueue(url, method = 'GET') {
    if (!url) return 'other';
    const u = url.toLowerCase();

    if (u.includes('/quests/')) return 'quest';
    if (u.includes('/messages') || u.includes('/channels/') && method !== 'GET') return 'message';
    if (u.includes('/users/@me/profile') || u.includes('/users/') && u.includes('/profile')) return 'profile';
    if (u.includes('/voice') || u.includes('/call')) return 'voice';
    if (u.includes('/channels/') && (method === 'POST' || method === 'PATCH' || method === 'DELETE')) return 'message';

    return 'other';
}

// Wrapper compatível com discordFetch antigo
async function discordFetchQueued(url, options = {}) {
    const queue = options.queue || detectQueue(url, options.method);
    const pool = getWorkerPool();

    const headers = {
        'Authorization': options.headers?.Authorization || options.headers?.authorization || '',
        'Content-Type': options.headers?.['Content-Type'] || 'application/json',
        ...options.headers
    };

    const result = await pool.execute(queue, {
        url,
        method: options.method || 'GET',
        headers,
        body: options.body,
        retries: 3,
        timeout: options.timeout || 30000
    });

    // Recria um objeto response-like para compatibilidade
    return {
        ok: result.ok,
        status: result.status,
        statusText: result.statusText,
        headers: {
            get: (name) => result.headers[name.toLowerCase()],
            entries: () => Object.entries(result.headers)
        },
        text: async () => result.body,
        json: async () => JSON.parse(result.body)
    };
}

// Wrapper para heartbeat de quests (compatível com queuedHeartbeat antigo)
async function queuedHeartbeatQueued(token, questId, body) {
    const pool = getWorkerPool();
    const result = await pool.execute('quest', {
        url: `https://discord.com/api/v9/quests/${questId}/heartbeat`,
        method: 'POST',
        headers: {
            'Authorization': token,
            'Content-Type': 'application/json'
        },
        body,
        retries: 3
    });
    return JSON.parse(result.body);
}

// Wrapper para video-progress de quests
async function queuedVideoProgressQueued(token, questId, body) {
    const pool = getWorkerPool();
    const result = await pool.execute('quest', {
        url: `https://discord.com/api/v9/quests/${questId}/video-progress`,
        method: 'POST',
        headers: {
            'Authorization': token,
            'Content-Type': 'application/json'
        },
        body,
        retries: 3
    });
    return JSON.parse(result.body);
}

// Wrapper compatível com curlRequest antigo
async function curlRequestQueued(method, url, options = {}) {
    const pool = getWorkerPool();
    const queue = options.queue || detectQueue(url, method);

    const result = await pool.execute(queue, {
        url,
        method,
        headers: {
            'Authorization': options.token || '',
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
            'X-Debug-Options': 'bugReporterEnabled',
            'X-Discord-Locale': 'pt-BR',
            'X-Discord-Timezone': 'America/Sao_Paulo',
            'X-Super-Properties': 'eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiQ2hyb21lIiwiZGV2aWNlIjoiIiwic3lzdGVtX2xvY2FsZSI6InB0LUJSIiwiaGFzX2NsaWVudF9tb2RzIjpmYWxzZSwiYnJvd3Nlcl91c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzE0Ny4wLjAuMCBTYWZhcmkvNTM3LjM2IiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTQ3LjAuMC4wIiwib3NfdmVyc2lvbiI6IjEwIiwicmVmZXJyZXIiOiJodHRwczovL2Rpc2NvcmQuY29tLyIsInJlZmVycmluZ19kb21haW4iOiJkaXNjb3JkLmNvbSIsInJlZmVycmVyX2N1cnJlbnQiOiJodHRwczovL2Rpc2NvcmQuY29tLyIsInJlZmVycmluZ19kb21haW5fY3VycmVudCI6ImRpc2NvcmQuY29tIiwicmVsZWFzZV9jaGFubmVsIjoic3RhYmxlIiwiY2xpZW50X2J1aWxkX251bWJlciI6NTM0OTgzLCJjbGllbnRfZXZlbnRfc291cmNlIjpudWxsLCJjbGllbnRfbGF1bmNoX2lkIjoiMWYxOTFjZDktMTYyYS00OThiLWI4N2MtZDkzNjg5NDQ2NDZhIiwibGF1bmNoX3NpZ25hdHVyZSI6IjEyMGFjMjY3LTI1ZTctNDJiZC05MDM4LTcyYmM0ZWE2ODA0YyIsImNsaWVudF9oZWF0YmVhdF9zZXNzaW9uX2lkIjoiYTIxODY3NjctMzRjYi00YjRhLTlkNjItNjNlN2MwZTdjNmVmIiwiY2xpZW50X2FwcF9zdGF0ZSI6ImZvY3VzZWQifQ==',
            ...options.headers
        },
        body: options.body,
        retries: 3,
        timeout: options.timeout || 30000
    });

    return {
        ok: result.ok,
        status: result.status,
        text: async () => result.body,
        json: async () => JSON.parse(result.body)
    };
}

module.exports = {
    DiscordWorkerPool,
    getWorkerPool,
    detectQueue,
    discordFetchQueued,
    queuedHeartbeatQueued,
    queuedVideoProgressQueued,
    curlRequestQueued
};
