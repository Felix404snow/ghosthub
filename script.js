const axios = require('axios');
const fs    = require('fs').promises;
const path  = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

let config = {};

const DEFAULT_CONFIG = {
    token: '',
    xSuperProperties: 'eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiQ2hyb21lIiwiZGV2aWNlIjoiIiwic3lzdGVtX2xvY2FsZSI6InB0LUJSIiwiaGFzX2NsaWVudF9tb2RzIjpmYWxzZSwiYnJvd3Nlcl91c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzEyMC4wLjAuMCBTYWZhcmkvNTM3LjM2IiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTIwLjAuMC4wIiwib3NfdmVyc2lvbiI6IjEwIiwicmVmZXJyZXIiOiIiLCJyZWZlcnJpbmdfZG9tYWluIjoiIiwicmVsZWFzZV9jaGFubmVsIjoic3RhYmxlIiwiY2xpZW50X2J1aWxkX251bWJlciI6OTk5OTk5LCJjbGllbnRfZXZlbnRfc291cmNlIjpudWxsfQ==',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9217 Chrome/138.0.7204.251 Electron/37.6.0 Safari/537.36'
};

const TASK_TYPES = {
    'WATCH_VIDEO':           '🎬 Vídeo',
    'WATCH_VIDEO_ON_MOBILE': '🎬 Vídeo',
    'PLAY_ON_DESKTOP':       '🎮 Jogar',
    'PLAY_ON_XBOX':          '🎮 Jogar',
    'PLAY_ON_PLAYSTATION':   '🎮 Jogar'
};

const TASK_TEXT_MAP = {
    'WATCH_VIDEO':           'Vídeo de',
    'WATCH_VIDEO_ON_MOBILE': 'Vídeo de',
    'PLAY_ON_DESKTOP':       'Jogar por',
    'PLAY_ON_XBOX':          'Jogar por',
    'PLAY_ON_PLAYSTATION':   'Jogar por'
};

const TASK_PRIORITY = ['PLAY_ON_DESKTOP', 'PLAY_ON_XBOX', 'PLAY_ON_PLAYSTATION', 'WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE'];

// ─── Config ───────────────────────────────────────────────────────────────────

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jitter(baseMs, rangeMs = 1500) {
    return baseMs + Math.floor(Math.random() * rangeMs);
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
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

function parseRewardText(r) {
    if (!r) return 'Recompensa desconhecida';
    if (r.type === 4) return `${r.orb_quantity} Orbs`;
    if (r.type === 3) return r.messages?.name || 'Decoração de Avatar';
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

function createProgressBar(current, total, size = 20) {
    const pct    = Math.min(Math.floor((current / total) * 100), 100);
    const filled = Math.round((pct / 100) * size);
    const empty  = size - filled;
    return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${pct}%`;
}

// ─── API ──────────────────────────────────────────────────────────────────────

async function makeRequest(endpoint, method, body = null) {
    try {
        const headers = {
            'authorization':      config.token,
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

        return await axios({
            method,
            url:            `https://discord.com/api/v9${endpoint}`,
            headers,
            data:           body,
            validateStatus: () => true
        });
    } catch (err) {
        return { status: 500, data: null };
    }
}

// ─── User Info ────────────────────────────────────────────────────────────────

async function getUserInfo() {
    const res = await makeRequest('/users/@me', 'GET');
    if (res.status !== 200) return null;
    return res.data;
}

async function getOrbsBalance() {
    const res = await makeRequest('/users/@me/virtual-currency/balance', 'GET');
    if (res.status !== 200) return null;
    return res.data.balance || 0;
}

// ─── Quests ───────────────────────────────────────────────────────────────────

