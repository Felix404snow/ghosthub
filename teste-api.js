const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

async function testar() {
    const TOKEN = 'COLOQUE_SEU_TOKEN_AQUI';
    const USER_ID = 'COLOQUE_O_ID_AQUI';
    
    try {
        const res = await fetch(`https://discord.com/api/v9/users/${USER_ID}/profile`, {
            method: 'GET',
            headers: {
                'Authorization': TOKEN,
                'Content-Type': 'application/json'
            }
        });
        
        const data = await res.json();
        
        if (res.ok) {
            console.log('✅ Funcionou!');
            console.log('Badges:', data.badges?.map(b => ({ id: b.id, desc: b.description })));
            console.log('Nitro desde:', data.premium_since);
            console.log('Boost desde:', data.premium_guild_since);
        } else {
            console.log('❌ Erro:', res.status, data);
        }
    } catch (e) {
        console.error('❌ Erro de conexão:', e.message);
    }
}

testar();