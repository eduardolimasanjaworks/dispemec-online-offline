// Removido dotenv
const { createDirectus, rest, staticToken, createCollection, createField, createRelation } = require('@directus/sdk');

// Defina as variáveis de ambiente ou substitua aqui diretamente se rodar local
const DIRECTUS_URL = process.env.DIRECTUS_URL || "http://91.99.137.101:8056/"; // Ex: https://api.seudominio.com
const DIRECTUS_TOKEN = process.env.DIRECTUS_TOKEN || "UuazE-Np-VrpGxmqe-bEpysiTSjV8_YR";

async function run() {
    console.log(`Conectando ao Directus em ${DIRECTUS_URL}...`);

    // Configura o client do Directus com token fixo e REST
    const client = createDirectus(DIRECTUS_URL)
        .with(staticToken(DIRECTUS_TOKEN))
        .with(rest());


    // ==========================================
    // 1. CRIAR COLEÇÃO: Telemetry_Users
    // Usa prefixo Telemetry_ para não conflitar com directus_users se vc não quiser usar os nativos
    // ==========================================
    try {
        console.log("Criando coleção 'Telemetry_Users'...");
        await client.request(createCollection({
            collection: 'Telemetry_Users',
            meta: {
                icon: 'group',
                note: 'Tabela de usuários legada (migrada do SQLite)',
                display_template: '{{username}}'
            },
            schema: {
                name: 'Telemetry_Users'
            },
            fields: [
                {
                    field: 'id',
                    type: 'string',
                    schema: { is_primary_key: true, max_length: 255 },
                    meta: { interface: 'input', hidden: true }
                }
            ]
        }));

        console.log("  ↳ Criando campos adicionais para Telemetry_Users...");
        const userFields = [
            { field: 'username', type: 'string', schema: { is_unique: true } },
            { field: 'password', type: 'string', meta: { interface: 'input-hashed' } }, // Hashed interface no painel
            { field: 'salt', type: 'string', meta: { hidden: true } },
            { field: 'isAdmin', type: 'boolean', schema: { default_value: false } },
            { field: 'lastLogin', type: 'timestamp' },
            { field: 'deletedAt', type: 'timestamp' } // Paranoia / soft delete do Sequelize
        ];

        for (const f of userFields) {
            await client.request(createField('Telemetry_Users', {
                field: f.field, type: f.type, schema: f.schema || {}, meta: f.meta || {}
            }));
        }
        console.log("✅ Coleção 'Telemetry_Users' criada com sucesso.");
    } catch (e) {
        console.log("⚠️ Coleção Telemetry_Users possivelmente já existe ou erro: ", e.message);
    }

    // ==========================================
    // 2. CRIAR COLEÇÃO: Telemetry_Sessions
    // ==========================================
    try {
        console.log("Criando coleção 'Telemetry_Sessions'...");
        await client.request(createCollection({
            collection: 'Telemetry_Sessions',
            meta: { icon: 'devices' },
            schema: { name: 'Telemetry_Sessions' },
            fields: [
                {
                    field: 'tabId',
                    type: 'uuid', // UUID field pra abas
                    schema: { is_primary_key: true },
                    meta: { interface: 'input', hidden: true }
                }
            ]
        }));

        console.log("  ↳ Criando campos adicionais para Telemetry_Sessions...");
        const sessionFields = [
            { field: 'userId', type: 'string' }, // Relacionamento
            { field: 'username', type: 'string' },
            { field: 'ip', type: 'string' },
            { field: 'state', type: 'string' },
            { field: 'lastSeen', type: 'timestamp' },
            { field: 'deviceType', type: 'string' },
            { field: 'userAgent', type: 'text' },
            { field: 'startedAt', type: 'timestamp', schema: { default_value: 'CURRENT_TIMESTAMP' } }
        ];

        for (const f of sessionFields) {
            await client.request(createField('Telemetry_Sessions', {
                field: f.field, type: f.type, schema: f.schema || {}, meta: f.meta || {}
            }));
        }

        // Criar a Relation M2O (One Session -> One User)
        console.log("  ↳ Criando relação Telemetry_Sessions.userId -> Telemetry_Users.id");
        await client.request(createRelation({
            collection: 'Telemetry_Sessions',
            field: 'userId',
            related_collection: 'Telemetry_Users',
            schema: { on_delete: 'CASCADE' }
        }));

        console.log("✅ Coleção 'Telemetry_Sessions' criada com sucesso.");
    } catch (e) {
        console.log("⚠️ Coleção Telemetry_Sessions possivelmente já existe ou erro: ", e.message);
    }

    // ==========================================
    // 3. CRIAR COLEÇÃO: Telemetry_Logs
    // ==========================================
    try {
        console.log("Criando coleção 'Telemetry_Logs'...");
        await client.request(createCollection({
            collection: 'Telemetry_Logs',
            meta: { icon: 'history' },
            schema: { name: 'Telemetry_Logs' },
            fields: [
                {
                    field: 'id',
                    type: 'integer',
                    schema: { is_primary_key: true, has_auto_increment: true },
                    meta: { hidden: true }
                }
            ]
        }));

        console.log("  ↳ Criando campos adicionais para Telemetry_Logs...");
        const logFields = [
            { field: 'userId', type: 'string' }, // Relacionamento
            { field: 'tabId', type: 'uuid' },
            { field: 'state', type: 'string' },
            { field: 'eventType', type: 'string' },
            { field: 'timestamp', type: 'timestamp', schema: { default_value: 'CURRENT_TIMESTAMP' } }
        ];

        for (const f of logFields) {
            await client.request(createField('Telemetry_Logs', {
                field: f.field, type: f.type, schema: f.schema || {}, meta: f.meta || {}
            }));
        }

        // Criar a Relation M2O (One Log -> One User)
        console.log("  ↳ Criando relação Telemetry_Logs.userId -> Telemetry_Users.id");
        await client.request(createRelation({
            collection: 'Telemetry_Logs',
            field: 'userId',
            related_collection: 'Telemetry_Users',
            schema: { on_delete: 'SET NULL' }
        }));

        console.log("✅ Coleção 'Telemetry_Logs' criada com sucesso.");
    } catch (e) {
        console.log("⚠️ Coleção Telemetry_Logs possivelmente já existe ou erro: ", e.message);
    }

    console.log("🎉 Processo finalizado!");
}

run();
