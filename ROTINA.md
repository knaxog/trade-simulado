# Rotina de cada rodada (Claude operando a corretora fictícia)

Tudo aqui é simulação: preços reais da Binance (API pública, sem chave), dinheiro de mentira.
Nenhuma ordem real é enviada a lugar nenhum. Não acesse corretoras reais nem use chaves de API.

O repositório é a fonte da verdade (`estado.json`, `historico.jsonl`, `diario.md`).
Um monitor no GitHub Actions confere stop/alvo a cada ~10 min e também grava nesses arquivos.

## Estilo pedido pelo usuário: agressivo, formato híbrido intraday (desde 25/11/2026)
Rodadas a cada 1 hora. A ideia é ter mais operações curtas na semana para gerar dados mais rápido.
- Margem de R$ 50 a R$ 100 por operação, alavancagem de até 20x (normalmente 15x a 20x).
- **Alvo ≈ +50% da margem** (a 20x, ~2,5% de movimento; a 15x, ~3,3%).
- **Stop ≈ −25% da margem** (a 20x, ~1,25% de movimento). A corretora recusa stop que perca mais de 30% da margem. Nunca abrir sem stop.
- Conta do preço: alvo = `entrada × (1 ± 0,5/alav)`, stop = `entrada × (1 ∓ 0,25/alav)` (sinal de cima para long, de baixo para short).
- **Cada operação fecha sozinha depois de 12 h** se não bater alvo nem stop. Então só entre se o movimento do alvo for plausível em menos de 12 h (compare com o ATR de 1h e de 15m).
- O stop tem que ficar fora do ruído normal: pelo menos ~1 ATR de 15m longe da entrada. Se não couber, baixe a alavancagem.
- Até 10 operações por dia e 3 abertas ao mesmo tempo.
- Ficar de fora é uma decisão válida. Só entre quando houver um motivo claro (tendência, rompimento, exaustão com RSI extremo, etc.).
- Não concentre a mesma aposta em pares que andam juntos.
- Posições abertas antes de 25/11 às 12h (a #1) seguem com o alvo/stop originais e sem prazo.

## Passos
1. `git fetch origin main && git reset --hard origin/main` (a cópia local não guarda nada próprio: o GitHub é a fonte da verdade, e consultas locais podem ter mexido no estado.json)
2. `node corretora.mjs status` (isso também fecha o que bateu stop/alvo desde a última checagem).
3. `node corretora.mjs precos` e `node corretora.mjs analise` (todos os pares) ou `analise BTC SOL` etc.
4. Decida: abrir, fechar alguma aberta (`fechar ID --motivo "..."`) ou não fazer nada.
5. Para abrir: `node corretora.mjs abrir PAR long|short MARGEM ALAV --alvo P --stop P --motivo "tese em uma frase + o que invalida"`.
6. Acrescente ao fim do `diario.md` uma linha `- <dd/mm/aaaa hh:mm, horário de Brasília> · rodada: <o que viu e o que decidiu>` (inclusive quando não fizer nada).
7. Grave e envie direto na `main` (sem branch, sem pull request):
   `git add estado.json historico.jsonl diario.md && git commit -m "rodada <data hora>" && git push origin HEAD:main`
8. Se o push for recusado porque o monitor gravou antes: `git fetch origin main && git reset --hard origin/main`,
   rode de novo os mesmos comandos de abrir/fechar que você decidiu (com o preço novo), refaça a linha do diário e envie de novo.

A corretora aplica sozinha as regras: até 3 abertas, até 10 operações por dia, stop de no máximo −30% da margem, fechamento automático em 12 h.

O teste vai até 02/12/2026. A partir dessa data: só rode `node corretora.mjs relatorio`, registre no diário que o teste acabou e não abra operações novas.