async function fetchAvailableQuests() {
    const res = await makeRequest('/quests/@me', 'GET');
    if (res.status !== 200 || !res.data?.quests) return [];

    const now = new Date();
    const result = [];

    for (const quest of res.data.quests) {
        if (new Date(quest.config.expires_at) < now) continue;
        if (quest.user_status?.completed_at) continue;

        const tasks = quest.config.task_config_v2?.tasks || {};
        const selectedTask = getBestTask(tasks);
        if (!selectedTask) continue;

        const target = selectedTask.taskData.target || 0;
        const rewardText = parseRewardText(quest.config.rewards_config?.rewards?.[0]);

        result.push({
            questId:    quest.id,
            questName:  quest.config.messages.quest_name,
            taskType:   selectedTask.taskType,
            target,
            rewardText,
            isEnrolled: !!quest.user_status?.enrolled_at
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

// ─── Quest Runner ─────────────────────────────────────────────────────────────

async function runQuest(quest) {
    const { questId, taskType, target } = quest;
    let currentProgress = 0;

    console.log(`\n🚀 Iniciando: ${quest.questName}`);
    console.log(`   Tipo: ${TASK_TYPES[taskType] || taskType} | Duração: ${getTaskDuration(target)} | Recompensa: ${quest.rewardText}\n`);

    if (!quest.isEnrolled) {
        const enroll = await makeRequest(`/quests/${questId}/enroll`, 'POST', { location: 11, is_targeted: false, metadata_raw: null });
        if (enroll.status !== 200) {
            console.log(`   ❌ Falha ao se inscrever na missão (status ${enroll.status})`);
            return false;
        }
        console.log('   ✅ Inscrito na missão');
    }

    if (taskType.startsWith('WATCH_')) {
        let timestamp = 0;

        while (currentProgress < target) {
            const res = await makeRequest(`/quests/${questId}/video-progress`, 'POST', { timestamp });

            if (res.status === 400 || res.status === 429) {
                timestamp = Math.max(0, timestamp - 10);
                await sleep(jitter(8000));
                continue;
            }

            if (res.status === 200) {
                if (res.data.completed_at) {
                    currentProgress = target;
                    break;
                }
                currentProgress = timestamp;
                timestamp += 10;

                process.stdout.write(`\r   ${createProgressBar(currentProgress, target)} | ${formatTime(currentProgress)} / ${formatTime(target)}`);

                if (currentProgress >= target) break;
            }

            await sleep(jitter(2500, 2500));
        }
    } else if (taskType.startsWith('PLAY_')) {
        const streamKey  = `call:${questId}:1`;
        const MAX_STUCK  = 8;
        let stuckCounter = 0;

        while (currentProgress < target) {
            const res = await makeRequest(`/quests/${questId}/heartbeat`, 'POST', { stream_key: streamKey, terminal: false });

            if (res.status === 429) {
                await sleep(jitter(8000));
                continue;
            }

            if (res.status === 200) {
                const data = res.data;

                if (data.completed_at || data.user_status?.completed_at) {
                    currentProgress = target;
                    break;
                }

                const newProgress = data.progress?.[taskType]?.value ?? currentProgress;

                if (newProgress > currentProgress) {
                    currentProgress = newProgress;
                    stuckCounter = 0;
                    process.stdout.write(`\r   ${createProgressBar(currentProgress, target)} | ${formatTime(currentProgress)} / ${formatTime(target)}`);

                    if (currentProgress >= target) {
                        await makeRequest(`/quests/${questId}/heartbeat`, 'POST', { stream_key: streamKey, terminal: true });
                        currentProgress = target;
                        break;
                    }
                } else {
                    stuckCounter++;
                    if (stuckCounter >= MAX_STUCK) {
                        await makeRequest(`/quests/${questId}/heartbeat`, 'POST', { stream_key: streamKey, terminal: true });
                        currentProgress = target;
                        break;
                    }
                }
            }

            await sleep(jitter(24000, 3000));
        }
    }

    process.stdout.write(`\r   ${createProgressBar(target, target)} | ${formatTime(target)} / ${formatTime(target)}\n`);
    console.log(`   ✅ Missão concluída! Recompensa: ${quest.rewardText}\n`);
    return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    await loadConfig();

    if (!config.token || config.token.trim() === '') {
        console.error('❌ Coloque seu token do Discord no config.json (campo "token") e execute novamente.');
        process.exit(1);
    }

    console.log('🔍 Validando token...');
    const user = await getUserInfo();
    if (!user) {
        console.error('❌ Token inválido ou expirado.');
        process.exit(1);
    }

    console.log(`👤 Conta: ${user.global_name || user.username} (@${user.username})`);
    console.log(`🆔 ID: ${user.id}`);

    const orbs = await getOrbsBalance();
    if (orbs !== null) {
        console.log(`💰 Orbs: ${orbs.toLocaleString('pt-BR')}`);
    }

    console.log('\n📋 Buscando missões disponíveis...\n');
    const quests = await fetchAvailableQuests();

    if (!quests.length) {
        console.log('🚫 Nenhuma missão disponível no momento.');
        return;
    }

    console.log(`🎯 ${quests.length} missão(ões) encontrada(s):\n`);
    for (let i = 0; i < quests.length; i++) {
        const q = quests[i];
        console.log(`   ${i + 1}. ${q.questName}`);
        console.log(`      ${TASK_TYPES[q.taskType]} | ${getTaskDuration(q.target)} | 🎁 ${q.rewardText}`);
    }

    console.log('\n▶️ Iniciando execução automática...\n');

    let completed = 0;
    for (const quest of quests) {
        const ok = await runQuest(quest);
        if (ok) completed++;
        if (quest !== quests[quests.length - 1]) {
            console.log('⏳ Aguardando antes da próxima missão...\n');
            await sleep(jitter(10000, 3000));
        }
    }

    console.log(`\n🏁 Tudo pronto! ${completed}/${quests.length} missões concluídas.`);

    const finalOrbs = await getOrbsBalance();
    if (finalOrbs !== null) {
        console.log(`💰 Saldo final de Orbs: ${finalOrbs.toLocaleString('pt-BR')}`);
    }
}

main().catch(err => {
    console.error('Erro fatal:', err);
    process.exit(1);
});
