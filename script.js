const {
    Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
    ButtonStyle, StringSelectMenuBuilder, ActivityType, ModalBuilder, TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const axios = require('axios');
const fs    = require('fs').promises;
const path  = require('path');

const CONFIG_PATH   = path.join(__dirname, 'config.json');
const DATABASE_PATH = path.join(__dirname, 'database.json');

let config       = {};
let database     = {};
let userSessions = {};

const DEFAULT_CONFIG = {
    channelId:        '',
    botToken:         '',
    guildId:          '',
    xSuperProperties: 'eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiQ2hyb21lIiwiZGV2aWNlIjoiIiwic3lzdGVtX2xvY2FsZSI6InB0LUJSIiwiaGFzX2NsaWVudF9tb2RzIjpmYWxzZSwiYnJvd3Nlcl91c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzEyMC4wLjAuMCBTYWZhcmkvNTM3LjM2IiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTIwLjAuMC4wIiwib3NfdmVyc2lvbiI6IjEwIiwicmVmZXJyZXIiOiIiLCJyZWZlcnJpbmdfZG9tYWluIjoiIiwicmVsZWFzZV9jaGFubmVsIjoic3RhYmxlIiwiY2xpZW50X2J1aWxkX251bWJlciI6OTk5OTk5LCJjbGllbnRfZXZlbnRfc291cmNlIjpudWxsfQ==',
    userAgent:        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9217 Chrome/138.0.7204.251 Electron/37.6.0 Safari/537.36',
    presence: {
        status:         'online',
        rotateInterval: 30,
        activities: [
            { type: 'Watching',  name: 'Discord Quests'    },
            { type: 'Playing',   name: 'Auto-Quest'        },
            { type: 'Listening', name: 'missões do Discord' }
        ]
    }
};

const DEFAULT_DATABASE = {
    panelMessageId: null,
    users:          {}
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

    if (!isObj(database.users))                { database.users          = {};        fix('users: ausente/inválido → {}'); }
    if (!('panelMessageId' in database))       { database.panelMessageId = null;      fix('panelMessageId: ausente → null'); }

    const validRoot = new Set(['panelMessageId', 'users']);
    for (const k of Object.keys(database)) {
        if (!validRoot.has(k)) { delete database[k]; fix(`raiz: campo desconhecido "${k}" removido`); }
    }

    const validUserKeys = new Set(['token', 'id', 'username', 'globalName', 'avatar', 'activeQuest', 'resumeChannelId', 'resumeMessageId']);

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
        }

        for (const k of Object.keys(user)) {
            if (!validUserKeys.has(k)) { delete user[k]; fix(`users[${userId}]: chave desconhecida "${k}" → removida`); }
        }
    }

    const line = '─'.repeat(50);
    console.log(`\n  ╔${line}╗`);
    console.log(`  ║  🔧 Database Repair`);
    console.log(`  ╠${line}╣`);
    if (fixes.length === 0) {
        console.log(`  ║  ✅ Nenhum problema encontrado.`);
    } else {
        for (const msg of fixes) console.log(`  ║  ⚠ ${msg}`);
        console.log(`  ╠${line}╣`);
        console.log(`  ║  ✅ ${fixes.length} problema(s) corrigido(s). Database salvo.`);
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
    const bar       = createTextProgressBar(current, total);

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

async function editProgressMessage(msg, payload) {
    try {
        await msg.edit({ ...payload, components: [] });
        return msg;
    } catch (err) {
        console.error('Erro ao editar progresso:', err);
        return msg;
    }
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

        return await axios({
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
        avatar:     avatarUrl
    };

    await saveDatabase();
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

    const quest = userSessions[userId].availableQuests[parseInt(interaction.values[0].split('_')[1])];
    const token = database.users[userId].token;

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
            components: []
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
            } catch (err) {
                console.error(`❌ Erro ao retomar quest de ${userData.username}:`, err);
            }
        })();
    }

    renderDashboard();
}

// ─── Terminal Dashboard ───────────────────────────────────────────────────────

let _lastDashboardState = '';

function renderDashboard() {
    const users        = Object.keys(database.users).length;
    const activeQuests = Object.values(database.users).filter(u => u.activeQuest).length;

    const state = `${users}|${activeQuests}`;
    if (state === _lastDashboardState) return;
    _lastDashboardState = state;

    const line = '─'.repeat(44);
    const pad  = (label, value, width = 44) => `  ${label}: ${value}`.padEnd(width);

    console.log(`  ╔${line}╗`);
    console.log(`  ║${pad('👥 Usuários conectados', users)}`);
    console.log(`  ║${pad('⚡ Missões em andamento', activeQuests)}`);
    console.log(`  ╚${line}╝\n`);
}

// ─── Presence ─────────────────────────────────────────────────────────────────

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

// ─── Boot ─────────────────────────────────────────────────────────────────────

client.once('ready', async () => {
    await loadDatabase();
    setupPresence();

    if (!isConfigured(config.channelId)) {
        console.error('❌ Configure o "channelId" no config.json e reinicie.');
        process.exit(1);
    }

    try {
        const channel = await client.channels.fetch(config.channelId);
        await sendPanel(channel);
    } catch (err) {
        console.error('❌ Erro ao configurar painel:', err.message);
        process.exit(1);
    }

    renderDashboard();
    await resumeQuestsOnStartup();

    setInterval(renderDashboard, 10000);
});

client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isButton()) {
            switch (interaction.customId) {
                case 'login':      return handleLogin(interaction);
                case 'disconnect': return handleDisconnect(interaction);
                case 'orbs':       return handleOrbs(interaction);
                case 'autoquest':  return handleAutoQuest(interaction);
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
