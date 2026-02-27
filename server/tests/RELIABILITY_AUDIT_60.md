# Reliability Audit (60 Pontos)

Formato: `ID | Categoria | Severidade | Ponto de Falha | Detecção | Mitigação Implementada/Planejada`

## 1) Concorrência e Integridade (20)

1. C1 | Concorrência | Crítica | Upsert concorrente por `tabId` sem coordenação | Conflitos + logs de versão | Mutex por `tabId` + check de versão
2. C2 | Concorrência | Alta | Retry cria efeito duplicado | Auditoria por `operationId` | Idempotency store com TTL
3. C3 | Concorrência | Alta | Evento antigo sobrescreve estado novo | `VERSION_CONFLICT` + `409` | Versionamento otimista
4. C4 | Concorrência | Alta | Prune remove sessão recém-atualizada | Sessão reaparece/oscila | Releitura antes de delete + lock
5. C5 | Concorrência | Média | Duas abas mesmo usuário geram clobber visual | Divergência no admin realtime | Estado por `userId/tabId`
6. C6 | Concorrência | Alta | Falha parcial em write/log | Diferença entre sessão e histórico | Retry + logs estruturados
7. C7 | Concorrência | Média | Delete concorrente em logout | Sessão fantasma | Remove com tolerância e auditoria
8. C8 | Concorrência | Média | Leitura+escrita sem guarda de versão em borda | Inconsistência eventual | `ENABLE_STRICT_VERSION_CHECK`
9. C9 | Concorrência | Média | Duplicidade de `operationId` entre atores | Chave reaproveitada indevida | Escopo por payload + tab/user
10. C10 | Concorrência | Média | Falha no lock cleanup | Crescimento `Map` de lock | `finally` com release garantido
11. C11 | Concorrência | Média | Latência alta abre janela de corrida maior | p95/p99 alto | Backoff + monitor de latência
12. C12 | Concorrência | Alta | Atualização fora de ordem no cliente | Estado admin “vai e volta” | Reconcile por versão
13. C13 | Concorrência | Média | Race entre `shutdown` e `heartbeat` | Sessão volta após encerrar | idempotência + ordem por versão
14. C14 | Concorrência | Média | Estado legado e robusto coexistem e divergem | Logs com caminhos diferentes | Feature flags + compat bridge
15. C15 | Concorrência | Média | Burst de eventos sem limitação | Saturação parcial | Políticas de retry e watchdog
16. C16 | Concorrência | Alta | Falha no Directus em meio a update | Erro 5xx + atraso | Circuit breaker + retry
17. C17 | Concorrência | Média | Snapshot admin desatualizado após reconexão | Diferença UI x API | `join_admin` ao reconectar
18. C18 | Concorrência | Baixa | Chaves de sessão inválidas no cliente | Erro de validação | UUID por aba + fallback
19. C19 | Concorrência | Média | Inconsistência por relógio do cliente | Ordem errada local | Tempo de servidor como referência
20. C20 | Concorrência | Alta | Ausência de prova de conflito resolvido | Sem evidência auditável | testes randomizados + integração

## 2) Rede e Conectividade (20)

