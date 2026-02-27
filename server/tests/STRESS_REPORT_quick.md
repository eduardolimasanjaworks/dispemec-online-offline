# Stress Report (Quick)

## Execução

- Comando: `npm run stress:quick`
- Data: 2026-02-27
- Config:
  - target: `http://localhost:8090`
  - agents: `40`
  - durationSec: `20`
  - heartbeatMs: `2000`
  - seed: `688693966`

## Resultado Objetivo

- totalRequests: `320`
- okCount: `0`
- conflictCount: `0`
- failureCount: `320`
- successRate: `0`
- throughputRps: `16`
- latency avg: `582ms`
- latency p95: `2309ms`
- latency p99: `2697ms`

## Health Before / After

- before:
  - breakerState: `CLOSED`
  - healthStatus: `saudavel`
  - failureRate: `0`
- after:
  - breakerState: `OPEN`
  - healthStatus: `critico`
  - failureRate: `1`
  - recommendation: ação imediata por dependência crítica indisponível

## Diagnóstico de Causa Raiz

- O backend entrou em `circuit_breaker_open` durante o stress.
- Logs do servidor mostram repetição de:
  - `Retry em operacao externa`
  - `Falha definitiva em operacao externa`
  - `Erro em upsertSession`
  - `Falha no processamento de telemetry`
- Conclusão: o run mediu corretamente o comportamento de degradação, mas **não valida SLO funcional** porque a dependência de dados (Directus) estava indisponível/intermitente no período.

## Avaliação contra critérios do plano

- `p95 < 100ms`: **falhou** (2309ms)
- `failureRate` baixa: **falhou** (1.0)
- `desync_rate=0`: **não conclusivo** (sem sucesso de escrita para aferir desync)
- `write_conflict_resolved=100%`: **não conclusivo** (sem tráfego válido)

## Próximos passos recomendados

1. Validar saúde do Directus antes do stress completo (5 min).
2. Rodar novamente `stress:quick` para confirmar baseline com dependência saudável.
3. Só então executar `stress:run` (120 agentes, 300s) para evidência final.
