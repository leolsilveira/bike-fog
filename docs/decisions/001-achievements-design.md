# ADR-001: Decisões de Design do Sistema de Conquistas

- **Status:** Aceito
- **Data:** 2026-11-20
- **Design Doc:** [001 — Sistema de Conquistas](../design/001-achievements.md)

---

## Contexto

Queríamos adicionar conquistas com recompensas em moedas no Desbrava, inspiradas no StatsHunters (níveis progressivos, metas mensais recorrentes, Número de Eddington) e em exploração urbana por cidade. Três decisões de produto/arquitetura precisavam ser definidas antes da implementação.

---

## Decisões

### 1. Concessão automática de moedas (sem botão "Resgatar")
- **Decisão:** Creditar moedas automaticamente na carteira (`wallet`) no momento do desbloqueio.
- **Motivo:** Reduz atrito e mantém o fluxo passivo do app durante pedaladas e corridas. Em gravação ativa, a notificação aparece como cartão compacto que some sozinho (mesmo padrão de capturas e level up). Em lotes (3+ conquistas simultâneas, como importação GPX), exibimos um único toast agregado para não empilhar modais.
- **Alternativa rejeitada:** Resgate manual na tela de conquistas.

### 2. Conquistas integradas na aba `Stats` + modal dedicado
- **Decisão:** Manter a barra inferior com 3 abas (`Mapa`, `Gravar`, `Stats`), exibindo um resumo + próximos alvos na aba `Stats` e um modal completo (`AchievementsModal`) com filtros por categoria.
- **Motivo:** Preserva a simplicidade da navegação principal (especialmente com uso de uma mão no celular) enquanto oferece espaço amplo para explorar dezenas de conquistas, cidades e metas mensais.
- **Alternativa rejeitada:** Adicionar uma 4ª aba fixa na barra inferior.

### 3. Atividades importadas (GPX / Strava) contam para conquistas
- **Decisão:** Avaliar conquistas sobre o estado consolidado do jogador, incluindo atividades importadas de arquivos `.gpx` e `.zip` do Strava.
- **Motivo:** Quem traz seu histórico do Strava espera ver o progresso refletido nas conquistas de cidade, distância, sequência e Eddington, além de receber moedas de boas-vindas — mantendo intacta a regra existente de que importações não alteram XP/nível.
- **Alternativa rejeitada:** Restringir conquistas apenas a atividades gravadas ao vivo no app.

---

## Consequências

- `PersistedState` ganha `achievements: Record<string, AchievementRecord>` de forma retrocompatível dentro da `version: 1`.
- Moedas de conquista vão apenas para `wallet` (não somam em `totals.coinsValue` nem `totals.coinsCount`), evitando que moedas de conquista desbloqueiem recursivamente a conquista `street_coins`.
- Conquistas já desbloqueadas ficam gravadas permanentemente em `achievements`, garantindo que o jogador nunca perca medalhas mesmo se atividades muito antigas saírem do limite de 200 itens em `activities`.
