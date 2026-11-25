# Trade simulado

Teste de uma semana: o Claude opera uma **corretora fictícia** de cripto com preços reais da Binance e **dinheiro de mentira** (R$ 1.000 iniciais). Nenhuma ordem real é enviada. Nada aqui é recomendação de investimento.

- `corretora.mjs`: a corretora (Node, sem dependências). `node corretora.mjs` mostra os comandos.
- `estado.json`, `historico.jsonl`, `diario.md`: conta, curva de patrimônio e diário de decisões.
- `ROTINA.md`: o que o Claude faz a cada rodada de decisão.
- `.github/workflows/monitor.yml`: confere stop/alvo a cada ~10 min.
- Painel: publicado no GitHub Pages (branch `gh-pages`).
