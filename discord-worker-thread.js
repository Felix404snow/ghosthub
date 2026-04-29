/**
 * Discord Worker Thread
 * Roda em thread separada via worker_threads.
 * Recebe jobs de HTTP fetch, executa, e retorna resultado.
 * Faz retry automático em 429 e erros de rede.
 */
const { parentPort } = require('worker_threads');
const fetch = require('node-fetch');
const { getProxyAgent } = require('./proxies');

const DEFAULT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    'X-Super-Properties': 'eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiQ2hyb21lIiwiZGV2aWNlIjoiIiwic3lzdGVtX2xvY2FsZSI6InB0LUJSIiwiaGFzX2NsaWVudF9tb2RzIjpmYWxzZSwiYnJvd3Nlcl91c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzE0Ny4wLjAuMCBTYWZhcmkvNTM3LjM2IiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTQ3LjAuMC4wIiwib3NfdmVyc2lvbiI6IjEwIiwicmVmZXJyZXIiOiJodHRwczovL2Rpc2NvcmQuY29tLyIsInJlZmVycmluZ19kb21haW4iOiJkaXNjb3JkLmNvbSIsInJlZmVycmVyX2N1cnJlbnQiOiJodHRwczovL2Rpc2NvcmQuY29tLyIsInJlZmVycmluZ19kb21haW5fY3VycmVudCI6ImRpc2NvcmQuY29tIiwicmVsZWFzZV9jaGFubmVsIjoic3RhYmxlIiwiY2xpZW50X2J1aWxkX251bWJlciI6NTM0OTgzLCJjbGllbnRfZXZlbnRfc291cmNlIjpudWxsLCJjbGllbnRfbGF1bmNoX2lkIjoiMWYxOTFjZDktMTYyYS00OThiLWI4N2MtZDkzNjg5NDQ2NDZhIiwibGF1bmNoX3NpZ25hdHVyZSI6IjEyMGFjMjY3LTI1ZTctNDJiZC05MDM4LTcyYmM0ZWE2ODA0YyIsImNsaWVudF9oZWF0YmVhdF9zZXNzaW9uX2lkIjoiYTIxODY3NjctMzRjYi00YjRhLTlkNjItNjNlN2MwZTdjNmVmIiwiY2xpZW50X2FwcF9zdGF0ZSI6ImZvY3VzZWQifQ==',
    'Origin': 'https://discord.com',
    'Referer': 'https://discord.com/',
    'Sec-Ch-Ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin'
};

async function executeJob(jobData) {
    const { url, method = 'GET', headers = {}, body, retries = 3 } = jobData;
    const attemptDelayBase = jobData.attemptDelayBase || 1500;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const options = {
                method,
                headers: { ...DEFAULT_HEADERS, ...headers },
                timeout: jobData.timeout || 30000,
                agent: getProxyAgent()
            };

            if (body !== undefined && body !== null) {
                options.body = typeof body === 'string' ? body : JSON.stringify(body);
            }

            const response = await fetch(url, options);

            // Rate limit — retry com backoff inteligente
            if (response.status === 429) {
                const retryAfter = parseFloat(response.headers.get('retry-after') || response.headers.get('x-ratelimit-reset-after') || 5);
                const isGlobal = response.headers.get('x-ratelimit-global') === 'true';

                if (attempt < retries) {
                    const waitMs = (retryAfter * 1000) + 1000 + (isGlobal ? 3000 : 0);
                    // Notifica main thread que está em rate limit (para logging/debug)
                    parentPort.postMessage({
                        type: 'rateLimit',
                        url,
                        retryAfter: waitMs,
                        attempt: attempt + 1,
                        isGlobal
                    });
                    await new Promise(r => setTimeout(r, waitMs));
                    continue;
                }

                const error = new Error('Too Many Requests');
                error.status = 429;
                error.retryAfter = retryAfter;
                throw error;
            }

            const text = await response.text();
            return {
                ok: response.ok,
                status: response.status,
                statusText: response.statusText,
                headers: Object.fromEntries(response.headers.entries()),
                body: text
            };

        } catch (e) {
            // Erro de rede / timeout — tenta novamente com backoff exponencial
            if (attempt < retries) {
                const backoff = attemptDelayBase * Math.pow(2, attempt) + Math.random() * 500;
                parentPort.postMessage({
                    type: 'retry',
                    url,
                    error: e.message,
                    attempt: attempt + 1,
                    backoff
                });
                await new Promise(r => setTimeout(r, backoff));
                continue;
            }
            throw e;
        }
    }
}

parentPort.on('message', async (msg) => {
    try {
        const result = await executeJob(msg.data);
        parentPort.postMessage({
            type: 'result',
            queueName: msg.queueName,
            jobId: msg.jobId,
            result
        });
    } catch (error) {
        parentPort.postMessage({
            type: 'error',
            queueName: msg.queueName,
            jobId: msg.jobId,
            error: error.message,
            status: error.status || 0,
            retryAfter: error.retryAfter || 0
        });
    }
});