21. N1 | Rede | Crítica | Queda total de rede no cliente | Falhas de fetch | `offline-safe` + lock progressivo
22. N2 | Rede | Alta | Reconexão websocket fraca | desconexão recorrente | reconnection options + handlers
23. N3 | Rede | Alta | Socket admin sem liveness check | stale socket silencioso | watchdog ping/pong admin
24. N4 | Rede | Média | Sem health endpoint objetivo | Operação sem termômetro | `/api/admin/health`
25. N5 | Rede | Alta | Dependência backend indisponível | breaker OPEN | Circuit breaker state no health
26. N6 | Rede | Média | Requisição lenta sem visibilidade | p95/p99 desconhecido | métricas de latência no monitor
27. N7 | Rede | Média | Sem recomendação operacional | equipe demora reação | `recommendation` no health snapshot
28. N8 | Rede | Alta | Falha em cadeia sob retries | carga amplificada | backoff exponencial com jitter
29. N9 | Rede | Média | Heartbeat sem SLA explícito | “online fantasma” | `sessionsOverSla` + thresholds
30. N10 | Rede | Média | Falhas intermitentes não registradas | incidentes sem rastro | logs persistentes em disco
31. N11 | Rede | Média | Falha de reconexão não reportada | debugging difícil | ingestão de erros do cliente
32. N12 | Rede | Baixa | Erro de payload não JSON | endpoint quebra parsing | parse defensivo + warning
33. N13 | Rede | Alta | Sem quick stress validation | regressão sem alerta | `stress:quick`/`stress:run`
34. N14 | Rede | Média | Ambiente sem servidor durante stress | falso negativo | modo `stress:dry`
35. N15 | Rede | Média | Conflitos sob carga não mensurados | risco oculto | `conflictRate` em relatório
36. N16 | Rede | Alta | Taxa de falha sob carga não mensurada | indisponibilidade não detectada | `failureRate` + relatório
37. N17 | Rede | Média | Timeout implícito no cliente | congelamento percebido | estado degradado/offline-safe
38. N18 | Rede | Média | Sem seed de aleatoriedade em stress | resultado não reproduzível | `STRESS_SEED` + output
39. N19 | Rede | Baixa | Falha ao ler health no admin | card vazio | tratamento silencioso + retry periódico
40. N20 | Rede | Alta | Não validar SLO pós-execução | aprovação insegura | hints de aceite no report

## 3) Lógica, Operação e Manutenibilidade (20)

41. L1 | Lógica | Crítica | `catch` vazio escondendo erro | ausência de logs | remoção de empty catches
42. L2 | Lógica | Alta | Monólito difícil de evoluir | mudanças arriscadas | extração para `reliability/*`
43. L3 | Lógica | Média | Raciocínio não rastreável para IA | contexto quebrado | módulos focados e headers
44. L4 | Lógica | Média | Sem regra operacional persistente | drift de padrão | `.cursorrules` reforçado
45. L5 | Lógica | Média | Logs sem rotação | disco enche | rotação de arquivo
46. L6 | Lógica | Média | Falha de I/O de log derruba fluxo | indisponibilidade desnecessária | fallback para console
47. L7 | Lógica | Baixa | Leitura de log cara em arquivos grandes | atraso em diagnóstico | tail controlado por linhas
48. L8 | Lógica | Alta | Frontend vendedor com ruído técnico | erro de uso | UI simplificada (botão único)
49. L9 | Lógica | Média | Mensagens em inglês no front | UX inconsistente | textos em português
50. L10 | Lógica | Média | Recuperação manual pouco clara | erro operacional | recomendação e status geral
51. L11 | Lógica | Alta | Sem classificação de saúde objetiva | reação tardia | `saudavel/degradado/critico`
52. L12 | Lógica | Média | Thresholds hardcoded sem override | pouca adaptação | env vars com defaults
53. L13 | Lógica | Média | Falta de baseline formal | difícil comparar evolução | stress report com before/after
54. L14 | Lógica | Alta | Sem tabela formal de falhas | auditoria incompleta | este documento (60 pontos)
55. L15 | Lógica | Média | Testes enviesados por cenários fixos | falsa confiança | testes randomizados por seed
56. L16 | Lógica | Baixa | Sem comando único de teste | execução inconsistente | scripts npm padronizados
57. L17 | Lógica | Média | Sem teste de integração watchdog | regressão silenciosa | `adminSocketWatchdog.integration.test.js`
58. L18 | Lógica | Média | Sem integração health pipeline | números sem validação | `healthMonitor.integration.test.js`
59. L19 | Lógica | Baixa | Resultados não reproduzíveis | auditoria difícil | `test:reliability:seed`
60. L20 | Lógica | Alta | Conclusão sem critério de aceite | risco de liberação | SLOs explicitados no report

## Cobertura dos 60 pontos

- Cobertos por implementação direta: C1-C4, C8, C10, C12-C14, C16-C17, C20, N1-N8, N10-N13, N15-N16, N18, N20, L1-L3, L5-L8, L11-L12, L14-L20.
- Cobertura parcial/operacional (depende de stress em ambiente alvo): C5-C7, C9, C11, C15, C18-C19, N9, N14, N17, N19, L4, L9-L10, L13.
