const { createDirectus, rest, staticToken, readItems, createItem, deleteItem } = require('@directus/sdk');
const crypto = require('crypto');

const DIRECTUS_URL = process.env.DIRECTUS_URL || "http://91.99.137.101:8056/";
const DIRECTUS_TOKEN = process.env.DIRECTUS_TOKEN || "UuazE-Np-VrpGxmqe-bEpysiTSjV8_YR";

const directus = createDirectus(DIRECTUS_URL)
    .with(staticToken(DIRECTUS_TOKEN))
    .with(rest());

function hashPassword(password, salt) {
    return crypto.scryptSync(password, salt, 64).toString('hex');
}

async function run() {
    console.log('🔄 Verificando administradores existentes...');
    try {
        const admins = await directus.request(readItems('Telemetry_Users', {
            filter: { username: { _eq: 'admin' } }
        }));

        // Apagar todos os admins atuais para resetar a senha com certeza
        for (const admin of admins) {
            console.log(`🗑️ Removendo admin existente: ${admin.id}`);
            await directus.request(deleteItem('Telemetry_Users', admin.id));
        }

        const ADMIN_PASSWORD = "SuperAdminStrongPassword2026!";
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = hashPassword(ADMIN_PASSWORD, salt);
        const adminId = crypto.randomUUID();

        await directus.request(createItem('Telemetry_Users', {
            id: adminId,
            username: 'admin',
            password: hash,
            salt: salt,
            isAdmin: true
        }));

        console.log(`✅ SEED CONCLUÍDA: Admin Account Recriada com sucesso!`);
        console.log(`👤 Usuário: admin`);
        console.log(`🔑 Senha: ${ADMIN_PASSWORD}`);

    } catch (e) {
        console.error("Erro ao rodar seed:", e.errors || e.message);
    }
}
run();
