const fs = require('fs');
const path = require('path');

/**
 * Context Header
 * Purpose: Gerar logs persistentes em disco para auditoria e leitura por IA.
 * Inputs/Outputs: Recebe eventos estruturados e persiste em app.log/audit.log + summary txt.
 * Invariants: Cada linha de log é JSON válido com timestamp e contexto mínimo.
 * Failure Modes: Falha de I/O em disco.
 * Fallback: Nunca quebra a aplicação; degrada para console.
 */
class LoggingManager {
    constructor(options = {}) {
        this.logsDir = options.logsDir || path.join(process.cwd(), 'logs');
        this.maxFileSizeBytes = options.maxFileSizeBytes || 5 * 1024 * 1024;
        this.maxBackups = options.maxBackups || 5;
        this.appLogFile = path.join(this.logsDir, 'app.log');
        this.auditLogFile = path.join(this.logsDir, 'audit.log');
        this.summaryFile = path.join(this.logsDir, 'last-session-summary.txt');

        this.ensureDir();
    }

    ensureDir() {
        try {
            fs.mkdirSync(this.logsDir, { recursive: true });
        } catch (error) {
            // fallback para console em caso de falha
            console.error('[LoggingManager] Falha ao criar pasta de logs:', error.message);
        }
    }

    rotateIfNeeded(filePath) {
        try {
            if (!fs.existsSync(filePath)) return;
            const size = fs.statSync(filePath).size;
            if (size < this.maxFileSizeBytes) return;

            for (let idx = this.maxBackups - 1; idx >= 1; idx -= 1) {
                const source = `${filePath}.${idx}`;
                const target = `${filePath}.${idx + 1}`;
                if (fs.existsSync(source)) fs.renameSync(source, target);
            }
            fs.renameSync(filePath, `${filePath}.1`);
        } catch (error) {
            console.error('[LoggingManager] Falha ao rotacionar log:', error.message);
        }
    }

    buildEntry(level, message, context = {}) {
        return {
            timestamp: new Date().toISOString(),
            level,
            service: 'telemetry-server',
            message,
            ...context
        };
    }

    write(filePath, entry) {
        try {
            this.rotateIfNeeded(filePath);
            fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
        } catch (error) {
            console.error('[LoggingManager] Falha ao persistir log:', error.message);
            console.log('[LoggingManager/Fallback]', entry);
        }
    }

    info(message, context = {}) {
        const entry = this.buildEntry('info', message, context);
        this.write(this.appLogFile, entry);
        if (context.printToConsole) console.log(`[INFO] ${message}`);
    }

    warn(message, context = {}) {
        const entry = this.buildEntry('warn', message, context);
        this.write(this.appLogFile, entry);
        console.warn(`[WARN] ${message}`);
    }

    error(message, context = {}) {
        const entry = this.buildEntry('error', message, context);
        this.write(this.appLogFile, entry);
        console.error(`[ERROR] ${message}`);
    }

    audit(action, context = {}) {
        const entry = this.buildEntry('audit', action, context);
        this.write(this.auditLogFile, entry);
    }

    updateSummary(lines) {
        try {
            const content = Array.isArray(lines) ? lines.join('\n') : String(lines || '');
            fs.writeFileSync(this.summaryFile, `${content}\n`, 'utf8');
        } catch (error) {
            console.error('[LoggingManager] Falha ao atualizar summary:', error.message);
        }
    }

    readTail(fileType = 'app', lineCount = 200) {
        const filePath = fileType === 'audit' ? this.auditLogFile : this.appLogFile;
        try {
            if (!fs.existsSync(filePath)) return [];
            const raw = fs.readFileSync(filePath, 'utf8');
            const lines = raw.split('\n').filter(Boolean);
            return lines.slice(-Math.max(1, lineCount));
        } catch (error) {
            this.error('Falha ao ler tail de logs', { errorMessage: error.message, fileType });
            return [];
        }
    }
}

module.exports = {
    LoggingManager
};
